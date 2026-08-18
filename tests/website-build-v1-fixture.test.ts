import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWebsiteBuildV1Fixture, WEBSITE_BUILD_V1_BLUEPRINT } from "../src/fixtures/website-build-v1.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { validatePlan } from "../src/domain/project-plan-validation.js";
import { deriveOutcomeJobSpecs } from "../src/domain/outcome-job-spec.js";

test("T1 reference proof: WEBSITE_BUILD_v1 compiles end-to-end to one COMPLETE deterministic plan", () => {
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

  assert.equal(plan.nodes.length, WEBSITE_BUILD_V1_BLUEPRINT.requirements.length);

  const validation = validatePlan(plan, fixture.blueprint);
  assert.equal(validation.status, "COMPLETE");
  assert.deepEqual(validation.findings, []);

  const byId = new Map<string, (typeof plan.nodes)[number]>(plan.nodes.map((n) => [n.requirementId, n]));
  assert.equal(byId.get("optional-multilingual-content")?.disposition, "REQUIRED");
  assert.equal(byId.get("optional-ecommerce-integration")?.disposition, "NOT_APPLICABLE");
  assert.equal(byId.get("verification")?.disposition, "REQUIRED");

  // discovery-evidence-intake evidence lineage is preserved.
  assert.deepEqual(byId.get("discovery-evidence-intake")?.evidenceRefs, ["ev-brand-guidelines"]);
});

test("T1 reference proof: recompiling the same fixture inputs produces an identical deterministic plan", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const planA = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-website-build-v1",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-18T00:00:00.000Z",
  });
  const planB = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-website-build-v1",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-18T00:00:00.000Z",
  });
  assert.deepEqual(planA, planB);
});

test("T13: WEBSITE_BUILD_v1 committed OutcomeJobSpecs carry telemetry-compatible Project/PlanVersion/Job attribution identifiers", () => {
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
  const specs = deriveOutcomeJobSpecs(plan);
  assert.ok(specs.length > 0, "expected at least one committed OutcomeJobSpec");
  for (const spec of specs) {
    assert.ok(spec.tenantId.length > 0, "tenantId identifier must be present");
    assert.ok(spec.projectId.length > 0, "projectId identifier must be present");
    assert.ok(spec.planId.length > 0, "planId identifier must be present");
    assert.ok(spec.planVersion > 0, "planVersion identifier must be present");
    assert.ok(spec.specId.length > 0, "specId (job attribution identifier) must be present");
  }
  // No cost/billing calculation is performed anywhere in this bounded
  // slice - OutcomeJobSpec carries identifiers only, never a cost value.
  for (const spec of specs) {
    assert.equal("cost" in spec, false);
    assert.equal("price" in spec, false);
  }
});
