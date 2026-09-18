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
const CLIENT_PLATFORM_PATH = `/client-platform/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;

function request(overrides: Partial<IncomingRequestLike>): IncomingRequestLike {
  return { method: "GET", path: CLIENT_PLATFORM_PATH, headers: {}, ...overrides };
}

function devHandler() {
  return createRequestHandler({
    sessionProvider: createDevFixtureSessionProvider({ fixtures: WEB_SHELL_DEV_SESSION_FIXTURES, isProduction: false }),
    snapshotSource: createWebShellFixtureSnapshotSource(),
  });
}

test("SITE-INTEGRATION-001: /client-platform/... never falls through to the existing HTML /portal/... route handling", () => {
  const handler = devHandler();
  const response = handler(request({ headers: {} }));
  assert.equal(response.headers["content-type"], "application/json");
});

test("SITE-INTEGRATION-001: a missing session token resolves 401 signed-out as JSON", () => {
  const handler = devHandler();
  const response = handler(request({ headers: {} }));
  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(response.body), { state: "signed-out" });
});

test("SITE-INTEGRATION-001: a valid session with matching ownership resolves 200 ready as JSON with a customer-readable status", () => {
  const handler = devHandler();
  const response = handler(
    request({ headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN, "accept-language": "en" } }),
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body) as { state: string; project?: { status?: string } };
  assert.equal(body.state, "ready");
  assert.equal(body.project?.status, "In progress");
});

test("SITE-INTEGRATION-001: a valid session for a different tenant/project resolves 403 unauthorized as JSON", () => {
  const handler = devHandler();
  const response = handler(
    request({
      path: "/client-platform/some-other-tenant/some-other-customer/some-other-project",
      headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN },
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.body), { state: "unauthorized" });
});

test("SITE-INTEGRATION-001: an unsupported HTTP method on the hydration route resolves 501 unsupported as JSON, not the HTML shell", () => {
  const handler = devHandler();
  const response = handler(request({ method: "POST" }));
  assert.equal(response.status, 501);
  assert.equal(response.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(response.body), { state: "unsupported" });
});

test("SITE-INTEGRATION-001 A7 preserved: a dev-fixture session token is rejected (401) by a production-mode handler on the hydration route too", () => {
  const productionHandler = createRequestHandler({
    sessionProvider: createProductionSessionProvider(),
    snapshotSource: createWebShellFixtureSnapshotSource(),
  });
  const response = productionHandler(request({ headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN } }));
  assert.equal(response.status, 401);
});

test("the existing HTML /portal/... route is completely unaffected by the new hydration route", () => {
  const handler = devHandler();
  const portalPath = `/portal/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;
  const response = handler(
    request({ path: portalPath, headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN } }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
});
