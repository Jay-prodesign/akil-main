import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer, toIncomingRequestLikeFromNode, isInternalOsPath } from "../src/web/http-server.js";
import {
  createWebShellFixtureSnapshotSource,
  createWebShellFixtureCommercialStatusSource,
  createWebShellFixtureBillingReferenceStatusSource,
  createWebShellFixtureLifecycleReadinessSource,
  WEB_SHELL_DEV_SESSION_FIXTURES,
  WEB_SHELL_DEV_SESSION_TOKEN,
} from "../src/fixtures/web-shell.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";

function listenOnEphemeralPort(server: import("node:http").Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected an AddressInfo from an ephemeral-port listen");
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("DEPLOY-003 H1: GET /health falls through to the normal (404) handler when no healthCheck is configured", async () => {
  const server = createHttpServer({
    isProduction: false,
    snapshotSource: createWebShellFixtureSnapshotSource(),
  });
  const port = await listenOnEphemeralPort(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 404);
  } finally {
    await closeServer(server);
  }
});

test("DEPLOY-003 H2: GET /health returns 200 with the probe's body when healthCheck reports healthy, with no session token required", async () => {
  const server = createHttpServer({
    isProduction: false,
    snapshotSource: createWebShellFixtureSnapshotSource(),
    healthCheck: () => ({ healthy: true, body: JSON.stringify({ status: "HEALTHY" }) }),
  });
  const port = await listenOnEphemeralPort(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    const body = await response.json();
    assert.deepEqual(body, { status: "HEALTHY" });
  } finally {
    await closeServer(server);
  }
});

test("DEPLOY-003 H3: GET /health returns 503 when healthCheck reports unhealthy", async () => {
  const server = createHttpServer({
    isProduction: false,
    snapshotSource: createWebShellFixtureSnapshotSource(),
    healthCheck: () => ({ healthy: false, body: JSON.stringify({ status: "UNHEALTHY" }) }),
  });
  const port = await listenOnEphemeralPort(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 503);
  } finally {
    await closeServer(server);
  }
});

test("DEPLOY-003 H4: a non-GET /health request is never routed to healthCheck - it falls through to the normal handler's method rejection", async () => {
  let healthCheckCalls = 0;
  const server = createHttpServer({
    isProduction: false,
    snapshotSource: createWebShellFixtureSnapshotSource(),
    healthCheck: () => {
      healthCheckCalls += 1;
      return { healthy: true, body: "{}" };
    },
  });
  const port = await listenOnEphemeralPort(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    assert.equal(response.status, 501);
    assert.equal(healthCheckCalls, 0);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// C1 (runtime composition root): /os dispatch, the three V2-CUST-SURFACE-001
// ports threaded through, the shared null-prototype header translation
// (C1a), and the last-resort exception guard.
// ---------------------------------------------------------------------------

const C1_PORTAL_PATH = `/portal/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;

test("C1 H5: with internalOsHandler supplied, /os paths (including /os itself and an empty-segment form) go to it; /portal and /health never do", async () => {
  const seen: string[] = [];
  const server = createHttpServer({
    isProduction: false,
    devSessionFixtures: WEB_SHELL_DEV_SESSION_FIXTURES,
    snapshotSource: createWebShellFixtureSnapshotSource(),
    healthCheck: () => ({ healthy: true, body: "{\"status\":\"HEALTHY\"}" }),
    internalOsHandler: (request) => {
      seen.push(request.path);
      return { status: 299, headers: { "content-type": "text/plain" }, body: "staff-surface" };
    },
  });
  const port = await listenOnEphemeralPort(server);
  try {
    for (const path of ["/os", "/os/home", "/os//work", "/os/admin"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 299, path);
      assert.equal(await response.text(), "staff-surface");
    }
    const portal = await fetch(`http://127.0.0.1:${port}${C1_PORTAL_PATH}`, {
      headers: { "x-akilta-session-token": WEB_SHELL_DEV_SESSION_TOKEN },
    });
    assert.equal(portal.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/osx/home`)).status, 404);
    assert.deepEqual(seen, ["/os", "/os/home", "/os//work", "/os/admin"]);
  } finally {
    await closeServer(server);
  }
});

test("C1 H6: with no internalOsHandler, /os paths keep their pre-C1 behavior - the portal handler's NOT_FOUND", async () => {
  const server = createHttpServer({ isProduction: false, snapshotSource: createWebShellFixtureSnapshotSource() });
  const port = await listenOnEphemeralPort(server);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/os/home`)).status, 404);
  } finally {
    await closeServer(server);
  }
});

