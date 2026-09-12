import type { StaffSessionContext } from "./staff-session-context.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";

/**
 * Distinct from `route-guard.ts`'s (V2-APP-001) `UnauthenticatedError` -
 * a staff-ingress failure and a customer-ingress failure are never the
 * same error type, matching this repository's "distinct types for
 * distinct identity domains" precedent.
 */
export class StaffUnauthenticatedError extends Error {
  constructor() {
    super("No valid staff session - request is unauthenticated");
    this.name = "StaffUnauthenticatedError";
  }
}

/**
 * Mirrors `route-guard.ts`'s `requireSession` exactly: the sole way a
 * caller obtains a `StaffSessionContext`. `sessionToken === undefined` and
 * "token does not resolve to a session" are both, deliberately, exactly
 * the same outcome here - there is no partial-credential or "almost
 * authenticated" state this function can return.
 */
export function requireStaffSession(
  provider: StaffSessionProvider,
  sessionToken: string | undefined,
): StaffSessionContext {
  const session = provider.resolveStaffSession(sessionToken);
  if (session === undefined) {
    throw new StaffUnauthenticatedError();
  }
  return session;
}
