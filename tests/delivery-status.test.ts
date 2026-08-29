import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob, transitionOutcomeJob, enterExceptionState, type OutcomeJob } from "../src/domain/outcome-job.js";
import { computeDeliveryStatus, InvalidDeliveryStatusError } from "../src/domain/delivery-status.js";

const tenantA = createTenantScope("tenant-a");
const tenantB = createTenantScope("tenant-b");
const customerInA = createCustomer({
  tenantScope: tenantA,
  customerId: "cust-1",
  displayName: "Acme Corp",
});
const projectInA = createProject({
  tenantScope: tenantA,
  customer: customerInA,
  projectId: "proj-1",
  ownerRef: "owner-1",
  state: "active",
});
const customerInB = createCustomer({
  tenantScope: tenantB,
  customerId: "cust-2",
  displayName: "Globex",
});
const projectInB = createProject({
  tenantScope: tenantB,
  customer: customerInB,
  projectId: "proj-2",
  ownerRef: "owner-2",
  state: "active",
});

function jobIn(project: typeof projectInA, jobId: string): OutcomeJob {
  return createOutcomeJob({
    tenantScope: tenantA,
    customer: customerInA,
    project,
    jobId,
    jobFamily: "onboarding",
    businessObjective: "Deliver the bounded slice",
  });
}

test("no jobs yields NOT_STARTED and an empty job list", () => {
  const view = computeDeliveryStatus({ project: projectInA, jobs: [] });
  assert.equal(view.overallStatus, "NOT_STARTED");
  assert.deepEqual(view.jobs, []);
  assert.equal(view.tenantId, "tenant-a");
  assert.equal(view.customerId, "cust-1");
  assert.equal(view.projectId, "proj-1");
});

test("all jobs CLOSED yields COMPLETE", () => {
  let job = jobIn(projectInA, "job-1");
  job = transitionOutcomeJob(job, "QUALIFIED");
  job = transitionOutcomeJob(job, "READY");
  job = transitionOutcomeJob(job, "EXECUTING");
  job = transitionOutcomeJob(job, "VERIFYING");
  // VERIFYING -> VERIFIED requires verifyOutcomeJob elsewhere; construct the
  // CLOSED state directly is not possible via transitionOutcomeJob by
  // design (see outcome-job.ts), so this test uses two independently
  // progressed jobs to exercise IN_PROGRESS instead, and a synthetic
  // object-spread only for the COMPLETE case's shape, not its lifecycle
  // legality (lifecycle legality is outcome-job.ts's own test contract).
  const closedJob: OutcomeJob = { ...job, state: "CLOSED" };
  const view = computeDeliveryStatus({ project: projectInA, jobs: [closedJob] });
  assert.equal(view.overallStatus, "COMPLETE");
  assert.equal(view.jobs.length, 1);
  assert.equal(view.jobs[0]?.state, "CLOSED");
  assert.equal(view.jobs[0]?.isBlocking, false);
});

test("a non-terminal, non-exception mix yields IN_PROGRESS", () => {
  const draft = jobIn(projectInA, "job-1");
  let executing = jobIn(projectInA, "job-2");
  executing = transitionOutcomeJob(executing, "QUALIFIED");
  executing = transitionOutcomeJob(executing, "READY");
  executing = transitionOutcomeJob(executing, "EXECUTING");
  const view = computeDeliveryStatus({ project: projectInA, jobs: [draft, executing] });
  assert.equal(view.overallStatus, "IN_PROGRESS");
  assert.equal(view.jobs.length, 2);
  assert.ok(view.jobs.every((job) => job.isBlocking === false));
});

test("any job in an exception state yields BLOCKED and marks only that job isBlocking", () => {
  const healthy = jobIn(projectInA, "job-1");
  const toBlock = jobIn(projectInA, "job-2");
  const { job: blocked } = enterExceptionState({
    job: toBlock,
    to: "BLOCKED",
    eventId: "evt-1",
    actorRef: "system",
    timestamp: "2026-08-21T09:00:00Z",
    reason: "waiting on customer-provided access",
  });
  const view = computeDeliveryStatus({ project: projectInA, jobs: [healthy, blocked] });
  assert.equal(view.overallStatus, "BLOCKED");
  const healthyStatus = view.jobs.find((job) => job.jobId === "job-1");
  const blockedStatus = view.jobs.find((job) => job.jobId === "job-2");
  assert.equal(healthyStatus?.isBlocking, false);
  assert.equal(blockedStatus?.isBlocking, true);
});

test("rejects a job that belongs to a different tenant than the given project", () => {
  const foreignJob = createOutcomeJob({
    tenantScope: tenantB,
    customer: customerInB,
    project: projectInB,
    jobId: "job-x",
    jobFamily: "onboarding",
    businessObjective: "Foreign tenant job",
  });
  assert.throws(
    () => computeDeliveryStatus({ project: projectInA, jobs: [foreignJob] }),
    InvalidDeliveryStatusError,
  );
});

test("rejects a job that belongs to a different project within the same tenant", () => {
  const otherProjectInA = createProject({
    tenantScope: tenantA,
    customer: customerInA,
    projectId: "proj-other",
    ownerRef: "owner-1",
    state: "active",
  });
  const wrongProjectJob = jobIn(otherProjectInA, "job-y");
  assert.throws(
    () => computeDeliveryStatus({ project: projectInA, jobs: [wrongProjectJob] }),
    InvalidDeliveryStatusError,
  );
});
