import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  createOutcomeJob,
  transitionOutcomeJob,
  InvalidOutcomeJobTransitionError,
  type OutcomeJob,
} from "../src/domain/outcome-job.js";
import {
  resolveWorkerRoute,
  type AdmittedWorker,
  type WorkerRoutingDecision,
} from "../src/domain/worker-routing-policy.js";
import {
  createRoutedExecutionAssignment,
  isRoutedExecutionAssignmentValidForJob,
  authorizeOutcomeJobExecutionFromRouting,
  InvalidRoutedExecutionAssignmentError,
  OutcomeJobExecutionNotRoutedError,
  type RoutedExecutionAssignment,
} from "../src/domain/outcome-job-routing-execution.js";

const requiredCapabilityRef = "cap:engineering.typescript";

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
const projectInB = createProject({
  tenantScope: tenantB,
  customer: customerInB,
  projectId: "proj-2",
  ownerRef: "owner-2",
  state: "active",
});

function draftJob(jobId = "job-1"): OutcomeJob {
  return createOutcomeJob({
    tenantScope: tenantA,
    customer: customerInA,
    project: projectInA,
    jobId,
    jobFamily: "onboarding",
    businessObjective: "Verify tenant isolation kernel end to end",
  });
}

function readyJob(jobId = "job-1"): OutcomeJob {
  return transitionOutcomeJob(transitionOutcomeJob(draftJob(jobId), "QUALIFIED"), "READY");
}

function admittedWorker(overrides: Partial<AdmittedWorker> & { workerId: string }): AdmittedWorker {
  return {
    declaredCapabilityRefs: [requiredCapabilityRef],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: `evidence:${overrides.workerId}`,
    ...overrides,
  };
}

function routedDecision(overrides?: { reviewer?: AdmittedWorker }): WorkerRoutingDecision {
  const executor = admittedWorker({ workerId: "claude" });
  if (overrides?.reviewer !== undefined) {
    return resolveWorkerRoute({
      requiredCapabilityRef,
      riskLevel: "STANDARD",
      requiredToolRefs: [],
      requiredPolicyConstraintRefs: [],
      requiredAuthorityLevel: "STANDARD",
      requiresIndependentReview: true,
      executorCandidates: [executor],
      reviewerCandidates: [overrides.reviewer],
    });
  }
  return resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiredToolRefs: [],
    requiredPolicyConstraintRefs: [],
    requiredAuthorityLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [executor],
  });
}

function rejectedDecision(): WorkerRoutingDecision {
  return resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiredToolRefs: [],
    requiredPolicyConstraintRefs: [],
    requiredAuthorityLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [admittedWorker({ workerId: "untrusted", trustStatus: "UNTRUSTED" })],
  });
}

function assignmentFor(job: OutcomeJob, decision: WorkerRoutingDecision = routedDecision()): RoutedExecutionAssignment {
  return createRoutedExecutionAssignment({ job, decision, boundAt: "2026-09-15T00:00:00.000Z" });
}

test("R1: createRoutedExecutionAssignment binds every scoping field from the supplied job, not caller-typed input", () => {
  const job = readyJob();
  const assignment = assignmentFor(job);
  assert.equal(assignment.tenantId, job.tenantId);
  assert.equal(assignment.customerId, job.customerId);
  assert.equal(assignment.projectId, job.projectId);
  assert.equal(assignment.jobId, job.jobId);
  assert.equal(assignment.executorWorkerId, "claude");
});

test("R2: createRoutedExecutionAssignment fails closed on a REJECTED decision - a rejected route can never authorize execution", () => {
  const job = readyJob();
  assert.throws(
    () => createRoutedExecutionAssignment({ job, decision: rejectedDecision(), boundAt: "2026-09-15T00:00:00.000Z" }),
    InvalidRoutedExecutionAssignmentError,
  );
});

test("R3: createRoutedExecutionAssignment fails closed on empty/whitespace-only boundAt", () => {
  const job = readyJob();
  assert.throws(
    () => createRoutedExecutionAssignment({ job, decision: routedDecision(), boundAt: "   " }),
    InvalidRoutedExecutionAssignmentError,
  );
});

test("R4: createRoutedExecutionAssignment carries reviewerWorkerId when the decision has one, and omits it when the decision does not", () => {
  const job = readyJob();
  const withoutReviewer = assignmentFor(job, routedDecision());
  assert.equal(withoutReviewer.reviewerWorkerId, undefined);

  const reviewer = admittedWorker({ workerId: "reviewer-1" });
  const withReviewer = assignmentFor(job, routedDecision({ reviewer }));
  assert.equal(withReviewer.reviewerWorkerId, "reviewer-1");
});

test("R5: isRoutedExecutionAssignmentValidForJob is true only for the exact job an assignment was created for", () => {
  const job = readyJob();
  const assignment = assignmentFor(job);
  assert.equal(isRoutedExecutionAssignmentValidForJob(assignment, job), true);
});

test("R6: isRoutedExecutionAssignmentValidForJob is false for a different jobId even in the same tenant/customer/project", () => {
  const job = readyJob("job-1");
  const otherJob = readyJob("job-2");
  const assignment = assignmentFor(job);
  assert.equal(isRoutedExecutionAssignmentValidForJob(assignment, otherJob), false);
});

test("R7: isRoutedExecutionAssignmentValidForJob is false across a cross-tenant substitution even when the jobId string happens to collide", () => {
  const jobInA = readyJob("shared-job-id");
  const jobInB = transitionOutcomeJob(
    transitionOutcomeJob(
      createOutcomeJob({
        tenantScope: tenantB,
        customer: customerInB,
        project: projectInB,
        jobId: "shared-job-id",
        jobFamily: "onboarding",
        businessObjective: "Verify tenant isolation kernel end to end",
      }),
      "QUALIFIED",
    ),
    "READY",
  );
  const assignment = assignmentFor(jobInA);
  assert.equal(isRoutedExecutionAssignmentValidForJob(assignment, jobInB), false);
});

test("R8: authorizeOutcomeJobExecutionFromRouting transitions a READY job to EXECUTING given a valid, matching assignment", () => {
  const job = readyJob();
  const executing = authorizeOutcomeJobExecutionFromRouting({ job, assignment: assignmentFor(job) });
  assert.equal(executing.state, "EXECUTING");
});

test("R9: authorizeOutcomeJobExecutionFromRouting throws OutcomeJobExecutionNotRoutedError when no assignment is supplied - a READY job is never moved to EXECUTING by default", () => {
  const job = readyJob();
  assert.throws(
    () => authorizeOutcomeJobExecutionFromRouting({ job, assignment: undefined }),
    OutcomeJobExecutionNotRoutedError,
  );
});

test("R10: authorizeOutcomeJobExecutionFromRouting throws when the supplied assignment belongs to a different job", () => {
  const job = readyJob("job-1");
  const otherJobAssignment = assignmentFor(readyJob("job-2"));
  assert.throws(
    () => authorizeOutcomeJobExecutionFromRouting({ job, assignment: otherJobAssignment }),
    OutcomeJobExecutionNotRoutedError,
  );
});

test("R11: authorizeOutcomeJobExecutionFromRouting throws when the job is not yet READY even with a well-formed matching assignment, since it still delegates to transitionOutcomeJob's own unmodified state-machine check", () => {
  const job = draftJob("job-1");
  const assignment = assignmentFor(readyJob("job-1"));
  assert.throws(
    () => authorizeOutcomeJobExecutionFromRouting({ job, assignment }),
    InvalidOutcomeJobTransitionError,
  );
});
