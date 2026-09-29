import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  createQuotaReservationIdentity,
  assertCurrentQuotaEnvelope,
  admitQuotaReservation,
  commitQuotaUsage,
  releaseQuotaReservation,
  projectQuotaScopeUsage,
  projectQuotaReadModel,
  quotaScopeKey,
  deriveQuotaReservationEventId,
  validatePersistedQuotaReservationEvent,
  EMPTY_QUOTA_LEDGER,
  StaleQuotaEnvelopeError,
  CrossScopeQuotaSubstitutionError,
  QuotaReservationConflictError,
  InvalidQuotaAdmissionError,
  type QuotaEnvelope,
} from "../src/domain/execution-quota-admission.js";
import { resolveWorkerRoute, type AdmittedWorker } from "../src/domain/worker-routing-policy.js";

const tenantScope = createTenantScope("tenant-quota");

function scope(overrides: Partial<{ customerId: string; projectId: string; planId: string; planVersion: number }> = {}) {
  return createQuotaAdmissionScope({
    tenantScope,
    customerId: overrides.customerId ?? "cust-1",
    projectId: overrides.projectId ?? "proj-1",
    planId: overrides.planId ?? "plan-1",
    planVersion: overrides.planVersion ?? 1,
  });
}

function envelope(limitMinorUnits: number, overrides: Partial<{ envelopeRef: string; sourceFingerprint: string; scopeOverrides: Parameters<typeof scope>[0] }> = {}): QuotaEnvelope {
  return createQuotaEnvelope({
    scope: scope(overrides.scopeOverrides),
    envelopeRef: overrides.envelopeRef ?? "envelope-1",
    sourceFingerprint: overrides.sourceFingerprint ?? "qfp-1",
    limit: { presence: "REPORTED", amountMinorUnits: limitMinorUnits, currency: "USD" },
  });
}

function identity(overrides: Partial<{ scope: ReturnType<typeof scope>; jobId: string; runId: string; attemptRef: string }> = {}) {
  return createQuotaReservationIdentity({
    scope: overrides.scope ?? scope(),
    jobId: overrides.jobId ?? "job-1",
    runId: overrides.runId ?? "run-1",
    attemptRef: overrides.attemptRef ?? "1",
  });
}

test("Q1 (Minimum Adversarial Evidence #7): a stale quota envelope cannot authorize - assertCurrentQuotaEnvelope throws before any reservation logic runs", () => {
  const env = envelope(1000, { sourceFingerprint: "qfp-old" });
  assert.throws(() => assertCurrentQuotaEnvelope(env, "qfp-new"), StaleQuotaEnvelopeError);
  assertCurrentQuotaEnvelope(env, "qfp-old"); // does not throw when current
});

test("Q2: an envelope cannot be constructed with an UNKNOWN limit - never invent a numeric ceiling", () => {
  assert.throws(
    () =>
      createQuotaEnvelope({
        scope: scope(),
        envelopeRef: "e",
        sourceFingerprint: "fp",
        limit: { presence: "UNKNOWN" },
      }),
    InvalidQuotaAdmissionError,
  );
});

test("Q3 (#1 basis, single-writer serialization): two admissions in the same scope, together exceeding the limit, result in exactly one RESERVED and one REJECTED", () => {
  const env = envelope(100);
  const first = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER,
    envelope: env,
    identity: identity({ runId: "run-a" }),
    idempotencyKey: "job-1::run-a::1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 60, currency: "USD" },
    occurredAt: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(first.outcome.status, "RESERVED");

  const second = admitQuotaReservation({
    ledger: first.ledger,
    envelope: env,
    identity: identity({ runId: "run-b" }),
    idempotencyKey: "job-1::run-b::1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 60, currency: "USD" },
    occurredAt: "2026-09-29T00:00:01.000Z",
  });
  assert.equal(second.outcome.status, "REJECTED");
  assert.match(second.outcome.event.reason ?? "", /insufficient allowance/);

  // A third request that DOES fit in the remaining 40 succeeds.
  const third = admitQuotaReservation({
    ledger: second.ledger,
    envelope: env,
    identity: identity({ runId: "run-c" }),
    idempotencyKey: "job-1::run-c::1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 40, currency: "USD" },
    occurredAt: "2026-09-29T00:00:02.000Z",
  });
  assert.equal(third.outcome.status, "RESERVED");
});

