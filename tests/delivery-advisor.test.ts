import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAdvisorResult,
  InvalidAdvisorContextError,
} from "../src/domain/delivery-advisor.js";
import { buildClientProjectSnapshot } from "../src/domain/client-project-snapshot.js";
import { createCapabilityAdmission } from "../src/domain/capability-admission.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { deriveOutcomeJobSpecs } from "../src/domain/outcome-job-spec.js";
import {
  admitServiceCatalogEntry,
  type ServiceCatalogAdmission,
} from "../src/domain/service-catalog-admission.js";
import { bindAdmittedRecipeToPlan } from "../src/domain/delivery-recipe-plan-binding.js";
import type { AdmittedWorker } from "../src/domain/worker-routing-policy.js";
import type { ServiceCatalogEntry } from "../src/domain/commercial-order.js";
import { buildWebsiteBuildV1Fixture, WEBSITE_BUILD_V1_BLUEPRINT } from "../src/fixtures/website-build-v1.js";
import { WEBSITE_BUILD_V1_RECIPE } from "../src/fixtures/website-build-v1-recipe.js";
import { WEBSITE_BUILD_V1_ADVISOR_RESULT } from "../src/fixtures/website-build-v1-advisor.js";
import {
  WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
  WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING,
  WEBSITE_BUILD_V1_BOUND_CLIENT_PROJECT_SNAPSHOT,
  WEBSITE_BUILD_V1_BOUND_JOBS,
  WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START,
} from "../src/fixtures/website-build-v1-recipe-binding.js";

function minimalSnapshot() {
  return buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    project: WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START.project,
    jobs: [],
  });
}

function elevatedWorker(overrides: Partial<AdmittedWorker> = {}): AdmittedWorker {
  return {
    workerId: "authority-delivery-advisor-test",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence:delivery-advisor-test-worker-eval",
    ...overrides,
  };
}

test("A4/A11 reference proof: WEBSITE_BUILD_v1 advisor result is deterministic, reaches L1_RECOMMEND and cites the applicable recipe via a verified binding", () => {
  const again = buildAdvisorResult({
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    snapshot: WEBSITE_BUILD_V1_BOUND_CLIENT_PROJECT_SNAPSHOT,
    binding: WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING,
  });
  assert.deepEqual(again, WEBSITE_BUILD_V1_ADVISOR_RESULT);
  assert.equal(WEBSITE_BUILD_V1_ADVISOR_RESULT.status, "RECOMMENDATIONS_AVAILABLE");
  assert.equal(WEBSITE_BUILD_V1_ADVISOR_RESULT.maturity, "L1_RECOMMEND");
  assert.equal(WEBSITE_BUILD_V1_ADVISOR_RESULT.recommendations.length, 1);
  assert.equal(
    WEBSITE_BUILD_V1_ADVISOR_RESULT.recommendations[0]?.basedOnCapabilityRef,
    "required-access-connections",
  );
  assert.deepEqual(WEBSITE_BUILD_V1_ADVISOR_RESULT.observation.applicableRecipeRef, {
    recipeId: WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING.boundRecipeId,
    version: WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING.consumedRecipeVersion,
  });
});

test("A4: L0 observation preserves overallStatus/nextAction/eta verbatim from the snapshot, including explicit UNKNOWN eta", () => {
  const snapshot = minimalSnapshot();
  const result = buildAdvisorResult({ ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP, snapshot });
  assert.equal(result.observation.overallStatus, snapshot.deliveryStatus.overallStatus);
  assert.deepEqual(result.observation.nextAction, snapshot.nextAction);
  assert.deepEqual(result.observation.eta, { status: "UNKNOWN" });
  assert.equal(result.observation.verifiedCompletedJobCount, 0);
});

test("A3: cross-tenant/customer/project ownership substitution rejects before any observation/recommendation is constructed", () => {
  const snapshot = minimalSnapshot();
  assert.throws(
    () =>
      buildAdvisorResult({
        ownership: createProjectOwnershipRef({
          tenantId: "some-other-tenant",
          customerId: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP.customerId,
          projectId: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP.projectId,
        }),
        snapshot,
      }),
    InvalidAdvisorContextError,
  );
  assert.throws(
    () =>
      buildAdvisorResult({
        ownership: createProjectOwnershipRef({
          tenantId: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP.tenantId,
          customerId: "some-other-customer",
          projectId: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP.projectId,
        }),
        snapshot,
      }),
    InvalidAdvisorContextError,
  );
  assert.throws(
    () =>
      buildAdvisorResult({
        ownership: createProjectOwnershipRef({
          tenantId: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP.tenantId,
          customerId: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP.customerId,
          projectId: "some-other-project",
        }),
        snapshot,
      }),
    InvalidAdvisorContextError,
  );
});

test("A6: zero eligible (VERIFIED_AVAILABLE) capability yields a deterministic UNAVAILABLE result, never a recommendation", () => {
  const snapshot = minimalSnapshot();
  const result = buildAdvisorResult({ ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP, snapshot });
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.maturity, "L0_OBSERVE");
  assert.deepEqual(result.recommendations, []);
  assert.equal(typeof result.unavailableReason, "string");
  assert.equal((result.unavailableReason as string).length > 0, true);
});

