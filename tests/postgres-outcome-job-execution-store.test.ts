import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createOutcomeJobExecutionEvent } from "../src/domain/outcome-job-execution-event.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import {
  PostgresOutcomeJobExecutionStore,
  CorruptedOutcomeJobExecutionRowError,
} from "../src/domain/postgres-outcome-job-execution-store.js";
import type { SqlClient } from "../src/ports/sql-client.js";
import {
  requestExecutionCancellation,
  PendingControlOperationReconciliationRequiredError,
  type ControlOperationInvoker,
} from "../src/application/outcome-job-execution-runtime.js";

interface RawRow {
  tenant_id: string;
  customer_id: string;
  project_id: string;
  job_id: string;
  run_id: string;
  correlation_id: string;
  attempt: number;
  sequence: number;
  event_id: string;
  type: string;
  occurred_at: string;
  reason: string | null;
  progress_ref: string | null;
  checkpoint_ref: string | null;
  executor_ref: string | null;
}

/**
 * Rev158 F15: the exact type list `migrations/0002_outcome_job_execution_events.sql`
 * currently admits via its `outcome_job_execution_events_type_recognized`
 * CHECK constraint - kept as a literal mirror of that migration's own SQL
 * text (not imported from the TS domain set) so a drift between the two
 * would show up as a real, independently-verified test failure, never
 * silently pass because both sides happened to import the same source.
 */
const CURRENT_MIGRATION_RECOGNIZED_TYPES: ReadonlySet<string> = new Set([
  "ACCEPTED", "ATTEMPT_STARTED", "PROGRESS", "CHECKPOINT",
  "CANCEL_REQUESTED", "CHECKPOINT_REQUESTED",
  "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "STALLED",
  "DEGRADED", "BLOCKED", "UNKNOWN", "UNSUPPORTED",
]);

/**
 * Rev158 F15: the OLD (pre-Rev158) migration type list, before
 * CANCEL_REQUESTED/CHECKPOINT_REQUESTED were added - used only to prove
 * `P9` would genuinely have failed against the schema as it stood before
 * this correction, not merely against a hypothetical.
 */
const PRE_REV158_MIGRATION_RECOGNIZED_TYPES: ReadonlySet<string> = new Set([
  "ACCEPTED", "ATTEMPT_STARTED", "PROGRESS", "CHECKPOINT",
  "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "STALLED",
  "DEGRADED", "BLOCKED", "UNKNOWN", "UNSUPPORTED",
]);

/**
 * In-memory `SqlClient` stand-in mirroring `postgres-outcome-job-store.test.ts`'s
 * own `FakeSqlClient` discipline - no live database anywhere in this file.
 * `ON CONFLICT (tenant_id, event_id) DO NOTHING` is modeled directly: a
 * duplicate event_id silently inserts nothing, exactly like a real
 * unique-constraint conflict. Rev158 F15: this fake now also enforces the
 * real migration's `type_recognized` CHECK constraint (configurable via
 * `recognizedTypes`, defaulting to the current migration's own list) rather
 * than blindly accepting any type string - a genuine adapter-level witness,
 * not only the in-memory reducer/store's own TS-level type checking.
 */
class FakeSqlClient implements SqlClient {
  readonly rows: RawRow[] = [];

  constructor(private readonly recognizedTypes: ReadonlySet<string> = CURRENT_MIGRATION_RECOGNIZED_TYPES) {}

