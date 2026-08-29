import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  createOutcomeJob,
  transitionOutcomeJob,
  verifyOutcomeJob,
  MissingVerificationEvidenceError,
  VerificationNotPassedError,
  InvalidOutcomeJobError,
  InvalidOutcomeJobTransitionError,
  type OutcomeJob,
} from "../src/domain/outcome-job.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult } from "../src/domain/verification-result.js";

const tenantScope = createTenantScope("tenant-a");
const customer = createCustomer({
  tenantScope,
  customerId: "cust-1",
  displayName: "Acme Corp",
});
const project = createProject({
  tenantScope,
  customer,
  projectId: "proj-1",
  ownerRef: "owner-1",
  state: "active",
});

function jobAtVerifying(): OutcomeJob {
  const draft = createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId: "job-1",
    jobFamily: "onboarding",
    businessObjective: "Verify tenant isolation kernel end to end",
  });
  const qualified = transitionOutcomeJob(draft, "QUALIFIED");
  const ready = transitionOutcomeJob(qualified, "READY");
  const executing = transitionOutcomeJob(ready, "EXECUTING");
  return transitionOutcomeJob(executing, "VERIFYING");
}

test("T5: fails when verification evidence is entirely absent", () => {
  const job = jobAtVerifying();
  assert.throws(
    () => verifyOutcomeJob(job, undefined),
    MissingVerificationEvidenceError,
  );
});

test("T5: fails when the VerificationResult status is FAILED", () => {
  const job = jobAtVerifying();
  const evidence = createEvidenceReference({
    job,
    evidenceId: "ev-1",
    evidenceType: "test-run-log",
    sourceLocator: "internal://tests",
    capturedAt: "2026-08-16T00:00:00.000Z",
  });
  const failedResult = createVerificationResult({
    verificationId: "verif-1",
    job,
    evidence,
    verificationRequirementRef: "T1-T12-suite",
    status: "FAILED",
    limitationOrFailureReason: "typecheck failed",
  });
  assert.throws(
    () => verifyOutcomeJob(job, failedResult),
    VerificationNotPassedError,
  );
});

test("T6: succeeds only when a PASSED VerificationResult for this job is supplied", () => {
  const job = jobAtVerifying();
  const evidence = createEvidenceReference({
    job,
    evidenceId: "ev-1",
    evidenceType: "test-run-log",
    sourceLocator: "internal://tests",
    capturedAt: "2026-08-16T00:00:00.000Z",
  });
  const passedResult = createVerificationResult({
    verificationId: "verif-1",
    job,
    evidence,
    verificationRequirementRef: "T1-T12-suite",
    status: "PASSED",
  });
  const verified = verifyOutcomeJob(job, passedResult);
  assert.equal(verified.state, "VERIFIED");
});

test("rejects a VerificationResult that belongs to a different job", () => {
  const job = jobAtVerifying();
  const otherJob = createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId: "job-2",
    jobFamily: "onboarding",
    businessObjective: "A different job",
  });
  const otherEvidence = createEvidenceReference({
    job: otherJob,
    evidenceId: "ev-2",
    evidenceType: "test-run-log",
    sourceLocator: "internal://tests",
    capturedAt: "2026-08-16T00:00:00.000Z",
  });
  const resultForOtherJob = createVerificationResult({
    verificationId: "verif-2",
    job: otherJob,
    evidence: otherEvidence,
    verificationRequirementRef: "T1-T12-suite",
    status: "PASSED",
  });
  assert.throws(
    () => verifyOutcomeJob(job, resultForOtherJob),
    InvalidOutcomeJobError,
  );
});

test("P0: refuses to verify when the VerificationResult belongs to a different tenant, even with matching jobId", () => {
  const job = jobAtVerifying();
  const otherTenantScope = createTenantScope("tenant-b");
  const otherTenantCustomer = createCustomer({
    tenantScope: otherTenantScope,
    customerId: "cust-1",
    displayName: "Other Tenant Co",
  });
  const otherTenantProject = createProject({
    tenantScope: otherTenantScope,
    customer: otherTenantCustomer,
    projectId: "proj-1",
    ownerRef: "owner-1",
    state: "active",
  });
  // Deliberately reuses jobId "job-1" from a different tenant so this
  // case is only caught by a tenantId check, not by jobId equality.
  let otherTenantJob = createOutcomeJob({
    tenantScope: otherTenantScope,
    customer: otherTenantCustomer,
    project: otherTenantProject,
    jobId: "job-1",
    jobFamily: "onboarding",
    businessObjective: "A same-jobId job belonging to a different tenant",
  });
  otherTenantJob = transitionOutcomeJob(otherTenantJob, "QUALIFIED");
  otherTenantJob = transitionOutcomeJob(otherTenantJob, "READY");
  otherTenantJob = transitionOutcomeJob(otherTenantJob, "EXECUTING");
  otherTenantJob = transitionOutcomeJob(otherTenantJob, "VERIFYING");
  const otherTenantEvidence = createEvidenceReference({
    job: otherTenantJob,
    evidenceId: "ev-1",
    evidenceType: "test-run-log",
    sourceLocator: "internal://tests",
    capturedAt: "2026-08-16T00:00:00.000Z",
  });
  const otherTenantResult = createVerificationResult({
    verificationId: "verif-cross-tenant",
    job: otherTenantJob,
    evidence: otherTenantEvidence,
    verificationRequirementRef: "T1-T12-suite",
    status: "PASSED",
  });
  assert.throws(
    () => verifyOutcomeJob(job, otherTenantResult),
    InvalidOutcomeJobError,
  );
});

test("refuses to verify a job that is not in VERIFYING", () => {
  const draft = createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId: "job-1",
    jobFamily: "onboarding",
    businessObjective: "x",
  });
  assert.throws(
    () => verifyOutcomeJob(draft, undefined),
    InvalidOutcomeJobTransitionError,
  );
});

test("RG-04: the generic transitionOutcomeJob cannot fake VERIFIED", () => {
  const job = jobAtVerifying();
  assert.throws(
    () => transitionOutcomeJob(job, "VERIFIED"),
    InvalidOutcomeJobTransitionError,
  );
});
