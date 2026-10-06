import { createServer, type Server } from "node:http";
import { createProductionStaffSessionProvider } from "./production-staff-session-provider.js";
import { createDevFixtureStaffSessionProvider } from "./dev-fixture-staff-session-provider.js";
import type { StaffSessionContext } from "./staff-session-context.js";
import {
  createInternalOsRequestHandler,
  type InternalOsRequestHandlerDeps,
} from "./internal-os-request-handler.js";
import type { IncomingRequestLike } from "./request-handler.js";

/**
 * Rev168 (mirrors `http-server.ts`'s own ADR 0001 discipline exactly, for
 * this package's own OS-V0-08 surface): the only file in this package that
 * imports `node:http`. `isProduction: true` always selects
 * `createProductionStaffSessionProvider()` (which always reports
 * unauthenticated - no real staff IdP exists yet), never the dev-fixture
 * provider - the dev-fixture provider's own construction already throws if
 * asked to build under `isProduction: true` (`DevFixtureStaffSessionProviderInProductionError`),
 * so this is a second, independent guard at the composition point, not the
 * only one.
 */
export function createInternalOsHttpServer(
  deps: Omit<InternalOsRequestHandlerDeps, "provider"> & {
    isProduction: boolean;
    devStaffFixtures?: ReadonlyMap<string, StaffSessionContext>;
  },
): Server {
  const provider = deps.isProduction
    ? createProductionStaffSessionProvider()
    : createDevFixtureStaffSessionProvider({
        fixtures: deps.devStaffFixtures ?? new Map(),
        isProduction: false,
      });

  const handleRequest = createInternalOsRequestHandler({
    provider,
    organization: deps.organization,
    grants: deps.grants,
    ...(deps.projectSource !== undefined ? { projectSource: deps.projectSource } : {}),
    ...(deps.jobSource !== undefined ? { jobSource: deps.jobSource } : {}),
    ...(deps.resourceBindingSource !== undefined ? { resourceBindingSource: deps.resourceBindingSource } : {}),
    ...(deps.operationalObservabilitySource !== undefined
      ? { operationalObservabilitySource: deps.operationalObservabilitySource }
      : {}),
  });

  return createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = Array.isArray(value) ? value[0] : value;
    }
    const request: IncomingRequestLike = { method, path: url.pathname, headers };

    const response = handleRequest(request);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });
}
