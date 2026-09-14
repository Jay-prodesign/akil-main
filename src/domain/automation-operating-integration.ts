import type { TenantScope } from "./tenant-scope.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { OrganizationMembership } from "./organization-membership.js";
import type { OwnershipAssignment, OwnerRole } from "./ownership-assignment.js";
import { resolveCurrentOwner } from "./ownership-assignment.js";
import type { WorkerRoutingDecision, AdmittedWorker } from "./worker-routing-policy.js";

export class InvalidAutomationActionError extends Error {
  constructor(reason: string) {
    super(`Invalid automation action: ${reason}`);
    this.name = "InvalidAutomationActionError";
  }
}

export class InvalidAutomationTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid automation action transition: ${reason}`);
    this.name = "InvalidAutomationTransitionError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidAutomationActionError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Rev98 gap-audit Family 9 ("V4 WORKSTREAM G — ACCOUNT-MANAGER +
 * AUTOMATION OPERATING INTEGRATION"): *"Reuse V3 AccountOwner/
 * DeliveryOwner, attention and worker routing. Close only missing
 * integration semantics for accountable owner on automation actions,
 * explicit automation<->human handoff/escalation, manual fallback/
 * support-burden observability and separation between human ownership
 * and worker identity."*
 *
 * This module composes three already-merged modules unmodified -
 * `ownership-assignment.ts` (`OwnershipAssignment`/`resolveCurrentOwner`),
 * `worker-routing-policy.ts` (`WorkerRoutingDecision`/`AdmittedWorker`),
 * and `organization-membership.ts` (`OrganizationMembership`) - rather
 * than inventing a second ownership or worker-identity model. Only
 * `ACCOUNT_OWNER`/`DELIVERY_OWNER` (the operational/delivery roles) are
 * eligible accountable owners here; `LEAD_OWNER`/`DEAL_OWNER` are
 * pre-sale roles with no bearing on who is accountable for an
 * already-executing automated action.
 *
 * "Separation between human ownership and worker identity" is structural
 * throughout: every function that names an accountable human always
 * takes a full `OrganizationMembership`/`OwnershipAssignment` object
 * (resolved from real domain state, never a bare caller-supplied id
 * string), while an automated executor is always identified only via
 * `WorkerRoutingDecision["executorWorkerId"]` - the two identifier
 * spaces are never accepted interchangeably anywhere in this module
 * (verified by the boundary scan's own signature inspection).
 */
export type AccountableOwnerRole = Extract<OwnerRole, "ACCOUNT_OWNER" | "DELIVERY_OWNER">;

const ACCOUNTABLE_OWNER_ROLES: ReadonlySet<AccountableOwnerRole> = new Set(["ACCOUNT_OWNER", "DELIVERY_OWNER"]);

/**
 * §"automation<->human handoff/escalation": a strictly closed lifecycle.
 * `AUTOMATED` is the only state a newly bound action can start in; only
 * an `AUTOMATED` action can be escalated to `HANDED_OFF_TO_HUMAN`
 * (escalating an already-resolved or already-escalated action makes no
 * sense and fails closed); both `AUTOMATED` and `HANDED_OFF_TO_HUMAN`
 * can resolve to the terminal `COMPLETED`/`FAILED` states.
 */
export type AutomationActionStatus = "AUTOMATED" | "HANDED_OFF_TO_HUMAN" | "COMPLETED" | "FAILED";

const AUTOMATION_ACTION_TRANSITIONS: ReadonlyMap<AutomationActionStatus, ReadonlySet<AutomationActionStatus>> = new Map([
  ["AUTOMATED", new Set<AutomationActionStatus>(["COMPLETED", "FAILED"])],
  ["HANDED_OFF_TO_HUMAN", new Set<AutomationActionStatus>(["COMPLETED", "FAILED"])],
  ["COMPLETED", new Set<AutomationActionStatus>()],
  ["FAILED", new Set<AutomationActionStatus>()],
]);

/**
 * §"manual fallback/support-burden observability": `everRequiredManualFallback`
 * is set exactly once, by `escalateAutomationActionToHuman`, and is
 * never cleared by any subsequent transition - it is the durable record
 * of whether this action's automation was ever insufficient on its own,
 * regardless of how the action eventually resolved. This module computes
 * no aggregate/rate itself (that composition belongs to a real telemetry
 * caller, e.g. a future `OBS-TEL-001` wiring - explicitly deferred, not
 * fabricated here); `resolveSupportBurden` below is the one-action-at-a-
 * time primitive such a caller would use.
 */
export interface AccountableAutomationAction {
  readonly tenantId: TenantScope["tenantId"];
  readonly ownership: ProjectOwnershipRef;
  readonly actionRef: string;
  readonly executorWorkerId: AdmittedWorker["workerId"];
  readonly accountableOwnerMembershipId: OrganizationMembership["membershipId"];
  readonly accountableOwnerRole: AccountableOwnerRole;
  readonly status: AutomationActionStatus;
  readonly everRequiredManualFallback: boolean;
}

/**
 * §"accountable owner on automation actions": an automated action can
 * only ever be bound once a `WorkerRoutingDecision` has genuinely
 * `ROUTED` (a `REJECTED` decision has no executor to bind - fails
 * closed), and only when a real, currently-active `ACCOUNT_OWNER` or
 * `DELIVERY_OWNER` assignment exists for the target `ownership` scope
 * (resolved via the existing, unmodified `resolveCurrentOwner` - no
 * second ownership-resolution mechanism). An automated action can never
 * be represented as "ownerless."
 */
export function bindAccountableOwnerToAutomationAction(input: {
  tenantScope: TenantScope;
  ownership: ProjectOwnershipRef;
  routingDecision: WorkerRoutingDecision;
  ownerHistory: ReadonlyArray<OwnershipAssignment>;
  accountableOwnerRole: unknown;
  actionRef: unknown;
}): AccountableAutomationAction {
  if (input.ownership.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidAutomationActionError("ownership scope does not match the given tenantScope");
  }
  if (input.routingDecision.status !== "ROUTED" || input.routingDecision.executorWorkerId === undefined) {
    throw new InvalidAutomationActionError(
      "cannot bind an accountable owner to a routing decision that was not ROUTED - there is no automated executor to be accountable for",
    );
  }
  if (!ACCOUNTABLE_OWNER_ROLES.has(input.accountableOwnerRole as AccountableOwnerRole)) {
    throw new InvalidAutomationActionError('accountableOwnerRole must be "ACCOUNT_OWNER" or "DELIVERY_OWNER"');
  }
  const accountableOwnerRole = input.accountableOwnerRole as AccountableOwnerRole;
  const owner = resolveCurrentOwner({
    history: input.ownerHistory,
    ownership: input.ownership,
    ownerRole: accountableOwnerRole,
  });
  if (owner === undefined) {
    throw new InvalidAutomationActionError(
      `cannot bind an automated action to ${accountableOwnerRole} - no active owner is currently assigned for this ownership scope, and an automated action can never proceed ownerless`,
    );
  }
  const actionRef = requireNonEmptyString(input.actionRef, "actionRef");
  return {
    tenantId: input.tenantScope.tenantId,
    ownership: input.ownership,
    actionRef,
    executorWorkerId: input.routingDecision.executorWorkerId,
    accountableOwnerMembershipId: owner.membershipId,
    accountableOwnerRole,
    status: "AUTOMATED",
    everRequiredManualFallback: false,
  };
}

/**
 * §"explicit automation<->human handoff/escalation": the only function
 * that can move an action into `HANDED_OFF_TO_HUMAN`. Fails closed
 * unless the action is still `AUTOMATED` (an action already handed off,
 * completed, or failed cannot be escalated again - a genuinely new
 * escalation requires a new action, matching this codebase's own
 * "terminal/in-progress state is never silently re-entered" discipline),
 * the escalation target is a real `OrganizationMembership` of the exact
 * same tenant as the action (cross-tenant escalation fails closed - no
 * bare id string is ever accepted as an escalation target), and a
 * non-empty `escalationReason` is supplied - a caller can never observe
 * a human handoff with no explanation of why automation was insufficient.
 */
export interface AutomationHandoffRecord {
  readonly actionRef: string;
  readonly escalatedToMembershipId: OrganizationMembership["membershipId"];
  readonly escalationReason: string;
  readonly escalatedAt: string;
}

export function escalateAutomationActionToHuman(input: {
  action: AccountableAutomationAction;
  escalatedTo: OrganizationMembership;
  escalationReason: unknown;
  escalatedAt: unknown;
}): { action: AccountableAutomationAction; handoff: AutomationHandoffRecord } {
  if (input.action.status !== "AUTOMATED") {
    throw new InvalidAutomationTransitionError(
      `only an AUTOMATED action can be escalated to a human (current status: ${input.action.status})`,
    );
  }
  if (input.escalatedTo.tenantId !== input.action.tenantId) {
    throw new InvalidAutomationTransitionError("escalation target belongs to a different tenant than the automation action");
  }
  const escalationReason = requireNonEmptyString(input.escalationReason, "escalationReason");
  const escalatedAt = requireNonEmptyString(input.escalatedAt, "escalatedAt");
  const action: AccountableAutomationAction = {
    ...input.action,
    status: "HANDED_OFF_TO_HUMAN",
    everRequiredManualFallback: true,
  };
  const handoff: AutomationHandoffRecord = {
    actionRef: input.action.actionRef,
    escalatedToMembershipId: input.escalatedTo.membershipId,
    escalationReason,
    escalatedAt,
  };
  return { action, handoff };
}

/**
 * Resolves either terminal outcome from `AUTOMATED` or
 * `HANDED_OFF_TO_HUMAN`, preserving `everRequiredManualFallback`
 * verbatim - a fallback that already happened is never erased merely
 * because the action later succeeded.
 */
export function transitionAutomationAction(input: {
  action: AccountableAutomationAction;
  to: unknown;
}): AccountableAutomationAction {
  const allowed = AUTOMATION_ACTION_TRANSITIONS.get(input.action.status);
  if (allowed === undefined || !allowed.has(input.to as AutomationActionStatus)) {
    throw new InvalidAutomationTransitionError(
      `cannot transition an automation action from ${input.action.status} to ${String(input.to)}`,
    );
  }
  return { ...input.action, status: input.to as AutomationActionStatus };
}

/**
 * §"manual fallback/support-burden observability": the one-action
 * primitive. `MANUAL_FALLBACK_REQUIRED` reflects the action's entire
 * lifetime (via `everRequiredManualFallback`), not merely its current
 * status - an action that was escalated and later `COMPLETED` still
 * reports `MANUAL_FALLBACK_REQUIRED`, since the automation itself was
 * genuinely insufficient at some point.
 */
export type SupportBurdenLevel = "NONE" | "MANUAL_FALLBACK_REQUIRED";

export function resolveSupportBurden(action: AccountableAutomationAction): SupportBurdenLevel {
  return action.everRequiredManualFallback ? "MANUAL_FALLBACK_REQUIRED" : "NONE";
}
