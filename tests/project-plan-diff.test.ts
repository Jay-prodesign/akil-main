import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope } from "../src/domain/sold-scope.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { diffProjectPlans, InvalidProjectPlanDiffError } from "../src/domain/project-plan-diff.js";

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

test("T8: a material sold-scope change produces a deterministic diff, not an invisible mutation", () => {
  const scopeV1 = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    excludedRequirementIds: ["b"],
  });
  const planV1 = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope: scopeV1,
    now: "2026-08-18T00:00:00.000Z",
  });

  const scopeV2 = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-2",
    outcomeContractRef: "contract-1",
    includedRequirementIds: ["b"],
  });
  const planV2 = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    version: 2,
    blueprint,
    soldScope: scopeV2,
    now: "2026-08-18T01:00:00.000Z",
  });

  const diff = diffProjectPlans(planV1, planV2);
  assert.equal(diff.fromVersion, 1);
  assert.equal(diff.toVersion, 2);
  assert.deepEqual(diff.addedRequirementIds, []);
  assert.deepEqual(diff.removedRequirementIds, []);
  assert.equal(diff.changedRequirements.length, 1);
  assert.equal(diff.changedRequirements[0]?.requirementId, "b");
  assert.equal(diff.changedRequirements[0]?.fromDisposition, "NOT_APPLICABLE");
  assert.equal(diff.changedRequirements[0]?.toDisposition, "REQUIRED");

  // Prior version's own node content is untouched by producing v2/the diff.
  const priorBNode = planV1.nodes.find((n) => n.requirementId === "b");
  assert.equal(priorBNode?.disposition, "NOT_APPLICABLE");
});

test("added/removed requirementIds reflect a blueprint requirement set change across versions", () => {
  const narrowerBlueprint = createOfferBlueprintVersion({
    blueprintId: "bp-1",
    version: "1.0.0",
    requirements: [{ requirementId: "a", description: "A", necessity: "REQUIRED", dependsOn: [] }],
  });
  const scope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
  });
  const planV1 = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint: narrowerBlueprint,
    soldScope: scope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const planV2 = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    version: 2,
    blueprint,
    soldScope: scope,
    now: "2026-08-18T01:00:00.000Z",
  });
  const diff = diffProjectPlans(planV1, planV2);
  assert.deepEqual(diff.addedRequirementIds, ["b"]);
  assert.deepEqual(diff.removedRequirementIds, []);
});

test("rejects diffing two plans with different planIds", () => {
  const scope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
  });
  const planA = compilePlan({
    tenantScope,
    project,
    planId: "plan-a",
    blueprint,
    soldScope: scope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const planB = compilePlan({
    tenantScope,
    project,
    planId: "plan-b",
    blueprint,
    soldScope: scope,
    now: "2026-08-18T00:00:00.000Z",
  });
  assert.throws(() => diffProjectPlans(planA, planB), InvalidProjectPlanDiffError);
});

test("rejects diffing when next.version is not strictly greater than previous.version", () => {
  const scope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
  });
  const planV1 = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope: scope,
    now: "2026-08-18T00:00:00.000Z",
  });
  assert.throws(() => diffProjectPlans(planV1, planV1), InvalidProjectPlanDiffError);
});
