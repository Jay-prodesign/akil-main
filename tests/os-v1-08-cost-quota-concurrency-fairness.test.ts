import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  createQuotaReservationIdentity,
  deriveQuotaReservationIdempotencyKey,
  admitQuotaReservation,
  commitQuotaUsage,
  QuotaReservationConflictError,
  EMPTY_QUOTA_LEDGER,
  type QuotaLedger,
} from "../src/domain/execution-quota-admission.js";
import { FileDurableQuotaReservationStore } from "../src/domain/durable-quota-reservation-store.js";
import {
  resolveWorkerRoute,
  type AdmittedWorker,
  type WorkerRoutingRequest,
} from "../src/domain/worker-routing-policy.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "os-v1-08-quota-"));
}

function withFreshStoreDir<T>(fn: (dir: string) => T): T {
  const dir = freshStoreDir();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tenantScope = createTenantScope("tenant-os-v1-08");

test("RACE1 (reservation races, cited/re-demonstrated): two concurrent admissions together exceeding the limit resolve to exactly one RESERVED, one REJECTED", async () => {
  await withFreshStoreDir(async (dir) => {
    const scope = createQuotaAdmissionScope({ tenantScope, customerId: "cust-race1", projectId: "proj-race1", planId: "plan-1", planVersion: 1 });
    const envelope = createQuotaEnvelope({ scope, envelopeRef: "env-race1", sourceFingerprint: "fp-1", unitLimit: 1 });
    const store = new FileDurableQuotaReservationStore(dir);
    const identityA = createQuotaReservationIdentity({ scope, jobId: "job-race1", runId: "run-a", attemptRef: "1" });
    const identityB = createQuotaReservationIdentity({ scope, jobId: "job-race1", runId: "run-b", attemptRef: "1" });
    const [outcomeA, outcomeB] = await Promise.all([
      Promise.resolve(store.admit({ envelope, identity: identityA, idempotencyKey: "race1-a", requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-10-09T00:00:00.000Z" })),
      Promise.resolve(store.admit({ envelope, identity: identityB, idempotencyKey: "race1-b", requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-10-09T00:00:00.000Z" })),
    ]);
    const statuses = [outcomeA.status, outcomeB.status].sort();
    assert.deepEqual(statuses, ["REJECTED", "RESERVED"]);
  });
});

test("FAN1 (fan-out ceiling bypass, NEW): ten concurrent admissions against a 3-slot unit floor resolve to EXACTLY 3 RESERVED and 7 REJECTED", async () => {
  await withFreshStoreDir(async (dir) => {
    const scope = createQuotaAdmissionScope({ tenantScope, customerId: "cust-fan1", projectId: "proj-fan1", planId: "plan-1", planVersion: 1 });
    const envelope = createQuotaEnvelope({ scope, envelopeRef: "env-fan1", sourceFingerprint: "fp-1", unitLimit: 3 });
    const store = new FileDurableQuotaReservationStore(dir);
    const fanOutCount = 10;
    const outcomes = await Promise.all(
      Array.from({ length: fanOutCount }, (_, index) => {
        const identity = createQuotaReservationIdentity({ scope, jobId: "job-fan1", runId: `run-${index}`, attemptRef: "1" });
        return Promise.resolve(
          store.admit({
            envelope,
            identity,
            idempotencyKey: `fan1-${index}`,
            requestedAmount: { presence: "UNKNOWN" },
            occurredAt: "2026-10-09T00:00:00.000Z",
          }),
        );
      }),
    );
    const reservedCount = outcomes.filter((o) => o.status === "RESERVED").length;
    const rejectedCount = outcomes.filter((o) => o.status === "REJECTED").length;
    assert.equal(reservedCount, 3, "a 3-slot ceiling must admit exactly 3 concurrent fan-out requests, never more");
    assert.equal(rejectedCount, 7);
  });
});

test("SETTLE1 (double settlement, cited/re-demonstrated): an identical-content duplicate commit is a safe no-op; a divergent-content duplicate throws QuotaReservationConflictError", () => {
  const scope = createQuotaAdmissionScope({ tenantScope, customerId: "cust-settle1", projectId: "proj-settle1", planId: "plan-1", planVersion: 1 });
  const envelope = createQuotaEnvelope({ scope, envelopeRef: "env-settle1", sourceFingerprint: "fp-1", unitLimit: 5 });
  const identity = createQuotaReservationIdentity({ scope, jobId: "job-settle1", runId: "run-1", attemptRef: "1" });
  const idempotencyKey = deriveQuotaReservationIdempotencyKey(identity);

  const afterAdmit = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER,
    envelope,
    identity,
    idempotencyKey,
    requestedAmount: { presence: "UNKNOWN" },
    occurredAt: "2026-10-09T00:00:00.000Z",
  });
  assert.equal(afterAdmit.outcome.status, "RESERVED");

  const firstCommit = commitQuotaUsage({
    ledger: afterAdmit.ledger,
    identity,
    idempotencyKey,
    actualAmount: { presence: "REPORTED", amountMinorUnits: 10, currency: "USD" },
    occurredAt: "2026-10-09T00:01:00.000Z",
  });
  assert.equal(firstCommit.outcome.status, "COMMITTED");

  const duplicateIdentical = commitQuotaUsage({
    ledger: firstCommit.ledger,
    identity,
    idempotencyKey,
    actualAmount: { presence: "REPORTED", amountMinorUnits: 10, currency: "USD" },
    occurredAt: "2026-10-09T00:02:00.000Z",
  });
  assert.equal(duplicateIdentical.outcome.status, "COMMITTED");
  assert.equal(duplicateIdentical.ledger, firstCommit.ledger, "an identical duplicate commit must append nothing new");

  assert.throws(
    () =>
      commitQuotaUsage({
        ledger: firstCommit.ledger,
        identity,
        idempotencyKey,
        actualAmount: { presence: "REPORTED", amountMinorUnits: 999, currency: "USD" },
        occurredAt: "2026-10-09T00:03:00.000Z",
      }),
    QuotaReservationConflictError,
  );
});

test("RETRY1 (retry bypass, NEW): three sequential retries against a 2-slot ceiling - the third is REJECTED by cumulative scope usage, never granted a fresh budget", async () => {
  await withFreshStoreDir(async (dir) => {
    const scope = createQuotaAdmissionScope({ tenantScope, customerId: "cust-retry1", projectId: "proj-retry1", planId: "plan-1", planVersion: 1 });
    const envelope = createQuotaEnvelope({ scope, envelopeRef: "env-retry1", sourceFingerprint: "fp-1", unitLimit: 2 });
    const store = new FileDurableQuotaReservationStore(dir);

    const identity1 = createQuotaReservationIdentity({ scope, jobId: "job-retry1", runId: "run-1", attemptRef: "1" });
    const identity2 = createQuotaReservationIdentity({ scope, jobId: "job-retry1", runId: "run-1", attemptRef: "2" });
    const identity3 = createQuotaReservationIdentity({ scope, jobId: "job-retry1", runId: "run-1", attemptRef: "3" });

    const key1 = deriveQuotaReservationIdempotencyKey(identity1);
    const key2 = deriveQuotaReservationIdempotencyKey(identity2);
    const key3 = deriveQuotaReservationIdempotencyKey(identity3);
    assert.notEqual(key1, key2);
    assert.notEqual(key2, key3);

    const attempt1 = store.admit({ envelope, identity: identity1, idempotencyKey: key1, requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-10-09T00:00:00.000Z" });
    assert.equal(attempt1.status, "RESERVED");

    const attempt2 = store.admit({ envelope, identity: identity2, idempotencyKey: key2, requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-10-09T00:01:00.000Z" });
    assert.equal(attempt2.status, "RESERVED");

    const attempt3 = store.admit({ envelope, identity: identity3, idempotencyKey: key3, requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-10-09T00:02:00.000Z" });
    assert.equal(attempt3.status, "REJECTED", "a third retry's fresh idempotencyKey must never grant quota the scope's cumulative usage has already exhausted");
  });
});

test("FALLBACK1 (fallback bypass, NEW): a second attempt against an already-exhausted scope is REJECTED regardless of being a different route - admission never inspects attribution", async () => {
  await withFreshStoreDir(async (dir) => {
    const scope = createQuotaAdmissionScope({ tenantScope, customerId: "cust-fallback1", projectId: "proj-fallback1", planId: "plan-1", planVersion: 1 });
    const envelope = createQuotaEnvelope({ scope, envelopeRef: "env-fallback1", sourceFingerprint: "fp-1", unitLimit: 1 });
    const store = new FileDurableQuotaReservationStore(dir);

    const primaryIdentity = createQuotaReservationIdentity({ scope, jobId: "job-fallback1", runId: "run-primary", attemptRef: "1" });
    const primary = store.admit({
      envelope,
      identity: primaryIdentity,
      idempotencyKey: "fallback1-primary",
      requestedAmount: { presence: "UNKNOWN" },
      occurredAt: "2026-10-09T00:00:00.000Z",
    });
    assert.equal(primary.status, "RESERVED");

    // A "fallback route" attempt is, from this admission gate's own
    // perspective, simply another request against the same scope - the
    // gate accepts no attribution/route parameter at all (attribution is
    // only ever recorded later, at commitQuotaUsage/settlement time), so a
    // cheaper/faster fallback cannot even present a different identity to
    // this check in a way that could matter.
    const fallbackIdentity = createQuotaReservationIdentity({ scope, jobId: "job-fallback1", runId: "run-fallback", attemptRef: "1" });
    const fallback = store.admit({
      envelope,
      identity: fallbackIdentity,
      idempotencyKey: "fallback1-fallback",
      requestedAmount: { presence: "UNKNOWN" },
      occurredAt: "2026-10-09T00:01:00.000Z",
    });
    assert.equal(fallback.status, "REJECTED", "switching to a fallback route must never bypass the same scope's exhausted ceiling");
  });
});

test("ATTR1 (provider/model attribution, cited/re-demonstrated): commitQuotaUsage preserves real attribution exactly, and never fabricates it when absent", () => {
  const scope = createQuotaAdmissionScope({ tenantScope, customerId: "cust-attr1", projectId: "proj-attr1", planId: "plan-1", planVersion: 1 });
  const envelope = createQuotaEnvelope({ scope, envelopeRef: "env-attr1", sourceFingerprint: "fp-1", unitLimit: 5 });

  const identityWithAttribution = createQuotaReservationIdentity({ scope, jobId: "job-attr1", runId: "run-with", attemptRef: "1" });
  const keyWithAttribution = deriveQuotaReservationIdempotencyKey(identityWithAttribution);
  const afterAdmitWith = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER,
    envelope,
    identity: identityWithAttribution,
    idempotencyKey: keyWithAttribution,
    requestedAmount: { presence: "UNKNOWN" },
    occurredAt: "2026-10-09T00:00:00.000Z",
  });
  const committedWith = commitQuotaUsage({
    ledger: afterAdmitWith.ledger,
    identity: identityWithAttribution,
    idempotencyKey: keyWithAttribution,
    actualAmount: { presence: "UNKNOWN" },
    occurredAt: "2026-10-09T00:01:00.000Z",
    attribution: { workerRef: "worker-a", providerRef: "provider-a", modelRef: "model-a", routeRef: "route-a" },
  });
  assert.ok(committedWith.outcome.status === "COMMITTED");
  assert.deepEqual(committedWith.outcome.event.attribution, {
    workerRef: "worker-a",
    providerRef: "provider-a",
    modelRef: "model-a",
    routeRef: "route-a",
  });

  const identityNoAttribution = createQuotaReservationIdentity({ scope, jobId: "job-attr1", runId: "run-without", attemptRef: "1" });
  const keyNoAttribution = deriveQuotaReservationIdempotencyKey(identityNoAttribution);
  const afterAdmitWithout = admitQuotaReservation({
    ledger: committedWith.ledger,
    envelope,
    identity: identityNoAttribution,
    idempotencyKey: keyNoAttribution,
    requestedAmount: { presence: "UNKNOWN" },
    occurredAt: "2026-10-09T00:02:00.000Z",
  });
  const committedWithout = commitQuotaUsage({
    ledger: afterAdmitWithout.ledger,
    identity: identityNoAttribution,
    idempotencyKey: keyNoAttribution,
    actualAmount: { presence: "UNKNOWN" },
    occurredAt: "2026-10-09T00:03:00.000Z",
  });
  assert.ok(committedWithout.outcome.status === "COMMITTED");
  assert.deepEqual(committedWithout.outcome.event.attribution, {}, "absent attribution must stay explicitly empty, never fabricated");
});

test("CROSSORG1 (cross-org quota theft, cited/re-demonstrated): two tenants sharing an identical bare customerId/projectId/planId, admitted against the SAME shared store instance, never cross-consume each other's ceiling", async () => {
  await withFreshStoreDir(async (dir) => {
    const tenantA = createTenantScope("tenant-os-v1-08-crossorg-a");
    const tenantB = createTenantScope("tenant-os-v1-08-crossorg-b");
    const bareIdentifiers = { customerId: "cust-shared-bare-id", projectId: "proj-shared-bare-id", planId: "plan-shared-bare-id", planVersion: 1 };
    const scopeA = createQuotaAdmissionScope({ tenantScope: tenantA, ...bareIdentifiers });
    const scopeB = createQuotaAdmissionScope({ tenantScope: tenantB, ...bareIdentifiers });
    const envelopeA = createQuotaEnvelope({ scope: scopeA, envelopeRef: "env-crossorg-a", sourceFingerprint: "fp-1", unitLimit: 1 });
    const envelopeB = createQuotaEnvelope({ scope: scopeB, envelopeRef: "env-crossorg-b", sourceFingerprint: "fp-1", unitLimit: 1 });

    const store = new FileDurableQuotaReservationStore(dir);
    const identityA = createQuotaReservationIdentity({ scope: scopeA, jobId: "job-shared-bare-id", runId: "run-shared-bare-id", attemptRef: "1" });
    const identityB = createQuotaReservationIdentity({ scope: scopeB, jobId: "job-shared-bare-id", runId: "run-shared-bare-id", attemptRef: "1" });

    const outcomeA = store.admit({ envelope: envelopeA, identity: identityA, idempotencyKey: "crossorg-shared-key", requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-10-09T00:00:00.000Z" });
    const outcomeB = store.admit({ envelope: envelopeB, identity: identityB, idempotencyKey: "crossorg-shared-key", requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-10-09T00:00:00.000Z" });

    // Each tenant's own 1-slot ceiling is independently satisfied - B's
    // admission is never rejected on account of A's identical bare-ID
    // reservation already having consumed "the" (shared-looking) slot.
    assert.equal(outcomeA.status, "RESERVED");
    assert.equal(outcomeB.status, "RESERVED");

    const readModelA = store.getReadModel(envelopeA);
    const readModelB = store.getReadModel(envelopeB);
    assert.equal(readModelA.unitReserved, 1);
    assert.equal(readModelB.unitReserved, 1);
  });
});

test("ENVELOPE1 (AI execution envelope / fallback cannot override policy, cited/re-demonstrated): a fallback candidate missing a required tool/policy/authority constraint is never selected over policy, regardless of cost", () => {
  const cheapButIneligible: AdmittedWorker = {
    workerId: "worker-cheap-ineligible",
    declaredCapabilityRefs: ["cap-1"],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 0,
    evaluationEvidenceRef: "eval-cheap",
  };
  const pricierEligible: AdmittedWorker = {
    workerId: "worker-pricier-eligible",
    declaredCapabilityRefs: ["cap-1"],
    declaredToolRefs: ["tool-required"],
    declaredPolicyConstraintRefs: ["policy-required"],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 100,
    evaluationEvidenceRef: "eval-pricier",
  };
  const request: WorkerRoutingRequest = {
    requiredCapabilityRef: "cap-1",
    riskLevel: "STANDARD",
    requiredToolRefs: ["tool-required"],
    requiredPolicyConstraintRefs: ["policy-required"],
    requiredAuthorityLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [cheapButIneligible, pricierEligible],
  };
  const decision = resolveWorkerRoute(request);
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "worker-pricier-eligible", "cost ordering (cheapButIneligible listed first, costWeight 0) must never override the required tool/policy constraints");
});
