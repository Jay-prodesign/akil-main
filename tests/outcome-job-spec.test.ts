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
