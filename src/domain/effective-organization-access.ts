import type { TenantScope } from "./tenant-scope.js";
import type { Organization } from "./organization.js";
import type { OrganizationMembership } from "./organization-membership.js";
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
 * (OS-V0-01), `OrganizationMembership`, a caller-supplied `AuthorityContext`,
 * and an optional `Project` scope. This module resolves nothing about
 * *who* is calling (that remains `AuthorityContext`'s caller/application-
 * boundary concern) and grants no permission of its own: `permissions`/
 * `canPerformProtectedActions` on a `GRANTED` resolution are always the
 * exact `AuthorityContext` values, read verbatim, after tenant-correlation
 * validation - never widened by role, ownership, or any other signal.
 * `reasons` always explains the decision explicitly; there is no silent
 * default. This function is pure (no wall-clock/randomness/persistence),
 * so re-invoking it with current inputs is the only way to get a current
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
 * Resolution order: membership presence, then membership/authority/
 * (optional) project tenant correlation, each against the given
 * `Organization`'s own `tenantId` - the exact structural anchor. Only once
 * every correlation check passes does this function read `authority.
 * permissions`/`authority.canPerformProtectedActions` verbatim onto the
 * `GRANTED` resolution. `membership.role` is read only to confirm a
 * membership exists; its exact value never influences the decision or the
 * projected `role` output, which is always `"MEMBER"`.
 */
export function resolveEffectiveOrganizationAccess(input: {
  organization: Organization;
  membership?: OrganizationMembership;
  authority: AuthorityContext;
  project?: Project;
}): EffectiveAccessResolution {
  if (input.membership === undefined) {
    return denied({
      organization: input.organization,
      membership: undefined,
      project: input.project,
      reason: "membership is required for effective access resolution",
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
      "organization/membership/authority tenant correlation verified" +
        (input.project !== undefined ? " (including project scope)" : ""),
    ],
  };
}
