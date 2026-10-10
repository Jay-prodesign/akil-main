import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "../src/web/http-server.js";
import { createWebShellFixtureSnapshotSource } from "../src/fixtures/web-shell.js";

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
