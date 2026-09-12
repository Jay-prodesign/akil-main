import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  createOutcomeJob,
  transitionOutcomeJob,
  verifyOutcomeJob,
  type OutcomeJob,
} from "../src/domain/outcome-job.js";
import { createVerificationResult } from "../src/domain/verification-result.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import {
  createClosureApprovalReference,
  isClosureApprovalValidForJob,
  closeOutcomeJobWithApproval,
  InvalidClosureApprovalReferenceError,
  OutcomeJobClosureNotApprovedError,
  type ClosureApprovalReference,
} from "../src/domain/outcome-job-closure-approval.js";

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

function verifiedJob(jobId = "job-1"): OutcomeJob {
  const job = draftJob(jobId);
  const qualified = transitionOutcomeJob(job, "QUALIFIED");
  const ready = transitionOutcomeJob(qualified, "READY");
  const executing = transitionOutcomeJob(ready, "EXECUTING");
  const verifying = transitionOutcomeJob(executing, "VERIFYING");
  const evidence = createEvidenceReference({
    job: verifying,
    evidenceId: `evidence-${jobId}`,
    evidenceType: "SCREENSHOT",
    sourceLocator: "https://example.test/evidence",
    capturedAt: "2026-09-12T00:00:00Z",
  });
  const verificationResult = createVerificationResult({
    verificationId: `verify-${jobId}`,
    job: verifying,
    evidence,
    verificationRequirementRef: "req-1",
    status: "PASSED",
  });
  return verifyOutcomeJob(verifying, verificationResult);
}

// --- ClosureApprovalReference construction ---

test("A1: createClosureApprovalReference binds every scoping field from the job, not caller-typed input", () => {
  const job = verifiedJob();
  const approval = createClosureApprovalReference({
    job,
    closureApprovalId: "approval-1",
    approvedAt: "2026-09-12T00:00:00Z",
    approverRef: "staff-membership-1",
  });
  assert.equal(approval.tenantId, job.tenantId);
  assert.equal(approval.customerId, job.customerId);
  assert.equal(approval.projectId, job.projectId);
  assert.equal(approval.jobId, job.jobId);
  assert.equal(approval.approverRef, "staff-membership-1");
});

test("A2: createClosureApprovalReference rejects an empty/whitespace-only closureApprovalId", () => {
  const job = verifiedJob();
  assert.throws(
    () =>
      createClosureApprovalReference({
        job,
        closureApprovalId: "   ",
        approvedAt: "2026-09-12T00:00:00Z",
        approverRef: "staff-1",
      }),
    InvalidClosureApprovalReferenceError,
  );
});

test("A3: createClosureApprovalReference rejects a missing approverRef", () => {
  const job = verifiedJob();
  assert.throws(
    () =>
      createClosureApprovalReference({
        job,
        closureApprovalId: "approval-1",
        approvedAt: "2026-09-12T00:00:00Z",
        approverRef: undefined,
      }),
    InvalidClosureApprovalReferenceError,
  );
});

// --- isClosureApprovalValidForJob ---

test("A4: isClosureApprovalValidForJob is true for the exact job it was created for", () => {
  const job = verifiedJob();
  const approval = createClosureApprovalReference({
    job,
    closureApprovalId: "approval-1",
    approvedAt: "2026-09-12T00:00:00Z",
    approverRef: "staff-1",
  });
  assert.equal(isClosureApprovalValidForJob(approval, job), true);
});

test("A5: isClosureApprovalValidForJob is false for a different jobId, even same tenant/customer/project", () => {
  const jobOne = verifiedJob("job-1");
  const jobTwo = verifiedJob("job-2");
  const approval = createClosureApprovalReference({
    job: jobOne,
    closureApprovalId: "approval-1",
    approvedAt: "2026-09-12T00:00:00Z",
    approverRef: "staff-1",
  });
  assert.equal(isClosureApprovalValidForJob(approval, jobTwo), false);
});

test("A6: isClosureApprovalValidForJob is false across a cross-tenant substitution even with an identical jobId string", () => {
  const jobInA = verifiedJob("shared-job-id");
  const jobInB = createOutcomeJob({
    tenantScope: tenantB,
    customer: customerInB,
    project: projectInB,
    jobId: "shared-job-id",
    jobFamily: "onboarding",
    businessObjective: "Different tenant's job with the same id string",
  });
  const approval = createClosureApprovalReference({
    job: jobInA,
    closureApprovalId: "approval-1",
    approvedAt: "2026-09-12T00:00:00Z",
    approverRef: "staff-1",
  });
  assert.equal(isClosureApprovalValidForJob(approval, jobInB), false);
});

// --- closeOutcomeJobWithApproval ---

test("A7: closeOutcomeJobWithApproval closes a VERIFIED job given a matching approval", () => {
  const job = verifiedJob();
  const approval = createClosureApprovalReference({
    job,
    closureApprovalId: "approval-1",
    approvedAt: "2026-09-12T00:00:00Z",
    approverRef: "staff-1",
  });
  const closed = closeOutcomeJobWithApproval({ job, approval });
  assert.equal(closed.state, "CLOSED");
});

test("A8 (adversarial): closeOutcomeJobWithApproval throws when no approval is supplied - a VERIFIED job is never closed by default", () => {
  const job = verifiedJob();
  assert.throws(
    () => closeOutcomeJobWithApproval({ job, approval: undefined }),
    OutcomeJobClosureNotApprovedError,
  );
});

test("A9 (adversarial): closeOutcomeJobWithApproval throws when the supplied approval belongs to a different job", () => {
  const jobOne = verifiedJob("job-1");
  const jobTwo = verifiedJob("job-2");
  const approvalForJobOne = createClosureApprovalReference({
    job: jobOne,
    closureApprovalId: "approval-1",
    approvedAt: "2026-09-12T00:00:00Z",
    approverRef: "staff-1",
  });
  assert.throws(
    () => closeOutcomeJobWithApproval({ job: jobTwo, approval: approvalForJobOne }),
    OutcomeJobClosureNotApprovedError,
  );
});

test("A10 (adversarial): closeOutcomeJobWithApproval throws when the job is not yet VERIFIED, even with a well-formed approval bound to it", () => {
  const job = draftJob(); // still DRAFT
  const approval: ClosureApprovalReference = {
    closureApprovalId: "approval-1" as ClosureApprovalReference["closureApprovalId"],
    tenantId: job.tenantId,
    customerId: job.customerId,
    projectId: job.projectId,
    jobId: job.jobId,
    approvedAt: "2026-09-12T00:00:00Z",
    approverRef: "staff-1",
  };
  assert.throws(() => closeOutcomeJobWithApproval({ job, approval }));
});

test("A11: closeOutcomeJobWithApproval delegates the actual transition to the existing, unmodified transitionOutcomeJob - an already-CLOSED job cannot be closed again", () => {
  const job = verifiedJob();
  const approval = createClosureApprovalReference({
    job,
    closureApprovalId: "approval-1",
    approvedAt: "2026-09-12T00:00:00Z",
    approverRef: "staff-1",
  });
  const closed = closeOutcomeJobWithApproval({ job, approval });
  const secondApproval = createClosureApprovalReference({
    job: closed,
    closureApprovalId: "approval-2",
    approvedAt: "2026-09-12T00:01:00Z",
    approverRef: "staff-1",
  });
  assert.throws(() => closeOutcomeJobWithApproval({ job: closed, approval: secondApproval }));
});
