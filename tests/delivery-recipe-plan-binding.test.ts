import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope } from "../src/domain/sold-scope.js";
import { compilePlan, type ProjectPlanVersion } from "../src/domain/project-plan.js";
import { deriveOutcomeJobSpecs, type OutcomeJobSpec } from "../src/domain/outcome-job-spec.js";
import {
  admitServiceCatalogEntry,
  revokeServiceCatalogAdmission,
  type ServiceCatalogAdmission,
} from "../src/domain/service-catalog-admission.js";
import { createDeliveryRecipe, type DeliveryRecipe } from "../src/domain/delivery-recipe.js";
import type { AdmittedWorker } from "../src/domain/worker-routing-policy.js";
import type { ServiceCatalogEntry } from "../src/domain/commercial-order.js";
import {
  bindAdmittedRecipeToPlan,
  InvalidDeliveryRecipePlanBindingError,
} from "../src/domain/delivery-recipe-plan-binding.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { WEBSITE_BUILD_V1_RECIPE } from "../src/fixtures/website-build-v1-recipe.js";

function elevatedWorker(): AdmittedWorker {
  return {
    workerId: "authority-1",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence:worker-eval-1",
  };
}

function buildWebsiteBuildV1Plan(): { plan: ProjectPlanVersion; specs: ReadonlyArray<OutcomeJobSpec> } {
  const fixture = buildWebsiteBuildV1Fixture();
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-website-build-v1",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-18T00:00:00.000Z",
  });
  return { plan, specs: deriveOutcomeJobSpecs(plan) };
}

function admitWebsiteBuildV1Recipe(
  plan: ProjectPlanVersion,
  recipe: DeliveryRecipe = WEBSITE_BUILD_V1_RECIPE,
): ServiceCatalogAdmission {
  const catalogEntry: ServiceCatalogEntry = {
    serviceRef: "service:website-build-v1",
    blueprintId: plan.sourceBlueprintId,
    blueprintVersion: plan.sourceBlueprintVersion,
    recipeId: recipe.recipeId,
    executionRoutingPolicy: "MANUAL_EXECUTION_ALLOWED",
  };
  return admitServiceCatalogEntry({
    catalogEntry,
    recipe,
    authorizingWorker: elevatedWorker(),
    evidenceRef: "evidence:catalog-review-1",
    admittedAt: "2026-01-01T00:00:00.000Z",
  });
}

// --- AI1: happy path ---

test("AI1: bindAdmittedRecipeToPlan binds an ADMITTED WEBSITE_BUILD_v1 recipe to its compiled plan and job lineage", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const admission = admitWebsiteBuildV1Recipe(plan);
  const binding = bindAdmittedRecipeToPlan({
    admission,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    plan,
    specs,
  });
  assert.equal(binding.tenantId, plan.tenantId);
  assert.equal(binding.projectId, plan.projectId);
  assert.equal(binding.planId, plan.planId);
  assert.equal(binding.planVersion, plan.version);
  assert.equal(binding.serviceRef, "service:website-build-v1");
  assert.equal(binding.blueprintId, plan.sourceBlueprintId);
  assert.equal(binding.blueprintVersion, plan.sourceBlueprintVersion);
  assert.equal(binding.boundRecipeId, WEBSITE_BUILD_V1_RECIPE.recipeId);
  assert.equal(binding.consumedRecipeVersion, WEBSITE_BUILD_V1_RECIPE.version);
  assert.equal(binding.admissionEvidenceRef, "evidence:catalog-review-1");
  assert.equal(binding.boundJobs.length, specs.length);
  assert.ok(specs.length > 0, "expected the reference fixture to produce at least one committed job");
  for (const spec of specs) {
    const jobBinding = binding.boundJobs.find((b) => b.specId === spec.specId);
    assert.ok(jobBinding, `expected a job binding for spec "${spec.specId}"`);
    assert.equal(jobBinding?.requirementId, spec.requirementId);
  }
});

// --- AI2/AI3: wrong blueprint id/version ---

