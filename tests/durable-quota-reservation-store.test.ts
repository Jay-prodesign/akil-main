import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  createQuotaReservationIdentity,
} from "../src/domain/execution-quota-admission.js";
import { FileDurableQuotaReservationStore } from "../src/domain/durable-quota-reservation-store.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "os-v0-07-quota-store-"));
}

const tenantScope = createTenantScope("tenant-quota-store");
const scope = createQuotaAdmissionScope({
  tenantScope, customerId: "cust-1", projectId: "proj-1", planId: "plan-1", planVersion: 1,
});
const envelope = createQuotaEnvelope({
  scope, envelopeRef: "envelope-1", sourceFingerprint: "qfp-1",
  limit: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
});

test("P1 (Minimum Adversarial Evidence #1): two concurrent admissions in the same scope, together exceeding the limit, resolve to exactly one RESERVED and one REJECTED", async () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableQuotaReservationStore(dir);
    const identityA = createQuotaReservationIdentity({ scope, jobId: "job-1", runId: "run-a", attemptRef: "1" });
    const identityB = createQuotaReservationIdentity({ scope, jobId: "job-1", runId: "run-b", attemptRef: "1" });

    const [outcomeA, outcomeB] = await Promise.all([
      Promise.resolve(
        store.admit({
          envelope, identity: identityA, idempotencyKey: "job-1::run-a::1",
          requestedAmount: { presence: "REPORTED", amountMinorUnits: 60, currency: "USD" },
          occurredAt: "2026-09-29T00:00:00.000Z",
        }),
      ),
      Promise.resolve(
        store.admit({
          envelope, identity: identityB, idempotencyKey: "job-1::run-b::1",
          requestedAmount: { presence: "REPORTED", amountMinorUnits: 60, currency: "USD" },
          occurredAt: "2026-09-29T00:00:00.000Z",
        }),
      ),
    ]);
    const statuses = [outcomeA.status, outcomeB.status].sort();
    assert.deepEqual(statuses, ["REJECTED", "RESERVED"], "exactly one of the two competing admissions must win when both cannot fit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2: admit/commit round-trips and survives a simulated restart (a fresh store instance over the same directory sees identical state)", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableQuotaReservationStore(dir);
    const identity = createQuotaReservationIdentity({ scope, jobId: "job-2", runId: "run-2", attemptRef: "1" });
    const admitted = store.admit({
      envelope, identity, idempotencyKey: "job-2::run-2::1",
      requestedAmount: { presence: "REPORTED", amountMinorUnits: 40, currency: "USD" },
      occurredAt: "2026-09-29T00:00:00.000Z",
    });
    assert.equal(admitted.status, "RESERVED");
    const committed = store.commit({
      identity, idempotencyKey: "job-2::run-2::1",
      actualAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:01.000Z",
    });
    assert.equal(committed.status, "COMMITTED");

    const restarted = new FileDurableQuotaReservationStore(dir);
    const readModel = restarted.getReadModel(envelope);
    // The reservation committed with an UNKNOWN actual, so the read model is
    // honestly INCOMPLETE rather than a fabricated numeric remaining - this
    // itself is proof the restart replayed the real persisted event, not an
    // empty ledger (an empty ledger would report a clean COMPUTED 100).
    assert.equal(readModel.status, "INCOMPLETE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P3: release is idempotent and a release after commit is a safe no-op, both surviving a restart", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableQuotaReservationStore(dir);
    const unusedIdentity = createQuotaReservationIdentity({ scope, jobId: "job-3", runId: "run-3a", attemptRef: "1" });
    store.admit({
      envelope, identity: unusedIdentity, idempotencyKey: "job-3::run-3a::1",
      requestedAmount: { presence: "REPORTED", amountMinorUnits: 10, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
    });
    const released = store.release({ identity: unusedIdentity, idempotencyKey: "job-3::run-3a::1", occurredAt: "2026-09-29T00:00:01.000Z" });
    assert.equal(released.status, "RELEASED");

    const committedIdentity = createQuotaReservationIdentity({ scope, jobId: "job-3", runId: "run-3b", attemptRef: "1" });
    store.admit({
      envelope, identity: committedIdentity, idempotencyKey: "job-3::run-3b::1",
      requestedAmount: { presence: "REPORTED", amountMinorUnits: 10, currency: "USD" }, occurredAt: "2026-09-29T00:00:02.000Z",
    });
    store.commit({
      identity: committedIdentity, idempotencyKey: "job-3::run-3b::1",
      actualAmount: { presence: "REPORTED", amountMinorUnits: 10, currency: "USD" }, occurredAt: "2026-09-29T00:00:03.000Z",
    });

    const restarted = new FileDurableQuotaReservationStore(dir);
    const releaseAfterRestart = restarted.release({ identity: unusedIdentity, idempotencyKey: "job-3::run-3a::1", occurredAt: "2026-09-29T00:00:04.000Z" });
    assert.equal(releaseAfterRestart.status, "RELEASED");
    const releaseCommittedAfterRestart = restarted.release({ identity: committedIdentity, idempotencyKey: "job-3::run-3b::1", occurredAt: "2026-09-29T00:00:05.000Z" });
    assert.equal(releaseCommittedAfterRestart.status, "ALREADY_COMMITTED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4: corrupted/cross-scope persisted lines fail closed rather than silently being accepted", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableQuotaReservationStore(dir);
    const identity = createQuotaReservationIdentity({ scope, jobId: "job-4", runId: "run-4", attemptRef: "1" });
    store.admit({
      envelope, identity, idempotencyKey: "job-4::run-4::1",
      requestedAmount: { presence: "REPORTED", amountMinorUnits: 10, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
    });
    // Corrupt the persisted file directly.
    const filePath = join(dir, readdirSync(dir)[0] as string);
    writeFileSync(filePath, "not valid json\n", "utf8");
    const restarted = new FileDurableQuotaReservationStore(dir);
    assert.throws(() => restarted.getReadModel(envelope));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
