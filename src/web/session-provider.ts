import type { SessionContext } from "./session-context.js";

/**
 * V2-APP-001 (IN SCOPE B/C): the one abstraction every route-admission
 * check depends on. Connecting a real external identity/session vendor is
 * explicitly out of scope for this task (see the task head's Hard
 * Non-Scope list); `resolveSession` returning `undefined` means "not
 * authenticated" and is always a safe, fail-closed answer.
 */
export interface SessionProvider {
  resolveSession(sessionToken: string | undefined): SessionContext | undefined;
}
