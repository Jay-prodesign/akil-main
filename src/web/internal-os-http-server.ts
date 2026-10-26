import { createServer, type Server } from "node:http";
import { selectInternalOsStaffSessionProvider } from "./staff-session-provider-selection.js";
import type { StaffSessionContext } from "./staff-session-context.js";
import {
  createInternalOsRequestHandler,
  type InternalOsRequestHandlerDeps,
} from "./internal-os-request-handler.js";
import type { IncomingRequestLike } from "./request-handler.js";
import { toIncomingRequestLikeFromNode, serveWithBoundedRequestBody } from "./http-server.js";

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
 *
 * C1: this standalone server is now used only by the dev-only
 * `internal-os-dev-main.ts` bootstrap and by tests. The deployable runtime
 * serves `/os` through `http-server.ts`'s single composed Node server. The
 * provider selection itself moved to `staff-session-provider-selection.ts`
 * (unchanged behavior), so both servers share one implementation.
 */
export function createInternalOsHttpServer(
  deps: Omit<InternalOsRequestHandlerDeps, "provider"> & {
    isProduction: boolean;
    devStaffFixtures?: ReadonlyMap<string, StaffSessionContext>;
  },
): Server {
  const provider = selectInternalOsStaffSessionProvider({
    isProduction: deps.isProduction,
    ...(deps.devStaffFixtures !== undefined ? { devStaffFixtures: deps.devStaffFixtures } : {}),
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
    ...(deps.customerOffboardingAdminSource !== undefined
      ? { customerOffboardingAdminSource: deps.customerOffboardingAdminSource }
      : {}),
    ...(deps.connectionsSource !== undefined ? { connectionsSource: deps.connectionsSource } : {}),
    ...(deps.peopleDirectorySource !== undefined ? { peopleDirectorySource: deps.peopleDirectorySource } : {}),
    ...(deps.knowledgeSource !== undefined ? { knowledgeSource: deps.knowledgeSource } : {}),
    ...(deps.attentionSource !== undefined ? { attentionSource: deps.attentionSource } : {}),
    ...(deps.customerOffboardingDecision !== undefined
      ? { customerOffboardingDecision: deps.customerOffboardingDecision }
      : {}),
    ...(deps.connectorConnectionStateDecision !== undefined
      ? { connectorConnectionStateDecision: deps.connectorConnectionStateDecision }
      : {}),
  });

  return createServer((req, res) => {
    /**
     * C1a (PROTO-HEADER-HARDENING follow-up): that checkpoint said it fixed
     * "both Node and Cloudflare Worker transports", but it only changed
     * `http-server.ts` and `cloudflare-worker-fetch-adapter.ts`. This
     * second Node transport kept its own inline copy of the translation,
     * with a plain `{}` header dictionary that silently drops a
     * caller-supplied `__proto__` header. It now calls the same
     * null-prototype translation `http-server.ts` uses
     * (`toIncomingRequestLikeFromNode`) instead of keeping a copy.
     */
    const request: IncomingRequestLike = toIncomingRequestLikeFromNode(req);

    // C4: a POST is the only request that reads a body. It is buffered
    // with the same hard cap as the deployable runtime's server
    // (`serveWithBoundedRequestBody`). Every other method is dispatched
    // synchronously, exactly as before.
    if (request.method === "POST") {
      serveWithBoundedRequestBody(req, res, request, handleRequest);
      return;
    }

    const response = handleRequest(request);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });
}
