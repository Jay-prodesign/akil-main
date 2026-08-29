import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import {
  createVerificationResult,
  InvalidVerificationResultError,
} from "../src/domain/verification-result.js";

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
const job = createOutcomeJob({
  tenantScope,
  customer,
  project,
  jobId: "job-1",
  jobFamily: "onboarding",
  businessObjective: "Verify tenant isolation kernel end to end",
});
const evidence = createEvidenceReference({
  job,
  evidenceId: "ev-1",
  evidenceType: "test-run-log",
  sourceLocator: "internal://tests",
  capturedAt: "2026-08-16T00:00:00.000Z",
});

test("creates a PASSED VerificationResult for matching job and evidence", () => {
  const result = createVerificationResult({
    verificationId: "verif-1",
    job,
    evidence,
    verificationRequirementRef: "T1-T12-suite",
    status: "PASSED",
  });
  assert.equal(result.jobId, job.jobId);
  assert.equal(result.evidenceId, evidence.evidenceId);
  assert.equal(result.status, "PASSED");
});

test("creates a FAILED VerificationResult with a limitation reason", () => {
  const result = createVerificationResult({
    verificationId: "verif-2",
    job,
    evidence,
    verificationRequirementRef: "T1-T12-suite",
    status: "FAILED",
    limitationOrFailureReason: "2 of 24 tests failed",
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.limitationOrFailureReason, "2 of 24 tests failed");
});

test("rejects an invalid status value", () => {
  assert.throws(
    () =>
      createVerificationResult({
        verificationId: "verif-3",
        job,
        evidence,
        verificationRequirementRef: "T1-T12-suite",
        status: "PROBABLY_FINE",
      }),
    InvalidVerificationResultError,
  );
});

test("P0: rejects evidence belonging to a different tenant, even when jobId values collide across tenants", () => {
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
  // Deliberately reuses jobId "job-1" from a different tenant, to prove
  // the tenant check is independent of (and not substitutable by) the
  // jobId-equality check.
  const otherTenantJob = createOutcomeJob({
    tenantScope: otherTenantScope,
    customer: otherTenantCustomer,
    project: otherTenantProject,
    jobId: "job-1",
    jobFamily: "onboarding",
    businessObjective: "A same-jobId job belonging to a different tenant",
  });
  const otherTenantEvidence = createEvidenceReference({
    job: otherTenantJob,
    evidenceId: "ev-1",
    evidenceType: "test-run-log",
    sourceLocator: "internal://tests",
    capturedAt: "2026-08-16T00:00:00.000Z",
  });
  assert.throws(
    () =>
      createVerificationResult({
        verificationId: "verif-5",
        job, // tenant-a's job-1
        evidence: otherTenantEvidence, // tenant-b's evidence for its own job-1
        verificationRequirementRef: "T1-T12-suite",
        status: "PASSED",
      }),
    InvalidVerificationResultError,
  );
});

test("rejects evidence that does not correspond to the given job", () => {
  const otherJob = createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId: "job-2",
    jobFamily: "onboarding",
    businessObjective: "A different job",
  });
  assert.throws(
    () =>
      createVerificationResult({
        verificationId: "verif-4",
        job: otherJob,
        evidence, // evidence.jobId === job.jobId, not otherJob.jobId
        verificationRequirementRef: "T1-T12-suite",
        status: "PASSED",
      }),
    InvalidVerificationResultError,
  );
});