test("A5: UNVERIFIED/UNSUPPORTED/INELIGIBLE capabilities are excluded from recommendations and classified into observation-only lists", () => {
  const admissions = [
    createCapabilityAdmission({
      capabilityAdmissionId: "cap-unverified",
      ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
      requiredCapabilityRef: "capability:unverified-one",
      status: "UNVERIFIED",
    }),
    createCapabilityAdmission({
      capabilityAdmissionId: "cap-unsupported",
      ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
      requiredCapabilityRef: "capability:unsupported-one",
      status: "UNSUPPORTED",
    }),
    createCapabilityAdmission({
      capabilityAdmissionId: "cap-ineligible",
      ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
      requiredCapabilityRef: "capability:ineligible-one",
      status: "INELIGIBLE",
    }),
  ];
  const snapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    project: WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START.project,
    jobs: [],
    capabilityAdmissions: admissions,
  });
  const result = buildAdvisorResult({ ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP, snapshot });
  assert.equal(result.status, "UNAVAILABLE");
  assert.deepEqual(result.recommendations, []);
  assert.deepEqual(result.observation.unsupportedCapabilityRefs, ["capability:unsupported-one"]);
  assert.deepEqual(
    [...result.observation.ineligibleCapabilityRefs].sort(),
    ["capability:ineligible-one", "capability:unverified-one"],
  );
});

test("A1 (CXP-001A): a verified binding whose boundJobs share no real job identity with the snapshot is never cited as applicable provenance", () => {
  const snapshot = minimalSnapshot();
  const result = buildAdvisorResult({
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    snapshot,
    binding: WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING,
  });
  assert.equal(result.observation.applicableRecipeRef, undefined);
});

test("CXP-001A (adversarial, contamination): a binding built for a different tenant/project can never become applicable provenance for this project, even though it is a genuinely valid binding elsewhere", () => {
  const otherFixture = buildWebsiteBuildV1Fixture();
  const otherPlan = compilePlan({
    tenantScope: otherFixture.tenantScope,
    project: otherFixture.project,
    planId: "plan-delivery-advisor-cross-tenant",
    blueprint: otherFixture.blueprint,
    soldScope: otherFixture.soldScope,
    evidence: otherFixture.evidence,
    now: "2026-09-10T00:00:00.000Z",
  });
  const otherSpecs = deriveOutcomeJobSpecs(otherPlan);
  const otherCatalogEntry: ServiceCatalogEntry = {
    serviceRef: "service:website-build-cross-tenant",
    blueprintId: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
    blueprintVersion: WEBSITE_BUILD_V1_BLUEPRINT.version,
    recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
    executionRoutingPolicy: "MANUAL_EXECUTION_ALLOWED",
  };
  const otherAdmission: ServiceCatalogAdmission = admitServiceCatalogEntry({
    catalogEntry: otherCatalogEntry,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    authorizingWorker: elevatedWorker(),
    evidenceRef: "evidence:delivery-advisor-cross-tenant",
    admittedAt: "2026-09-10T00:00:00.000Z",
  });
  const otherBinding = bindAdmittedRecipeToPlan({
    admission: otherAdmission,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    plan: otherPlan,
    specs: otherSpecs,
  });

  const result = buildAdvisorResult({
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    snapshot: WEBSITE_BUILD_V1_BOUND_CLIENT_PROJECT_SNAPSHOT,
    binding: otherBinding,
  });
  assert.equal(result.observation.applicableRecipeRef, undefined);
});

test("CXP-001A (adversarial, staleness): a binding for an old plan version cannot ride along on old job ids once the snapshot's working artifact has moved to a newer plan version", () => {
  const newerPlan = compilePlan({
    tenantScope: WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START.tenantScope,
    project: WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START.project,
    planId: WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START.plan.planId,
    version: 2,
    blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
    soldScope: WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START.soldScope,
    now: "2026-09-11T00:00:00.000Z",
  });
  const staleSnapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    project: WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START.project,
    jobs: WEBSITE_BUILD_V1_BOUND_JOBS,
    plan: newerPlan,
  });

  const result = buildAdvisorResult({
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    snapshot: staleSnapshot,
    binding: WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING,
  });
  assert.equal(result.observation.applicableRecipeRef, undefined);
});

test("A7: this module exports no function other than buildAdvisorResult capable of producing an AdvisorResult (no mutation/approve/execute surface)", async () => {
  const moduleExports = await import("../src/domain/delivery-advisor.js");
  const functionExportNames = Object.keys(moduleExports).filter(
    (key) => typeof (moduleExports as Record<string, unknown>)[key] === "function",
  );
  assert.deepEqual(functionExportNames, ["InvalidAdvisorContextError", "buildAdvisorResult"]);
});

test("A9: AdvisorResult carries only the fields this module defines - no secret/internal/margin field leaks through", () => {
  const forbiddenKeys = ["secret", "credential", "token", "password", "margin", "cost", "prompt"];
  const serialized = JSON.stringify(WEBSITE_BUILD_V1_ADVISOR_RESULT).toLowerCase();
  for (const forbidden of forbiddenKeys) {
    assert.equal(serialized.includes(forbidden), false, `found forbidden key fragment "${forbidden}"`);
  }
});
