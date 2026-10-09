export class InvalidStaffSessionContextError extends Error {
  constructor(reason: string) {
    super(`Invalid StaffSessionContext: ${reason}`);
    this.name = "InvalidStaffSessionContextError";
  }
}

type StaffPrincipalId = string & { readonly __brand: "StaffPrincipalId" };

/**
 * Rev98 Family 2 ("final trusted authenticated internal/staff ingress").
 * Deliberately structurally distinct from `session-context.ts`'s
 * `AuthenticatedPrincipal` (V2-APP-001) rather than reused or extended:
 * that type is customer-facing (carries `tenantId`/`customerId`, scoping
 * an external customer's own account), while a staff principal is
 * AKILTA-internal and has no customer/tenant of its own to be scoped to -
 * conflating the two would blur exactly the identity-domain boundary this
 * repository's own precedent keeps separate (see `partner-organization.ts`
 * deliberately not importing `organization-membership.ts`, and
 * `automation-operating-integration.ts` keeping human-membership vs.
 * worker-id identity domains structurally distinct).
 *
 * `principalId` is designed to be reused by shape (never by import, since
 * `src/domain/` depends on nothing else in `src/`) as
 * `organization-membership.ts`'s `OrganizationMembership.principalRef` -
 * exactly the same "principalId reused as principalRef by shape" pattern
 * `docs/architecture/DEPENDENCY_MAP.md` already documents for the
 * customer-facing principal.
 */
export interface AuthenticatedStaffPrincipal {
  readonly principalId: StaffPrincipalId;
  readonly displayName: string;
}

/**
 * OS-V1-02: the minimum V1 lifecycle floor for a staff session, mirroring
 * `OrganizationMembership`'s/`OrganizationServicePrincipal`'s own
 * `ACTIVE`/`REVOKED` floor exactly (Phase C, Rev131; OS-V0-02 final
 * convergence, Rev136) - `ACTIVE` is the only usable state, `REVOKED` is a
 * one-way terminal stop. No reactivation/renewal is representable here:
 * "recovery" from a revoked or expired session is always a NEW session
 * (the provider issuing a fresh `StaffSessionContext` for a fresh
 * authentication), never a resurrection of the old one - the same
 * discipline already established for membership and service-principal
 * revocation.
 */
export type StaffSessionContextLifecycleState = "ACTIVE" | "REVOKED";

/**
 * `state`/`revokedAt`/`revokedReason`/`expiresAt` are all OPTIONAL
 * (OS-V1-02 additive widening, not a breaking change): every existing
 * caller across this repository constructs a `StaffSessionContext` as a
 * plain `{ principal, issuedAt }` literal (there is no factory function for
 * this type, unlike `OrganizationMembership`), so a required new field
 * would silently break dozens of already-accepted fixtures/tests. An absent
 * `state` is treated as `"ACTIVE"` and an absent `expiresAt` as "never
 * expires" by `isStaffSessionContextActive` below - identical behavior to
 * before this change for every caller that does not opt in. A caller that
 * DOES want expiry/revoke enforcement sets these fields explicitly and
 * passes `now` to `requireStaffSession`/`requireInternalOsAccess` (see
 * `staff-route-guard.ts`).
 */
export interface StaffSessionContext {
  readonly principal: AuthenticatedStaffPrincipal;
  readonly issuedAt: string;
  readonly state?: StaffSessionContextLifecycleState;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
  readonly expiresAt?: string;
}

export class InvalidStaffSessionContextTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid StaffSessionContext transition: ${reason}`);
    this.name = "InvalidStaffSessionContextTransitionError";
  }
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  ErrorClass: new (reason: string) => Error = InvalidStaffSessionContextError,
): string {
  if (typeof value !== "string") {
    throw new ErrorClass(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new ErrorClass(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new ErrorClass(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new ErrorClass(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

export function createAuthenticatedStaffPrincipal(input: {
  principalId: unknown;
  displayName: unknown;
}): AuthenticatedStaffPrincipal {
  return {
    principalId: requireNonEmptyString(input.principalId, "principalId") as StaffPrincipalId,
    displayName: requireNonEmptyString(input.displayName, "displayName"),
  };
}

/**
 * The single reusable currentness predicate every consumer
 * (`requireStaffSession`, and transitively `requireInternalOsAccess`) must
 * use rather than re-deriving its own "is this session usable" check -
 * mirrors `isOrganizationMembershipActive`'s/`isOrganizationServicePrincipalActive`'s
 * own exact discipline. `state === "REVOKED"` (or stale revocation metadata
 * present on an otherwise-`ACTIVE`-looking record) always denies. `expiresAt`,
 * when present, is a hard admission requirement for a clock: a session that
 * declares an expiry can never be admitted without the caller supplying
 * `now` (an expiring session with no clock to check it against fails CLOSED,
 * never silently open) - comparison uses `Date.parse` (never raw string
 * equality) so differing-but-equal timezone-offset representations compare
 * correctly, and strictly-equal-to-expiry is already expired (half-open
 * window, matching this repository's own "not before" convention read the
 * other way).
 */
export function isStaffSessionContextActive(session: StaffSessionContext, now?: string): boolean {
  if (session.state === "REVOKED") {
    return false;
  }
  if (session.revokedAt !== undefined || session.revokedReason !== undefined) {
    return false;
  }
  if (session.expiresAt !== undefined) {
    if (now === undefined) {
      return false;
    }
    const nowMs = Date.parse(now);
    const expiresAtMs = Date.parse(session.expiresAt);
    if (Number.isNaN(nowMs) || Number.isNaN(expiresAtMs)) {
      return false;
    }
    if (nowMs >= expiresAtMs) {
      return false;
    }
  }
  return true;
}

/**
 * The single one-way `ACTIVE -> REVOKED` transition, mirroring
 * `revokeOrganizationMembership`/`revokeOrganizationServicePrincipal`
 * exactly: no reactivation function is implemented or exposed; "recovery"
 * is always a fresh session from a fresh authentication (see this module's
 * own doc comment above), never a resurrection of this value. Revalidates
 * the FULL pre-existing record via `isStaffSessionContextActive` (passing
 * no `now`, so an already-expired-but-not-yet-revoked session - which
 * `isStaffSessionContextActive` cannot evaluate without a clock when
 * `expiresAt` is set - is not rejected here merely for lacking one; a
 * session already carrying stale revocation metadata, or already
 * `REVOKED`, still is) before consuming it.
 */
export function revokeStaffSessionContext(input: {
  session: StaffSessionContext;
  revokedAt: unknown;
  revokedReason: unknown;
}): StaffSessionContext {
  if (input.session.state === "REVOKED" || input.session.revokedAt !== undefined || input.session.revokedReason !== undefined) {
    throw new InvalidStaffSessionContextTransitionError(
      "session must be a coherent ACTIVE record (no existing revocation metadata) to revoke",
    );
  }
  const revokedAt = requireNonEmptyString(input.revokedAt, "revokedAt", InvalidStaffSessionContextTransitionError);
  if (Number.isNaN(Date.parse(revokedAt))) {
    throw new InvalidStaffSessionContextTransitionError("revokedAt must be a valid ISO timestamp");
  }
  const revokedReason = requireNonEmptyString(input.revokedReason, "revokedReason", InvalidStaffSessionContextTransitionError);
  return {
    ...input.session,
    state: "REVOKED",
    revokedAt,
    revokedReason,
  };
}
