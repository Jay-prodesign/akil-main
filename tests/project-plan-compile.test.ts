import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope } from "../src/domain/sold-scope.js";
import { createCustomerEvidenceItem } from "../src/domain/customer-evidence.js";
import { compilePlan, InvalidProjectPlanError } from "../src/domain/project-plan.js";

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
    { requirementId: "c", description: "C", necessity: "REQUIRED", dependsOn: ["b"] },
    { requirementId: "d", description: "D", necessity: "CONDITIONAL", dependsOn: [] },
  ],
});

test("T1: a valid input compiles to one versioned deterministic plan", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    includedRequirementIds: ["b"],
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope,
    now: "2026-08-18T00:00:00.000Z",
  });
  assert.equal(plan.version, 1);
  assert.equal(plan.status, "DRAFT");
  assert.equal(plan.nodes.length, 4);
  const byId = new Map<string, (typeof plan.nodes)[number]>(plan.nodes.map((n) => [n.requirementId, n]));
  assert.equal(byId.get("a")?.disposition, "REQUIRED");
  assert.equal(byId.get("b")?.disposition, "REQUIRED");
  assert.equal(byId.get("c")?.disposition, "REQUIRED");
  assert.equal(byId.get("d")?.disposition, "UNKNOWN");
});

test("BLOCKED: a REQUIRED node depending on an excluded CONDITIONAL node becomes BLOCKED, not REQUIRED", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    excludedRequirementIds: ["b"],
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const byId = new Map<string, (typeof plan.nodes)[number]>(plan.nodes.map((n) => [n.requirementId, n]));
  assert.equal(byId.get("b")?.disposition, "NOT_APPLICABLE");
  assert.equal(byId.get("c")?.disposition, "BLOCKED");
  assert.match(byId.get("c")?.dispositionReason ?? "", /dependency "b" is not REQUIRED/);
});

test("T3: NOT_APPLICABLE carries an explicit non-empty reason", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    excludedRequirementIds: ["b", "d"],
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const dNode = plan.nodes.find((n) => n.requirementId === "d");
  assert.equal(dNode?.disposition, "NOT_APPLICABLE");
  assert.ok(dNode?.dispositionReason && dNode.dispositionReason.trim().length > 0);
});

test("T7: rejects a soldScope that does not belong to the given tenantScope", () => {
  const otherTenantScope = createTenantScope("tenant-b");
  const otherCustomer = createCustomer({
    tenantScope: otherTenantScope,
    customerId: "cust-2",
    displayName: "Other Co",
  });
  const otherProject = createProject({
    tenantScope: otherTenantScope,
    customer: otherCustomer,
    projectId: "proj-2",
    ownerRef: "owner-2",
    state: "active",
  });
  const otherSoldScope = createSoldScope({
    tenantScope: otherTenantScope,
    project: otherProject,
    soldScopeId: "scope-2",
    outcomeContractRef: "contract-2",
  });
  assert.throws(
    () =>
      compilePlan({
        tenantScope,
        project,
        planId: "plan-1",
        blueprint,
        soldScope: otherSoldScope,
        now: "2026-08-18T00:00:00.000Z",
      }),
    InvalidProjectPlanError,
  );
});

test("T7: rejects evidence that does not belong to the given tenant/project", () => {
  const otherTenantScope = createTenantScope("tenant-b");
  const otherCustomer = createCustomer({
    tenantScope: otherTenantScope,
    customerId: "cust-2",
    displayName: "Other Co",
  });
  const otherProject = createProject({
    tenantScope: otherTenantScope,
    customer: otherCustomer,
    projectId: "proj-2",
    ownerRef: "owner-2",
    state: "active",
  });
  const foreignEvidence = createCustomerEvidenceItem({
    tenantScope: otherTenantScope,
    project: otherProject,
    evidenceRef: "ev-foreign",
    kind: "FACT",
    subject: "belongs to a different tenant/project",
    sourceLocator: "internal://tests",
  });
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
  });
  assert.throws(
    () =>
      compilePlan({
        tenantScope,
        project,
        planId: "plan-1",
        blueprint,
        soldScope,
        evidence: [foreignEvidence],
        now: "2026-08-18T00:00:00.000Z",
      }),
    InvalidProjectPlanError,
  );
});

test("rejects a soldScope referencing an unknown requirementId", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    includedRequirementIds: ["does-not-exist"],
  });
  assert.throws(
    () =>
      compilePlan({
        tenantScope,
        project,
        planId: "plan-1",
        blueprint,
        soldScope,
        now: "2026-08-18T00:00:00.000Z",
      }),
    InvalidProjectPlanError,
  );
});

test("evidence with a relatedRequirementId is attached to the matching PlanNode's evidenceRefs", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    includedRequirementIds: ["b"],
  });
  const evidence = createCustomerEvidenceItem({
    tenantScope,
    project,
    evidenceRef: "ev-1",
    kind: "FACT",
    subject: "supports requirement a",
    sourceLocator: "internal://tests",
    relatedRequirementId: "a",
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-1",
    blueprint,
    soldScope,
    evidence: [evidence],
    now: "2026-08-18T00:00:00.000Z",
  });
  const aNode = plan.nodes.find((n) => n.requirementId === "a");
  assert.deepEqual(aNode?.evidenceRefs, ["ev-1"]);
  const cNode = plan.nodes.find((n) => n.requirementId === "c");
  assert.deepEqual(cNode?.evidenceRefs, []);
});