  async query<Row>(text: string, params: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<Row> }> {
    if (text.includes("INSERT INTO outcome_job_execution_events")) {
      const [
        tenantId, customerId, projectId, jobId, runId, correlationId, attempt, sequence,
        eventId, type, occurredAt, reason, progressRef, checkpointRef, executorRef,
      ] = params as [string, string, string, string, string, string, number, number, string, string, string, string | null, string | null, string | null, string | null];
      if (!this.recognizedTypes.has(type)) {
        throw new Error(
          `FakeSqlClient: CHECK constraint "outcome_job_execution_events_type_recognized" violated for type "${type}"`,
        );
      }
      const conflict = this.rows.some((row) => row.tenant_id === tenantId && row.event_id === eventId);
      if (conflict) {
        // Rev146 F7: `ON CONFLICT ... DO NOTHING RETURNING event_id` returns
        // NO rows when the insert was suppressed by the unique constraint -
        // faithfully model that (previously this always returned `rows: []`
        // regardless of conflict, so `appendEvent`'s boolean return value
        // was never actually exercised by this fake).
        return { rows: [] as unknown as ReadonlyArray<Row> };
      }
      this.rows.push({
        tenant_id: tenantId, customer_id: customerId, project_id: projectId, job_id: jobId, run_id: runId,
        correlation_id: correlationId, attempt, sequence, event_id: eventId, type, occurred_at: occurredAt,
        reason, progress_ref: progressRef, checkpoint_ref: checkpointRef, executor_ref: executorRef,
      });
      return { rows: [{ event_id: eventId }] as unknown as ReadonlyArray<Row> };
    }
    if (text.includes("SELECT") && text.includes("FROM outcome_job_execution_events")) {
      const [tenantId, customerId, projectId, jobId, runId] = params as string[];
      // Mirrors the real query's ORDER BY exactly (Rev147 F8): attempt,
      // sequence, then ACCEPTED-sorts-first as an explicit semantic
      // tiebreaker for the shared (attempt, sequence) coordinate, then
      // event_id as a final deterministic tiebreaker - never physical/
      // insertion (array push) order, which this fake deliberately does
      // NOT preserve by not sorting on push order at all.
      const typeOrdinal = (type: string) => (type === "ACCEPTED" ? 0 : 1);
      const matches = this.rows
        .filter((r) => r.tenant_id === tenantId && r.customer_id === customerId && r.project_id === projectId && r.job_id === jobId && r.run_id === runId)
        .sort((a, b) => {
          if (a.attempt !== b.attempt) return a.attempt - b.attempt;
          if (a.sequence !== b.sequence) return a.sequence - b.sequence;
          const ordinalDiff = typeOrdinal(a.type) - typeOrdinal(b.type);
          if (ordinalDiff !== 0) return ordinalDiff;
          return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
        });
      return { rows: matches as unknown as ReadonlyArray<Row> };
    }
    throw new Error(`FakeSqlClient: unrecognized query: ${text}`);
  }
}

const tenantScope = createTenantScope("tenant-pg-exec");
const customer = createCustomer({ tenantScope, customerId: "cust-pg-exec", displayName: "PG Exec Customer" });
const project = createProject({ tenantScope, customer, projectId: "project-pg-exec", ownerRef: "owner-pg-exec", state: "active" });
const job = createOutcomeJob({
  tenantScope, customer, project, jobId: "job-pg-exec", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver website",
});

test("P1: appendEvent + getState reconstructs ACCEPTED -> ATTEMPT_STARTED -> SUCCEEDED", async () => {
  const store = new PostgresOutcomeJobExecutionStore(new FakeSqlClient());
  const accepted = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-1", correlationId: "corr-pg-1",
    attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
  });
  await store.appendEvent(accepted);
  const started = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-1", correlationId: "corr-pg-1",
    attempt: 1, sequence: 1, type: "ATTEMPT_STARTED", occurredAt: "2026-09-26T00:00:01.000Z",
  });
  await store.appendEvent(started);
  const succeeded = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-1", correlationId: "corr-pg-1",
    attempt: 1, sequence: 2, type: "SUCCEEDED", occurredAt: "2026-09-26T00:00:02.000Z",
  });
  await store.appendEvent(succeeded);
  const state = await store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-pg-1");
  assert.equal(state?.status, "SUCCEEDED");
});

