import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope } from "../src/domain/sold-scope.js";
import { compilePlan, type ProjectPlanVersion } from "../src/domain/project-plan.js";
import {
  validatePlan,
  InvalidPlanValidationInputError,
} from "../src/domain/project-plan-validation.js";

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
    { requirementId: "b", description: "B", necessity: "CONDITIONAL", dependsOn: [] },
  ],
});

function compileWithSoldScope(soldScope: ReturnType<typeof createSoldScope>): ProjectPlanVersion {
  return compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope,
    now: "2026-08-18T00:00:00.000Z",
  });
}

test("COMPLETE: a plan with full REQUIRED coverage and no UNKNOWN/BLOCKED nodes validates COMPLETE", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    excludedRequirementIds: ["b"],
  });
  const plan = compileWithSoldScope(soldScope);
  const result = validatePlan(plan, blueprint);
  assert.equal(result.status, "COMPLETE");
  assert.deepEqual(result.findings, []);
});

test("T4: an UNKNOWN disposition makes the plan INCOMPLETE", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
  });
  const plan = compileWithSoldScope(soldScope);
  const result = validatePlan(plan, blueprint);
  assert.equal(result.status, "INCOMPLETE");
  assert.ok(result.findings.some((f) => f.code === "UNKNOWN_MANDATORY_REQUIREMENT" && f.requirementId === "b"));
});

test("T2: a plan hand-crafted with missing REQUIRED coverage fails completeness validation", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    excludedRequirementIds: ["b"],
  });
  const validPlan = compileWithSoldScope(soldScope);
  // Independently prove the validator itself catches missing REQUIRED
  // coverage, rather than only trusting that the compiler happens to
  // always produce it: construct a plan with node "a" removed entirely.
  const brokenPlan: ProjectPlanVersion = {
    ...validPlan,
    nodes: validPlan.nodes.filter((n) => n.requirementId !== "a"),
  };
  const result = validatePlan(brokenPlan, blueprint);
  assert.equal(result.status, "INCOMPLETE");
  assert.ok(
    result.findings.some((f) => f.code === "MISSING_REQUIRED_COVERAGE" && f.requirementId === "a"),
  );
});

test("T4: a BLOCKED disposition makes the plan INCOMPLETE", () => {
  const dependentBlueprint = createOfferBlueprintVersion({
    blueprintId: "bp-2",
    version: "1.0.0",
    requirements: [
      { requirementId: "x", description: "X", necessity: "CONDITIONAL", dependsOn: [] },
      { requirementId: "y", description: "Y", necessity: "REQUIRED", dependsOn: ["x"] },
    ],
  });
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-2",
    outcomeContractRef: "contract-2",
    excludedRequirementIds: ["x"],
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-2",
    blueprint: dependentBlueprint,
    soldScope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const result = validatePlan(plan, dependentBlueprint);
  assert.equal(result.status, "INCOMPLETE");
  assert.ok(result.findings.some((f) => f.code === "BLOCKED_MANDATORY_REQUIREMENT" && f.requirementId === "y"));
});

test("rejects validating a plan against a blueprint it was not compiled from", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    excludedRequirementIds: ["b"],
  });
  const plan = compileWithSoldScope(soldScope);
  const unrelatedBlueprint = createOfferBlueprintVersion({
    blueprintId: "bp-unrelated",
    version: "1.0.0",
    requirements: [{ requirementId: "z", description: "Z", necessity: "REQUIRED", dependsOn: [] }],
  });
  assert.throws(() => validatePlan(plan, unrelatedBlueprint), InvalidPlanValidationInputError);
});
