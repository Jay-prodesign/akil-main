import { createServer, type Server } from "node:http";
import type { SessionContext } from "./session-context.js";
import { createProductionSessionProvider } from "./production-session-provider.js";
import { createDevFixtureSessionProvider } from "./dev-fixture-session-provider.js";
import { createRequestHandler, type IncomingRequestLike } from "./request-handler.js";
import type { ClientProjectSnapshotSource } from "./snapshot-view-state.js";
import type { TeamAttentionSource } from "./team-attention-view-state.js";

/**
 * V2-APP-001 (ADR 0001): the only file in this shell that imports
 * `node:http`. Everything else in `src/web/` is plain, transport-agnostic
 * logic exercised directly by tests; this function's own job is narrow -
 * translate a real socket request/response to/from that plain shape, and
 * (A7/A8) choose the fail-closed production provider whenever
 * `isProduction` is true, never the dev-fixture one.
 */
export function createHttpServer(deps: {
  isProduction: boolean;
  devSessionFixtures?: ReadonlyMap<string, SessionContext>;
  snapshotSource: ClientProjectSnapshotSource;
  teamAttentionSource?: TeamAttentionSource;
}): Server {
  const sessionProvider = deps.isProduction
    ? createProductionSessionProvider()
    : createDevFixtureSessionProvider({
        fixtures: deps.devSessionFixtures ?? new Map(),
        isProduction: false,
      });

  const handleRequest = createRequestHandler({
    sessionProvider,
    snapshotSource: deps.snapshotSource,
    ...(deps.teamAttentionSource !== undefined ? { teamAttentionSource: deps.teamAttentionSource } : {}),
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
