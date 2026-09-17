import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toIncomingRequestLike,
  toFetchResponse,
  createCloudflareWorkerFetchHandler,
} from "../src/runtime/cloudflare-worker-fetch-adapter.js";
import type { RequestHandler } from "../src/web/request-handler.js";

test("W1: toIncomingRequestLike translates method/path/headers from a Fetch API Request", () => {
  const request = new Request("http://worker.example/portal/tenant-1/customer-1/project-1", {
    method: "GET",
    headers: { "x-akilta-session-token": "dev-token-website-build-v1" },
  });
  const translated = toIncomingRequestLike(request);
  assert.equal(translated.method, "GET");
  assert.equal(translated.path, "/portal/tenant-1/customer-1/project-1");
  assert.equal(translated.headers["x-akilta-session-token"], "dev-token-website-build-v1");
});

test("W2: toFetchResponse translates status/headers/body into a Fetch API Response", async () => {
  const response = toFetchResponse({ status: 404, headers: { "content-type": "text/html" }, body: "not found" });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type"), "text/html");
  assert.equal(await response.text(), "not found");
});

test("W4 (Rev66 audit, adversarial - prototype-shaped header name): a request header literally named \"__proto__\" is preserved as a real header value, not silently dropped via the Object.prototype accessor setter", () => {
  // A plain object literal `{ "__proto__": "x" }` sets the prototype at parse time rather than
  // creating an own property, so the array-of-pairs Headers constructor form is used here to
  // construct a header genuinely named "__proto__" - exactly what a real Fetch API Request can
  // carry (proven directly against the Fetch API's own Headers implementation).
  const request = new Request("http://worker.example/x", {
    method: "GET",
    headers: [
      ["__proto__", "evil-header-value"],
      ["constructor", "another-value"],
      ["x-normal", "y"],
    ],
  });
  const translated = toIncomingRequestLike(request);
  assert.equal(translated.headers["__proto__"], "evil-header-value");
  assert.equal(translated.headers["constructor"], "another-value");
  assert.equal(translated.headers["x-normal"], "y");
  assert.ok(Object.prototype.hasOwnProperty.call(translated.headers, "__proto__"));
});

test("W3: createCloudflareWorkerFetchHandler composes both directions through an injected RequestHandler unmodified", async () => {
  let capturedPath: string | undefined;
  const stubHandler: RequestHandler = (request) => {
    capturedPath = request.path;
    return { status: 200, headers: { "content-type": "text/plain" }, body: `handled:${request.method}` };
  };
  const fetchHandler = createCloudflareWorkerFetchHandler(stubHandler);
  const response = fetchHandler(new Request("http://worker.example/some/path", { method: "POST" }));
  assert.equal(capturedPath, "/some/path");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "handled:POST");
});