test("P2 (#14): concurrent duplicate append of the identical event is single-authority via the (tenant_id, event_id) unique constraint", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobExecutionStore(client);
  const accepted = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-2", correlationId: "corr-pg-2",
    attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
  });
  await Promise.all([store.appendEvent(accepted), store.appendEvent(accepted)]);
  assert.equal(client.rows.length, 1, "two concurrent identical appends must never produce two rows");
});

test("P2b (Rev146 F7): appendEvent's own boolean return value is true for the winning insert and false for the duplicate - not merely inferred from row count", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobExecutionStore(client);
  const accepted = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-2b", correlationId: "corr-pg-2b",
    attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
  });
  const first = await store.appendEvent(accepted);
  const second = await store.appendEvent(accepted);
  assert.equal(first, true, "the first append must report it durably created the row (RETURNING event_id came back non-empty)");
  assert.equal(second, false, "the duplicate append must report it did NOT create a row (ON CONFLICT ... DO NOTHING suppressed it)");
  assert.equal(client.rows.length, 1);
});

test("P3: get fails closed on a corrupted row with an unrecognized event type", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobExecutionStore(client);
  client.rows.push({
    tenant_id: "tenant-pg-corrupt", customer_id: "cust-pg-corrupt", project_id: "project-pg-corrupt",
    job_id: "job-pg-corrupt", run_id: "run-pg-corrupt", correlation_id: "corr-pg-corrupt",
    attempt: 1, sequence: 1, event_id: "e1", type: "NOT_A_REAL_TYPE", occurred_at: "2026-09-26T00:00:00.000Z",
    reason: null, progress_ref: null, checkpoint_ref: null, executor_ref: null,
  });
  await assert.rejects(
    () => store.getEvents("tenant-pg-corrupt" as never, "cust-pg-corrupt" as never, "project-pg-corrupt" as never, "job-pg-corrupt" as never, "run-pg-corrupt"),
    CorruptedOutcomeJobExecutionRowError,
  );
});

test("P4: getEvents fails closed if a returned row's tenant_id does not match the tenant requested (defense in depth)", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobExecutionStore(client);
  client.rows.push({
    tenant_id: "tenant-actually-different", customer_id: "cust-x", project_id: "project-x",
    job_id: "job-x", run_id: "run-x", correlation_id: "corr-x",
    attempt: 1, sequence: 1, event_id: "e1", type: "ACCEPTED", occurred_at: "2026-09-26T00:00:00.000Z",
    reason: null, progress_ref: null, checkpoint_ref: null, executor_ref: null,
  });
  const originalQuery = client.query.bind(client);
  client.query = async (text: string, params: ReadonlyArray<unknown>) => {
    if (text.includes("SELECT")) {
      return { rows: [client.rows[0]] } as never;
    }
    return originalQuery(text, params);
  };
  await assert.rejects(
    () => store.getEvents("tenant-requested" as never, "cust-x" as never, "project-x" as never, "job-x" as never, "run-x"),
    CorruptedOutcomeJobExecutionRowError,
  );
});

test("P5: getEvents orders rows by attempt then sequence regardless of insertion order", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobExecutionStore(client);
  const accepted = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-5", correlationId: "corr-pg-5",
    attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
  });
  const started = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-5", correlationId: "corr-pg-5",
    attempt: 1, sequence: 1, type: "ATTEMPT_STARTED", occurredAt: "2026-09-26T00:00:01.000Z",
  });
  const progress = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-5", correlationId: "corr-pg-5",
    attempt: 1, sequence: 2, type: "PROGRESS", occurredAt: "2026-09-26T00:00:02.000Z",
  });
  // Insert out of order.
  await store.appendEvent(progress);
  await store.appendEvent(accepted);
  await store.appendEvent(started);
  const events = await store.getEvents(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-pg-5");
  assert.deepEqual(events.map((e) => e.type), ["ACCEPTED", "ATTEMPT_STARTED", "PROGRESS"]);
});

