export class InvalidSessionContextError extends Error {
  constructor(reason: string) {
    super(`Invalid SessionContext: ${reason}`);
    this.name = "InvalidSessionContextError";
  }
}

type PrincipalId = string & { readonly __brand: "PrincipalId" };

/**
 * V2-APP-001 (IN SCOPE B): a provider-neutral identity - deliberately not
 * coupled to any external IdP's user-object shape. `tenantId`/`customerId`
 * are carried directly on the principal (not merely on the session) so
 * `TenantContext` below can be constructed from the principal alone,
 * without trusting any caller-supplied value.
 */
export interface AuthenticatedPrincipal {
  readonly principalId: PrincipalId;
  readonly tenantId: string;
  readonly customerId: string;
  readonly displayName: string;
}

/**
 * The authorized scope this session may act within. `projectId` is
 * optional: a principal may be scoped to an entire customer account
 * without being bound to one specific project (V2-APP-001 Architecture
 * Invariant: tenant/customer/project identity is derived from trusted
 * session context, never from browser-supplied route/query/form values).
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly customerId: string;
  readonly projectId?: string;
}

export interface SessionContext {
  readonly principal: AuthenticatedPrincipal;
  readonly tenant: TenantContext;
  readonly issuedAt: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidSessionContextError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidSessionContextError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidSessionContextError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidSessionContextError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

export function createAuthenticatedPrincipal(input: {
  principalId: unknown;
  tenantId: unknown;
  customerId: unknown;
  displayName: unknown;
}): AuthenticatedPrincipal {
  return {
    principalId: requireNonEmptyString(input.principalId, "principalId") as PrincipalId,
    tenantId: requireNonEmptyString(input.tenantId, "tenantId"),
    customerId: requireNonEmptyString(input.customerId, "customerId"),
    displayName: requireNonEmptyString(input.displayName, "displayName"),
  };
}

/**
 * A2/A6: `tenant` must belong to the exact same tenant/customer as
 * `principal` - a session can never claim tenant/customer scope its own
 * authenticated principal does not itself carry. This is the structural
 * guarantee behind "framework/session internals do not become canonical
 * customer/project identity authority": the only way to widen scope is
 * to issue a different, already-validated `AuthenticatedPrincipal`.
 */
export function createSessionContext(input: {
  principal: AuthenticatedPrincipal;
  projectId?: unknown;
  issuedAt: unknown;
}): SessionContext {
  const issuedAt = requireNonEmptyString(input.issuedAt, "issuedAt");
  const tenant: TenantContext = {
    tenantId: input.principal.tenantId,
    customerId: input.principal.customerId,
    ...(input.projectId !== undefined
      ? { projectId: requireNonEmptyString(input.projectId, "projectId") }
      : {}),
  };
  return { principal: input.principal, tenant, issuedAt };
}
