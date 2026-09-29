import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  createQuotaReservationIdentity,
  QuotaReservationConflictError,
} from "../src/domain/execution-quota-admission.js";
import { PostgresQuotaReservationStore } from "../src/domain/postgres-quota-reservation-store.js";
import type { SqlClient } from "../src/ports/sql-client.js";

interface RawRow {
  tenant_id: string;
  event_id: string;
  scope_key: string;
  customer_id: string;
  project_id: string;
  plan_id: string;
  plan_version: number;
  job_id: string;
  run_id: string;
  attempt_ref: string;
  idempotency_key: string;
  envelope_ref: string;
  source_fingerprint: string;
  type: string;
  occurred_at: string;
  amount_minor_units: number | null;
  amount_presence: string | null;
  currency: string | null;
  reason: string | null;
  worker_ref: string | null;
  provider_ref: string | null;
  model_ref: string | null;
  route_ref: string | null;
}

/**
 * In-memory `SqlClient` stand-in mirroring `postgres-outcome-job-execution-
 * store.test.ts`'s own `FakeSqlClient` discipline (no live database anywhere
 * in this file): recognizes each distinct query by a distinguishing
 * substring and models its intended semantics directly in JS, rather than
 * parsing/executing SQL. The admit() query's `pg_advisory_xact_lock`-guarded
 * CTE is modeled as: an existing RESERVED row for this idempotencyKey is
 * permanent and blocks re-evaluation (replay); an existing REJECTED row
 * consumed no allowance, so it is re-evaluated fresh against current usage
 * (Rev176 "rejected-then-later-admissible recovery") - if it now fits, a
 * NEW RESERVED row is appended (a distinct event_id, since event_id depends
 * on type); if it still does not fit, the ORIGINAL cached REJECTED row is
 * replayed unchanged rather than appending a duplicate-event_id row.
 */
class FakeSqlClient implements SqlClient {
  readonly rows: RawRow[] = [];

