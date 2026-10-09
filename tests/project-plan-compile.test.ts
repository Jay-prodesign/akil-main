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

test("CXP-001H (adversarial): rejects a soldScope belonging to a different customer within the SAME tenant, even when projectId values collide across customers", () => {
  const otherCustomer = createCustomer({
    tenantScope,
    customerId: "cust-other-plan-compile",
    displayName: "Other Customer, Same Tenant",
  });
  // Deliberately reuses the SAME projectId ("proj-1") from a different
  // customer, so this case is caught ONLY by a customerId check - a
  // tenantId or projectId check alone would not distinguish it
  // (project.ts does not enforce projectId global uniqueness across
  // customers).
  const otherCustomerProject = createProject({
    tenantScope,
    customer: otherCustomer,
    projectId: project.projectId,
    ownerRef: "owner-other-customer",
    state: "active",
  });
  const otherCustomerSoldScope = createSoldScope({
    tenantScope,
    project: otherCustomerProject,
    soldScopeId: "scope-other-customer",
    outcomeContractRef: "contract-other-customer",
  });
  assert.throws(
    () =>
      compilePlan({
        tenantScope,
        project, // cust-1's proj-1
        planId: "plan-1",
        blueprint,
        soldScope: otherCustomerSoldScope, // other customer's own proj-1-named project
        now: "2026-08-18T00:00:00.000Z",
      }),
    InvalidProjectPlanError,
  );
});

test("CXP-001H (adversarial): rejects evidence belonging to a different customer within the SAME tenant, even when projectId values collide across customers", () => {
  const otherCustomer = createCustomer({
    tenantScope,
    customerId: "cust-other-plan-compile-evidence",
    displayName: "Other Customer, Same Tenant",
  });
  const otherCustomerProject = createProject({
    tenantScope,
    customer: otherCustomer,
    projectId: project.projectId,
    ownerRef: "owner-other-customer-evidence",
    state: "active",
  });
  const otherCustomerEvidence = createCustomerEvidenceItem({
    tenantScope,
    project: otherCustomerProject,
    evidenceRef: "ev-other-customer",
    kind: "FACT",
    subject: "belongs to a different customer, same tenant/projectId string",
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
        evidence: [otherCustomerEvidence],
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
