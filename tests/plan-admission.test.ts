import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope, type SoldScope } from "../src/domain/sold-scope.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { deriveOutcomeJobSpecs } from "../src/domain/outcome-job-spec.js";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import { admitPlan, admitJobs, InvalidPlanAdmissionError } from "../src/domain/plan-admission.js";
import {
  WEBSITE_BUILD_V1_BLUEPRINT,
  buildWebsiteBuildV1Fixture,
} from "../src/fixtures/website-build-v1.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";

function fullyResolvedFixture() {
  return buildWebsiteBuildV1Fixture();
}

function compileFromFixture(soldScope: SoldScope) {
  const fixture = fullyResolvedFixture();
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-admission-test",
    blueprint: fixture.blueprint,
    soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  return { ...fixture, plan };
}

test("T1: a valid, fully-resolved plan with a matching approval admits ADMITTED with every job ADMITTED", () => {
  const fixture = fullyResolvedFixture();
  const { tenantScope, project, blueprint, soldScope } = fixture;
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-t1",
    blueprint,
    soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-t1",
    approvedAt: "2026-08-19T00:00:00.000Z",
    approverRef: "owner:founder",
  });

  const planAdmission = admitPlan({
    plan,
    blueprint,
    readinessAssertions: buildFullReadinessAssertions(tenantScope, project, plan),
    approval,
  });
  assert.equal(planAdmission.status, "ADMITTED");
  assert.equal(planAdmission.evaluatedApprovalId, "approval-t1");

  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);
  assert.equal(jobAdmissions.length, specs.length);
  assert.ok(jobAdmissions.every((j) => j.status === "ADMITTED"));
});

test("T2: a REQUIRED requirement depending on an excluded CONDITIONAL one is BLOCKED with an exact reason; no job is admitted", () => {
  const tenantScope = createTenantScope("tenant-t2");
  const customer = createCustomer({ tenantScope, customerId: "cust-t2", displayName: "T2 Customer" });
  const project = createProject({
    tenantScope,
    customer,
    projectId: "proj-t2",
    ownerRef: "owner-t2",
    state: "active",
  });
  const blueprint = createOfferBlueprintVersion({
    blueprintId: "blueprint-t2",
    version: "1.0.0",
    requirements: [
      { requirementId: "core-required", description: "Core work", necessity: "REQUIRED", dependsOn: ["optional-dependency"] },
      { requirementId: "optional-dependency", description: "Optional prerequisite", necessity: "CONDITIONAL", dependsOn: [] },
    ],
  });
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "sold-scope-t2",
    outcomeContractRef: "outcome-contract-t2",
    excludedRequirementIds: ["optional-dependency"],
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-t2",
    blueprint,
    soldScope,
    now: "2026-08-19T00:00:00.000Z",
  });

  const planAdmission = admitPlan({ plan, blueprint });
  assert.equal(planAdmission.status, "BLOCKED");
  assert.equal(planAdmission.blockedReasons.length, 1);
  assert.match(planAdmission.blockedReasons[0]!, /core-required/);

  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);
  assert.ok(jobAdmissions.every((j) => j.status === "BLOCKED"));
});

test("T3: an unresolved CONDITIONAL scope decision yields WAITING with the exact awaited requirementId/reason; no job is admitted", () => {
  const fixture = fullyResolvedFixture();
  const { tenantScope, project, blueprint } = fixture;
  // Leave "optional-ecommerce-integration" neither included nor excluded.
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "sold-scope-t3",
    outcomeContractRef: "outcome-contract-t3",
    includedRequirementIds: ["optional-multilingual-content"],
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-t3",
    blueprint,
    soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });

  const planAdmission = admitPlan({ plan, blueprint });
  assert.equal(planAdmission.status, "WAITING");
  assert.equal(planAdmission.awaiting?.entity, "optional-ecommerce-integration");
  assert.match(planAdmission.awaiting?.reason ?? "", /UNKNOWN/);

  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);
  assert.ok(jobAdmissions.every((j) => j.status === "WAITING"));
});

test("T3: a fully-resolved but unapproved plan yields WAITING awaiting plan-approval (DEC-135 admission/approval hardening)", () => {
  const { plan, blueprint, tenantScope, project } = compileFromFixture(
    (() => {
      const fixture = fullyResolvedFixture();
      return fixture.soldScope;
    })(),
  );
  const planAdmission = admitPlan({
    plan,
    blueprint,
    readinessAssertions: buildFullReadinessAssertions(tenantScope, project, plan),
  });
  assert.equal(planAdmission.status, "WAITING");
  assert.equal(planAdmission.awaiting?.entity, "plan-approval");
});

