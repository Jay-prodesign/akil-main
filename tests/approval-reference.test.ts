import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope } from "../src/domain/sold-scope.js";
import { compilePlan } from "../src/domain/project-plan.js";
import {
  createApprovalReference,
  isApprovalValidForPlan,
} from "../src/domain/approval-reference.js";

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

test("an approval is valid for the exact plan version/payload it was granted against", () => {
  const scope = createSoldScope({
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
    soldScope: scope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-1",
    approvedAt: "2026-08-18T00:05:00.000Z",
    approverRef: "owner:founder",
  });
  assert.equal(isApprovalValidForPlan(approval, plan), true);
});

test("T10: an approval is invalid against a materially changed later plan version", () => {
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
  const approval = createApprovalReference({
    plan: planV1,
    approvalId: "approval-1",
    approvedAt: "2026-08-18T00:05:00.000Z",
    approverRef: "owner:founder",
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

  assert.equal(isApprovalValidForPlan(approval, planV2), false);
});

test("T10: an approval is invalid against a same-version plan reconstructed with different content", () => {
  const scope = createSoldScope({
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
    soldScope: scope,
    now: "2026-08-18T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-1",
    approvedAt: "2026-08-18T00:05:00.000Z",
    approverRef: "owner:founder",
  });

  // Same planId/version, but different node content - a payload-identity
  // mismatch the approval must still fail closed against.
  const tamperedPlan = {
    ...plan,
    nodes: plan.nodes.map((node) =>
      node.requirementId === "b" ? { ...node, disposition: "REQUIRED" as const } : node,
    ),
  };
  assert.equal(isApprovalValidForPlan(approval, tamperedPlan), false);
});
