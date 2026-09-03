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
 * Rev29 bounded correction (Brain handoff, CHANGES_REQUIRED_SOURCE_SECURITY
 * on PR #8, OPEN FINDING - MEMBERSHIP CURRENTNESS): OrganizationMembership
 * (V3-ORG-001) carries no lifecycle/status field by its own bounded
 * contract - but the ABSENCE of such a field on a given value never
 * proves that value is current; it only proves the type permits a stale
 * or a current membership to look byte-identical. Presenting `viewerRole`
 * therefore requires proof from a source *external to* `viewerMembership`
 * itself. This is that authoritative source: a minimal, append-only
 * directory entry mirroring `OwnershipAssignment`'s own
 * supersededAt-based currentness proof (V3-OWN-001) - the smallest
 * trusted contract that can vouch for a membershipId without inventing a
 * new identity/RBAC framework. A caller-supplied bare boolean is
 * deliberately not accepted in its place: a boolean can be fabricated
 * inline with no accountable source, whereas a directory record at least
 * carries its own membershipId/tenantId identity that must independently
 * match the membership being vouched for.
 */
export interface MembershipCurrentnessRecord {
  readonly membershipId: OrganizationMembership["membershipId"];
  readonly tenantId: TenantScope["tenantId"];
  readonly supersededAt?: string;
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
 * Rev29 bounded correction: proves `viewerMembership` is current before
 * ever letting its `role` become the projection's `viewerRole`. Fails
 * closed (returns `false`, meaning "unproven, do not surface") in every
 * case except an exact, unambiguous, non-superseded match:
 * - no directory supplied at all -> unknown/unproven, not "assume current".
 * - directory supplied but no record matches this exact membershipId AND
 *   tenantId -> unknown/unproven, never guessed from a partial match.
 * - the matching record carries `supersededAt` -> proven stale.
 * - more than one active (non-superseded) record matches the same
 *   membershipId/tenantId -> a data-integrity ambiguity; this read
 *   projection never guesses which one is "the" current record, so it
 *   is treated identically to "unproven" (unlike `resolveCurrentOwner`,
 *   which throws for the analogous `OwnershipAssignment` case - a single
 *   optional display label warrants the smaller blast radius of silent
 *   omission over crashing the whole page render).
 */
function isViewerMembershipCurrent(input: {
  viewerMembership: OrganizationMembership;
  currentnessDirectory: ReadonlyArray<MembershipCurrentnessRecord> | undefined;
}): boolean {
  if (input.currentnessDirectory === undefined) {
    return false;
  }
  const activeMatches = input.currentnessDirectory.filter(
    (record) =>
      record.membershipId === input.viewerMembership.membershipId &&
      record.tenantId === input.viewerMembership.tenantId &&
      record.supersededAt === undefined,
  );
  return activeMatches.length === 1;
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
 * Rev29 bounded correction (Brain handoff, CHANGES_REQUIRED_SOURCE_SECURITY
 * on PR #8): tenant match alone is not proof the membership is current -
 * `viewerRole` is now additionally gated on `isViewerMembershipCurrent`
 * against the caller-supplied `viewerMembershipCurrentness` directory.
 * Omitting the directory, or supplying one with no current record for
 * this exact membership, silently omits `viewerRole` (the same "honestly
 * absent, never guessed" contract this projection already applies to
 * every other optional field) - it never fails the whole projection,
 * since owners/attention remain independently trustworthy.
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
  viewerMembershipCurrentness?: ReadonlyArray<MembershipCurrentnessRecord>;
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
  if (
    input.viewerMembership !== undefined &&
    input.viewerMembership.tenantId === input.ownership.tenantId &&
    isViewerMembershipCurrent({
      viewerMembership: input.viewerMembership,
      currentnessDirectory: input.viewerMembershipCurrentness,
    })
  ) {
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
