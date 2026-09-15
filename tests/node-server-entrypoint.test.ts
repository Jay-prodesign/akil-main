import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAppConfig } from "../src/runtime/app-config.js";
import { createNodeRuntime, health } from "../src/runtime/node-server-entrypoint.js";
import { WEB_SHELL_DEV_SESSION_TOKEN } from "../src/fixtures/web-shell.js";
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

test("N1: health(config) reports HEALTHY for a validly resolved config", () => {
  const config = resolveAppConfig({});
  const result = health(config);
  assert.equal(result.status, "HEALTHY");
});

test("N2: createNodeRuntime boots a real server that serves the existing shell end-to-end over an ephemeral local port", async () => {
  const config = resolveAppConfig({ DEPLOYMENT_ENV: "development" });
  const runtime = createNodeRuntime(config);
  const port = await listenOnEphemeralPort(runtime.server);
  try {
    const path = `/portal/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "x-akilta-session-token": WEB_SHELL_DEV_SESSION_TOKEN },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.length > 0);
  } finally {
    await closeServer(runtime.server);
  }
});

test("N3: an unauthenticated request against the booted runtime is rejected, not silently served", async () => {
  const config = resolveAppConfig({ DEPLOYMENT_ENV: "development" });
  const runtime = createNodeRuntime(config);
  const port = await listenOnEphemeralPort(runtime.server);
  try {
    const path = `/portal/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.notEqual(response.status, 200);
  } finally {
    await closeServer(runtime.server);
  }
});
