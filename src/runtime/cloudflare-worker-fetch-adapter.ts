import type { RequestHandler, IncomingRequestLike, OutgoingResponseLike } from "../web/request-handler.js";

/**
 * RUNTIME-001 Cloudflare Worker candidate: the Fetch-API counterpart to
 * `src/web/http-server.ts`'s `node:http` adapter. `request-handler.ts` is
 * already transport-agnostic by design (ADR 0001) - this file is simply
 * the second transport-specific translation layer that same design
 * anticipated, translating the Web-standard `Request`/`Response` a
 * Cloudflare Worker isolate receives to/from the same plain
 * `IncomingRequestLike`/`OutgoingResponseLike` shape `createHttpServer`
 * already translates `node:http`'s request/response to. No change to
 * `request-handler.ts` itself was needed or made.
 *
 * Disclosed, not fabricated, boundary: this adapter only proves the
 * existing read-only shell logic can serve Worker (V8 isolate) traffic.
 * It says nothing about persistence - `FileDurableOutcomeJobStore` (and
 * this checkpoint's own `PostgresOutcomeJobStore`, over a raw TCP `pg`
 * connection) both assume a runtime with `node:fs`/raw sockets, neither
 * of which a Worker isolate provides. Making a durable store reachable
 * from a Worker would need an HTTP-reachable database driver (e.g. a
 * Neon/PlanetScale HTTP client satisfying this repo's own `SqlClient`
 * port) - a specific provider choice this checkpoint deliberately does
 * not make, rather than fabricate one without a real caller.
 */
export function toIncomingRequestLike(request: Request): IncomingRequestLike {
  const url = new URL(request.url);
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { method: request.method, path: url.pathname, headers };
}

export function toFetchResponse(response: OutgoingResponseLike): Response {
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export function createCloudflareWorkerFetchHandler(handleRequest: RequestHandler): (request: Request) => Response {
  return (request: Request): Response => toFetchResponse(handleRequest(toIncomingRequestLike(request)));
}
