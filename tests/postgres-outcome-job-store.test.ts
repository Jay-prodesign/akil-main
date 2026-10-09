import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob, type OutcomeJob } from "../src/domain/outcome-job.js";
import {
  PostgresOutcomeJobStore,
  CorruptedOutcomeJobRowError,
} from "../src/domain/postgres-outcome-job-store.js";
import type { SqlClient } from "../src/ports/sql-client.js";

/**
 * A minimal in-memory stand-in for a real `pg`-backed `SqlClient`,
 * dispatching on the exact query shapes `PostgresOutcomeJobStore` issues
 * (no live database is required, or connected to, anywhere in this test
 * file) - the same injected-adapter discipline this session already
 * established for `connector-execution.test.ts`'s `RoutingMockTransport`.
 * `ON CONFLICT (tenant_id, job_id) DO NOTHING` is modeled directly: an
 * INSERT for an already-present (tenant_id, job_id) pair returns zero
 * rows, exactly like a real unique-constraint conflict would.
 */
interface RawRow {
  tenant_id: string;
  customer_id: string;
  project_id: string;
  job_id: string;
  job_family: string;
  business_objective: string;
  state: string;
}

class FakeSqlClient implements SqlClient {
  readonly rows: RawRow[] = [];

  async query<Row>(text: string, params: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<Row> }> {
    if (text.includes("INSERT INTO outcome_jobs")) {
      const [tenantId, customerId, projectId, jobId, jobFamily, businessObjective, state] = params as string[];
      const alreadyExists = this.rows.some((row) => row.tenant_id === tenantId && row.job_id === jobId);
      if (alreadyExists) {
        return { rows: [] };
      }
      const row: RawRow = {
        tenant_id: tenantId as string,
        customer_id: customerId as string,
        project_id: projectId as string,
        job_id: jobId as string,
        job_family: jobFamily as string,
        business_objective: businessObjective as string,
        state: state as string,
      };
      this.rows.push(row);
      return { rows: [row] as unknown as ReadonlyArray<Row> };
    }
    if (text.includes("job_id = $2")) {
      const [tenantId, jobId] = params as string[];
      const row = this.rows.find((r) => r.tenant_id === tenantId && r.job_id === jobId);
      return { rows: (row !== undefined ? [row] : []) as unknown as ReadonlyArray<Row> };
    }
    if (text.includes("project_id = $2")) {
      const [tenantId, projectId] = params as string[];
      const matches = this.rows.filter((r) => r.tenant_id === tenantId && r.project_id === projectId);
      return { rows: matches as unknown as ReadonlyArray<Row> };
    }
    throw new Error(`FakeSqlClient: unrecognized query: ${text}`);
  }
}

function buildJob(overrides?: Partial<{ tenantId: string; jobId: string; projectId: string }>): OutcomeJob {
  const tenantScope = createTenantScope(overrides?.tenantId ?? "tenant-pg-1");
  const customer = createCustomer({ tenantScope, customerId: "customer-pg-1", displayName: "PG Customer" });
  const project = createProject({
    tenantScope,
    customer,
    projectId: overrides?.projectId ?? "project-pg-1",
    ownerRef: "owner-pg-1",
    state: "ACTIVE",
  });
  return createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId: overrides?.jobId ?? "job-pg-1",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver website",
  });
}

test("P1: putIfAbsent persists a new job and reports created:true", async () => {
  const store = new PostgresOutcomeJobStore(new FakeSqlClient());
  const job = buildJob();
  const result = await store.putIfAbsent(job);
  assert.equal(result.created, true);
  assert.deepEqual(result.job, job);
});

test("P2: putIfAbsent replay of the same jobId reports created:false and returns the first-persisted job unchanged", async () => {
  const store = new PostgresOutcomeJobStore(new FakeSqlClient());
  const job = buildJob();
  const first = await store.putIfAbsent(job);
  const second = await store.putIfAbsent(job);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.job, job);
});

test("P3: the same jobId under two different tenants persists as two independent rows", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobStore(client);
  const jobA = buildJob({ tenantId: "tenant-pg-a", jobId: "shared-job-id" });
  const jobB = buildJob({ tenantId: "tenant-pg-b", jobId: "shared-job-id" });
  const resultA = await store.putIfAbsent(jobA);
  const resultB = await store.putIfAbsent(jobB);
  assert.equal(resultA.created, true);
  assert.equal(resultB.created, true);
  assert.equal(client.rows.length, 2);
});

