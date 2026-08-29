import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/web/http-server.js";
import {
  WEB_SHELL_DEV_SESSION_TOKEN,
  WEB_SHELL_DEV_SESSION_FIXTURES,
  createWebShellFixtureSnapshotSource,
} from "../src/fixtures/web-shell.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";

const SESSION_TOKEN_HEADER = "x-akilta-session-token";
const PORTAL_PATH = `/portal/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;

async function withServer(
  deps: Parameters<typeof createHttpServer>[0],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createHttpServer(deps);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("A3: the shell starts on an ephemeral local port and serves a real HTTP request end-to-end", async () => {
  await withServer(
    {
      isProduction: false,
      devSessionFixtures: WEB_SHELL_DEV_SESSION_FIXTURES,
      snapshotSource: createWebShellFixtureSnapshotSource(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}${PORTAL_PATH}`, {
        headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN },
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /Overall status/);
    },
  );
});

test("A4: a real HTTP request with no session token is rejected end-to-end with 401", async () => {
  await withServer(
    {
      isProduction: false,
      devSessionFixtures: WEB_SHELL_DEV_SESSION_FIXTURES,
      snapshotSource: createWebShellFixtureSnapshotSource(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}${PORTAL_PATH}`);
      assert.equal(response.status, 401);
    },
  );
});

test("A8: a production-mode server never admits the dev-fixture token, even when supplied as devSessionFixtures", async () => {
  await withServer(
    {
      isProduction: true,
      devSessionFixtures: WEB_SHELL_DEV_SESSION_FIXTURES,
      snapshotSource: createWebShellFixtureSnapshotSource(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}${PORTAL_PATH}`, {
        headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN },
      });
      assert.equal(response.status, 401);
    },
  );
});
