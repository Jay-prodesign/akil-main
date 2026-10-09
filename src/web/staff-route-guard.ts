import { isStaffSessionContextActive, type StaffSessionContext } from "./staff-session-context.js";
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
 *
 * OS-V1-02: a session that resolves but is `REVOKED`, or has expired as of
 * the optional `now`, collapses into the exact same `StaffUnauthenticatedError`
 * as "no session at all" - deliberately not a distinct error type, for the
 * same reason an unresolved token and a missing token are not distinguished:
 * distinguishing "revoked"/"expired" from "never existed" would leak session
 * existence to an unauthenticated caller. `now` is optional and purely
 * additive - a caller that never passes it gets exactly the pre-OS-V1-02
 * behavior for any session without an `expiresAt` (every existing fixture),
 * and `isStaffSessionContextActive` itself fails closed (never open) for a
 * session that declares an `expiresAt` but is checked with no `now`.
 */
export function requireStaffSession(
  provider: StaffSessionProvider,
  sessionToken: string | undefined,
  now?: string,
): StaffSessionContext {
  const session = provider.resolveStaffSession(sessionToken);
  if (session === undefined) {
    throw new StaffUnauthenticatedError();
  }
  if (!isStaffSessionContextActive(session, now)) {
    throw new StaffUnauthenticatedError();
  }
  return session;
}