test("AI2 (adversarial): bindAdmittedRecipeToPlan rejects an admission bound to a different blueprintId than the plan's", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const admission = admitWebsiteBuildV1Recipe(plan);
  const mismatched: ServiceCatalogAdmission = {
    ...admission,
    blueprintId: "some-other-blueprint" as ServiceCatalogAdmission["blueprintId"],
  };
  assert.throws(
    () =>
      bindAdmittedRecipeToPlan({
        admission: mismatched,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        plan,
        specs,
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

test("AI3 (adversarial): bindAdmittedRecipeToPlan rejects an admission bound to a different blueprintVersion than the plan's", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const admission = admitWebsiteBuildV1Recipe(plan);
  const mismatched: ServiceCatalogAdmission = {
    ...admission,
    blueprintVersion: "9.9.9" as ServiceCatalogAdmission["blueprintVersion"],
  };
  assert.throws(
    () =>
      bindAdmittedRecipeToPlan({
        admission: mismatched,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        plan,
        specs,
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

// --- AI4: wrong recipeId (invariant 6 - the principal mismatch guard) ---

test("AI4 (adversarial, principal mismatch guard): a caller-supplied recipe with a different recipeId than the admission cannot become authoritative", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const admission = admitWebsiteBuildV1Recipe(plan);
  const otherRecipe = createDeliveryRecipe({
    ...WEBSITE_BUILD_V1_RECIPE,
    recipeId: "some-other-recipe-id",
  });
  assert.throws(
    () =>
      bindAdmittedRecipeToPlan({
        admission,
        recipe: otherRecipe,
        plan,
        specs,
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

// --- AI5: REVOKED admission cannot bind ---

test("AI5 (adversarial): a REVOKED admission can never bind, even if every other field still matches", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const admission = admitWebsiteBuildV1Recipe(plan);
  const revoked = revokeServiceCatalogAdmission({
    admission,
    revokedAt: "2026-02-01T00:00:00.000Z",
    reason: "recipe superseded",
  });
  assert.throws(
    () =>
      bindAdmittedRecipeToPlan({
        admission: revoked,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        plan,
        specs,
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

// --- AI6: wrong project/plan/spec lineage (no cross-plan substitution) ---

test("AI6 (adversarial): a spec from a different plan cannot be smuggled into a binding for this plan", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const admission = admitWebsiteBuildV1Recipe(plan);

  const otherTenantScope = createTenantScope("tenant-other");
  const otherCustomer = createCustomer({
    tenantScope: otherTenantScope,
    customerId: "cust-other",
    displayName: "Other Co",
  });
  const otherProject = createProject({
    tenantScope: otherTenantScope,
    customer: otherCustomer,
    projectId: "proj-other",
    ownerRef: "owner-other",
    state: "active",
  });
  const otherBlueprint = createOfferBlueprintVersion({
    blueprintId: plan.sourceBlueprintId,
    version: plan.sourceBlueprintVersion,
    requirements: [
      { requirementId: "discovery-evidence-intake", description: "d", necessity: "REQUIRED", dependsOn: [] },
    ],
  });
  const otherSoldScope = createSoldScope({
    tenantScope: otherTenantScope,
    project: otherProject,
    soldScopeId: "scope-other",
    outcomeContractRef: "contract-other",
  });
  const otherPlan = compilePlan({
    tenantScope: otherTenantScope,
    project: otherProject,
    planId: "plan-other",
    blueprint: otherBlueprint,
    soldScope: otherSoldScope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const otherSpecs = deriveOutcomeJobSpecs(otherPlan);
  assert.ok(otherSpecs.length > 0);

  assert.throws(
    () =>
      bindAdmittedRecipeToPlan({
        admission,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        plan,
        specs: [...specs, ...otherSpecs],
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

// --- AI7: duplicate/replay deterministic equality ---

test("AI7: bindAdmittedRecipeToPlan is deterministic - replaying the exact same inputs produces a deep-equal binding", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const admission = admitWebsiteBuildV1Recipe(plan);
  const first = bindAdmittedRecipeToPlan({ admission, recipe: WEBSITE_BUILD_V1_RECIPE, plan, specs });
  const second = bindAdmittedRecipeToPlan({ admission, recipe: WEBSITE_BUILD_V1_RECIPE, plan, specs });
  assert.deepEqual(first, second);
});

// --- AI8: recipe-version provenance honesty ---

test("AI8 (provenance honesty): consumedRecipeVersion records the concrete recipe version bound, not an admission-level version claim", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const versionedRecipe = createDeliveryRecipe({ ...WEBSITE_BUILD_V1_RECIPE, version: 7 });
  const catalogEntry: ServiceCatalogEntry = {
    serviceRef: "service:website-build-v1",
    blueprintId: plan.sourceBlueprintId,
    blueprintVersion: plan.sourceBlueprintVersion,
    recipeId: versionedRecipe.recipeId,
    executionRoutingPolicy: "MANUAL_EXECUTION_ALLOWED",
  };
  const admission = admitServiceCatalogEntry({
    catalogEntry,
    recipe: versionedRecipe,
    authorizingWorker: elevatedWorker(),
    evidenceRef: "evidence:catalog-review-1",
    admittedAt: "2026-01-01T00:00:00.000Z",
  });
  // ServiceCatalogAdmission structurally carries recipeId only, never a
  // version - so there is no admission-level version to even disagree with.
  assert.equal((admission as unknown as Record<string, unknown>)["recipeVersion"], undefined);
  const binding = bindAdmittedRecipeToPlan({ admission, recipe: versionedRecipe, plan, specs });
  assert.equal(binding.consumedRecipeVersion, 7);
});

// --- AI10/AI11/AI12 (Brain PR #65 F1, adversarial): canonical derived-spec authenticity + completeness ---

test("AI10 (Brain F1, adversarial): a forged same-lineage spec with an altered requirementId/intendedOutcome cannot be bound as canonical job provenance", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const admission = admitWebsiteBuildV1Recipe(plan);
  const forged: OutcomeJobSpec[] = specs.map((spec, i) =>
    i === 0 ? { ...spec, intendedOutcome: "a fabricated outcome the plan never actually required" } : spec,
  );
  assert.throws(
    () =>
      bindAdmittedRecipeToPlan({
        admission,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        plan,
        specs: forged,
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

test("AI11 (Brain F1, adversarial): omitting one canonically-derived required spec cannot be bound - completeness is required, not just per-spec lineage", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const admission = admitWebsiteBuildV1Recipe(plan);
  assert.ok(specs.length > 1, "expected more than one committed job for this omission test to be meaningful");
  assert.throws(
    () =>
      bindAdmittedRecipeToPlan({
        admission,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        plan,
        specs: specs.slice(1),
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

test("AI12 (Brain F1, adversarial): a duplicated spec substituting for a different required spec cannot be bound, even when the total count matches", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const admission = admitWebsiteBuildV1Recipe(plan);
  assert.ok(specs.length > 1, "expected more than one committed job for this duplicate-substitution test to be meaningful");
  const withDuplicate: OutcomeJobSpec[] = [...specs.slice(0, -1), specs[0] as OutcomeJobSpec];
  assert.throws(
    () =>
      bindAdmittedRecipeToPlan({
        admission,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        plan,
        specs: withDuplicate,
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

// --- AI9: recipe.jobFamily incompatible with the plan's blueprint ---

test("AI9 (adversarial): a recipe whose jobFamily is incompatible with the plan's blueprint cannot bind, even with matching recipeId/blueprint/version", () => {
  const { plan, specs } = buildWebsiteBuildV1Plan();
  const incompatibleRecipe = createDeliveryRecipe({
    ...WEBSITE_BUILD_V1_RECIPE,
    jobFamily: "some-unrelated-job-family",
  });
  const catalogEntry: ServiceCatalogEntry = {
    serviceRef: "service:website-build-v1",
    blueprintId: plan.sourceBlueprintId,
    blueprintVersion: plan.sourceBlueprintVersion,
    recipeId: incompatibleRecipe.recipeId,
    executionRoutingPolicy: "MANUAL_EXECUTION_ALLOWED",
  };
  const admission = admitServiceCatalogEntry({
    catalogEntry,
    recipe: incompatibleRecipe,
    authorizingWorker: elevatedWorker(),
    evidenceRef: "evidence:catalog-review-1",
    admittedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.throws(
    () =>
      bindAdmittedRecipeToPlan({
        admission,
        recipe: incompatibleRecipe,
        plan,
        specs,
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});
