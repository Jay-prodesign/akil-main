import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createSoldScope } from "../src/domain/sold-scope.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { deriveOutcomeJobSpecs } from "../src/domain/outcome-job-spec.js";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import { admitPlan, admitJobs } from "../src/domain/plan-admission.js";
import { wireAdmittedOutcomeJobs, InvalidOutcomeJobWiringError } from "../src/domain/outcome-job-wiring.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";

test("T1: an ADMITTED plan wires exactly the REQUIRED-derived OutcomeJobSpecs into DRAFT OutcomeJobs with correct lineage", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-wiring-t1",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-wiring-t1",
    approvedAt: "2026-08-19T00:00:00.000Z",
    approverRef: "owner:founder",
  });
  const planAdmission = admitPlan({
    plan,
    blueprint: fixture.blueprint,
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    approval,
  });
  assert.equal(planAdmission.status, "ADMITTED");
  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);

  const jobs = wireAdmittedOutcomeJobs({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    planAdmission,
    jobAdmissions,
    specs,
  });

  assert.equal(jobs.length, specs.length);
  assert.ok(jobs.every((job) => job.state === "DRAFT"));
  assert.ok(jobs.every((job) => job.tenantId === fixture.tenantScope.tenantId));
  assert.ok(jobs.every((job) => job.projectId === fixture.project.projectId));
  assert.ok(jobs.every((job) => job.customerId === fixture.customer.customerId));
  const jobFamilies = jobs.map((job) => job.jobFamily).sort();
  const specRequirementIds = specs.map((spec) => spec.requirementId).sort();
  assert.deepEqual(jobFamilies, specRequirementIds);
});

test("T9: a BLOCKED or WAITING plan wires zero OutcomeJobs, unconditionally", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const soldScope = createSoldScope({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    soldScopeId: "sold-scope-wiring-t9",
    outcomeContractRef: "outcome-contract-wiring-t9",
    // both conditional requirements left UNKNOWN -> plan-level WAITING
  });
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-wiring-t9",
    blueprint: fixture.blueprint,
    soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const planAdmission = admitPlan({ plan, blueprint: fixture.blueprint });
  assert.equal(planAdmission.status, "WAITING");
  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);

  const jobs = wireAdmittedOutcomeJobs({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    planAdmission,
    jobAdmissions,
    specs,
  });
  assert.deepEqual(jobs, []);
});

test("T4: an unresolved scope decision (WAITING) that is later answered transitions to ADMITTED exactly once; replaying the same answer does not double-create jobs", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const waitingSoldScope = createSoldScope({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    soldScopeId: "sold-scope-t4-waiting",
    outcomeContractRef: "outcome-contract-t4",
    includedRequirementIds: ["optional-multilingual-content"],
    // "optional-ecommerce-integration" intentionally left unresolved.
  });
  const waitingPlan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-t4",
    blueprint: fixture.blueprint,
    soldScope: waitingSoldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const waitingAdmission = admitPlan({ plan: waitingPlan, blueprint: fixture.blueprint });
  assert.equal(waitingAdmission.status, "WAITING");
  assert.equal(waitingAdmission.awaiting?.entity, "optional-ecommerce-integration");

  // The "answer": the customer's scope decision for the awaited
  // requirement is now durably resolved (excluded), producing a new
  // resolved sold scope - exactly the DEL-003 first-slice
  // "authorized scope-change input" pattern.
  const resolvedSoldScope = createSoldScope({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    soldScopeId: "sold-scope-t4-resolved",
    outcomeContractRef: "outcome-contract-t4",
    includedRequirementIds: ["optional-multilingual-content"],
    excludedRequirementIds: ["optional-ecommerce-integration"],
  });
  const resolvedPlan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-t4",
    blueprint: fixture.blueprint,
    soldScope: resolvedSoldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:05:00.000Z",
  });
  const approval = createApprovalReference({
    plan: resolvedPlan,
    approvalId: "approval-t4",
    approvedAt: "2026-08-19T00:05:00.000Z",
    approverRef: "owner:founder",
  });
  const resolvedAdmission = admitPlan({
    plan: resolvedPlan,
    blueprint: fixture.blueprint,
    readinessAssertions: buildFullReadinessAssertions(
      fixture.tenantScope,
      fixture.project,
      resolvedPlan,
    ),
    approval,
  });
  assert.equal(resolvedAdmission.status, "ADMITTED");

  const specs = deriveOutcomeJobSpecs(resolvedPlan);
  const jobAdmissions = admitJobs(resolvedAdmission, specs);

  const wiringInput = {
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    planAdmission: resolvedAdmission,
    jobAdmissions,
    specs,
  };
  const firstResume = wireAdmittedOutcomeJobs(wiringInput);
  // Duplicate/replayed "answer" (identical resolved inputs) - simulates a
  // retried resume signal or a restart re-evaluating the same durable state.
  const replayedResume = wireAdmittedOutcomeJobs(wiringInput);

  assert.deepEqual(firstResume, replayedResume);
  const jobIds = firstResume.map((job) => job.jobId);
  assert.equal(new Set(jobIds).size, jobIds.length, "no duplicate jobId across the wired job set");
});

