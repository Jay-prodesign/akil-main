import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  createQuotaReservationIdentity,
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
 * CTE is modeled as: find any already-existing RESERVED/REJECTED row for
 * this idempotencyKey (replay), else sum current RESERVED/COMMITTED/
 * RECONCILIATION_REQUIRED rows for the scope and decide RESERVED/REJECTED -
 * exactly the real query's own decision logic, since this fake never
 * actually needs the lock (its own JS execution is already single-threaded
 * and synchronous within one `query()` call).
 */
class FakeSqlClient implements SqlClient {
  readonly rows: RawRow[] = [];

  async query<Row>(text: string, params: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<Row> }> {
    if (text.includes("pg_advisory_xact_lock")) {
      const [
        tenantId, scopeKey, customerId, projectId, planId, planVersion,
        jobId, runId, attemptRef, idempotencyKey, envelopeRef,
        presence, amountMinorUnits, limitMinorUnits, occurredAt, currency,
      ] = params as [string, string, string, string, string, number, string, string, string, string, string, string, number, number, string, string | null];

      const already = this.rows.find((r) => r.tenant_id === tenantId && r.idempotency_key === idempotencyKey && (r.type === "RESERVED" || r.type === "REJECTED"));
      if (already !== undefined) {
        return { rows: [already] as unknown as ReadonlyArray<Row> };
      }
      let decidedType: "RESERVED" | "REJECTED";
      let reason: string | null;
      if (presence === "UNKNOWN") {
        decidedType = "REJECTED";
        reason = "an UNKNOWN estimated cost cannot be admitted against a monetary ceiling - it is never treated as zero";
      } else {
        const currentTotal = this.rows
          .filter((r) => r.tenant_id === tenantId && r.scope_key === scopeKey && (r.type === "RESERVED" || r.type === "COMMITTED" || r.type === "RECONCILIATION_REQUIRED"))
          .reduce((sum, r) => sum + (r.amount_minor_units ?? 0), 0);
        if (currentTotal + amountMinorUnits <= limitMinorUnits) {
          decidedType = "RESERVED";
          reason = null;
        } else {
          decidedType = "REJECTED";
          reason = "insufficient allowance remaining under the current envelope limit";
        }
      }
      const eventId = [scopeKey, jobId, runId, attemptRef, idempotencyKey, decidedType].join("::");
      const row: RawRow = {
        tenant_id: tenantId, event_id: eventId, scope_key: scopeKey, customer_id: customerId, project_id: projectId,
        plan_id: planId, plan_version: planVersion, job_id: jobId, run_id: runId, attempt_ref: attemptRef,
        idempotency_key: idempotencyKey, envelope_ref: envelopeRef, type: decidedType, occurred_at: occurredAt,
        amount_minor_units: presence === "UNKNOWN" ? null : amountMinorUnits, amount_presence: presence,
        currency: presence === "UNKNOWN" ? null : currency, reason,
        worker_ref: null, provider_ref: null, model_ref: null, route_ref: null,
      };
      this.rows.push(row);
      return { rows: [row] as unknown as ReadonlyArray<Row> };
    }

    if (text.includes("INSERT INTO quota_reservation_events")) {
      const [
        tenantId, eventId, scopeKey, customerId, projectId, planId, planVersion, jobId, runId, attemptRef,
        idempotencyKey, envelopeRef, type, occurredAt, amountMinorUnits, amountPresence, currency, reason,
        workerRef, providerRef, modelRef, routeRef,
      ] = params as [
        string, string, string, string, string, string, number, string, string, string, string, string, string,
        string, number | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null,
      ];
      const conflict = this.rows.some((r) => r.tenant_id === tenantId && r.event_id === eventId);
      if (conflict) {
        return { rows: [] as unknown as ReadonlyArray<Row> };
      }
      const row: RawRow = {
        tenant_id: tenantId, event_id: eventId, scope_key: scopeKey, customer_id: customerId, project_id: projectId,
        plan_id: planId, plan_version: planVersion, job_id: jobId, run_id: runId, attempt_ref: attemptRef,
        idempotency_key: idempotencyKey, envelope_ref: envelopeRef, type, occurred_at: occurredAt,
        amount_minor_units: amountMinorUnits, amount_presence: amountPresence, currency, reason,
        worker_ref: workerRef, provider_ref: providerRef, model_ref: modelRef, route_ref: routeRef,
      };
      this.rows.push(row);
      return { rows: [{ event_id: eventId }] as unknown as ReadonlyArray<Row> };
    }

    if (text.includes("SELECT * FROM quota_reservation_events") && text.includes("job_id")) {
      const [tenantId, scopeKey, jobId, runId, attemptRef, idempotencyKey] = params as string[];
      const matches = this.rows.filter(
        (r) => r.tenant_id === tenantId && r.scope_key === scopeKey && r.job_id === jobId && r.run_id === runId && r.attempt_ref === attemptRef && r.idempotency_key === idempotencyKey,
      );
      return { rows: matches as unknown as ReadonlyArray<Row> };
    }

    if (text.includes("SELECT * FROM quota_reservation_events")) {
      const [tenantId, scopeKey] = params as string[];
      const matches = this.rows.filter((r) => r.tenant_id === tenantId && r.scope_key === scopeKey);
      return { rows: matches as unknown as ReadonlyArray<Row> };
    }

    throw new Error(`FakeSqlClient: unrecognized query: ${text}`);
  }
}

const tenantScope = createTenantScope("tenant-pg-quota");
const scope = createQuotaAdmissionScope({
  tenantScope, customerId: "cust-1", projectId: "proj-1", planId: "plan-1", planVersion: 1,
});
const envelope = createQuotaEnvelope({
  scope, envelopeRef: "envelope-1", sourceFingerprint: "qfp-1",
  limit: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
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
  assert.equal(readModel.status, "INCOMPLETE");
});
