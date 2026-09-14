import type { StaffSessionContext } from "./staff-session-context.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";

/**
 * Mirrors `dev-fixture-session-provider.ts`'s (V2-APP-001) mechanical
 * production guard exactly, for the staff identity domain: this provider
 * exists ONLY to let staff-ingress-dependent work (e.g. `LOCAL-EXEC-004`)
 * be implemented and tested without selecting an external identity
 * provider. `createDevFixtureStaffSessionProvider` throws immediately -
 * before returning any usable provider - if asked to construct one while
 * `isProduction` is true. There is no runtime flag, environment variable,
 * or request value that can make this provider exist in a process that
 * declared itself production; the guard is at construction time, not
 * per-request, so it cannot be bypassed by any request the provider
 * itself later receives.
 */
export class DevFixtureStaffSessionProviderInProductionError extends Error {
  constructor() {
    super(
      "DevFixtureStaffSessionProvider must never be constructed when isProduction is true - this is a fail-closed mechanical guard, not a per-request check",
    );
    this.name = "DevFixtureStaffSessionProviderInProductionError";
  }
}

/**
 * `fixtures` is a fixed, deterministic in-memory token -> StaffSessionContext
 * map - a test aid only, never a durable production identity/session
 * store, matching `dev-fixture-session-provider.ts`'s exact discipline.
 */
export function createDevFixtureStaffSessionProvider(input: {
  fixtures: ReadonlyMap<string, StaffSessionContext>;
  isProduction: boolean;
}): StaffSessionProvider {
  if (input.isProduction) {
    throw new DevFixtureStaffSessionProviderInProductionError();
  }
  return {
    resolveStaffSession(sessionToken: string | undefined): StaffSessionContext | undefined {
      if (sessionToken === undefined) {
        return undefined;
      }
      return input.fixtures.get(sessionToken);
    },
  };
}
