import type { StaffSessionContext } from "./staff-session-context.js";

/**
 * Mirrors `session-provider.ts`'s (V2-APP-001) `SessionProvider` exactly,
 * for the structurally distinct staff identity domain: the one
 * abstraction every internal/staff route-admission check depends on.
 * Connecting a real external identity/session vendor for staff is
 * explicitly out of scope for this checkpoint - `resolveStaffSession`
 * returning `undefined` means "not authenticated" and is always a safe,
 * fail-closed answer.
 */
export interface StaffSessionProvider {
  resolveStaffSession(sessionToken: string | undefined): StaffSessionContext | undefined;
}
