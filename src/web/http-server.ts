import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SessionContext } from "./session-context.js";
import { createProductionSessionProvider } from "./production-session-provider.js";
import { createDevFixtureSessionProvider } from "./dev-fixture-session-provider.js";
import {
  createRequestHandler,
  type IncomingRequestLike,
  type OutgoingResponseLike,
  type RequestHandler,
} from "./request-handler.js";
import type { ClientProjectSnapshotSource } from "./snapshot-view-state.js";
import type { TeamAttentionSource } from "./team-attention-view-state.js";
import type { CustomerCommercialStatusSource } from "./customer-commercial-view-state.js";
import type { BillingReferenceStatusSource } from "./billing-reference-view-state.js";
import type { CustomerLifecycleReadinessSource } from "./customer-lifecycle-readiness-view-state.js";
import type { IdentityVerifier } from "./identity-verifier.js";

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
 *
 * C1 / C1a: this translation used to be inlined here and copied into
 * `internal-os-http-server.ts`, and the copy kept a plain `{}`. That is
 * how PROTO-HEADER-HARDENING missed the internal-OS Node transport. Both
 * Node transports now call this one exported function, so they cannot
 * drift apart again, and it is unit-testable without a socket (no real
 * HTTP client will even transmit a `__proto__` header - see
 * PROTO-HEADER-HARDENING.md's disclosed limitation).
 */
export function toIncomingRequestLikeFromNode(
  req: Pick<IncomingMessage, "method" | "url" | "headers">,
): IncomingRequestLike {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = Array.isArray(value) ? value[0] : value;
  }
  return { method, path: url.pathname, headers };
}

/**
 * C1: `true` exactly when `path` belongs to the staff `/os` surface, using
 * the same segment split `internal-os-request-handler.ts`'s own
 * `parseInternalOsPath` uses (empty segments dropped), so the dispatcher
 * and the handler always agree on what an `/os` path is.
 */
export function isInternalOsPath(path: string): boolean {
  return path.split("/").filter((segment) => segment.length > 0)[0] === "os";
}

/**
 * C1: returned when a handler throws instead of returning a response. It
 * is a plain body with no error message, stack, or request data.
 */
const INTERNAL_ERROR_RESPONSE: OutgoingResponseLike = {
  status: 500,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: "Internal Server Error",
};

/**
 * C4 (first `/os` mutation route): the hard cap on a buffered `/os` POST
 * body, in bytes. 8 KiB. The only POST forms on this surface are the
 * customer-offboarding deny/complete forms: a request id, a version number
 * and (for deny) a short free-text reason, URL-encoded. That is a few
 * hundred bytes in practice, and even a long reason in a non-Latin script
 * (URL-encoding can triple its byte size) stays far below 8 KiB.
 *
 * The cap exists because the body is buffered BEFORE the staff session is
 * checked (see `serveWithBoundedRequestBody`), so an unauthenticated caller
 * controls how much is held in memory. 8 KiB per in-flight request is the
 * same order as what Node already holds per request for headers (its
 * default `maxHeaderSize` is 16 KiB), so this adds no new class of memory
 * exposure.
 */
export const INTERNAL_OS_MAX_REQUEST_BODY_BYTES = 8 * 1024;

const PAYLOAD_TOO_LARGE_RESPONSE: OutgoingResponseLike = {
  status: 413,
  headers: { "content-type": "text/plain; charset=utf-8", connection: "close" },
  body: "Payload Too Large",
};

export type BoundedRequestBodyOutcome =
  | { readonly kind: "COMPLETE"; readonly body: string }
  | { readonly kind: "TOO_LARGE" }
  | { readonly kind: "ABORTED" };

/**
 * C4: reads a request body off the socket, holding at most `maxBytes` of it
 * in memory, and reports exactly one outcome.
 *
 * - A declared `content-length` above `maxBytes` (or one that is not a
 *   number) is `TOO_LARGE` at once, before a single body byte is read.
 * - Without a usable declared length (for example a chunked upload), bytes
 *   are counted as they arrive. The first chunk that takes the total over
 *   `maxBytes` pauses the stream and reports `TOO_LARGE`. That chunk and
 *   everything after it are never kept.
 * - A request stream that errors or closes before `end` is `ABORTED`.
 *
 * Slow senders are bounded by Node's own `server.requestTimeout` (300 s by
 * default), which covers receiving the whole request, body included.
 */