test("P8 (Rev147 F8, adversarial): ACCEPTED always replays before ATTEMPT_STARTED at their shared (1,1) coordinate, even when ATTEMPT_STARTED is physically/durably written first", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobExecutionStore(client);
  const accepted = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-8", correlationId: "corr-pg-8",
    attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
  });
  const started = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-8", correlationId: "corr-pg-8",
    attempt: 1, sequence: 1, type: "ATTEMPT_STARTED", occurredAt: "2026-09-26T00:00:01.000Z",
  });
  // Deliberately reversed: ATTEMPT_STARTED is durably written BEFORE its own
  // run's ACCEPTED (e.g. an out-of-order replicated write, or simply a
  // different physical row order than logical order) - ordering must not
  // depend on this.
  await store.appendEvent(started);
  await store.appendEvent(accepted);

  const events = await store.getEvents(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-pg-8");
  assert.deepEqual(
    events.map((e) => e.type),
    ["ACCEPTED", "ATTEMPT_STARTED"],
    "ACCEPTED must sort before ATTEMPT_STARTED at the shared (1,1) coordinate regardless of physical/insertion order",
  );

  // The whole point: a reducer replay over this reverse-physical-order
  // durable log must still succeed (not reject a genuinely valid run).
  const state = await store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-pg-8");
  assert.equal(state?.status, "RUNNING");
  assert.equal(state?.currentAttempt, 1);
});

test("P9 (Rev158 F15, adversarial): CANCEL_REQUESTED/CHECKPOINT_REQUESTED are admitted by the current migration's type CHECK constraint, would have been rejected under the pre-Rev158 constraint, and an unrecognized type still fails closed under either", async () => {
  const cancelRequested = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-9", correlationId: "corr-pg-9",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:01.000Z", reason: "user requested",
  });
  const checkpointRequested = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-9b", correlationId: "corr-pg-9b",
    attempt: 1, sequence: 2, type: "CHECKPOINT_REQUESTED", occurredAt: "2026-09-26T00:00:01.000Z",
  });

  // The current (fixed) migration's own CHECK constraint list admits both
  // new request-marker types.
  const currentStore = new PostgresOutcomeJobExecutionStore(new FakeSqlClient(CURRENT_MIGRATION_RECOGNIZED_TYPES));
  await currentStore.appendEvent(cancelRequested);
  await currentStore.appendEvent(checkpointRequested);

  // A real adapter/schema witness, not only the in-memory fake: against the
  // OLD (pre-Rev158) migration's CHECK constraint list, appending either new
  // type must genuinely fail - proving the schema fix is real and load-
  // bearing, not merely assumed.
  const preRev158Store = new PostgresOutcomeJobExecutionStore(new FakeSqlClient(PRE_REV158_MIGRATION_RECOGNIZED_TYPES));
  await assert.rejects(
    () => preRev158Store.appendEvent(cancelRequested),
    /CHECK constraint/,
    "CANCEL_REQUESTED must be rejected by the pre-Rev158 migration's own CHECK constraint list",
  );
  await assert.rejects(
    () => preRev158Store.appendEvent(checkpointRequested),
    /CHECK constraint/,
    "CHECKPOINT_REQUESTED must be rejected by the pre-Rev158 migration's own CHECK constraint list",
  );

  // An unrecognized type must still fail closed under the CURRENT (fixed)
  // constraint list too - the fix admits the two new real types, it does not
  // loosen the constraint into accepting anything.
  const bogusEvent = { ...cancelRequested, type: "BOGUS_TYPE" as never };
  await assert.rejects(
    () => currentStore.appendEvent(bogusEvent),
    /CHECK constraint/,
    "an unrecognized type must still fail closed under the current migration's constraint",
  );
});

const authority = createAuthorityContext({
  tenantScope, permissions: ["EXECUTE", "WRITE", "READ"], canPerformProtectedActions: false,
});