test("Q4 (#2): an identical replay of an already-decided idempotencyKey returns the same decision without consuming a second unit of allowance", () => {
  const env = envelope(100);
  const id = identity();
  const requestedAmount = { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" } as const;
  const first = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: id, idempotencyKey: "key-1", requestedAmount, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(first.outcome.status, "RESERVED");

  const replay = admitQuotaReservation({
    ledger: first.ledger, envelope: env, identity: id, idempotencyKey: "key-1", requestedAmount, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  assert.equal(replay.outcome.status, "RESERVED");
  assert.deepEqual(replay.ledger, first.ledger, "a replay must not append a second event");

  // A second, DIFFERENT idempotencyKey requesting the same amount is now
  // correctly rejected - proving the replay above did not silently free or
  // re-consume allowance.
  const second = admitQuotaReservation({
    ledger: replay.ledger,
    envelope: env,
    identity: identity({ runId: "run-2" }),
    idempotencyKey: "key-2",
    requestedAmount,
    occurredAt: "2026-09-29T00:00:02.000Z",
  });
  assert.equal(second.outcome.status, "REJECTED");
});

test("Q5 (#3): a duplicate idempotencyKey with materially different requested content fails closed rather than silently overwriting the original", () => {
  const env = envelope(1000);
  const id = identity();
  const first = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: id, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  assert.throws(
    () =>
      admitQuotaReservation({
        ledger: first.ledger, envelope: env, identity: id, idempotencyKey: "key-1",
        requestedAmount: { presence: "REPORTED", amountMinorUnits: 999, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
      }),
    QuotaReservationConflictError,
  );
});

test("Q6 (#4, retry double-reserve): the SAME attempt's idempotencyKey replays safely (no double reserve), but a NEW attempt for the same run correctly reserves separately", () => {
  const env = envelope(150);
  const runId = "run-retry";
  const attempt1 = identity({ runId, attemptRef: "1" });
  const attempt2 = identity({ runId, attemptRef: "2" });
  const requestedAmount = { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" } as const;

  const first = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: attempt1, idempotencyKey: "job-1::run-retry::1", requestedAmount, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  assert.equal(first.outcome.status, "RESERVED");

  // Retrying the identical attempt-1 request (e.g. a caller-side retry
  // before durable confirmation) is a safe replay, not a double reserve.
  const retrySameAttempt = admitQuotaReservation({
    ledger: first.ledger, envelope: env, identity: attempt1, idempotencyKey: "job-1::run-retry::1", requestedAmount, occurredAt: "2026-09-29T00:00:02.000Z",
  });
  assert.equal(retrySameAttempt.outcome.status, "RESERVED");
  assert.deepEqual(retrySameAttempt.ledger, first.ledger);

  // A genuinely NEW attempt (attempt 2) re-admits under current allowance -
  // 100 (still outstanding from attempt 1) + 100 > 150, so it is REJECTED,
  // proving attempt 1's reservation was not silently discounted.
  const secondAttempt = admitQuotaReservation({
    ledger: retrySameAttempt.ledger, envelope: env, identity: attempt2, idempotencyKey: "job-1::run-retry::2", requestedAmount, occurredAt: "2026-09-29T00:00:03.000Z",
  });
  assert.equal(secondAttempt.outcome.status, "REJECTED");
});

test("Q7 (#8): an UNKNOWN requested amount is REJECTED, never silently treated as zero-cost and admitted", () => {
  const env = envelope(1);
  const result = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: identity(), idempotencyKey: "key-1",
    requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(result.outcome.status, "REJECTED");
  assert.match(result.outcome.event.reason ?? "", /never treated as zero/);
});

test("Q8 (#9): actual usage exceeding its reservation beyond the allowed overage is COMMITTED as RECONCILIATION_REQUIRED, never silently erased", () => {
  const env = envelope(1000);
  const id = identity();
  const admitted = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: id, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  const committed = commitQuotaUsage({
    ledger: admitted.ledger, identity: id, idempotencyKey: "key-1",
    actualAmount: { presence: "REPORTED", amountMinorUnits: 150, currency: "USD" }, occurredAt: "2026-09-29T00:00:02.000Z",
  });
  assert.equal(committed.outcome.status, "RECONCILIATION_REQUIRED");
  assert.equal(committed.outcome.event.amount?.amountMinorUnits, 150, "the real overage amount must still be recorded, not erased");
  assert.match(committed.outcome.event.reason ?? "", /exceeded its reservation/);

  // Within the allowed overage, it commits cleanly.
  const withinOverage = commitQuotaUsage({
    ledger: admitted.ledger, identity: id, idempotencyKey: "key-1",
    actualAmount: { presence: "REPORTED", amountMinorUnits: 110, currency: "USD" }, occurredAt: "2026-09-29T00:00:02.000Z",
    allowedOverage: { presence: "REPORTED", amountMinorUnits: 20, currency: "USD" },
  });
  assert.equal(withinOverage.outcome.status, "COMMITTED");
});

test("Q9 (#10): a failed/unknown provider response still records attributable usage once, as UNKNOWN, rather than discarding it", () => {
  const env = envelope(1000);
  const id = identity();
  const admitted = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: id, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  const committed = commitQuotaUsage({
    ledger: admitted.ledger, identity: id, idempotencyKey: "key-1",
    actualAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:02.000Z",
  });
  assert.equal(committed.outcome.status, "COMMITTED");
  assert.equal(committed.outcome.event.amount?.presence, "UNKNOWN");
});

test("Q10 (#11): cross-scope substitution is rejected - a reservation identity whose scope does not match the envelope's scope can never be admitted", () => {
  const env = envelope(1000, { scopeOverrides: { customerId: "cust-A" } });
  const foreignIdentity = identity({ scope: scope({ customerId: "cust-B" }) });
  assert.throws(
    () =>
      admitQuotaReservation({
        ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: foreignIdentity, idempotencyKey: "key-1",
        requestedAmount: { presence: "REPORTED", amountMinorUnits: 1, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
      }),
    CrossScopeQuotaSubstitutionError,
  );
});

test("Q11 (#11/#12): usage in one scope never aggregates into a different customer/project/planVersion scope - each is isolated", () => {
  const envA = envelope(100, { scopeOverrides: { customerId: "cust-A" } });
  const envB = envelope(100, { scopeOverrides: { customerId: "cust-B" } });
  const idA = identity({ scope: scope({ customerId: "cust-A" }) });
  const idB = identity({ scope: scope({ customerId: "cust-B" }) });

  const admittedA = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: envA, identity: idA, idempotencyKey: "key-A",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  assert.equal(admittedA.outcome.status, "RESERVED");

  // cust-B's envelope/scope is completely unaffected by cust-A's full reservation.
  const admittedB = admitQuotaReservation({
    ledger: admittedA.ledger, envelope: envB, identity: idB, idempotencyKey: "key-B",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:02.000Z",
  });
  assert.equal(admittedB.outcome.status, "RESERVED");

  const usageA = projectQuotaScopeUsage(admittedB.ledger, envA.scope);
  const usageB = projectQuotaScopeUsage(admittedB.ledger, envB.scope);
  assert.equal(usageA.reservedTotal, 100);
  assert.equal(usageB.reservedTotal, 100);
});

test("Q12 (#12): two different planVersions of the same plan are isolated budget scopes, not merged", () => {
  const envV1 = envelope(50, { scopeOverrides: { planVersion: 1 } });
  const envV2 = envelope(50, { scopeOverrides: { planVersion: 2 } });
  const idV1 = identity({ scope: scope({ planVersion: 1 }) });
  const idV2 = identity({ scope: scope({ planVersion: 2 }) });

  const admittedV1 = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: envV1, identity: idV1, idempotencyKey: "key-v1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  const admittedV2 = admitQuotaReservation({
    ledger: admittedV1.ledger, envelope: envV2, identity: idV2, idempotencyKey: "key-v2",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:02.000Z",
  });
  assert.equal(admittedV1.outcome.status, "RESERVED");
  assert.equal(admittedV2.outcome.status, "RESERVED", "planVersion 2's full budget must be untouched by planVersion 1's own full reservation");
});

test("Q13 (#13): a duplicate usage report (same idempotencyKey, identical content) is a safe no-op; a conflicting one fails closed", () => {
  const env = envelope(1000);
  const id = identity();
  const admitted = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: id, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  const actualAmount = { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" } as const;
  const firstCommit = commitQuotaUsage({ ledger: admitted.ledger, identity: id, idempotencyKey: "key-1", actualAmount, occurredAt: "2026-09-29T00:00:02.000Z" });
  const duplicateCommit = commitQuotaUsage({ ledger: firstCommit.ledger, identity: id, idempotencyKey: "key-1", actualAmount, occurredAt: "2026-09-29T00:00:03.000Z" });
  assert.deepEqual(duplicateCommit.ledger, firstCommit.ledger, "an identical duplicate callback must not append a second COMMITTED event");

  assert.throws(
    () =>
      commitQuotaUsage({
        ledger: firstCommit.ledger, identity: id, idempotencyKey: "key-1",
        actualAmount: { presence: "REPORTED", amountMinorUnits: 999, currency: "USD" }, occurredAt: "2026-09-29T00:00:04.000Z",
      }),
    QuotaReservationConflictError,
  );
});

test("Q14 (#14): releasing an already-COMMITTED reservation is a safe, explicit no-op - it never discards the committed usage record", () => {
  const env = envelope(1000);
  const id = identity();
  const admitted = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: id, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  const committed = commitQuotaUsage({
    ledger: admitted.ledger, identity: id, idempotencyKey: "key-1",
    actualAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:02.000Z",
  });
  const released = releaseQuotaReservation({ ledger: committed.ledger, identity: id, idempotencyKey: "key-1", occurredAt: "2026-09-29T00:00:03.000Z" });
  assert.equal(released.outcome.status, "ALREADY_COMMITTED");
  assert.deepEqual(released.ledger, committed.ledger, "release after commit must not mutate the ledger");

  // A genuine RESERVED-but-unused reservation DOES release cleanly, and a
  // repeat release of it is an idempotent no-op.
  const otherId = identity({ runId: "run-unused" });
  const admittedOther = admitQuotaReservation({
    ledger: committed.ledger, envelope: env, identity: otherId, idempotencyKey: "key-2",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:04.000Z",
  });
  const firstRelease = releaseQuotaReservation({ ledger: admittedOther.ledger, identity: otherId, idempotencyKey: "key-2", occurredAt: "2026-09-29T00:00:05.000Z" });
  assert.equal(firstRelease.outcome.status, "RELEASED");
  const secondRelease = releaseQuotaReservation({ ledger: firstRelease.ledger, identity: otherId, idempotencyKey: "key-2", occurredAt: "2026-09-29T00:00:06.000Z" });
  assert.equal(secondRelease.outcome.status, "RELEASED");
  assert.deepEqual(secondRelease.ledger, firstRelease.ledger);
});

test("Q15 (#16): the read model distinguishes UNKNOWN/INCOMPLETE committed usage from a numeric zero - remaining is never fabricated", () => {
  const env = envelope(1000);
  const id = identity();
  const admitted = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: id, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  const cleanReadModel = projectQuotaReadModel(admitted.ledger, env);
  assert.equal(cleanReadModel.status, "COMPUTED");
  if (cleanReadModel.status === "COMPUTED") {
    assert.equal(cleanReadModel.remaining, 900);
  }

  const committedUnknown = commitQuotaUsage({
    ledger: admitted.ledger, identity: id, idempotencyKey: "key-1", actualAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:02.000Z",
  });
  const incompleteReadModel = projectQuotaReadModel(committedUnknown.ledger, env);
  assert.equal(incompleteReadModel.status, "INCOMPLETE");
  assert.ok(!("remaining" in incompleteReadModel), "an INCOMPLETE read model must never carry a fabricated numeric remaining");
});

test("Q16 (#17): commit never fabricates worker/provider/model/route attribution - absence stays explicit, and real attribution is preserved exactly", () => {
  const env = envelope(1000);
  const id = identity();
  const admitted = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: id, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  const withoutAttribution = commitQuotaUsage({
    ledger: admitted.ledger, identity: id, idempotencyKey: "key-1",
    actualAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:02.000Z",
  });
  assert.deepEqual(withoutAttribution.outcome.event.attribution, {});

  const idWithAttribution = identity({ runId: "run-2" });
  const admitted2 = admitQuotaReservation({
    ledger: withoutAttribution.ledger, envelope: env, identity: idWithAttribution, idempotencyKey: "key-2",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:03.000Z",
  });
  const withAttribution = commitQuotaUsage({
    ledger: admitted2.ledger, identity: idWithAttribution, idempotencyKey: "key-2",
    actualAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:04.000Z",
    attribution: { workerRef: "worker-1", providerRef: "provider-1", modelRef: "model-1", routeRef: "route-1" },
  });
  assert.deepEqual(withAttribution.outcome.event.attribution, {
    workerRef: "worker-1", providerRef: "provider-1", modelRef: "model-1", routeRef: "route-1",
  });
});

test("Q17 (#6, composition witness): a cheaper but ineligible worker is never selected over an eligible one - budget/quota admission has no visibility into or influence over worker eligibility", () => {
  const cheapIneligible: AdmittedWorker = {
    workerId: "cheap-worker", declaredCapabilityRefs: ["cap:build"], declaredToolRefs: [], declaredPolicyConstraintRefs: [],
    trustStatus: "UNTRUSTED", availability: "AVAILABLE", maxRiskLevel: "STANDARD", authorityLevel: "STANDARD",
    costWeight: 1, evaluationEvidenceRef: "evidence-1",
  };
  const expensiveEligible: AdmittedWorker = {
    workerId: "expensive-worker", declaredCapabilityRefs: ["cap:build"], declaredToolRefs: [], declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED", availability: "AVAILABLE", maxRiskLevel: "STANDARD", authorityLevel: "STANDARD",
    costWeight: 100, evaluationEvidenceRef: "evidence-2",
  };
  const decision = resolveWorkerRoute({
    requiredCapabilityRef: "cap:build", riskLevel: "STANDARD", requiredToolRefs: [], requiredPolicyConstraintRefs: [],
    requiredAuthorityLevel: "STANDARD", requiresIndependentReview: false,
    executorCandidates: [cheapIneligible, expensiveEligible],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "expensive-worker", "the cheaper-but-ineligible worker must never be selected regardless of cost");
});

test("Q18: quotaScopeKey/deriveQuotaReservationEventId are injective enough to keep distinct scopes/reservations from colliding in normal use, and the persisted-record validator round-trips a real event and rejects a forged eventId", () => {
  const env = envelope(1000);
  const id = identity();
  const admitted = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: id, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  const reservedEvent = admitted.outcome.event;
  const roundTripped = validatePersistedQuotaReservationEvent(JSON.parse(JSON.stringify(reservedEvent)), id.scope);
  assert.deepEqual(roundTripped, reservedEvent);

  const forged = { ...reservedEvent, eventId: "forged-event-id" };
  assert.throws(() => validatePersistedQuotaReservationEvent(forged, id.scope), InvalidQuotaAdmissionError);

  const expectedId = deriveQuotaReservationEventId(id, "key-1", "RESERVED");
  assert.equal(reservedEvent.eventId, expectedId);
});

test("Q19: an envelope's requestedAmount currency mismatch fails closed structurally, before any allowance math runs", () => {
  const env = envelope(1000);
  assert.throws(
    () =>
      admitQuotaReservation({
        ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: identity(), idempotencyKey: "key-1",
        requestedAmount: { presence: "REPORTED", amountMinorUnits: 1, currency: "EUR" }, occurredAt: "2026-09-29T00:00:01.000Z",
      }),
    InvalidQuotaAdmissionError,
  );
});

test("Q20: committing usage against a reservation that was REJECTED, or that never existed, fails closed", () => {
  const env = envelope(1);
  const id = identity();
  const rejected = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: id, idempotencyKey: "key-1",
    requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  assert.equal(rejected.outcome.status, "REJECTED");
  assert.throws(
    () => commitQuotaUsage({ ledger: rejected.ledger, identity: id, idempotencyKey: "key-1", actualAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:02.000Z" }),
    InvalidQuotaAdmissionError,
  );
  assert.throws(
    () => commitQuotaUsage({ ledger: EMPTY_QUOTA_LEDGER, identity: id, idempotencyKey: "never-existed", actualAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:03.000Z" }),
    InvalidQuotaAdmissionError,
  );
});

test("Q21 (Rev176, rejected-then-later-admissible recovery): a REJECTED decision is re-evaluated fresh on a later identical request and upgrades to RESERVED once allowance frees up - a RESERVED decision, by contrast, is permanent and never re-evaluated", () => {
  const env = envelope(100);
  const blockerId = identity({ runId: "run-blocker" });
  const blocked = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: env, identity: blockerId, idempotencyKey: "key-blocker",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(blocked.outcome.status, "RESERVED");

  const laterId = identity({ runId: "run-later" });
  const requestedAmount = { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" } as const;
  const firstAttempt = admitQuotaReservation({
    ledger: blocked.ledger, envelope: env, identity: laterId, idempotencyKey: "key-later", requestedAmount, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  assert.equal(firstAttempt.outcome.status, "REJECTED");

  // Re-evaluating the IDENTICAL still-rejected request appends no duplicate
  // event and returns the same cached rejection - not a growing ledger of
  // identical REJECTED entries.
  const stillRejected = admitQuotaReservation({
    ledger: firstAttempt.ledger, envelope: env, identity: laterId, idempotencyKey: "key-later", requestedAmount, occurredAt: "2026-09-29T00:00:02.000Z",
  });
  assert.equal(stillRejected.outcome.status, "REJECTED");
  assert.deepEqual(stillRejected.ledger, firstAttempt.ledger);

  // Free up the blocking reservation.
  const released = releaseQuotaReservation({
    ledger: stillRejected.ledger, identity: blockerId, idempotencyKey: "key-blocker", occurredAt: "2026-09-29T00:00:03.000Z",
  });
  assert.equal(released.outcome.status, "RELEASED");

  // The SAME idempotencyKey, same identical request, now succeeds.
  const nowAdmitted = admitQuotaReservation({
    ledger: released.ledger, envelope: env, identity: laterId, idempotencyKey: "key-later", requestedAmount, occurredAt: "2026-09-29T00:00:04.000Z",
  });
  assert.equal(nowAdmitted.outcome.status, "RESERVED", "a REJECTED decision must be re-evaluated once circumstances change, never permanently stuck");

  // Once RESERVED, it is permanent - a further identical call never
  // re-evaluates it again, even if the scope later becomes fully consumed
  // by something else.
  const replayed = admitQuotaReservation({
    ledger: nowAdmitted.ledger, envelope: env, identity: laterId, idempotencyKey: "key-later", requestedAmount, occurredAt: "2026-09-29T00:00:05.000Z",
  });
  assert.equal(replayed.outcome.status, "RESERVED");
  assert.deepEqual(replayed.ledger, nowAdmitted.ledger);
});

test("Q22 (Rev177 F1, collision-safe scope key): two distinct scopes whose caller-controlled identifiers happen to contain the `::` delimiter never collide into the same quotaScopeKey, and their allowance accounting stays fully isolated", () => {
  // Under the old `::`-join encoding, these two distinct (customerId, projectId)
  // pairs produced the IDENTICAL scope key: "a::b" joined with "c" gives
  // "a::b::c", and "a" joined with "b::c" ALSO gives "a::b::c".
  const scopeA = scope({ customerId: "a::b", projectId: "c" });
  const scopeB = scope({ customerId: "a", projectId: "b::c" });
  assert.notEqual(quotaScopeKey(scopeA), quotaScopeKey(scopeB), "distinct scopes must never derive the same scope key merely because an identifier contains the delimiter");

  const envA = envelope(100, { scopeOverrides: { customerId: "a::b", projectId: "c" } });
  const envB = envelope(100, { scopeOverrides: { customerId: "a", projectId: "b::c" } });
  const idA = identity({ scope: scopeA });
  const idB = identity({ scope: scopeB });

  const admittedA = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: envA, identity: idA, idempotencyKey: "key-a",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(admittedA.outcome.status, "RESERVED");

  // scopeB's full, independent allowance must be completely untouched by
  // scopeA's own full reservation - if the two scope keys collided, this
  // would incorrectly see scopeA's usage and reject.
  const admittedB = admitQuotaReservation({
    ledger: admittedA.ledger, envelope: envB, identity: idB, idempotencyKey: "key-b",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  assert.equal(admittedB.outcome.status, "RESERVED", "scopeB's allowance must be fully isolated from scopeA's, even though their identifiers collide under a naive delimiter join");
});

test("Q23 (Rev177 F1, collision-safe eventId): two distinct reservation identities whose jobId/runId contain the `::` delimiter never derive the same eventId", () => {
  // Under the old `::`-join encoding, jobId="a::b"/runId="c" and jobId="a"/
  // runId="b::c" (same attemptRef) derived the IDENTICAL eventId.
  const idA = identity({ jobId: "a::b", runId: "c", attemptRef: "1" });
  const idB = identity({ jobId: "a", runId: "b::c", attemptRef: "1" });
  assert.notEqual(
    deriveQuotaReservationEventId(idA, "key-1", "RESERVED"),
    deriveQuotaReservationEventId(idB, "key-1", "RESERVED"),
    "distinct reservation identities must never derive the same eventId merely because jobId/runId contain the delimiter",
  );
});

test("Q24 (Rev177 F2, sourceFingerprint conflict): a same-idempotencyKey replay under a DIFFERENT envelope sourceFingerprint fails closed exactly like a differing envelopeRef/identity/amount already does", () => {
  const envOriginal = envelope(1000, { sourceFingerprint: "qfp-original" });
  const envChanged = envelope(1000, { sourceFingerprint: "qfp-changed" });
  const id = identity();
  const admitted = admitQuotaReservation({
    ledger: EMPTY_QUOTA_LEDGER, envelope: envOriginal, identity: id, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(admitted.outcome.status, "RESERVED");
  assert.equal(admitted.outcome.event.sourceFingerprint, "qfp-original", "the reservation must durably record the exact envelope version it was admitted against");

  assert.throws(
    () =>
      admitQuotaReservation({
        ledger: admitted.ledger, envelope: envChanged, identity: id, idempotencyKey: "key-1",
        requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
      }),
    QuotaReservationConflictError,
    "a same-idempotencyKey replay under a different envelope version (sourceFingerprint) must fail closed, never silently authorize under the new policy without a fresh idempotencyKey",
  );
});

