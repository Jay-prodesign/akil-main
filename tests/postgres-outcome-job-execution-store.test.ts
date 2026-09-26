import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createOutcomeJobExecutionEvent } from "../src/domain/outcome-job-execution-event.js";
import {
  PostgresOutcomeJobExecutionStore,
  CorruptedOutcomeJobExecutionRowError,
} from "../src/domain/postgres-outcome-job-execution-store.js";
import type { SqlClient } from "../src/ports/sql-client.js";

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
 * In-memory `SqlClient` stand-in mirroring `postgres-outcome-job-store.test.ts`'s
 * own `FakeSqlClient` discipline - no live database anywhere in this file.
 * `ON CONFLICT (tenant_id, event_id) DO NOTHING` is modeled directly: a
 * duplicate event_id silently inserts nothing, exactly like a real
 * unique-constraint conflict.
 */
class FakeSqlClient implements SqlClient {
  readonly rows: RawRow[] = [];

  async query<Row>(text: string, params: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<Row> }> {
    if (text.includes("INSERT INTO outcome_job_execution_events")) {
      const [
        tenantId, customerId, projectId, jobId, runId, correlationId, attempt, sequence,
        eventId, type, occurredAt, reason, progressRef, checkpointRef, executorRef,
      ] = params as [string, string, string, string, string, string, number, number, string, string, string, string | null, string | null, string | null, string | null];
      const conflict = this.rows.some((row) => row.tenant_id === tenantId && row.event_id === eventId);
      if (!conflict) {
        this.rows.push({
          tenant_id: tenantId, customer_id: customerId, project_id: projectId, job_id: jobId, run_id: runId,
          correlation_id: correlationId, attempt, sequence, event_id: eventId, type, occurred_at: occurredAt,
          reason, progress_ref: progressRef, checkpoint_ref: checkpointRef, executor_ref: executorRef,
        });
      }
      return { rows: [] as unknown as ReadonlyArray<Row> };
    }
    if (text.includes("SELECT") && text.includes("FROM outcome_job_execution_events")) {
      const [tenantId, customerId, projectId, jobId, runId] = params as string[];
      const matches = this.rows
        .filter((r) => r.tenant_id === tenantId && r.customer_id === customerId && r.project_id === projectId && r.job_id === jobId && r.run_id === runId)
        .sort((a, b) => (a.attempt === b.attempt ? a.sequence - b.sequence : a.attempt - b.attempt));
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
