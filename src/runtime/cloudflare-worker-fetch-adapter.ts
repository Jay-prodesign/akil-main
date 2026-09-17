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
  /**
   * Bounded hardening correction (Rev66 completion-confidence audit): a
   * request header name is fully caller-controlled - a real client can
   * send a header literally named `__proto__`. Assigning a string value to
   * `headers["__proto__"]` on a plain `{}` invokes `Object.prototype`'s
   * special `__proto__` accessor setter, which silently no-ops for a
   * non-object/non-null value rather than storing it - the header would be
   * silently and completely discarded before ever reaching the request
   * handler. `Object.create(null)` has no inherited `__proto__` accessor,
   * so every header name, including prototype-shaped ones, is stored as an
   * ordinary own property.
   */
  const headers: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
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