  async query<Row>(text: string, params: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<Row> }> {
    if (text.includes("existing_terminal")) {
      // Rev177 F4: `claimFirstTerminalDisposition`'s atomic statement - a
      // different `pg_advisory_xact_lock` key (tenant+idempotencyKey, not
      // tenant+scopeKey) than `admit()`'s own, distinguished here by its
      // unique `existing_terminal` CTE name. If a terminal event
      // (COMMITTED/RELEASED/RECONCILIATION_REQUIRED) already exists for this
      // exact idempotencyKey, that row wins unconditionally and the
      // candidate is never inserted.
      const [
        tenantId, eventId, scopeKey, customerId, projectId, planId, planVersion, jobId, runId, attemptRef,
        idempotencyKey, envelopeRef, sourceFingerprint, type, occurredAt, amountMinorUnits, amountPresence, currency, reason,
        workerRef, providerRef, modelRef, routeRef,
      ] = params as [
        string, string, string, string, string, string, number, string, string, string, string, string, string, string,
        string, number | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null,
      ];
      const existingTerminal = this.rows.find(
        (r) => r.tenant_id === tenantId && r.idempotency_key === idempotencyKey && (r.type === "COMMITTED" || r.type === "RELEASED" || r.type === "RECONCILIATION_REQUIRED"),
      );
      if (existingTerminal !== undefined) {
        return { rows: [existingTerminal] as unknown as ReadonlyArray<Row> };
      }
      const row: RawRow = {
        tenant_id: tenantId, event_id: eventId, scope_key: scopeKey, customer_id: customerId, project_id: projectId,
        plan_id: planId, plan_version: planVersion, job_id: jobId, run_id: runId, attempt_ref: attemptRef,
        idempotency_key: idempotencyKey, envelope_ref: envelopeRef, source_fingerprint: sourceFingerprint, type, occurred_at: occurredAt,
        amount_minor_units: amountMinorUnits, amount_presence: amountPresence, currency, reason,
        worker_ref: workerRef, provider_ref: providerRef, model_ref: modelRef, route_ref: routeRef,
      };
      const conflict = this.rows.some((r) => r.tenant_id === tenantId && r.event_id === eventId);
      if (!conflict) {
        this.rows.push(row);
      }
      return { rows: [row] as unknown as ReadonlyArray<Row> };
    }

    if (text.includes("pg_advisory_xact_lock")) {
      // Rev177 F1: candidate RESERVED/REJECTED eventIds now arrive as plain
      // parameters (computed by the real store via the one canonical
      // `deriveQuotaReservationEventId`) - this fake never reconstructs an
      // eventId itself, exactly mirroring the real SQL's own fix.
      const [
        tenantId, scopeKey, customerId, projectId, planId, planVersion,
        jobId, runId, attemptRef, idempotencyKey, envelopeRef,
        presence, amountMinorUnits, monetaryLimitMinorUnits, occurredAt, currency,
        candidateReservedEventId, candidateRejectedEventId, sourceFingerprint, unitLimit,
      ] = params as [
        string, string, string, string, string, number, string, string, string, string, string,
        string, number, number | null, string, string | null, string, string, string, number,
      ];

      const alreadyReserved = this.rows.find((r) => r.tenant_id === tenantId && r.idempotency_key === idempotencyKey && r.type === "RESERVED");
      if (alreadyReserved !== undefined) {
        return { rows: [alreadyReserved] as unknown as ReadonlyArray<Row> };
      }
      const existingRejected = this.rows.find((r) => r.tenant_id === tenantId && r.idempotency_key === idempotencyKey && r.type === "REJECTED");

      // Rev176/Rev177 F10: this store is append-only - a COMMITTED/RELEASED
      // transition never deletes/updates its reservation's earlier RESERVED
      // row. Mirror the real SQL's `DISTINCT ON (idempotency_key) ... ORDER
      // BY id DESC`: keep only the LATEST row per idempotency_key.
      const latestByIdempotencyKey = new Map<string, RawRow>();
      for (const r of this.rows) {
        if (r.tenant_id === tenantId && r.scope_key === scopeKey) {
          latestByIdempotencyKey.set(r.idempotency_key, r);
        }
      }
      const outstandingOrSettled = Array.from(latestByIdempotencyKey.values()).filter(
        (r) => r.type === "RESERVED" || r.type === "COMMITTED" || r.type === "RECONCILIATION_REQUIRED",
      );
      const unitCount = outstandingOrSettled.length;
      const monetaryTotal = outstandingOrSettled.reduce((sum, r) => sum + (r.amount_minor_units ?? 0), 0);
      const hasUnknownCommitted = Array.from(latestByIdempotencyKey.values()).some(
        (r) => (r.type === "COMMITTED" || r.type === "RECONCILIATION_REQUIRED") && r.amount_presence === "UNKNOWN",
      );

      let decidedType: "RESERVED" | "REJECTED";
      let reason: string | null;
      if (unitCount + 1 > unitLimit) {
        decidedType = "REJECTED";
        reason = "insufficient unit allowance remaining under the current envelope's unit floor";
      } else if (monetaryLimitMinorUnits === null) {
        decidedType = "RESERVED";
        reason = null;
      } else if (hasUnknownCommitted) {
        decidedType = "REJECTED";
        reason = "an UNKNOWN committed monetary usage already exists in this scope - further monetary-ceiling-dependent admission cannot trust the remaining monetary allowance";
      } else if (presence === "UNKNOWN") {
        decidedType = "REJECTED";
        reason = "an UNKNOWN estimated cost cannot be admitted against a monetary ceiling - it is never treated as zero";
      } else if (monetaryTotal + amountMinorUnits <= monetaryLimitMinorUnits) {
        decidedType = "RESERVED";
        reason = null;
      } else {
        decidedType = "REJECTED";
        reason = "insufficient monetary allowance remaining under the current envelope's monetaryLimit";
      }

      if (decidedType === "REJECTED" && existingRejected !== undefined) {
        // Still does not fit - replay the original cached rejection rather
        // than inserting a duplicate-event_id row.
        return { rows: [existingRejected] as unknown as ReadonlyArray<Row> };
      }

      const eventId = decidedType === "RESERVED" ? candidateReservedEventId : candidateRejectedEventId;
      const row: RawRow = {
        tenant_id: tenantId, event_id: eventId, scope_key: scopeKey, customer_id: customerId, project_id: projectId,
        plan_id: planId, plan_version: planVersion, job_id: jobId, run_id: runId, attempt_ref: attemptRef,
        idempotency_key: idempotencyKey, envelope_ref: envelopeRef, source_fingerprint: sourceFingerprint, type: decidedType, occurred_at: occurredAt,
        amount_minor_units: presence === "UNKNOWN" ? null : amountMinorUnits, amount_presence: presence,
        currency: presence === "UNKNOWN" ? null : currency, reason,
        worker_ref: null, provider_ref: null, model_ref: null, route_ref: null,
      };
      this.rows.push(row);
      return { rows: [row] as unknown as ReadonlyArray<Row> };
    }

    if (text.includes("SELECT * FROM quota_reservation_events") && text.includes("job_id")) {
      const [tenantId, scopeKey, jobId, runId, attemptRef, idempotencyKey] = params as string[];
      const matches = this.rows.filter(
        (r) => r.tenant_id === tenantId && r.scope_key === scopeKey && r.job_id === jobId && r.run_id === runId && r.attempt_ref === attemptRef && r.idempotency_key === idempotencyKey,
      );
      return { rows: this.orderRows(matches, text) as unknown as ReadonlyArray<Row> };
    }

    if (text.includes("SELECT * FROM quota_reservation_events")) {
      const [tenantId, scopeKey] = params as string[];
      const matches = this.rows.filter((r) => r.tenant_id === tenantId && r.scope_key === scopeKey);
      return { rows: this.orderRows(matches, text) as unknown as ReadonlyArray<Row> };
    }

    throw new Error(`FakeSqlClient: unrecognized query: ${text}`);
  }

