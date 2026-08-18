import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import {
  createEvidenceReference,
  InvalidEvidenceReferenceError,
} from "../src/domain/evidence.js";

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

test("creates an EvidenceReference for a job", () => {
  const evidence = createEvidenceReference({
    job,
    evidenceId: "ev-1",
    evidenceType: "test-run-log",
    sourceLocator: "internal://tests/outcome-job-verify.test.ts",
    capturedAt: "2026-08-16T00:00:00.000Z",
  });
  assert.equal(evidence.jobId, job.jobId);
  assert.equal(evidence.evidenceId, "ev-1");
  assert.equal(evidence.evidenceType, "test-run-log");
});

test("rejects a missing sourceLocator", () => {
  assert.throws(
    () =>
      createEvidenceReference({
        job,
        evidenceId: "ev-1",
        evidenceType: "test-run-log",
        sourceLocator: undefined,
        capturedAt: "2026-08-16T00:00:00.000Z",
      }),
    InvalidEvidenceReferenceError,
  );
});

test("rejects an empty capturedAt", () => {
  assert.throws(
    () =>
      createEvidenceReference({
        job,
        evidenceId: "ev-1",
        evidenceType: "test-run-log",
        sourceLocator: "internal://tests",
        capturedAt: "",
      }),
    InvalidEvidenceReferenceError,
  );
});
