import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createOwnershipAssignment } from "../src/domain/ownership-assignment.js";
import type { WorkerRoutingDecision } from "../src/domain/worker-routing-policy.js";
import {
  bindAccountableOwnerToAutomationAction,
  escalateAutomationActionToHuman,
  transitionAutomationAction,
  resolveSupportBurden,
  InvalidAutomationActionError,
  InvalidAutomationTransitionError,
} from "../src/domain/automation-operating-integration.js";

const tenantScope = createTenantScope("tenant-aut-1");
const otherTenantScope = createTenantScope("tenant-aut-other");
const ownership = createProjectOwnershipRef({ tenantId: "tenant-aut-1", customerId: "customer-1", projectId: "project-1" });

function routedDecision(workerId = "worker-1"): WorkerRoutingDecision {
  return {
    requiredCapabilityRef: "cap:x",
    riskLevel: "STANDARD",
    status: "ROUTED",
    executorWorkerId: workerId,
    reason: "eligible",
  };
}

function rejectedDecision(): WorkerRoutingDecision {
  return {
    requiredCapabilityRef: "cap:x",
    riskLevel: "STANDARD",
    status: "REJECTED",
    reason: "no eligible worker",
  };
}

function membership(id: string, scope = tenantScope) {
  return createOrganizationMembership({ membershipId: id, tenantScope: scope, principalRef: `principal-${id}`, role: "STAFF" });
}

function ownerAssignment(id: string, role: "ACCOUNT_OWNER" | "DELIVERY_OWNER", m = membership(`owner-${id}`)) {
  return createOwnershipAssignment({
    ownershipAssignmentId: `assignment-${id}`,
    membership: m,
    ownership,
    ownerRole: role,
    assignedAt: "2026-09-01T00:00:00.000Z",
  });
}

// --- bindAccountableOwnerToAutomationAction ---

test("A1: binds an AUTOMATED action to the currently active DELIVERY_OWNER", () => {
  const owner = ownerAssignment("1", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision("worker-1"),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-1",
  });
  assert.equal(action.status, "AUTOMATED");
  assert.equal(action.executorWorkerId, "worker-1");
  assert.equal(action.accountableOwnerMembershipId, owner.membershipId);
  assert.equal(action.everRequiredManualFallback, false);
});

test("A2 (adversarial: nothing to bind): bindAccountableOwnerToAutomationAction fails closed on a REJECTED routing decision", () => {
  const owner = ownerAssignment("2", "DELIVERY_OWNER");
  assert.throws(
    () =>
      bindAccountableOwnerToAutomationAction({
        tenantScope,
        ownership,
        routingDecision: rejectedDecision(),
        ownerHistory: [owner],
        accountableOwnerRole: "DELIVERY_OWNER",
        actionRef: "action-2",
      }),
    InvalidAutomationActionError,
  );
});

test("A3 (never ownerless): bindAccountableOwnerToAutomationAction fails closed when no active owner exists for the required role", () => {
  assert.throws(
    () =>
      bindAccountableOwnerToAutomationAction({
        tenantScope,
        ownership,
        routingDecision: routedDecision(),
        ownerHistory: [],
        accountableOwnerRole: "DELIVERY_OWNER",
        actionRef: "action-3",
      }),
    InvalidAutomationActionError,
  );
});

test("A4: bindAccountableOwnerToAutomationAction rejects LEAD_OWNER/DEAL_OWNER as an accountable role", () => {
  const owner = ownerAssignment("4", "DELIVERY_OWNER");
  assert.throws(
    () =>
      bindAccountableOwnerToAutomationAction({
        tenantScope,
        ownership,
        routingDecision: routedDecision(),
        ownerHistory: [owner],
        accountableOwnerRole: "LEAD_OWNER",
        actionRef: "action-4",
      }),
    InvalidAutomationActionError,
  );
});

test("A5: binds correctly to ACCOUNT_OWNER (not just DELIVERY_OWNER)", () => {
  const owner = ownerAssignment("5", "ACCOUNT_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "ACCOUNT_OWNER",
    actionRef: "action-5",
  });
  assert.equal(action.accountableOwnerRole, "ACCOUNT_OWNER");
});

test("A6 (adversarial cross-tenant ownership scope): bindAccountableOwnerToAutomationAction fails closed when ownership does not match tenantScope", () => {
  const owner = ownerAssignment("6", "DELIVERY_OWNER");
  assert.throws(
    () =>
      bindAccountableOwnerToAutomationAction({
        tenantScope: otherTenantScope,
        ownership,
        routingDecision: routedDecision(),
        ownerHistory: [owner],
        accountableOwnerRole: "DELIVERY_OWNER",
        actionRef: "action-6",
      }),
    InvalidAutomationActionError,
  );
});

// --- escalateAutomationActionToHuman ---