test("C1 H7: createHttpServer now threads commercialStatusSource / billingReferenceStatusSource / lifecycleReadinessSource into the real portal route", async () => {
  const withoutPorts = createHttpServer({
    isProduction: false,
    devSessionFixtures: WEB_SHELL_DEV_SESSION_FIXTURES,
    snapshotSource: createWebShellFixtureSnapshotSource(),
  });
  const withPorts = createHttpServer({
    isProduction: false,
    devSessionFixtures: WEB_SHELL_DEV_SESSION_FIXTURES,
    snapshotSource: createWebShellFixtureSnapshotSource(),
    commercialStatusSource: createWebShellFixtureCommercialStatusSource(),
    billingReferenceStatusSource: createWebShellFixtureBillingReferenceStatusSource(),
    lifecycleReadinessSource: createWebShellFixtureLifecycleReadinessSource(),
  });
  const portA = await listenOnEphemeralPort(withoutPorts);
  const portB = await listenOnEphemeralPort(withPorts);
  try {
    const headers = { "x-akilta-session-token": WEB_SHELL_DEV_SESSION_TOKEN };
    const absent = await (await fetch(`http://127.0.0.1:${portA}${C1_PORTAL_PATH}`, { headers })).text();
    const present = await (await fetch(`http://127.0.0.1:${portB}${C1_PORTAL_PATH}`, { headers })).text();
    assert.doesNotMatch(absent, /Subscription status:/);
    assert.doesNotMatch(absent, /Reference status:/);
    assert.doesNotMatch(absent, /Offboarding status:/);
    assert.match(present, /Subscription status: <strong>ACTIVE<\/strong>/);
    assert.match(present, /Reference status: <strong>ISSUED<\/strong>/);
    assert.match(present, /Offboarding status:/);
  } finally {
    await closeServer(withoutPorts);
    await closeServer(withPorts);
  }
});

test("C1a H8: toIncomingRequestLikeFromNode (shared by both Node transports) keeps a header literally named __proto__ / constructor as an own property", () => {
  // `JSON.parse` creates `__proto__` as an ordinary own data property, exactly
  // as a raw HTTP parser could hand it over - no real HTTP client will even
  // transmit such a header (PROTO-HEADER-HARDENING's disclosed limitation).
  const headers = JSON.parse('{"__proto__":"proto-value","constructor":"ctor-value","x-normal":"ok"}') as import("node:http").IncomingHttpHeaders;
  const translated = toIncomingRequestLikeFromNode({ method: "GET", url: "/os/home?ignored=1", headers });
  assert.equal(translated.path, "/os/home");
  assert.ok(Object.prototype.hasOwnProperty.call(translated.headers, "__proto__"));
  assert.equal(translated.headers["__proto__"], "proto-value");
  assert.equal(translated.headers["constructor"], "ctor-value");
  assert.equal(translated.headers["x-normal"], "ok");
});

test("C1 H9: isInternalOsPath matches exactly the paths whose first non-empty segment is 'os'", () => {
  assert.equal(isInternalOsPath("/os"), true);
  assert.equal(isInternalOsPath("/os/"), true);
  assert.equal(isInternalOsPath("//os/home"), true);
  assert.equal(isInternalOsPath("/osx"), false);
  assert.equal(isInternalOsPath("/portal/os"), false);
  assert.equal(isInternalOsPath("/"), false);
});

test("C1 H10: an exception escaping a handler becomes one generic 500 with no error detail, and the server keeps serving", async () => {
  const server = createHttpServer({
    isProduction: false,
    snapshotSource: createWebShellFixtureSnapshotSource(),
    healthCheck: () => ({ healthy: true, body: "{}" }),
    internalOsHandler: () => {
      throw new Error("secret-internal-detail /var/data/tenant.json");
    },
  });
  const port = await listenOnEphemeralPort(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/os/home`);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body, "Internal Server Error");
    assert.doesNotMatch(body, /secret-internal-detail/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    await closeServer(server);
  }
});
