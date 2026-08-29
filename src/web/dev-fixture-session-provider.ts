import type { SessionContext } from "./session-context.js";
import type { SessionProvider } from "./session-provider.js";

/**
 * V2-APP-001 (IN SCOPE E / Architecture Invariant #9 / A7): this provider
 * exists ONLY to let the shell and later V2-CDO-006 be implemented and
 * tested without selecting an external identity provider. It is
 * mechanically isolated from production: `createDevFixtureSessionProvider`
 * throws immediately - before returning any usable provider - if asked to
 * construct one while `isProduction` is true. There is no runtime flag,
 * environment variable, or request value that can make this provider
 * exist in a process that declared itself production; the guard is at
 * construction time, not per-request, so it cannot be bypassed by any
 * request the provider itself later receives.
 */
export class DevFixtureSessionProviderInProductionError extends Error {
  constructor() {
    super(
      "DevFixtureSessionProvider must never be constructed when isProduction is true - this is a fail-closed mechanical guard, not a per-request check",
    );
    this.name = "DevFixtureSessionProviderInProductionError";
  }
}

/**
 * `fixtures` is a fixed, deterministic in-memory token -> SessionContext
 * map - a test aid only (IN SCOPE E: "deterministic"). It is never a
 * durable production identity/session store (Architecture Invariant #4).
 */
export function createDevFixtureSessionProvider(input: {
  fixtures: ReadonlyMap<string, SessionContext>;
  isProduction: boolean;
}): SessionProvider {
  if (input.isProduction) {
    throw new DevFixtureSessionProviderInProductionError();
  }
  return {
    resolveSession(sessionToken: string | undefined): SessionContext | undefined {
      if (sessionToken === undefined) {
        return undefined;
      }
      return input.fixtures.get(sessionToken);
    },
  };
}
