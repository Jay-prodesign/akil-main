import type { TenantScope } from "./tenant-scope.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import { resolveCurrentOwner, type OwnershipAssignment, type OwnerRole } from "./ownership-assignment.js";
import type { OrganizationMembership } from "./organization-membership.js";
import type { AttentionState, InternalAttentionLevel } from "./attention-state.js";

/**
 * V3 Full Blueprint §9, Workstream F ("V3 logged-in frontend / role-aware
 * IA") floor slice: "LeadOwner/DealOwner/AccountOwner/DeliveryOwner render
 * separately" + "acting organization/client context and current role are
 * visible where ambiguity exists." This module composes only already-
 * merged V3 A-D substrate (`OrganizationMembership`/V3-ORG-001,
 * `OwnershipAssignment`/`resolveCurrentOwner`/V3-OWN-001, `AttentionState`/
 * V3-SLA-001) into one deterministic, tenant/project-scoped, fail-closed
 * read projection - it invents no new authority, ownership, or attention
 * concept of its own.
 */
export interface TeamAttentionOwnerAssignments {
  readonly leadOwnerMembershipId?: OwnershipAssignment["membershipId"];
  readonly dealOwnerMembershipId?: OwnershipAssignment["membershipId"];
  readonly accountOwnerMembershipId?: OwnershipAssignment["membershipId"];
  readonly deliveryOwnerMembershipId?: OwnershipAssignment["membershipId"];
}

export interface TeamAttentionSummary {
  readonly isActive: boolean;
  readonly internalAttentionLevel: InternalAttentionLevel;
  readonly reason?: string;
  readonly timestamp?: string;
}

/**
 * Deliberately carries no commission/discount/commercial field of any
 * kind - Workstream E (commercial-authority read models) is a separate,
 * unmerged checkpoint at the time this module was written, and this
 * projection must not consume it or invent a competing commercial type.
 * The shell renders commercial visibility as a fixed "unavailable"
 * literal (see `shell-render.ts`), not a value produced here.
 */
export interface TeamAttentionProjection {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: ProjectOwnershipRef["customerId"];
  readonly projectId: ProjectOwnershipRef["projectId"];
  readonly viewerRole?: OrganizationMembership["role"];
  readonly owners: TeamAttentionOwnerAssignments;
  readonly attention?: TeamAttentionSummary;
}

const OWNER_ROLES: ReadonlyArray<OwnerRole> = [
  "LEAD_OWNER",
  "DEAL_OWNER",
  "ACCOUNT_OWNER",
  "DELIVERY_OWNER",
];

function ownerField(ownerRole: OwnerRole): keyof TeamAttentionOwnerAssignments {
  switch (ownerRole) {
    case "LEAD_OWNER":
      return "leadOwnerMembershipId";
    case "DEAL_OWNER":
      return "dealOwnerMembershipId";
    case "ACCOUNT_OWNER":
      return "accountOwnerMembershipId";
    case "DELIVERY_OWNER":
      return "deliveryOwnerMembershipId";
  }
}

/**
 * §9 UX truth: "acting organization/client context and current role are
 * visible where ambiguity exists" - `viewerRole` reuses `resolveCurrentOwner`'s
 * own exact-scope discipline: a `viewerMembership` from a different tenant
 * than `ownership` is never surfaced (fail-closed, no cross-tenant role
 * leakage), mirroring the same check `buildAttentionState`/
 * `buildCommercialAuthoritySnapshot`-style modules already apply to
 * `OwnershipAssignment` history.
 *
 * §9 UX truth: "LeadOwner/DealOwner/AccountOwner/DeliveryOwner render
 * separately" - each role is resolved independently via
 * `resolveCurrentOwner` (V3-OWN-001), never inferred from another role or
 * from a viewer's own membership.
 *
 * §7 acceptance direction (V3-SLA-001, reused verbatim here): a supplied
 * `attentionState` is only surfaced when its own `tenantId`/`projectId`
 * match the given `ownership` - a foreign project's attention state is
 * never coerced into this scope's projection (the same two-field check
 * `buildAttentionState` itself already performs against its `job`).
 */
export function buildTeamAttentionProjection(input: {
  ownership: ProjectOwnershipRef;
  viewerMembership?: OrganizationMembership;
  ownerHistory?: ReadonlyArray<OwnershipAssignment>;
  attentionState?: AttentionState;
}): TeamAttentionProjection {
  const owners: { -readonly [K in keyof TeamAttentionOwnerAssignments]?: OwnershipAssignment["membershipId"] } =
    {};
  if (input.ownerHistory !== undefined) {
    for (const ownerRole of OWNER_ROLES) {
      const current = resolveCurrentOwner({
        history: input.ownerHistory,
        ownership: input.ownership,
        ownerRole,
      });
      if (current !== undefined) {
        owners[ownerField(ownerRole)] = current.membershipId;
      }
    }
  }

  let viewerRole: OrganizationMembership["role"] | undefined;
  if (input.viewerMembership !== undefined && input.viewerMembership.tenantId === input.ownership.tenantId) {
    viewerRole = input.viewerMembership.role;
  }

  let attention: TeamAttentionSummary | undefined;
  if (
    input.attentionState !== undefined &&
    input.attentionState.tenantId === input.ownership.tenantId &&
    input.attentionState.projectId === input.ownership.projectId
  ) {
    attention = {
      isActive: input.attentionState.internalAttentionLevel !== "NORMAL",
      internalAttentionLevel: input.attentionState.internalAttentionLevel,
      ...(input.attentionState.reason !== undefined ? { reason: input.attentionState.reason } : {}),
      ...(input.attentionState.timestamp !== undefined ? { timestamp: input.attentionState.timestamp } : {}),
    };
  }

  return {
    tenantId: input.ownership.tenantId,
    customerId: input.ownership.customerId,
    projectId: input.ownership.projectId,
    ...(viewerRole !== undefined ? { viewerRole } : {}),
    owners,
    ...(attention !== undefined ? { attention } : {}),
  };
}