  /**
   * Rev177 F8 witness support: `this.rows` is append-only, so a naive filter
   * always happens to return rows in true insertion order - which would
   * never actually exercise whether the real store's `ORDER BY id ASC` fix
   * matters. Genuinely simulate Postgres's documented lack of ordering
   * guarantee for a plain `SELECT *`: return rows REVERSED by default, and
   * only in true (ascending) insertion order when the query text itself
   * carries an explicit `ORDER BY id ASC`.
   */
  private orderRows(matches: RawRow[], text: string): RawRow[] {
    return text.includes("ORDER BY id ASC") ? matches : [...matches].reverse();
  }
}

const tenantScope = createTenantScope("tenant-pg-quota");
const scope = createQuotaAdmissionScope({
  tenantScope, customerId: "cust-1", projectId: "proj-1", planId: "plan-1", planVersion: 1,
});
const envelope = createQuotaEnvelope({
  scope, envelopeRef: "envelope-1", sourceFingerprint: "qfp-1",
  unitLimit: 1_000_000,
  monetaryLimit: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
});

test("PG1 (Minimum Adversarial Evidence #1): two admissions together exceeding the limit resolve to exactly one RESERVED and one REJECTED", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identityA = createQuotaReservationIdentity({ scope, jobId: "job-1", runId: "run-a", attemptRef: "1" });
  const identityB = createQuotaReservationIdentity({ scope, jobId: "job-1", runId: "run-b", attemptRef: "1" });

  const outcomeA = await store.admit({
    envelope, identity: identityA, idempotencyKey: "job-1::run-a::1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 60, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  const outcomeB = await store.admit({
    envelope, identity: identityB, idempotencyKey: "job-1::run-b::1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 60, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  assert.equal(outcomeA.status, "RESERVED");
  assert.equal(outcomeB.status, "REJECTED");
});

test("PG2: an identical replay of an admission returns the same decision without a second row", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identity = createQuotaReservationIdentity({ scope, jobId: "job-2", runId: "run-2", attemptRef: "1" });
  const requestedAmount = { presence: "REPORTED" as const, amountMinorUnits: 50, currency: "USD" };
  const first = await store.admit({ envelope, identity, idempotencyKey: "key-1", requestedAmount, occurredAt: "2026-09-29T00:00:00.000Z" });
  const replay = await store.admit({ envelope, identity, idempotencyKey: "key-1", requestedAmount, occurredAt: "2026-09-29T00:00:01.000Z" });
  assert.equal(first.status, "RESERVED");
  assert.equal(replay.status, "RESERVED");
  assert.equal(client.rows.filter((r) => r.type === "RESERVED" || r.type === "REJECTED").length, 1);
});