test("T5: wiring for a different tenant/project than the plan admission fails closed", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-wiring-t5",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-wiring-t5",
    approvedAt: "2026-08-19T00:00:00.000Z",
    approverRef: "owner:founder",
  });
  const planAdmission = admitPlan({
    plan,
    blueprint: fixture.blueprint,
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    approval,
  });
  assert.equal(planAdmission.status, "ADMITTED");
  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);

  // A genuinely different tenant/project (not just a second fixture call,
  // which reuses the same hardcoded reference IDs every time).
  const otherTenantScope = createTenantScope("tenant-t5-other");
  const otherCustomer = createCustomer({
    tenantScope: otherTenantScope,
    customerId: "cust-t5-other",
    displayName: "Other Customer",
  });
  const otherProject = createProject({
    tenantScope: otherTenantScope,
    customer: otherCustomer,
    projectId: "proj-t5-other",
    ownerRef: "owner-t5-other",
    state: "active",
  });
  assert.throws(
    () =>
      wireAdmittedOutcomeJobs({
        tenantScope: otherTenantScope,
        customer: otherCustomer,
        project: otherProject,
        planAdmission,
        jobAdmissions,
        specs,
      }),
    InvalidOutcomeJobWiringError,
  );
});

test("T11: wired OutcomeJob identifiers remain traceable to their exact Project/PlanVersion/requirement lineage", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-wiring-t11",
    version: 3,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-wiring-t11",
    approvedAt: "2026-08-19T00:00:00.000Z",
    approverRef: "owner:founder",
  });
  const planAdmission = admitPlan({
    plan,
    blueprint: fixture.blueprint,
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    approval,
  });
  assert.equal(planAdmission.status, "ADMITTED");
  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);
  const jobs = wireAdmittedOutcomeJobs({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    planAdmission,
    jobAdmissions,
    specs,
  });

  for (const job of jobs) {
    assert.ok(job.jobId.startsWith(`${plan.planId}:v${plan.version}:`));
    assert.ok(job.jobId.includes(job.jobFamily));
  }
});

test("F4: a JobAdmissionResult whose lineage does not match the planAdmission fails closed at the wiring boundary, independently of admitJobs", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-wiring-f4",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-wiring-f4",
    approvedAt: "2026-08-19T00:00:00.000Z",
    approverRef: "owner:founder",
  });
  const planAdmission = admitPlan({
    plan,
    blueprint: fixture.blueprint,
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    approval,
  });
  assert.equal(planAdmission.status, "ADMITTED");
  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);

  // Hand-built, mixed-lineage JobAdmissionResult: correct specId (so it
  // matches a real spec) but a planVersion that does not agree with the
  // planAdmission it is being wired against - exactly the "malformed/mixed
  // JobAdmissionResult lineage" the wiring boundary must independently
  // reject rather than trust from its caller.
  const mismatchedJobAdmissions = [
    { ...jobAdmissions[0]!, planVersion: planAdmission.planVersion + 1 },
  ];
  assert.throws(
    () =>
      wireAdmittedOutcomeJobs({
        tenantScope: fixture.tenantScope,
        customer: fixture.customer,
        project: fixture.project,
        planAdmission,
        jobAdmissions: mismatchedJobAdmissions,
        specs,
      }),
    InvalidOutcomeJobWiringError,
  );

  // A JobAdmissionResult whose requirementId disagrees with the spec it
  // claims to match (specId correct, requirementId swapped for a different
  // real requirement's) must also fail closed rather than silently wiring
  // a job under the wrong requirement.
  const mismatchedRequirement = [
    { ...jobAdmissions[0]!, requirementId: jobAdmissions[1]!.requirementId },
  ];
  assert.throws(
    () =>
      wireAdmittedOutcomeJobs({
        tenantScope: fixture.tenantScope,
        customer: fixture.customer,
        project: fixture.project,
        planAdmission,
        jobAdmissions: mismatchedRequirement,
        specs,
      }),
    InvalidOutcomeJobWiringError,
  );
});
