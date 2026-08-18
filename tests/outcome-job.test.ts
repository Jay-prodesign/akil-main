import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  createOutcomeJob,
  transitionOutcomeJob,
  InvalidOutcomeJobError,
  InvalidOutcomeJobTransitionError,
  type OutcomeJob,
  type OutcomeJobState,
} from "../src/domain/outcome-job.js";

const tenantA = createTenantScope("tenant-a");
const tenantB = createTenantScope("tenant-b");
const customerInA = createCustomer({
  tenantScope: tenantA,
  customerId: "cust-1",
  displayName: "Acme Corp",
});
const customerInB = createCustomer({
  tenantScope: tenantB,
  customerId: "cust-2",
  displayName: "Globex",
});
const projectInA = createProject({
  tenantScope: tenantA,
  customer: customerInA,
  projectId: "proj-1",
  ownerRef: "owner-1",
  state: "active",
});

function baseJob(): OutcomeJob {
  return createOutcomeJob({
    tenantScope: tenantA,
    customer: customerInA,
    project: projectInA,
    jobId: "job-1",
    jobFamily: "onboarding",
    businessObjective: "Verify tenant isolation kernel end to end",
  });
}

test("creates an OutcomeJob at the canonical entry state DRAFT", () => {
  const job = baseJob();
  assert.equal(job.state, "DRAFT");
  assert.equal(job.tenantId, "tenant-a");
  assert.equal(job.customerId, "cust-1");
  assert.equal(job.projectId, "proj-1");
});

test("rejects construction when the project belongs to a different tenant", () => {
  assert.throws(
    () =>
      createOutcomeJob({
        tenantScope: tenantB,
        customer: customerInB,
        project: projectInA,
        jobId: "job-1",
        jobFamily: "onboarding",
        businessObjective: "x",
      }),
    InvalidOutcomeJobError,
  );
});

test("rejects construction when the project belongs to a different customer", () => {
  const otherCustomerInA = createCustomer({
    tenantScope: tenantA,
    customerId: "cust-other",
    displayName: "Other Co",
  });
  assert.throws(
    () =>
      createOutcomeJob({
        tenantScope: tenantA,
        customer: otherCustomerInA,
        project: projectInA,
        jobId: "job-1",
        jobFamily: "onboarding",
        businessObjective: "x",
      }),
    InvalidOutcomeJobError,
  );
});

test("RG-03: canonical main-path transitions succeed in sequence", () => {
  let job = baseJob();
  const path: OutcomeJobState[] = [
    "QUALIFIED",
    "READY",
    "EXECUTING",
    "VERIFYING",
  ];
  for (const next of path) {
    job = transitionOutcomeJob(job, next);
    assert.equal(job.state, next);
  }
});

test("T3 / RG-03: rejects invalid transitions (negative matrix)", () => {
  const cases: Array<[OutcomeJobState, OutcomeJobState]> = [
    // RG-03 explicit examples
    ["DRAFT", "VERIFIED"],
    ["EXECUTING", "CLOSED"], // T4: EXECUTING cannot jump directly to CLOSED
    ["VERIFIED", "EXECUTING"],
    // additional skip-ahead / backward jumps
    ["DRAFT", "READY"],
    ["QUALIFIED", "EXECUTING"],
    ["CLOSED", "DRAFT"],
    // VERIFYING -> VERIFIED is deferred until step 5's evidence gate
    // exists (see src/domain/outcome-job.ts); currently must be rejected.
    ["VERIFYING", "VERIFIED"],
  ];
  for (const [from, to] of cases) {
    const job: OutcomeJob = { ...baseJob(), state: from };
    assert.throws(
      () => transitionOutcomeJob(job, to),
      InvalidOutcomeJobTransitionError,
      `expected ${from} -> ${to} to be rejected`,
    );
  }
});

test("VERIFIED -> CLOSED is allowed (terminal step of the main path)", () => {
  const job: OutcomeJob = { ...baseJob(), state: "VERIFIED" };
  const closed = transitionOutcomeJob(job, "CLOSED");
  assert.equal(closed.state, "CLOSED");
});
