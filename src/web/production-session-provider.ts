import type { SessionProvider } from "./session-provider.js";

/**
 * V2-APP-001 (IN SCOPE F / Architecture Invariant #8 / A8): this task
 * admits no real external identity/session provider. Production mode's
 * `SessionProvider` therefore always reports "unauthenticated" - it never
 * fabricates a logged-in customer, and there is no code path in this
 * function that could be made to return a session no matter what
 * `sessionToken` value is supplied. Replacing this with a real provider
 * is a separately authorized, separately gated task (Protected Gates:
 * "external provider selection/connection").
 */
export function createProductionSessionProvider(): SessionProvider {
  return {
    resolveSession(): undefined {
      return undefined;
    },
  };
}
