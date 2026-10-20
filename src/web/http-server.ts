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
/**
 * DEPLOY-003: a health probe's result, shaped deliberately as plain
 * {healthy, body} rather than importing `runtime/health-check.ts`'s
 * `HealthCheckResult` here - this file stays decoupled from the
 * runtime layer (node-server-entrypoint.ts already depends on both and
 * does that mapping), matching this module's existing "only translates
 * a real socket request/response" responsibility (ADR 0001).
 */
export interface HealthProbeResponse {
  readonly healthy: boolean;
  readonly body: string;
}

export function createHttpServer(deps: {
  isProduction: boolean;
  devSessionFixtures?: ReadonlyMap<string, SessionContext>;
  snapshotSource: ClientProjectSnapshotSource;
  teamAttentionSource?: TeamAttentionSource;
  healthCheck?: () => HealthProbeResponse;
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

    // DEPLOY-003: health checks are a transport-level concern (no
    // session/snapshot involvement), so they're handled here, before
    // translating into the authenticated-shell request path at all -
    // never routed through handleRequest/requireSession.
    if (method === "GET" && url.pathname === "/health" && deps.healthCheck !== undefined) {
      const probe = deps.healthCheck();
      res.writeHead(probe.healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(probe.body);
      return;
    }

    /**
     * PROTO-HEADER-HARDENING: an incoming request header name is fully
     * caller-controlled - a real client can send a header literally named
     * `__proto__`. Assigning a string value to `headers["__proto__"]` on a
     * plain `{}` invokes `Object.prototype`'s special `__proto__` accessor
     * setter, which silently no-ops for a non-object/non-null value (per
     * the Annex B spec) rather than storing it - the header would be
     * silently and completely discarded before ever reaching the request
     * handler. `Object.create(null)` has no inherited `__proto__` accessor,
     * so every header name, including prototype-shaped ones, is stored as
     * an ordinary own property.
     */
    const headers: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = Array.isArray(value) ? value[0] : value;
    }
    const request: IncomingRequestLike = { method, path: url.pathname, headers };

    const response = handleRequest(request);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });
}
