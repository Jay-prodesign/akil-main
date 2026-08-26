import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestHandler, type IncomingRequestLike } from "../src/web/request-handler.js";
import { createDevFixtureSessionProvider } from "../src/web/dev-fixture-session-provider.js";
import { createProductionSessionProvider } from "../src/web/production-session-provider.js";
import {
  WEB_SHELL_DEV_SESSION_TOKEN,
  WEB_SHELL_DEV_SESSION_FIXTURES,
  createWebShellFixtureSnapshotSource,
} from "../src/fixtures/web-shell.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";

const SESSION_TOKEN_HEADER = "x-akilta-session-token";
const PORTAL_PATH = `/portal/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;

function request(overrides: Partial<IncomingRequestLike>): IncomingRequestLike {
  return {
    method: "GET",
    path: PORTAL_PATH,
    headers: {},
    ...overrides,
  };
}

function devHandler() {
  return createRequestHandler({
    sessionProvider: createDevFixtureSessionProvider({
      fixtures: WEB_SHELL_DEV_SESSION_FIXTURES,
      isProduction: false,
    }),
    snapshotSource: createWebShellFixtureSnapshotSource(),
  });
}

test("an unsupported HTTP method resolves 501 UNSUPPORTED without ever checking session or ownership", () => {
  const handler = devHandler();
  const response = handler(request({ method: "POST" }));
  assert.equal(response.status, 501);
});

test("an unparseable path resolves 404 NOT_FOUND", () => {
  const handler = devHandler();
  const response = handler(request({ path: "/not-a-portal-path" }));
  assert.equal(response.status, 404);
});

test("A4: a missing session token resolves 401 UNAUTHENTICATED", () => {
  const handler = devHandler();
  const response = handler(request({ headers: {} }));
  assert.equal(response.status, 401);
});

test("A4: an invalid/unknown session token resolves 401 UNAUTHENTICATED", () => {
  const handler = devHandler();
  const response = handler(request({ headers: { [SESSION_TOKEN_HEADER]: "not-a-real-token" } }));
  assert.equal(response.status, 401);
});

test("A5: a valid session for a different tenant/project resolves 403 FORBIDDEN_TENANT_SCOPE", () => {
  const handler = createRequestHandler({
    sessionProvider: createDevFixtureSessionProvider({
      fixtures: WEB_SHELL_DEV_SESSION_FIXTURES,
      isProduction: false,
    }),
    snapshotSource: createWebShellFixtureSnapshotSource(),
  });
  const response = handler(
    request({
      path: "/portal/some-other-tenant/some-other-customer/some-other-project",
      headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN },
    }),
  );
  assert.equal(response.status, 403);
});

test("A9: a valid session with matching ownership resolves 200 READY and renders the underlying snapshot's delivery status", () => {
  const handler = devHandler();
  const response = handler(request({ headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN } }));
  assert.equal(response.status, 200);
  assert.match(response.body, /Delivery status/);
  assert.match(response.body, /IN_PROGRESS/);
});

test("A7: the exact dev-fixture token that authenticates a dev-mode handler is rejected (401) by a production-mode handler", () => {
  const productionHandler = createRequestHandler({
    sessionProvider: createProductionSessionProvider(),
    snapshotSource: createWebShellFixtureSnapshotSource(),
  });
  const response = productionHandler(
    request({ headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN } }),
  );
  assert.equal(response.status, 401);
});
