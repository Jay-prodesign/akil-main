import type { StaffSessionContext } from "./staff-session-context.js";
import type { OrganizationMembership } from "../domain/organization-membership.js";
import type { TenantScope } from "../domain/tenant-scope.js";

/**
 * Rev98 Family 2's actual remaining gap, precisely named by PR #33
 * (`AUD-V5-AUTHORITY-INGRESS`): an `AuthorityContext` can already be
 * checked for permission/protected-action authority (`authority.ts`), and
 * a `StaffSessionContext` can already prove a request carries *some*
 * authenticated staff identity (`staff-route-guard.ts`) - but nothing
 * previously bound the two together with a real, current organizational
 * fact. This module is that binding: an authenticated staff principal is
 * trusted for internal/staff action only once it resolves to exactly one
 * current `OrganizationMembership` record in the target tenant - a valid
 * session token alone is never sufficient.
 *
 * `memberships` is caller-supplied (this module has no persistence/lookup
 * capability of its own, consistent with every other pure `src/web/`/
 * `src/domain/` module in this repository) - matching `organization-
 * membership.ts`'s own documented reuse contract: `principalRef` is
 * compared against `session.principal.principalId` by shape, never by
 * import (`src/domain/` depends on nothing else in `src/`).
 */
export class NoStaffMembershipError extends Error {
  constructor() {
    super("The authenticated staff principal has no current OrganizationMembership in this tenant");
    this.name = "NoStaffMembershipError";
  }
}

export class AmbiguousStaffMembershipError extends Error {
  constructor() {
    super(
      "The authenticated staff principal matches more than one OrganizationMembership in this tenant - ambiguous, never guessed",
    );
    this.name = "AmbiguousStaffMembershipError";
  }
}

/**
 * Pure lookup - never throws on zero matches (a session with no
 * membership yet is an ordinary, expected state, not a caller error).
 * Throws only on more than one match: an ambiguous binding is never
 * silently resolved to "the first one," matching `resolveTrustedServiceForOrder`'s
 * (`SVC-ADM-001`) and `resolveCurrentOwner`'s (`V3-OWN-001`) own
 * fail-closed-on-ambiguity precedent.
 */
export function resolveCurrentStaffMembership(input: {
  session: StaffSessionContext;
  tenantId: TenantScope["tenantId"];
  memberships: ReadonlyArray<OrganizationMembership>;
}): OrganizationMembership | undefined {
  const matches = input.memberships.filter(
    (membership) =>
      membership.principalRef === input.session.principal.principalId &&
      membership.tenantId === input.tenantId,
  );
  if (matches.length > 1) {
    throw new AmbiguousStaffMembershipError();
  }
  return matches[0];
}

/**
 * The fail-closed form: throws `NoStaffMembershipError` rather than
 * returning `undefined`, for the ordinary internal-route-guard call site
 * where an unbound staff session must never be treated as authorized to
 * act - mirroring `requireSession`'s (V2-APP-001) "no partial-credential
 * state" discipline for the membership-binding dimension specifically.
 */
export function requireCurrentStaffMembership(input: {
  session: StaffSessionContext;
  tenantId: TenantScope["tenantId"];
  memberships: ReadonlyArray<OrganizationMembership>;
}): OrganizationMembership {
  const membership = resolveCurrentStaffMembership(input);
  if (membership === undefined) {
    throw new NoStaffMembershipError();
  }
  return membership;
}
