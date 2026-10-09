import { requireStaffSession } from "./staff-route-guard.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import type { Organization } from "../domain/organization.js";
import type { OrganizationMembership, AssignmentReference } from "../domain/organization-membership.js";
import type { AuthorityContext } from "../domain/authority.js";
import type { OrganizationAccessRoleContext } from "../domain/organization-access-role.js";
import { resolveEffectiveOrganizationAccess } from "../domain/effective-organization-access.js";
import {
  resolveEffectiveDelegatedAccess,
  type DelegatedAccessGrant,
  type EffectiveDelegatedAccessResolution,
} from "../domain/delegated-access-grant.js";

/**
 * Brain targeted review (PR #125 comment id `6076214816`): `resolveEffectiveDelegatedAccess`
 * (`delegated-access-grant.ts`) re-resolves the delegation's own currentness
 * fresh (expiry/revocation), but both `currentPrincipalRef` AND
 * `delegatorCurrentAccess` were plain caller-supplied values with no
 * application-boundary authentication behind either - a caller could
 * simply assert `grant.delegatePrincipalRef` as `currentPrincipalRef`
 * without ever having authenticated as that principal, and/or hand in a
 * fabricated or stale `EffectiveAccessResolution` object claiming the
 * delegator is still in good standing. This is exactly the same missing
 * boundary `authenticated-controlled-organization-switch.ts` (OS-V1-01
 * Rev205 F2-R2) already closed for switch admission, now recurring for
 * delegated access.
 *
 * This is that missing application boundary: authenticate the DELEGATE's
 * own session first (`requireStaffSession` - deliberately NOT the heavier
 * `requireInternalOsAccess`, since a delegate may be acting under a
 * session that has no `OrganizationMembership` of its own in this
 * organization at all; `delegated-access-grant.ts`'s own doc comment
 * states this explicitly), so `currentPrincipalRef` is ALWAYS
 * `session.principal.principalId` - never a caller-supplied value. Then
 * re-resolve the DELEGATOR's current standing fresh, from raw evidence
 * (`delegatorMembership`/`delegatorAuthority`/`delegatorAssignments`/
 * `delegatorRoleContext` - the same caller-supplies-current-store-fetched-
 * evidence shape `requireInternalOsAccess`'s own `StaffAccessGrant` already
 * uses), via the existing `resolveEffectiveOrganizationAccess` - never
 * accepting a pre-built `EffectiveAccessResolution` snapshot from the
 * caller, which could be stale or fabricated. Domain code never depends on
 * `src/web/` (this repository's own established layering), so
 * `resolveEffectiveDelegatedAccess` itself stays exactly as it was; this
 * module is the thin web-layer composition a real caller uses instead. A
 * forged/absent/expired/revoked delegate session fails inside
 * `requireStaffSession` itself, before the delegation is ever resolved; a
 * delegator whose own membership was revoked (or whose authority shrank)
 * since the grant was minted fails inside the freshly-recomputed
 * `delegatorCurrentAccess` - either way, zero delegated-access grant.
 */
export function resolveEffectiveDelegatedAccessAsAuthenticatedStaff(input: {
  readonly organization: Organization;
  readonly grant: DelegatedAccessGrant | undefined;
  readonly now: string;
  readonly provider: StaffSessionProvider;
  readonly sessionToken: string | undefined;
  readonly delegatorMembership: OrganizationMembership;
  readonly delegatorAuthority: AuthorityContext;
  readonly delegatorAssignments?: ReadonlyArray<AssignmentReference>;
  readonly delegatorRoleContext?: OrganizationAccessRoleContext;
}): EffectiveDelegatedAccessResolution {
  const session = requireStaffSession(input.provider, input.sessionToken, input.now);
  const delegatorCurrentAccess = resolveEffectiveOrganizationAccess({
    organization: input.organization,
    membership: input.delegatorMembership,
    currentPrincipalRef: input.delegatorMembership.principalRef,
    authority: input.delegatorAuthority,
    ...(input.delegatorAssignments !== undefined ? { assignments: input.delegatorAssignments } : {}),
    ...(input.delegatorRoleContext !== undefined ? { roleContext: input.delegatorRoleContext } : {}),
  });
  return resolveEffectiveDelegatedAccess({
    organization: input.organization,
    ...(input.grant !== undefined ? { grant: input.grant } : {}),
    currentPrincipalRef: session.principal.principalId,
    now: input.now,
    delegatorCurrentAccess,
  });
}
