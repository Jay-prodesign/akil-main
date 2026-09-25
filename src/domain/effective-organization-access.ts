import type { TenantScope } from "./tenant-scope.js";
import type { Organization } from "./organization.js";
import { resolveAssignmentStatus, type AssignmentReference, type OrganizationMembership } from "./organization-membership.js";
import type { AuthorityContext, Permission } from "./authority.js";
import type { Project } from "./project.js";

export type AccessDecision = "GRANTED" | "DENIED";

/**
 * OS-V0-02 Phase A: legacy `OrganizationMembership.role` (`STAFF`/`JUNIOR`/
 * `STUDENT`/`CLIENT_ASSOCIATE`) projects uniformly to `"MEMBER"` - none of
 * those roles, nor `Project.ownerRef`/`OwnershipAssignment` (never even
 * imported here), can be used to fabricate a richer `OWNER`/`ADMIN`
 * classification. If current primitives are later extended to truthfully
 * distinguish ownership/administration, that is separate future policy
 * work, not invented in this bounded slice.
 */
export type EffectiveOrganizationRole = "MEMBER";

/**
 * OS-V0-02 "Effective Access Resolution Foundation": a pure, deterministic,
 * explainable composition over already-distinct primitives - `Organization`
 * (OS-V0-01), `OrganizationMembership`, a caller-supplied
 * `currentPrincipalRef` identity claim, a caller-supplied `AuthorityContext`,
 * an optional `Project` scope, and (Phase B) an optional list of the
 * caller's current `AssignmentReference` evidence. This module does not
 * authenticate `currentPrincipalRef` or resolve who the current caller is
 * (that identity boundary remains a future, separate application concern);
 * it only proves the supplied membership record belongs to the identity the
 * caller currently asserts (Rev129: closes same-tenant membership
 * substitution, which tenant correlation alone cannot detect) and, when a
 * `Project` is supplied, that exact current assignment evidence exists for
 * that membership and project via the existing `resolveAssignmentStatus`
 * semantics (Rev130 Phase B: tenant correlation alone does not prove the
 * member is actually assigned to that project). It grants no permission of
 * its own: `permissions`/`canPerformProtectedActions` on a `GRANTED`
 * resolution are always the exact `AuthorityContext` values, read verbatim,
 * after tenant-correlation, principal-binding, and (when scoped) assignment
 * validation - never widened by role, ownership, or any other signal.
 * `reasons` always explains the decision explicitly; there is no silent
 * default. This function is pure (no wall-clock/randomness/persistence), so
 * re-invoking it with current inputs is the only way to get a current
 * answer - it cannot itself preserve a stale decision.
 */
export interface EffectiveAccessResolution {
  readonly decision: AccessDecision;
  readonly tenantId: TenantScope["tenantId"];
  readonly organizationId: Organization["organizationId"];
  readonly membershipId?: OrganizationMembership["membershipId"];
  readonly projectId?: Project["projectId"];
  readonly role?: EffectiveOrganizationRole;
  readonly permissions: ReadonlySet<Permission>;
  readonly canPerformProtectedActions: boolean;
  readonly reasons: ReadonlyArray<string>;
}

function denied(input: {
  organization: Organization;
  membership: OrganizationMembership | undefined;
  project: Project | undefined;
  reason: string;
}): EffectiveAccessResolution {
  return {
    decision: "DENIED",
    tenantId: input.organization.tenantId,
    organizationId: input.organization.organizationId,
    ...(input.membership !== undefined ? { membershipId: input.membership.membershipId } : {}),
    ...(input.project !== undefined ? { projectId: input.project.projectId } : {}),
    permissions: new Set<Permission>(),
    canPerformProtectedActions: false,
    reasons: [input.reason],
  };
}

/**
 * Rev129 correction: `currentPrincipalRef` is an already-resolved
 * application-boundary identity claim - the same trust footing as
 * `AuthorityContext` - supplied by the caller, never inferred from
 * `membership`/`role`/`ownerRef`/permissions. It is validated here purely
 * structurally (non-empty, non-whitespace, no leading/trailing
 * whitespace); this module does not authenticate it or resolve who the
 * current caller is, it only proves the supplied membership record belongs
 * to the identity the caller currently asserts.
 */
function isValidCurrentPrincipalRef(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.trim() === value
  );
}

/**
 * Resolution order: membership presence, then `currentPrincipalRef`
 * structural validity, then membership/authority/(optional) project
 * tenant correlation (each against the given `Organization`'s own
 * `tenantId` - the exact structural anchor), then exact
 * `membership.principalRef === currentPrincipalRef` equality (Rev129:
 * closes same-tenant membership substitution, which tenant correlation
 * alone cannot detect), then - only when a `Project` is supplied - exact
 * assignment evidence via the existing `resolveAssignmentStatus` (Rev130
 * Phase B: `assignments` defaults to an empty list, which
 * `resolveAssignmentStatus` already resolves to `"UNASSIGNED"`, so an
 * omitted/empty evidence list fails closed exactly like a missing
 * membership does). Only once every check passes does this function read
 * `authority.permissions`/`authority.canPerformProtectedActions` verbatim
 * onto the `GRANTED` resolution. `membership.role` and `Project.ownerRef`
 * are never read for this decision - a role or an ownerRef match can never
 * substitute for `AssignmentReference` evidence or grant permission; the
 * projected `role` output is always `"MEMBER"`.
 */
export function resolveEffectiveOrganizationAccess(input: {
  organization: Organization;
  membership?: OrganizationMembership;
  currentPrincipalRef: string;
  authority: AuthorityContext;
  project?: Project;
  assignments?: ReadonlyArray<AssignmentReference>;
}): EffectiveAccessResolution {
  if (input.membership === undefined) {
    return denied({
      organization: input.organization,
      membership: undefined,
      project: input.project,
      reason: "membership is required for effective access resolution",
    });
  }
  if (!isValidCurrentPrincipalRef(input.currentPrincipalRef)) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason:
        "currentPrincipalRef is required and must be a non-empty, non-whitespace string",
    });
  }
  if (input.membership.tenantId !== input.organization.tenantId) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason: "membership belongs to a different tenant than the organization",
    });
  }
  if (input.authority.tenantId !== input.organization.tenantId) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason: "authority belongs to a different tenant than the organization",
    });
  }
  if (input.project !== undefined && input.project.tenantId !== input.organization.tenantId) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason: "project belongs to a different tenant than the organization",
    });
  }
  if (input.membership.principalRef !== input.currentPrincipalRef) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason: "membership belongs to a different principal than the current caller identity",
    });
  }
  if (input.project !== undefined) {
    const assignmentStatus = resolveAssignmentStatus({
      membership: input.membership,
      assignments: input.assignments ?? [],
      customerId: input.project.customerId,
      projectId: input.project.projectId,
    });
    if (assignmentStatus !== "ASSIGNED") {
      return denied({
        organization: input.organization,
        membership: input.membership,
        project: input.project,
        reason:
          "no exact assignment evidence exists for the current membership and project scope",
      });
    }
  }

  return {
    decision: "GRANTED",
    tenantId: input.organization.tenantId,
    organizationId: input.organization.organizationId,
    membershipId: input.membership.membershipId,
    ...(input.project !== undefined ? { projectId: input.project.projectId } : {}),
    role: "MEMBER",
    permissions: new Set(input.authority.permissions),
    canPerformProtectedActions: input.authority.canPerformProtectedActions,
    reasons: [
      "organization/membership/authority tenant correlation verified; membership principal matches current caller identity" +
        (input.project !== undefined
          ? "; exact assignment evidence verified for the project scope"
          : ""),
    ],
  };
}