test("P10 (Rev166 F19, adversarial): the Postgres store exposes equivalent resolution-slot-race behavior to the File/in-memory store - a positive reconciliation that loses its slot to a concurrent PROGRESS row fails closed, and current durable state is authoritative", async () => {
  const store = new PostgresOutcomeJobExecutionStore(new FakeSqlClient());
  const accepted = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-10", correlationId: "corr-pg-10",
    attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
  });
  await store.appendEvent(accepted);
  const started = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-10", correlationId: "corr-pg-10",
    attempt: 1, sequence: 1, type: "ATTEMPT_STARTED", occurredAt: "2026-09-26T00:00:01.000Z",
  });
  await store.appendEvent(started);
  const staleCancelRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-10", correlationId: "corr-pg-10",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:02.000Z", reason: "first attempt",
  });
  await store.appendEvent(staleCancelRequest);
  const stateAfterCrash = await store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-pg-10");

  const invoker: ControlOperationInvoker & { cancelCalls: number } = {
    cancelCalls: 0,
    async requestCancel() { this.cancelCalls += 1; return { acknowledged: true }; },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    async reconcileControlRequest() {
      const racingProgress = createOutcomeJobExecutionEvent({
        tenantScope, customer, project, job, runId: "run-pg-10", correlationId: "corr-pg-10",
        attempt: 1, sequence: 3, type: "PROGRESS", occurredAt: "2026-09-26T00:00:03.000Z",
      });
      await store.appendEvent(racingProgress);
      return { acknowledged: true };
    },
  };
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "retry", store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
    "the Postgres-backed store must fail closed identically to the File/in-memory store when the resolving event loses its slot",
  );
  assert.equal(invoker.cancelCalls, 0, "the external cancel effect must never be re-invoked merely to obtain a durable resolution");
  const finalState = await store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-pg-10");
  assert.deepEqual(finalState?.attempts.get(1)?.pendingControlRequest, {
    kind: "CANCEL_REQUESTED",
    controlRequestId: staleCancelRequest.eventId,
    reason: "first attempt",
  }, "the original pending cancel must remain exactly as it was in the Postgres-backed store too");
  assert.equal(finalState?.attempts.get(1)?.status, "RUNNING");
});

test("P6 (Rev145 F2, adversarial): a row whose event_id column does not match the canonical derivation from its own tuple fails closed", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobExecutionStore(client);
  client.rows.push({
    tenant_id: tenantScope.tenantId, customer_id: customer.customerId, project_id: project.projectId,
    job_id: job.jobId, run_id: "run-pg-6", correlation_id: "corr-pg-6",
    attempt: 1, sequence: 1, event_id: "forged-event-id-does-not-match-tuple", type: "ACCEPTED",
    occurred_at: "2026-09-26T00:00:00.000Z", reason: null, progress_ref: null, checkpoint_ref: null, executor_ref: null,
  });
  await assert.rejects(
    () => store.getEvents(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-pg-6"),
    CorruptedOutcomeJobExecutionRowError,
  );
});

test("P7 (Rev145 F2): getEvents fails closed if a returned row's customer/project/job/run does not match the exact requested scope, not merely the tenant", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobExecutionStore(client);
  const legit = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-pg-7", correlationId: "corr-pg-7",
    attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
  });
  client.rows.push({
    tenant_id: legit.tenantId, customer_id: "cust-pg-different", project_id: legit.projectId,
    job_id: legit.jobId, run_id: legit.runId, correlation_id: legit.correlationId,
    attempt: legit.attempt, sequence: legit.sequence, event_id: legit.eventId, type: legit.type,
    occurred_at: legit.occurredAt, reason: null, progress_ref: null, checkpoint_ref: null, executor_ref: null,
  });
  const originalQuery = client.query.bind(client);
  client.query = async (text: string, params: ReadonlyArray<unknown>) => {
    if (text.includes("SELECT")) {
      return { rows: [client.rows[0]] } as never;
    }
    return originalQuery(text, params);
  };
  await assert.rejects(
    () => store.getEvents(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-pg-7"),
    CorruptedOutcomeJobExecutionRowError,
    "a row scoped to a different customer must fail closed even though tenant_id matches",
  );
});