test("PG3: admit -> commit round-trip, and a duplicate identical commit is a safe no-op", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identity = createQuotaReservationIdentity({ scope, jobId: "job-3", runId: "run-3", attemptRef: "1" });
  await store.admit({
    envelope, identity, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  const actualAmount = { presence: "UNKNOWN" as const };
  const committed = await store.commit({ identity, idempotencyKey: "key-1", actualAmount, occurredAt: "2026-09-29T00:00:01.000Z" });
  assert.equal(committed.status, "COMMITTED");
  const duplicate = await store.commit({ identity, idempotencyKey: "key-1", actualAmount, occurredAt: "2026-09-29T00:00:02.000Z" });
  assert.equal(duplicate.status, "COMMITTED");
  assert.equal(client.rows.filter((r) => r.type === "COMMITTED").length, 1);
});

test("PG4: getReadModel reflects committed UNKNOWN usage as INCOMPLETE, never a fabricated numeric remaining", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identity = createQuotaReservationIdentity({ scope, jobId: "job-4", runId: "run-4", attemptRef: "1" });
  await store.admit({
    envelope, identity, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  await store.commit({ identity, idempotencyKey: "key-1", actualAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:01.000Z" });
  const readModel = await store.getReadModel(envelope);
  assert.equal(readModel.monetary.status, "INCOMPLETE");
});

test("PG5 (Rev176, rejected-then-later-admissible recovery): a REJECTED admission re-evaluates fresh once the blocking reservation is released, without inserting a duplicate row while still rejected", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const blockerIdentity = createQuotaReservationIdentity({ scope, jobId: "job-5", runId: "run-5-blocker", attemptRef: "1" });
  await store.admit({
    envelope, identity: blockerIdentity, idempotencyKey: "key-blocker",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });

  const laterIdentity = createQuotaReservationIdentity({ scope, jobId: "job-5", runId: "run-5-later", attemptRef: "1" });
  const requestedAmount = { presence: "REPORTED" as const, amountMinorUnits: 50, currency: "USD" };
  const first = await store.admit({ envelope, identity: laterIdentity, idempotencyKey: "key-later", requestedAmount, occurredAt: "2026-09-29T00:00:01.000Z" });
  assert.equal(first.status, "REJECTED");

  const stillRejected = await store.admit({ envelope, identity: laterIdentity, idempotencyKey: "key-later", requestedAmount, occurredAt: "2026-09-29T00:00:02.000Z" });
  assert.equal(stillRejected.status, "REJECTED");
  assert.equal(client.rows.filter((r) => r.idempotency_key === "key-later").length, 1, "re-checking a still-rejected request must not insert a duplicate row");

  await store.release({ identity: blockerIdentity, idempotencyKey: "key-blocker", occurredAt: "2026-09-29T00:00:03.000Z" });

  const nowAdmitted = await store.admit({ envelope, identity: laterIdentity, idempotencyKey: "key-later", requestedAmount, occurredAt: "2026-09-29T00:00:04.000Z" });
  assert.equal(nowAdmitted.status, "RESERVED");
});

test("PG6 (Rev177 F2, replay parity - identity): a same-idempotencyKey replay under a DIFFERENT reservation identity fails closed, matching the pure domain's own contract", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identityA = createQuotaReservationIdentity({ scope, jobId: "job-6", runId: "run-6a", attemptRef: "1" });
  const identityB = createQuotaReservationIdentity({ scope, jobId: "job-6", runId: "run-6b", attemptRef: "1" });
  const requestedAmount = { presence: "REPORTED" as const, amountMinorUnits: 50, currency: "USD" };
  const first = await store.admit({ envelope, identity: identityA, idempotencyKey: "key-shared", requestedAmount, occurredAt: "2026-09-29T00:00:00.000Z" });
  assert.equal(first.status, "RESERVED");

  await assert.rejects(
    () => store.admit({ envelope, identity: identityB, idempotencyKey: "key-shared", requestedAmount, occurredAt: "2026-09-29T00:00:01.000Z" }),
    QuotaReservationConflictError,
  );
});

test("PG7 (Rev177 F2, replay parity - amount): a same-idempotencyKey replay requesting a DIFFERENT amount fails closed", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identity = createQuotaReservationIdentity({ scope, jobId: "job-7", runId: "run-7", attemptRef: "1" });
  const first = await store.admit({
    envelope, identity, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(first.status, "RESERVED");

  await assert.rejects(
    () =>
      store.admit({
        envelope, identity, idempotencyKey: "key-1",
        requestedAmount: { presence: "REPORTED", amountMinorUnits: 99, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
      }),
    QuotaReservationConflictError,
  );
});

test("PG8 (Rev177 F2, replay parity - envelopeRef): a same-idempotencyKey replay under a DIFFERENT envelopeRef fails closed", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identity = createQuotaReservationIdentity({ scope, jobId: "job-8", runId: "run-8", attemptRef: "1" });
  const requestedAmount = { presence: "REPORTED" as const, amountMinorUnits: 50, currency: "USD" };
  const first = await store.admit({ envelope, identity, idempotencyKey: "key-1", requestedAmount, occurredAt: "2026-09-29T00:00:00.000Z" });
  assert.equal(first.status, "RESERVED");

  const differentEnvelopeRef = createQuotaEnvelope({
    scope, envelopeRef: "envelope-DIFFERENT", sourceFingerprint: "qfp-1",
    unitLimit: 1_000_000,
    monetaryLimit: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
  });
  await assert.rejects(
    () => store.admit({ envelope: differentEnvelopeRef, identity, idempotencyKey: "key-1", requestedAmount, occurredAt: "2026-09-29T00:00:01.000Z" }),
    QuotaReservationConflictError,
  );
});

test("PG9 (Rev177 F2, replay parity - sourceFingerprint): a same-idempotencyKey replay under a DIFFERENT envelope sourceFingerprint fails closed - the Postgres adapter must not authorize a stored reservation under a new policy version merely because envelopeRef/idempotencyKey still match", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identity = createQuotaReservationIdentity({ scope, jobId: "job-9", runId: "run-9", attemptRef: "1" });
  const requestedAmount = { presence: "REPORTED" as const, amountMinorUnits: 50, currency: "USD" };
  const first = await store.admit({ envelope, identity, idempotencyKey: "key-1", requestedAmount, occurredAt: "2026-09-29T00:00:00.000Z" });
  assert.equal(first.status, "RESERVED");
  assert.equal((first as { event: { sourceFingerprint: string } }).event.sourceFingerprint, "qfp-1");

  const differentFingerprint = createQuotaEnvelope({
    scope, envelopeRef: "envelope-1", sourceFingerprint: "qfp-CHANGED",
    unitLimit: 1_000_000,
    monetaryLimit: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
  });
  await assert.rejects(
    () => store.admit({ envelope: differentFingerprint, identity, idempotencyKey: "key-1", requestedAmount, occurredAt: "2026-09-29T00:00:01.000Z" }),
    QuotaReservationConflictError,
  );
});

test("PG10 (Rev177 F1, collision-safe scope key at the adapter level): two distinct scopes whose identifiers contain the `::` delimiter never merge allowance accounting through the Postgres adapter", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const scopeA = createQuotaAdmissionScope({ tenantScope, customerId: "a::b", projectId: "c", planId: "plan-1", planVersion: 1 });
  const scopeB = createQuotaAdmissionScope({ tenantScope, customerId: "a", projectId: "b::c", planId: "plan-1", planVersion: 1 });
  const envelopeA = createQuotaEnvelope({ scope: scopeA, envelopeRef: "envelope-a", sourceFingerprint: "qfp-1", unitLimit: 1_000_000, monetaryLimit: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" } });
  const envelopeB = createQuotaEnvelope({ scope: scopeB, envelopeRef: "envelope-b", sourceFingerprint: "qfp-1", unitLimit: 1_000_000, monetaryLimit: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" } });
  const identityA = createQuotaReservationIdentity({ scope: scopeA, jobId: "job-10a", runId: "run-10a", attemptRef: "1" });
  const identityB = createQuotaReservationIdentity({ scope: scopeB, jobId: "job-10b", runId: "run-10b", attemptRef: "1" });
  const requestedAmount = { presence: "REPORTED" as const, amountMinorUnits: 100, currency: "USD" };

  const outcomeA = await store.admit({ envelope: envelopeA, identity: identityA, idempotencyKey: "key-a", requestedAmount, occurredAt: "2026-09-29T00:00:00.000Z" });
  assert.equal(outcomeA.status, "RESERVED");

  // scopeB's full, independent allowance must be untouched by scopeA's own
  // full reservation - a colliding scope_key would incorrectly see scopeA's
  // usage here and reject.
  const outcomeB = await store.admit({ envelope: envelopeB, identity: identityB, idempotencyKey: "key-b", requestedAmount, occurredAt: "2026-09-29T00:00:01.000Z" });
  assert.equal(outcomeB.status, "RESERVED", "scopeB's allowance must be fully isolated from scopeA's, even though their identifiers collide under a naive delimiter join");
});

test("PG11 (Rev177 F4, concurrent terminal-disposition race - commit wins): a concurrent commit and release racing on the SAME reservation resolve to exactly one terminal disposition, never both", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identity = createQuotaReservationIdentity({ scope, jobId: "job-11a", runId: "run-11a", attemptRef: "1" });
  await store.admit({
    envelope, identity, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });

  const [commitResult, releaseResult] = await Promise.all([
    store.commit({ identity, idempotencyKey: "key-1", actualAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z" }),
    store.release({ identity, idempotencyKey: "key-1", occurredAt: "2026-09-29T00:00:01.000Z" }),
  ]);

  const terminalRows = client.rows.filter((r) => r.type === "COMMITTED" || r.type === "RELEASED" || r.type === "RECONCILIATION_REQUIRED");
  assert.equal(terminalRows.length, 1, "exactly one terminal disposition must win - never both a COMMITTED and a RELEASED row for the same reservation");
  assert.equal(commitResult.status, "COMMITTED", "commit() started first in this race and must durably win the terminal claim");
  assert.equal(releaseResult.status, "ALREADY_COMMITTED", "release() must gracefully reconcile to the real winning disposition, not fail or silently insert its own");
});

test("PG12 (Rev177 F4, concurrent terminal-disposition race - release wins): the symmetric race where release() is issued first must leave commit() failing closed, never silently resurrecting spend", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identity = createQuotaReservationIdentity({ scope, jobId: "job-11b", runId: "run-11b", attemptRef: "1" });
  await store.admit({
    envelope, identity, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });

  const releasePromise = store.release({ identity, idempotencyKey: "key-1", occurredAt: "2026-09-29T00:00:01.000Z" });
  const commitPromise = store.commit({ identity, idempotencyKey: "key-1", actualAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z" });

  const releaseResult = await releasePromise;
  await assert.rejects(() => commitPromise, /already terminally settled as RELEASED/);

  const terminalRows = client.rows.filter((r) => r.type === "COMMITTED" || r.type === "RELEASED" || r.type === "RECONCILIATION_REQUIRED");
  assert.equal(terminalRows.length, 1, "exactly one terminal disposition must win");
  assert.equal(releaseResult.status, "RELEASED");
  assert.equal(terminalRows[0]?.type, "RELEASED");
});

test("PG13 (Rev177 F8, explicit id-ordering load-bearing): getReadModel's latest-per-reservation fold must not be fooled by a Postgres row order that differs from true insertion order", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const identity = createQuotaReservationIdentity({ scope, jobId: "job-13", runId: "run-13", attemptRef: "1" });
  await store.admit({
    envelope, identity, idempotencyKey: "key-1",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 80, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  const committed = await store.commit({
    identity, idempotencyKey: "key-1",
    actualAmount: { presence: "REPORTED", amountMinorUnits: 30, currency: "USD" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  assert.equal(committed.status, "COMMITTED");

  // This reservation's ledger now holds [RESERVED(80), COMMITTED(30)] in
  // true insertion order. `getReadModel()` never routes through
  // `claimFirstTerminalDisposition` (unlike commit()/release(), whose own
  // independent atomic re-check can mask an ordering bug) - it is a single
  // direct read, so it genuinely exercises whether
  // `projectQuotaScopeUsage`'s "last element per reservation key wins" fold
  // depends on the real store's `ORDER BY id ASC` fix. If the fake instead
  // returned rows REVERSED (`[COMMITTED(30), RESERVED(80)]` - exactly what
  // Postgres is free to do for a plain `SELECT *` without that clause), the
  // fold would treat the stale RESERVED(80) as "latest" instead of the true
  // final COMMITTED(30), fabricating 80 as still-outstanding reserved
  // allowance instead of correctly reporting 30 as spent.
  const readModel = await store.getReadModel(envelope);
  assert.equal(readModel.monetary.status, "COMPUTED");
  if (readModel.monetary.status === "COMPUTED") {
    assert.equal(readModel.monetary.reserved, 0, "the COMMITTED disposition must fully retire this reservation's outstanding RESERVED total");
    assert.equal(readModel.monetary.committed, 30, "committed spend must reflect the true final actualAmount, not the stale original reservation amount");
    assert.equal(readModel.monetary.remaining, 70);
  }
});

// ---------------------------------------------------------------------------
// Rev177 F10: the Postgres adapter's single atomic admit() statement must
// enforce the SAME unit-floor-always / monetary-optional split as the pure
// domain reducer, including F6's rescoped "UNKNOWN committed monetary usage
// blocks further monetary-ceiling-dependent admission" rule.
// ---------------------------------------------------------------------------

test("PG14 (Rev177 F10, load-bearing): the unit floor rejects admission through the real atomic SQL even when the requested amount is UNKNOWN and no monetaryLimit is configured", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const unitOnlyEnvelope = createQuotaEnvelope({ scope, envelopeRef: "envelope-unit-only", sourceFingerprint: "qfp-1", unitLimit: 1 });
  const identityA = createQuotaReservationIdentity({ scope, jobId: "job-14", runId: "run-14a", attemptRef: "1" });
  const identityB = createQuotaReservationIdentity({ scope, jobId: "job-14", runId: "run-14b", attemptRef: "1" });

  const first = await store.admit({
    envelope: unitOnlyEnvelope, identity: identityA, idempotencyKey: "key-a",
    requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(first.status, "RESERVED", "a scope with no monetaryLimit must admit an UNKNOWN estimate fine, as long as the unit floor has room");

  const second = await store.admit({
    envelope: unitOnlyEnvelope, identity: identityB, idempotencyKey: "key-b",
    requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:01.000Z",
  });
  assert.equal(second.status, "REJECTED");
  assert.match((second as { event: { reason?: string } }).event.reason ?? "", /insufficient unit allowance/);
});

test("PG15 (Rev177 F6, rescoped, load-bearing): UNKNOWN committed monetary usage blocks further admission through the real atomic SQL ONLY when the envelope configures a monetaryLimit", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresQuotaReservationStore(client);
  const withCeiling = createQuotaEnvelope({
    scope, envelopeRef: "envelope-ceiling", sourceFingerprint: "qfp-1", unitLimit: 1_000_000,
    monetaryLimit: { presence: "REPORTED", amountMinorUnits: 1000, currency: "USD" },
  });
  const identityA = createQuotaReservationIdentity({ scope, jobId: "job-15", runId: "run-15a", attemptRef: "1" });
  await store.admit({
    envelope: withCeiling, identity: identityA, idempotencyKey: "key-a",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }, occurredAt: "2026-09-29T00:00:00.000Z",
  });
  await store.commit({ identity: identityA, idempotencyKey: "key-a", actualAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:01.000Z" });

  const identityB = createQuotaReservationIdentity({ scope, jobId: "job-15", runId: "run-15b", attemptRef: "1" });
  const rejectedB = await store.admit({
    envelope: withCeiling, identity: identityB, idempotencyKey: "key-b",
    requestedAmount: { presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }, occurredAt: "2026-09-29T00:00:02.000Z",
  });
  assert.equal(rejectedB.status, "REJECTED");
  assert.match((rejectedB as { event: { reason?: string } }).event.reason ?? "", /UNKNOWN committed monetary usage/);

  // The identical sequence under a unit-floor-only envelope (no
  // monetaryLimit, DIFFERENT scope to avoid cross-test interference) is
  // entirely unaffected.
  const unitOnlyScope = createQuotaAdmissionScope({ tenantScope, customerId: "cust-15", projectId: "proj-15", planId: "plan-1", planVersion: 1 });
  const unitOnlyEnvelope = createQuotaEnvelope({ scope: unitOnlyScope, envelopeRef: "envelope-unit-only-15", sourceFingerprint: "qfp-1", unitLimit: 1_000_000 });
  const identityC = createQuotaReservationIdentity({ scope: unitOnlyScope, jobId: "job-15", runId: "run-15c", attemptRef: "1" });
  await store.admit({
    envelope: unitOnlyEnvelope, identity: identityC, idempotencyKey: "key-c",
    requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:03.000Z",
  });
  await store.commit({ identity: identityC, idempotencyKey: "key-c", actualAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:04.000Z" });

  const identityD = createQuotaReservationIdentity({ scope: unitOnlyScope, jobId: "job-15", runId: "run-15d", attemptRef: "1" });
  const admittedD = await store.admit({
    envelope: unitOnlyEnvelope, identity: identityD, idempotencyKey: "key-d",
    requestedAmount: { presence: "UNKNOWN" }, occurredAt: "2026-09-29T00:00:05.000Z",
  });
  assert.equal(admittedD.status, "RESERVED", "a unit-floor-only scope has no monetary allowance to protect, so a prior UNKNOWN commit never blocks a later admission");
});
