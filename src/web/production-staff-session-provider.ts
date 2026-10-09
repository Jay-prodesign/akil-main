import type { StaffSessionProvider } from "./staff-session-provider.js";

/**
 * Mirrors `production-session-provider.ts`'s (V2-APP-001) exact
 * discipline for the staff identity domain: this checkpoint admits no
 * real external identity/session provider for staff. Production mode's
 * `StaffSessionProvider` therefore always reports "unauthenticated" - it
 * never fabricates a logged-in staff member, and there is no code path in
 * this function that could be made to return a session no matter what
 * `sessionToken` value is supplied. Replacing this with a real provider
 * is a separately authorized, separately gated task (per Rev102's own
 * correction: real identity-provider credential/account activation
 * remains `BLOCKED_BY_EXACT_PROTECTED_GATE`; only this dark/internal
 * boundary itself is in scope here).
 */
export function createProductionStaffSessionProvider(): StaffSessionProvider {
  return {
    resolveStaffSession(): undefined {
      return undefined;
    },
  };
}