test("A7: escalateAutomationActionToHuman moves an AUTOMATED action to HANDED_OFF_TO_HUMAN and records a handoff", () => {
  const owner = ownerAssignment("7", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-7",
  });
  const escalationTarget = membership("escalate-7");
  const { action: escalated, handoff } = escalateAutomationActionToHuman({
    action,
    escalatedTo: escalationTarget,
    escalationReason: "automation could not resolve an ambiguous case",
    escalatedAt: "2026-09-01T01:00:00.000Z",
  });
  assert.equal(escalated.status, "HANDED_OFF_TO_HUMAN");
  assert.equal(escalated.everRequiredManualFallback, true);
  assert.equal(handoff.escalatedToMembershipId, escalationTarget.membershipId);
  assert.equal(handoff.escalationReason, "automation could not resolve an ambiguous case");
});

test("A8 (adversarial re-escalation): escalateAutomationActionToHuman fails closed on an action already HANDED_OFF_TO_HUMAN", () => {
  const owner = ownerAssignment("8", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-8",
  });
  const { action: escalated } = escalateAutomationActionToHuman({
    action,
    escalatedTo: membership("escalate-8"),
    escalationReason: "reason",
    escalatedAt: "2026-09-01T01:00:00.000Z",
  });
  assert.throws(
    () =>
      escalateAutomationActionToHuman({
        action: escalated,
        escalatedTo: membership("escalate-8-again"),
        escalationReason: "reason again",
        escalatedAt: "2026-09-01T02:00:00.000Z",
      }),
    InvalidAutomationTransitionError,
  );
});

test("A9 (adversarial cross-tenant escalation target): escalateAutomationActionToHuman fails closed when the escalation target belongs to a different tenant", () => {
  const owner = ownerAssignment("9", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-9",
  });
  const foreignMembership = membership("foreign-9", otherTenantScope);
  assert.throws(
    () =>
      escalateAutomationActionToHuman({
        action,
        escalatedTo: foreignMembership,
        escalationReason: "reason",
        escalatedAt: "2026-09-01T01:00:00.000Z",
      }),
    InvalidAutomationTransitionError,
  );
});

test("A10: escalateAutomationActionToHuman rejects an empty escalationReason", () => {
  const owner = ownerAssignment("10", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-10",
  });
  assert.throws(
    () =>
      escalateAutomationActionToHuman({
        action,
        escalatedTo: membership("escalate-10"),
        escalationReason: "",
        escalatedAt: "2026-09-01T01:00:00.000Z",
      }),
    InvalidAutomationActionError,
  );
});

// --- transitionAutomationAction ---

test("A11: AUTOMATED can transition directly to COMPLETED (no handoff needed)", () => {
  const owner = ownerAssignment("11", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-11",
  });
  const completed = transitionAutomationAction({ action, to: "COMPLETED" });
  assert.equal(completed.status, "COMPLETED");
});

test("A12: HANDED_OFF_TO_HUMAN can transition to FAILED", () => {
  const owner = ownerAssignment("12", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-12",
  });
  const { action: escalated } = escalateAutomationActionToHuman({
    action,
    escalatedTo: membership("escalate-12"),
    escalationReason: "reason",
    escalatedAt: "2026-09-01T01:00:00.000Z",
  });
  const failed = transitionAutomationAction({ action: escalated, to: "FAILED" });
  assert.equal(failed.status, "FAILED");
});

test("A13 (adversarial illegal transition): AUTOMATED cannot transition directly to HANDED_OFF_TO_HUMAN via transitionAutomationAction - only escalateAutomationActionToHuman produces that state", () => {
  const owner = ownerAssignment("13", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-13",
  });
  assert.throws(() => transitionAutomationAction({ action, to: "HANDED_OFF_TO_HUMAN" }), InvalidAutomationTransitionError);
});

test("A14 (terminal is terminal): a COMPLETED action cannot transition further", () => {
  const owner = ownerAssignment("14", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-14",
  });
  const completed = transitionAutomationAction({ action, to: "COMPLETED" });
  assert.throws(() => transitionAutomationAction({ action: completed, to: "FAILED" }), InvalidAutomationTransitionError);
});

// --- resolveSupportBurden ---

test("A15 (missing-vs-zero-style support-burden signal): resolveSupportBurden is NONE for an action that never required escalation", () => {
  const owner = ownerAssignment("15", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-15",
  });
  const completed = transitionAutomationAction({ action, to: "COMPLETED" });
  assert.equal(resolveSupportBurden(completed), "NONE");
});

test("A16: resolveSupportBurden is MANUAL_FALLBACK_REQUIRED for an action that was ever escalated, even after it later COMPLETED", () => {
  const owner = ownerAssignment("16", "DELIVERY_OWNER");
  const action = bindAccountableOwnerToAutomationAction({
    tenantScope,
    ownership,
    routingDecision: routedDecision(),
    ownerHistory: [owner],
    accountableOwnerRole: "DELIVERY_OWNER",
    actionRef: "action-16",
  });
  const { action: escalated } = escalateAutomationActionToHuman({
    action,
    escalatedTo: membership("escalate-16"),
    escalationReason: "reason",
    escalatedAt: "2026-09-01T01:00:00.000Z",
  });
  const completed = transitionAutomationAction({ action: escalated, to: "COMPLETED" });
  assert.equal(resolveSupportBurden(completed), "MANUAL_FALLBACK_REQUIRED");
});
