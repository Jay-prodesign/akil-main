import type { SessionContext, TenantContext } from "./session-context.js";
import type { SessionProvider } from "./session-provider.js";

export class UnauthenticatedError extends Error {
  constructor() {
    super("No valid session - request is unauthenticated");
    this.name = "UnauthenticatedError";
  }
}

export class TenantScopeMismatchError extends Error {
  constructor(reason: string) {
    super(`Tenant scope mismatch: ${reason}`);
    this.name = "TenantScopeMismatchError";
  }
}

/**
 * V2-APP-001 A4: the sole way a caller obtains a `SessionContext`.
 * `sessionToken === undefined` and "token does not resolve to a session"
 * are both, deliberately, exactly the same outcome here - there is no
 * partial-credential or "almost authenticated" state this function can
 * return.
 */
export function requireSession(
  provider: SessionProvider,
  sessionToken: string | undefined,
): SessionContext {
  const session = provider.resolveSession(sessionToken);
  if (session === undefined) {
    throw new UnauthenticatedError();
  }
  return session;
}

/**
 * V2-APP-001 A5 / Architecture Invariant D: `requestedTenant` values come
 * from the route/query/path (untrusted, caller-controlled) - this
 * function proves they cannot widen scope beyond what the already-trusted
 * `session.tenant` actually authorizes. `undefined` on either side is
 * "not scoped to a specific project" and matches only `undefined` on the
 * other side - a session scoped to an entire customer account is not
 * thereby authorized for every project, so a route that names an exact
 * `projectId` still requires the session to name that exact same one.
 */
export function requireTenantOwnership(
  session: SessionContext,
  requestedTenant: TenantContext,
): void {
  if (session.tenant.tenantId !== requestedTenant.tenantId) {
    throw new TenantScopeMismatchError("tenantId does not match the authenticated session's tenant");
  }
  if (session.tenant.customerId !== requestedTenant.customerId) {
    throw new TenantScopeMismatchError("customerId does not match the authenticated session's tenant");
  }
  if (session.tenant.projectId !== requestedTenant.projectId) {
    throw new TenantScopeMismatchError("projectId does not match the authenticated session's tenant scope");
  }
}
