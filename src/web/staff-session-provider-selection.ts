import { createProductionStaffSessionProvider } from "./production-staff-session-provider.js";
import { createDevFixtureStaffSessionProvider } from "./dev-fixture-staff-session-provider.js";
import type { StaffSessionContext } from "./staff-session-context.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";

/**
 * C1 (runtime composition root): the staff-session-provider selection that
 * used to be inlined in `createInternalOsHttpServer` (Rev168). It now
 * lives here so the deployable runtime (`node-server-entrypoint.ts`,
 * which serves `/os` from the same single Node server as `/portal`) makes
 * exactly the same fail-closed choice instead of copying it.
 * `internal-os-http-server.ts` calls this same function.
 *
 * Behavior is identical to the previous inline code:
 *
 * - `isProduction: true` always selects
 *   `createProductionStaffSessionProvider()`, which always reports
 *   unauthenticated (no real staff IdP exists yet), and never reads
 *   `devStaffFixtures`.
 * - Non-production selects the dev-fixture provider, whose own
 *   construction independently throws under `isProduction: true`.
 *
 * No caller can supply a staff provider of its own through this
 * function.
 */
export function selectInternalOsStaffSessionProvider(deps: {
  readonly isProduction: boolean;
  readonly devStaffFixtures?: ReadonlyMap<string, StaffSessionContext>;
}): StaffSessionProvider {
  return deps.isProduction
    ? createProductionStaffSessionProvider()
    : createDevFixtureStaffSessionProvider({
        fixtures: deps.devStaffFixtures ?? new Map(),
        isProduction: false,
      });
}
