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

export interface StaffSessionContext {
  readonly principal: AuthenticatedStaffPrincipal;
  readonly issuedAt: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidStaffSessionContextError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidStaffSessionContextError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidStaffSessionContextError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidStaffSessionContextError(
      `${field} must not contain leading or trailing whitespace`,
    );
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