test("P4: putIfAbsent fails closed when the same jobId is reused for a different project under the same tenant", async () => {
  const store = new PostgresOutcomeJobStore(new FakeSqlClient());
  const jobOne = buildJob({ jobId: "job-reused", projectId: "project-one" });
  const jobTwo = buildJob({ jobId: "job-reused", projectId: "project-two" });
  await store.putIfAbsent(jobOne);
  await assert.rejects(() => store.putIfAbsent(jobTwo), CorruptedOutcomeJobRowError);
});

test("P5: get returns undefined when no row exists", async () => {
  const store = new PostgresOutcomeJobStore(new FakeSqlClient());
  const tenantScope = createTenantScope("tenant-pg-empty");
  const result = await store.get(tenantScope.tenantId, "no-such-job" as OutcomeJob["jobId"]);
  assert.equal(result, undefined);
});

test("P6: get round-trips an exact match after putIfAbsent", async () => {
  const store = new PostgresOutcomeJobStore(new FakeSqlClient());
  const job = buildJob();
  await store.putIfAbsent(job);
  const found = await store.get(job.tenantId, job.jobId);
  assert.deepEqual(found, job);
});

test("P7: list filters by tenant and project, excluding other tenants/projects", async () => {
  const store = new PostgresOutcomeJobStore(new FakeSqlClient());
  const jobInScope = buildJob({ jobId: "job-in-scope" });
  const jobOtherProject = buildJob({ jobId: "job-other-project", projectId: "project-other" });
  const jobOtherTenant = buildJob({ tenantId: "tenant-other", jobId: "job-other-tenant" });
  await store.putIfAbsent(jobInScope);
  await store.putIfAbsent(jobOtherProject);
  await store.putIfAbsent(jobOtherTenant);

  const listed = await store.list(jobInScope.tenantId, jobInScope.projectId);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], jobInScope);
});

test("P8: get fails closed on a corrupted row with an unrecognized state", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobStore(client);
  client.rows.push({
    tenant_id: "tenant-corrupt",
    customer_id: "customer-corrupt",
    project_id: "project-corrupt",
    job_id: "job-corrupt",
    job_family: "WEBSITE_BUILD",
    business_objective: "Deliver website",
    state: "NOT_A_REAL_STATE",
  });
  await assert.rejects(
    () => store.get("tenant-corrupt" as never, "job-corrupt" as OutcomeJob["jobId"]),
    CorruptedOutcomeJobRowError,
  );
});

test("P9: list fails closed if any returned row has an empty required field", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobStore(client);
  client.rows.push({
    tenant_id: "tenant-corrupt-2",
    customer_id: "",
    project_id: "project-corrupt-2",
    job_id: "job-corrupt-2",
    job_family: "WEBSITE_BUILD",
    business_objective: "Deliver website",
    state: "DRAFT",
  });
  await assert.rejects(
    () => store.list("tenant-corrupt-2" as never, "project-corrupt-2" as never),
    CorruptedOutcomeJobRowError,
  );
});

test("P10: get fails closed if a row's tenant_id does not match the tenant requested (defense in depth against a mis-scoped driver)", async () => {
  const client = new FakeSqlClient();
  const store = new PostgresOutcomeJobStore(client);
  client.rows.push({
    tenant_id: "tenant-actually-different",
    customer_id: "customer-x",
    project_id: "project-x",
    job_id: "job-x",
    job_family: "WEBSITE_BUILD",
    business_objective: "Deliver website",
    state: "DRAFT",
  });
  // Force the fake to hand back a row under a tenant it was not asked for,
  // exactly as a buggy/misconfigured real driver might.
  const originalQuery = client.query.bind(client);
  client.query = async (text: string, params: ReadonlyArray<unknown>) => {
    if (text.includes("job_id = $2")) {
      return { rows: [client.rows[0]] } as never;
    }
    return originalQuery(text, params);
  };
  await assert.rejects(
    () => store.get("tenant-requested" as never, "job-x" as OutcomeJob["jobId"]),
    CorruptedOutcomeJobRowError,
  );
});