test("F1/T2: a REQUIRED requirement with a missing readiness assertion is BLOCKED with an exact reason, even though the plan is otherwise structurally complete and approved", () => {
  const fixture = fullyResolvedFixture();
  const { tenantScope, project, blueprint, soldScope } = fixture;
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-f1-missing",
    blueprint,
    soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-f1-missing",
    approvedAt: "2026-08-19T00:00:00.000Z",
    approverRef: "owner:founder",
  });
  const incompleteReadiness = buildFullReadinessAssertions(tenantScope, project, plan).filter(
    (a) => a.evidence.relatedRequirementId !== "verification",
  );

  const planAdmission = admitPlan({
    plan,
    blueprint,
    readinessAssertions: incompleteReadiness,
    approval,
  });
  assert.equal(planAdmission.status, "BLOCKED");
  assert.equal(planAdmission.blockedReasons.length, 1);
  assert.match(planAdmission.blockedReasons[0]!, /verification/);

  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);
  assert.ok(jobAdmissions.every((j) => j.status === "BLOCKED"));
});

test("T5: an OutcomeJobSpec from a different plan fails closed rather than being silently admitted", () => {
  const fixtureA = fullyResolvedFixture();
  const planA = compilePlan({
    tenantScope: fixtureA.tenantScope,
    project: fixtureA.project,
    planId: "plan-a",
    blueprint: fixtureA.blueprint,
    soldScope: fixtureA.soldScope,
    evidence: fixtureA.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const planAdmissionA = admitPlan({ plan: planA, blueprint: fixtureA.blueprint });

  const fixtureB = fullyResolvedFixture();
  const planB = compilePlan({
    tenantScope: fixtureB.tenantScope,
    project: fixtureB.project,
    planId: "plan-b",
    blueprint: fixtureB.blueprint,
    soldScope: fixtureB.soldScope,
    evidence: fixtureB.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const specsFromPlanB = deriveOutcomeJobSpecs(planB);

  assert.throws(() => admitJobs(planAdmissionA, specsFromPlanB), InvalidPlanAdmissionError);
});

test("T6: a materially changed plan invalidates a stale approval - the newer version cannot inherit the old admission", () => {
  const fixture = fullyResolvedFixture();
  const { tenantScope, project, blueprint } = fixture;
  const planV1 = compilePlan({
    tenantScope,
    project,
    planId: "plan-t6",
    version: 1,
    blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const approvalForV1 = createApprovalReference({
    plan: planV1,
    approvalId: "approval-t6",
    approvedAt: "2026-08-19T00:00:00.000Z",
    approverRef: "owner:founder",
  });
  assert.equal(
    admitPlan({
      plan: planV1,
      blueprint,
      readinessAssertions: buildFullReadinessAssertions(tenantScope, project, planV1),
      approval: approvalForV1,
    }).status,
    "ADMITTED",
  );

  // A materially different sold scope produces a new plan version with
  // different node content - the same approval object cannot admit it.
  const differentSoldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "sold-scope-t6-v2",
    outcomeContractRef: "outcome-contract-t6-v2",
    excludedRequirementIds: ["optional-multilingual-content", "optional-ecommerce-integration"],
  });
  const planV2 = compilePlan({
    tenantScope,
    project,
    planId: "plan-t6",
    version: 2,
    blueprint,
    soldScope: differentSoldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T01:00:00.000Z",
  });

  const planAdmissionV2 = admitPlan({
    plan: planV2,
    blueprint,
    readinessAssertions: buildFullReadinessAssertions(tenantScope, project, planV2),
    approval: approvalForV1,
  });
  assert.equal(planAdmissionV2.status, "WAITING");
  assert.equal(planAdmissionV2.awaiting?.entity, "plan-approval");
});

test("T7/T8: admitPlan is a pure deterministic recomputation - two independent evaluations of the same inputs (simulated restart/replay) produce deep-equal results", () => {
  const fixture = fullyResolvedFixture();
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-t7",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-t7",
    approvedAt: "2026-08-19T00:00:00.000Z",
    approverRef: "owner:founder",
  });
  const readinessAssertions = buildFullReadinessAssertions(
    fixture.tenantScope,
    fixture.project,
    plan,
  );

  const first = admitPlan({ plan, blueprint: fixture.blueprint, readinessAssertions, approval });
  const second = admitPlan({ plan, blueprint: fixture.blueprint, readinessAssertions, approval });
  assert.deepEqual(first, second);
  assert.equal(first.status, "ADMITTED");

  const specs = deriveOutcomeJobSpecs(plan);
  const jobsFirst = admitJobs(first, specs);
  const jobsSecond = admitJobs(second, specs);
  assert.deepEqual(jobsFirst, jobsSecond);
});

test("T9: a BLOCKED or WAITING plan never reports an ADMITTED job", () => {
  const fixture = fullyResolvedFixture();
  const soldScope = createSoldScope({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    soldScopeId: "sold-scope-t9",
    outcomeContractRef: "outcome-contract-t9",
    // Neither included nor excluded -> UNKNOWN -> plan-level WAITING.
  });
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-t9",
    blueprint: fixture.blueprint,
    soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const planAdmission = admitPlan({ plan, blueprint: fixture.blueprint });
  assert.notEqual(planAdmission.status, "ADMITTED");

  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);
  assert.ok(jobAdmissions.every((j) => j.status !== "ADMITTED"));
});

test("sanity: WEBSITE_BUILD_v1 blueprint identity is stable across this test file's independent compilations", () => {
  assert.equal(WEBSITE_BUILD_V1_BLUEPRINT.blueprintId, "website-build-v1");
});
