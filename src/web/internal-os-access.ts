import { requireStaffSession } from "./staff-route-guard.js";
import { requireMatchingStaffMembership } from "./staff-membership-guard.js";
import type { StaffSessionContext } from "./staff-session-context.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import type { OrganizationMembership, AssignmentReference } from "../domain/organization-membership.js";
import type { Organization } from "../domain/organization.js";
import type { Project } from "../domain/project.js";
import type { AuthorityContext } from "../domain/authority.js";
import { requirePermission } from "../domain/authority.js";
import {
  resolveEffectiveOrganizationAccess,
  type EffectiveAccessResolution,
} from "../domain/effective-organization-access.js";
import type { OrganizationAccessRoleContext } from "../domain/organization-access-role.js";

/**
 * OS-V0-08 Phase A: this repository has no existing "staff membership ->
 * AuthorityContext" derivation of its own - `internal-command-access.ts`
 * (Family 10) never needed one, since it grants no permission-scoped view.
 * The internal OS shell does need real READ/WRITE/EXECUTE and
 * `canPerformProtectedActions` truth to honestly render role-vs-authority
 * distinctions (Rev168's own explicit acceptance test: "ADMIN label +
 * READ-only authority exposes no active write/execute CTA"). Rather than
 * inventing a new IAM/authority-resolution policy (explicitly forbidden),
 * this module follows the repository's existing, universal discipline that
 * `AuthorityContext` is always caller-supplied, never resolved from
 * identity by this layer itself (see every OS-V0-05 runtime function, every
 * `src/application/*` entry point). A `StaffAccessGrant` is simply the
 * caller-supplied bundle of everything `resolveEffectiveOrganizationAccess`
 * needs for one specific membership - the exact same "caller supplies the
 * evidence set" shape `requireMatchingStaffMembership` already uses for
 * `memberships`, extended with the additional evidence that function's own
 * narrower scope never needed.
 */
export interface StaffAccessGrant {
  readonly membership: OrganizationMembership;
  readonly authority: AuthorityContext;
  readonly assignments: ReadonlyArray<AssignmentReference>;
  readonly roleContext?: OrganizationAccessRoleContext;
}

export class InternalOsAccessDeniedError extends Error {
  constructor(reasons: ReadonlyArray<string>) {
    super(`Internal OS access denied: ${reasons.join("; ")}`);
    this.name = "InternalOsAccessDeniedError";
  }
}

export interface InternalOsAccessContext {
  readonly session: StaffSessionContext;
  readonly membership: OrganizationMembership;
  readonly grant: StaffAccessGrant;
  readonly access: EffectiveAccessResolution;
}

/**
 * The one required gate before any internal OS page may render: a valid
 * staff session, bound to exactly one matching ACTIVE `OrganizationMembership`
 * in the target organization's tenant, whose caller-supplied `AuthorityContext`
 * is then independently re-proven via `resolveEffectiveOrganizationAccess`
 * (tenant correlation, principal binding, membership currentness - all
 * re-checked here even though `requireMatchingStaffMembership` already
 * filters to ACTIVE, since `resolveEffectiveOrganizationAccess` is the
 * single canonical decision this whole package renders from). Phase A is
 * read-only: every route additionally requires `READ` permission - `WRITE`/
 * `EXECUTE` are never required or granted by this Phase A gate itself, since
 * no mutating action exists anywhere in this package's surface yet.
 *
 * `grants` is caller-supplied, exactly mirroring `requireMatchingStaffMembership`'s
 * own `memberships` contract - this module has no persistence/lookup
 * capability of its own, consistent with every other module in `src/web/`.
 * A customer `SessionContext` or `OrganizationServicePrincipal` cannot
 * satisfy `provider.resolveStaffSession` at all (structurally disjoint
 * identity types - see `staff-session-context.ts`'s own doc comment), so
 * this gate is unreachable by either identity family by construction, not
 * merely by convention.
 */
export function requireInternalOsAccess(input: {
  provider: StaffSessionProvider;
  sessionToken: string | undefined;
  organization: Organization;
  grants: ReadonlyArray<StaffAccessGrant>;
}): InternalOsAccessContext {
  const session = requireStaffSession(input.provider, input.sessionToken);
  const membership = requireMatchingStaffMembership({
    session,
    tenantId: input.organization.tenantId,
    memberships: input.grants.map((grant) => grant.membership),
  });
  const grant = input.grants.find((candidate) => candidate.membership.membershipId === membership.membershipId);
  if (grant === undefined) {
    // Structurally unreachable given `requireMatchingStaffMembership` just
    // matched this exact membership out of `grants.map(g => g.membership)` -
    // guarded explicitly rather than asserted, matching this repository's
    // "never trust an internal invariant silently" discipline.
    throw new InternalOsAccessDeniedError(["no access grant is bound to the resolved membership"]);
  }
  const access = resolveEffectiveOrganizationAccess({
    organization: input.organization,
    membership,
    currentPrincipalRef: session.principal.principalId,
    authority: grant.authority,
    assignments: grant.assignments,
    ...(grant.roleContext !== undefined ? { roleContext: grant.roleContext } : {}),
  });
  if (access.decision !== "GRANTED") {
    throw new InternalOsAccessDeniedError(access.reasons);
  }
  requirePermission(grant.authority, "READ");
  return { session, membership, grant, access };
}

/**
 * Symmetric project-scoped re-check for a route that names an exact
 * project (e.g. Work project detail): re-runs the SAME
 * `resolveEffectiveOrganizationAccess` decision with `project` supplied, so
 * `resolveAssignmentStatus` is consulted - a MEMBER with `READ` but no
 * `AssignmentReference` for this exact project is denied here even though
 * `requireInternalOsAccess` above already granted organization-level
 * access. Never widens what the organization-level grant already proved;
 * it can only narrow.
 */
export function requireInternalOsProjectAccess(input: {
  organization: Organization;
  context: InternalOsAccessContext;
  project: Project;
}): EffectiveAccessResolution {
  const access = resolveEffectiveOrganizationAccess({
    organization: input.organization,
    membership: input.context.membership,
    currentPrincipalRef: input.context.session.principal.principalId,
    authority: input.context.grant.authority,
    project: input.project,
    assignments: input.context.grant.assignments,
    ...(input.context.grant.roleContext !== undefined ? { roleContext: input.context.grant.roleContext } : {}),
  });
  if (access.decision !== "GRANTED") {
    throw new InternalOsAccessDeniedError(access.reasons);
  }
  return access;
}
