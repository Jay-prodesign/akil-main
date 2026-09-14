import { test } from "node:test";
import assert from "node:assert/strict";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import { admitPlan, admitJobs } from "../src/domain/plan-admission.js";
import { deriveOutcomeJobSpecs } from "../src/domain/outcome-job-spec.js";
import { wireAdmittedOutcomeJobs } from "../src/domain/outcome-job-wiring.js";
import { buildWebsiteBuildV1ColdStartFixture } from "../src/fixtures/website-build-v1-commercial-order.js";
import { WEBSITE_BUILD_V1_BLUEPRINT } from "../src/fixtures/website-build-v1.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";

/**
 * Rev62 AUD-V5-GAP-02 "Required Approval: PRESENT primitive / PARTIAL
 * end-to-end". Continues the Cold-Start chain proof past structural
 * completeness (proven in commercial-order-intake.test.ts) through to an
 * ADMITTED plan and its wired DRAFT OutcomeJobs, from the same
 * zero-history commercial order - composing only existing, separately
 * tested primitives (`createApprovalReference`, `admitPlan`, `admitJobs`,
 * `deriveOutcomeJobSpecs`, `wireAdmittedOutcomeJobs`; the same pattern
 * already proven for the direct-fixture case in
 * `tests/outcome-job-wiring.test.ts` T1). Deliberately stops at DRAFT
 * OutcomeJobs: actual execution/verification/handover ("Delivery
 * Closure") requires real worker capability this repository does not
 * have, and stays out of scope here, same as V4 Workstreams C-H.
 */
test("Rev62 AUD-V5-GAP-02: the Cold-Start chain (order -> resolution -> intake -> compiled plan) admits end to end given a valid approval and full readiness evidence", () => {
  const fixture = buildWebsiteBuildV1ColdStartFixture();

  const approval = createApprovalReference({
    plan: fixture.plan,
    approvalId: "approval-cold-start",
    approvedAt: "2026-09-09T00:00:00.000Z",
    approverRef: "owner:founder",
  });
  const readinessAssertions = buildFullReadinessAssertions(
    fixture.tenantScope,
    fixture.project,
    fixture.plan,
  );

  const planAdmission = admitPlan({
    plan: fixture.plan,
    blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
    readinessAssertions,
    approval,
  });
  assert.equal(planAdmission.status, "ADMITTED");

  const specs = deriveOutcomeJobSpecs(fixture.plan);
  const jobAdmissions = admitJobs(planAdmission, specs);
  assert.ok(jobAdmissions.every((admission) => admission.status === "ADMITTED"));

  const jobs = wireAdmittedOutcomeJobs({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    planAdmission,
    jobAdmissions,
    specs,
  });

  assert.equal(jobs.length, specs.length);
  assert.ok(jobs.length > 0, "expected at least one DRAFT OutcomeJob wired from the cold-start order");
  assert.ok(jobs.every((job) => job.state === "DRAFT"));
  assert.ok(jobs.every((job) => job.tenantId === fixture.tenantScope.tenantId));
  assert.ok(jobs.every((job) => job.projectId === fixture.project.projectId));
  assert.ok(jobs.every((job) => job.customerId === fixture.customer.customerId));
});

test("Rev62 AUD-V5-GAP-02: without a valid approval, the Cold-Start chain's compiled plan stays WAITING and wires zero OutcomeJobs", () => {
  const fixture = buildWebsiteBuildV1ColdStartFixture();
  const readinessAssertions = buildFullReadinessAssertions(
    fixture.tenantScope,
    fixture.project,
    fixture.plan,
  );

  const planAdmission = admitPlan({
    plan: fixture.plan,
    blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
    readinessAssertions,
    // no approval supplied
  });
  assert.equal(planAdmission.status, "WAITING");

  const specs = deriveOutcomeJobSpecs(fixture.plan);
  const jobAdmissions = admitJobs(planAdmission, specs);
  const jobs = wireAdmittedOutcomeJobs({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    planAdmission,
    jobAdmissions,
    specs,
  });
  assert.equal(jobs.length, 0);
});
