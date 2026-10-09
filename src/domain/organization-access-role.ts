import { isOrganizationMembershipActive, type OrganizationMembership } from "./organization-membership.js";
import type { TenantScope } from "./tenant-scope.js";

export class InvalidOrganizationAccessRoleContextError extends Error {
  constructor(reason: string) {
    super(`Invalid OrganizationAccessRoleContext: ${reason}`);
    this.name = "InvalidOrganizationAccessRoleContextError";
  }
}

/**
 * OS-V0-02 Phase D (Rev135): a minimal curated organization-role
 * classification, deliberately distinct from `OrganizationMembership.role`
 * (`STAFF`/`JUNIOR`/`STUDENT`/`CLIENT_ASSOCIATE` - unchanged, unrelabeled,
 * still an operational classification carrying no ownership/administration
 * meaning). `OWNER`/`ADMIN` here are provenance/classification only: they
 * carry no permission, approval, or execution authority of their own -
 * `AuthorityContext` (`authority.ts`) remains the sole permission/
 * protected-action source, unchanged by this module or by anything that
 * consumes it.
 */
export type OrganizationAccessRole = "OWNER" | "ADMIN" | "MEMBER";

const ORGANIZATION_ACCESS_ROLE_VALUES: ReadonlySet<string> = new Set(["OWNER", "ADMIN", "MEMBER"]);

export function isValidOrganizationAccessRole(value: unknown): value is OrganizationAccessRole {
  return typeof value === "string" && ORGANIZATION_ACCESS_ROLE_VALUES.has(value);
}

/**
 * A current application-boundary curated-role claim, distinct from
 * `OrganizationMembership` (identity/tenant fact), `AssignmentReference`
 * (project-scope evidence), `OwnershipAssignment`/`Project.ownerRef`
 * (never read here, never imported - `ownership-assignment.ts` is not a
 * dependency of this module), and `AuthorityContext` (permission/
 * protected-action authority). It is bound to the exact current membership
 * identity by `tenantId` + `membershipId` + `principalRef` so a consumer
 * (e.g. `resolveEffectiveOrganizationAccess`) can prove this context was
 * actually issued for the membership it is being paired with, not merely
 * copied from a different one. It carries no permission, approval, or
 * execution field of any kind - `role` is the only payload.
 */
export interface OrganizationAccessRoleContext {
  readonly tenantId: TenantScope["tenantId"];
  readonly membershipId: OrganizationMembership["membershipId"];
  readonly principalRef: string;
  readonly role: OrganizationAccessRole;
}

/**
 * Deterministic factory: `tenantId`/`membershipId`/`principalRef` are
 * always inherited from the given `membership` - never separately
 * caller-supplied - so a context can never be constructed detached from,
 * or claiming a different identity than, a real membership. Refuses a
 * revoked/incoherent membership via the existing
 * `isOrganizationMembershipActive` predicate (Phase C, Rev131) rather than
 * re-deriving that check, so a curated role can never be minted for a
 * membership that could not itself pass effective-access's own currentness
 * gate. `role` is validated against the closed `OrganizationAccessRole`
 * vocabulary; legacy `OrganizationMembership.role` values (`STAFF` etc.)
 * are never accepted here, and this factory never reads
 * `membership.role` at all - the two role concepts are structurally
 * disjoint. Pure: no store/session/IdP/provider/network/persistence/
 * global registry/randomness/wall-clock read.
 */
export function createOrganizationAccessRoleContext(input: {
  membership: OrganizationMembership;
  role: unknown;
}): OrganizationAccessRoleContext {
  if (!isOrganizationMembershipActive(input.membership)) {
    throw new InvalidOrganizationAccessRoleContextError(
      "membership must be an active, coherent membership record to bear a curated access role",
    );
  }
  if (!isValidOrganizationAccessRole(input.role)) {
    throw new InvalidOrganizationAccessRoleContextError(
      `role must be one of ${Array.from(ORGANIZATION_ACCESS_ROLE_VALUES).join(", ")}`,
    );
  }
  return {
    tenantId: input.membership.tenantId,
    membershipId: input.membership.membershipId,
    principalRef: input.membership.principalRef,
    role: input.role,
  };
}
