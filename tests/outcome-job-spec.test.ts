import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope } from "../src/domain/sold-scope.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { deriveOutcomeJobSpecs } from "../src/domain/outcome-job-spec.js";

const tenantScope = createTenantScope("tenant-a");
const customer = createCustomer({ tenantScope, customerId: "cust-1", displayName: "Acme" });
const project = createProject({
  tenantScope,
  customer,
  projectId: "proj-1",
  ownerRef: "owner-1",
  state: "active",
});

const blueprint = createOfferBlueprintVersion({
  blueprintId: "bp-1",
  version: "1.0.0",
  requirements: [
    { requirementId: "a", description: "A", necessity: "REQUIRED", dependsOn: [] },
    { requirementId: "b", description: "B", necessity: "CONDITIONAL", dependsOn: ["a"] },
    { requirementId: "c", description: "C", necessity: "CONDITIONAL", dependsOn: [] },
  ],
});

test("T6: every generated OutcomeJobSpec preserves tenant/project/plan/blueprint/requirement lineage", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    includedRequirementIds: ["b"],
    excludedRequirementIds: ["c"],
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const specs = deriveOutcomeJobSpecs(plan);
  const bSpec = specs.find((s) => s.requirementId === "b");
  assert.ok(bSpec, "expected an OutcomeJobSpec for requirement b");
  assert.equal(bSpec?.tenantId, tenantScope.tenantId);
  assert.equal(bSpec?.projectId, project.projectId);
  assert.equal(bSpec?.planId, plan.planId);
  assert.equal(bSpec?.planVersion, plan.version);
  assert.equal(bSpec?.sourceBlueprintId, blueprint.blueprintId);
  assert.equal(bSpec?.sourceBlueprintVersion, blueprint.version);
  assert.deepEqual(bSpec?.prerequisites, ["a"]);
});

test("T9: a NOT_APPLICABLE (out-of-scope) requirement produces no OutcomeJobSpec", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    excludedRequirementIds: ["c"],
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const specs = deriveOutcomeJobSpecs(plan);
  assert.equal(specs.some((s) => s.requirementId === "c"), false);
});

test("T9: excluding then including the same requirementId via a new sold scope produces a committed job (authorized scope-change input)", () => {
  const excludedScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    excludedRequirementIds: ["c"],
  });
  const excludedPlan = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope: excludedScope,
    now: "2026-08-18T00:00:00.000Z",
  });
  assert.equal(deriveOutcomeJobSpecs(excludedPlan).some((s) => s.requirementId === "c"), false);

  const includedScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-2",
    outcomeContractRef: "contract-1",
    includedRequirementIds: ["c"],
  });
  const includedPlan = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    version: 2,
    blueprint,
    soldScope: includedScope,
    now: "2026-08-18T01:00:00.000Z",
  });
  assert.equal(deriveOutcomeJobSpecs(includedPlan).some((s) => s.requirementId === "c"), true);
});

test("Brain Rev44 F1 (adversarial): two distinct customer/project identity tuples whose components contain the delimiter character never collide on specId, even though raw ':' concatenation of the same tuples would produce an identical string", () => {
  // customerId="a:b" + projectId="c" and customerId="a" + projectId="b:c"
  // both concatenate to the literal string "a:b:c" under naive
  // `${customerId}:${projectId}` joining - this is the exact Brain Rev44
  // F1 collision shape. Holding planId/version/requirementId constant
  // isolates the identity-tuple encoding as the only thing that can
  // distinguish these two specs.
  const customerA = createCustomer({ tenantScope, customerId: "a:b", displayName: "Customer A" });
  const projectA = createProject({
    tenantScope,
    customer: customerA,
    projectId: "c",
    ownerRef: "owner-a",
    state: "active",
  });
  const customerB = createCustomer({ tenantScope, customerId: "a", displayName: "Customer B" });
  const projectB = createProject({
    tenantScope,
    customer: customerB,
    projectId: "b:c",
    ownerRef: "owner-b",
    state: "active",
  });

  const soldScopeA = createSoldScope({
    tenantScope,
    project: projectA,
    soldScopeId: "scope-a",
    outcomeContractRef: "contract-a",
  });
  const soldScopeB = createSoldScope({
    tenantScope,
    project: projectB,
    soldScopeId: "scope-b",
    outcomeContractRef: "contract-b",
  });
  const planA = compilePlan({
    tenantScope,
    project: projectA,
    planId: "plan-1",
    blueprint,
    soldScope: soldScopeA,
    now: "2026-08-18T00:00:00.000Z",
  });
  const planB = compilePlan({
    tenantScope,
    project: projectB,
    planId: "plan-1",
    blueprint,
    soldScope: soldScopeB,
    now: "2026-08-18T00:00:00.000Z",
  });

  const specA = deriveOutcomeJobSpecs(planA).find((s) => s.requirementId === "a");
  const specB = deriveOutcomeJobSpecs(planB).find((s) => s.requirementId === "a");
  assert.ok(specA, "expected an OutcomeJobSpec for requirement a on planA");
  assert.ok(specB, "expected an OutcomeJobSpec for requirement a on planB");

  // Sanity: prove the OLD raw-concatenation formula genuinely collided on
  // these two tuples, so this test would have failed to catch anything
  // before the Rev44 correction.
  const oldFormulaA = `${customerA.customerId}:${projectA.projectId}:plan-1:v1:a`;
  const oldFormulaB = `${customerB.customerId}:${projectB.projectId}:plan-1:v1:a`;
  assert.equal(oldFormulaA, oldFormulaB, "sanity: the old raw concatenation formula must collide for this adversarial pair");

  assert.notEqual(specA?.specId, specB?.specId);
});

test("an UNKNOWN requirement produces no OutcomeJobSpec (only REQUIRED nodes are committed)", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const specs = deriveOutcomeJobSpecs(plan);
  assert.equal(specs.some((s) => s.requirementId === "b"), false);
  assert.equal(specs.some((s) => s.requirementId === "c"), false);
  assert.equal(specs.some((s) => s.requirementId === "a"), true);
});