export function readBoundedRequestBody(
  req: IncomingMessage,
  maxBytes: number,
  onDone: (outcome: BoundedRequestBodyOutcome) => void,
): void {
  let settled = false;
  const chunks: Buffer[] = [];
  let total = 0;

  const settle = (outcome: BoundedRequestBodyOutcome): void => {
    if (settled) {
      return;
    }
    settled = true;
    req.removeListener("data", onData);
    req.removeListener("end", onEnd);
    req.removeListener("close", onClose);
    chunks.length = 0;
    onDone(outcome);
  };

  function onData(chunk: Buffer | string): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    total += buffer.length;
    if (total > maxBytes) {
      req.pause();
      settle({ kind: "TOO_LARGE" });
      return;
    }
    chunks.push(buffer);
  }

  function onEnd(): void {
    const body = Buffer.concat(chunks, total).toString("utf8");
    settle({ kind: "COMPLETE", body });
  }

  function onClose(): void {
    settle({ kind: "ABORTED" });
  }

  // Kept for the request's whole lifetime, even after `settle`: an `error`
  // event with no listener would be thrown and crash the process.
  req.on("error", () => settle({ kind: "ABORTED" }));

  const declared = req.headers["content-length"];
  if (declared !== undefined) {
    const declaredBytes = Number(declared);
    if (!Number.isFinite(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes) {
      req.pause();
      settle({ kind: "TOO_LARGE" });
      return;
    }
  }

  req.on("data", onData);
  req.on("end", onEnd);
  req.on("close", onClose);
}

function writeResponse(res: ServerResponse, response: OutgoingResponseLike, onFinished?: () => void): void {
  res.writeHead(response.status, response.headers);
  if (onFinished !== undefined) {
    res.end(response.body, onFinished);
  } else {
    res.end(response.body);
  }
}

/**
 * C4: serves one request whose handler needs its body, used only for `/os`
 * POST requests (both `createHttpServer` below and the dev-only
 * `internal-os-http-server.ts`). Every other request in both servers is
 * still dispatched synchronously with no body read, exactly as before C4.
 *
 * Order: the body is buffered first (bounded by `maxBytes`), and only then
 * is the handler called, which checks the staff session before it parses
 * the body. Checking the session before buffering would mean resolving the
 * organization, the grants and the session here in the transport, which
 * ADR 0001 keeps out of this file, or calling the handler twice. With an
 * 8 KiB cap, buffering first costs at most 8 KiB per in-flight request.
 *
 * - `TOO_LARGE`: a plain 413 with `connection: close`, then the socket is
 *   destroyed once the response is flushed. The handler is never called.
 * - `ABORTED`: the client is gone. Nothing is written and the handler is
 *   never called.
 * - `COMPLETE`: the handler gets the request with `body` set. If it
 *   throws, the response is the same generic 500 as the synchronous path.
 */
export function serveWithBoundedRequestBody(
  req: IncomingMessage,
  res: ServerResponse,
  request: IncomingRequestLike,
  handler: RequestHandler,
  maxBytes: number = INTERNAL_OS_MAX_REQUEST_BODY_BYTES,
): void {
  readBoundedRequestBody(req, maxBytes, (outcome) => {
    if (outcome.kind === "ABORTED") {
      req.destroy();
      return;
    }
    if (outcome.kind === "TOO_LARGE") {
      writeResponse(res, PAYLOAD_TOO_LARGE_RESPONSE, () => req.destroy());
      return;
    }
    let response: OutgoingResponseLike;
    try {
      response = handler({ ...request, body: outcome.body });
    } catch {
      response = INTERNAL_ERROR_RESPONSE;
    }
    writeResponse(res, response);
  });
}

export function createHttpServer(deps: {
  isProduction: boolean;
  devSessionFixtures?: ReadonlyMap<string, SessionContext>;
  snapshotSource: ClientProjectSnapshotSource;
  teamAttentionSource?: TeamAttentionSource;
  /**
   * C1: the three V2-CUST-SURFACE-001 ports `createRequestHandler` has
   * accepted since that checkpoint. Until now this server never passed
   * them through, so those portal sections were unreachable from any real
   * server. Each one is optional and additive. An absent port makes its
   * section render the existing honest "Unavailable" state.
   */
  commercialStatusSource?: CustomerCommercialStatusSource;
  billingReferenceStatusSource?: BillingReferenceStatusSource;
  lifecycleReadinessSource?: CustomerLifecycleReadinessSource;
  healthCheck?: () => HealthProbeResponse;
  identityVerifier?: IdentityVerifier;
  /**
   * C1: an already-composed, transport-agnostic handler for the staff
   * `/os` surface. When it is present, every `/os` path is sent to it
   * instead of to the portal handler. The caller builds it with its own
   * fail-closed staff provider (see `staff-session-provider-selection.ts`);
   * this server only routes to it. When it is absent, `/os` paths fall
   * through to the portal handler's `NOT_FOUND`, which is the behavior
   * before C1.
   */
  internalOsHandler?: RequestHandler;
}): Server {
  const sessionProvider = deps.isProduction
    ? createProductionSessionProvider(
        deps.identityVerifier !== undefined ? { verifier: deps.identityVerifier } : undefined,
      )
    : createDevFixtureSessionProvider({
        fixtures: deps.devSessionFixtures ?? new Map(),
        isProduction: false,
      });

  const handleRequest = createRequestHandler({
    sessionProvider,
    snapshotSource: deps.snapshotSource,
    ...(deps.teamAttentionSource !== undefined ? { teamAttentionSource: deps.teamAttentionSource } : {}),
    ...(deps.commercialStatusSource !== undefined ? { commercialStatusSource: deps.commercialStatusSource } : {}),
    ...(deps.billingReferenceStatusSource !== undefined
      ? { billingReferenceStatusSource: deps.billingReferenceStatusSource }
      : {}),
    ...(deps.lifecycleReadinessSource !== undefined ? { lifecycleReadinessSource: deps.lifecycleReadinessSource } : {}),
  });

  return createServer((req, res) => {
    /**
     * C1 last-resort guard. Before C1, every source behind these handlers
     * was an in-memory fixture that never threw. Now they read real FILE
     * stores, and a store's fail-closed replay validation throws on a
     * corrupted tenant file. Not every resolver on the `/os` path catches
     * that (for example `resolveWorkProjectDetailView`), and an exception
     * escaping a `node:http` request listener crashes the whole process.
     * One damaged tenant file would then take the runtime down for every
     * tenant. This guard turns any exception that escapes into a single
     * generic 500 for that one request. It never reveals the error, and
     * the process keeps serving.
     *
     * C1 fix (review finding): `toIncomingRequestLikeFromNode` itself can
     * throw - `new URL(req.url ?? "/", "http://localhost")` rejects a
     * request target such as `//` or `//:99999/` (parsed as a host, then
     * rejected as an invalid one) with `ERR_INVALID_URL`. That call used
     * to run before this guard, so a single unauthenticated, malformed
     * request line crashed the whole process for every tenant. The
     * translation now runs inside the guard, like every other failure
     * path.
     */
    let response: OutgoingResponseLike;
    try {
      const request = toIncomingRequestLikeFromNode(req);

      // DEPLOY-003: health checks are a transport-level concern (no
      // session/snapshot involvement), so they're handled here, before
      // translating into the authenticated-shell request path at all -
      // never routed through handleRequest/requireSession.
      if (request.method === "GET" && request.path === "/health" && deps.healthCheck !== undefined) {
        const probe = deps.healthCheck();
        response = {
          status: probe.healthy ? 200 : 503,
          headers: { "content-type": "application/json" },
          body: probe.body,
        };
      } else if (deps.internalOsHandler !== undefined && isInternalOsPath(request.path)) {
        // C4: only an `/os` POST reads a body, asynchronously and bounded.
        // Every other `/os` method, and every `/portal` request below,
        // stays on the synchronous path exactly as before.
        if (request.method === "POST") {
          serveWithBoundedRequestBody(req, res, request, deps.internalOsHandler);
          return;
        }
        response = deps.internalOsHandler(request);
      } else {
        response = handleRequest(request);
      }
    } catch {
      response = INTERNAL_ERROR_RESPONSE;
    }

    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });
}
