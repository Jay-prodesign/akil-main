import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestHandler, type IncomingRequestLike } from "../src/web/request-handler.js";
import { createDevFixtureSessionProvider } from "../src/web/dev-fixture-session-provider.js";
import {
  WEB_SHELL_DEV_SESSION_TOKEN,
  WEB_SHELL_DEV_SESSION_FIXTURES,
  createWebShellFixtureSnapshotSource,
} from "../src/fixtures/web-shell.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";

const SESSION_TOKEN_HEADER = "x-akilta-session-token";
const PORTAL_PATH = `/portal/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;

function request(overrides: Partial<IncomingRequestLike>): IncomingRequestLike {
  return { method: "GET", path: PORTAL_PATH, headers: {}, ...overrides };
}

function devHandler() {
  return createRequestHandler({
    sessionProvider: createDevFixtureSessionProvider({ fixtures: WEB_SHELL_DEV_SESSION_FIXTURES, isProduction: false }),
    snapshotSource: createWebShellFixtureSnapshotSource(),
  });
}

test("I19 (Turkish default, end-to-end): a real request with no Accept-Language header renders the Turkish shell by default, matching the Türkiye-launch primary requirement", () => {
  const handler = devHandler();
  const response = handler(request({ headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN } }));
  assert.equal(response.status, 200);
  assert.match(response.body, /<html lang="tr">/);
  assert.match(response.body, /Genel durum/);
  assert.doesNotMatch(response.body, /Overall status/);
});

test("I20 (English selection, end-to-end): a real request with Accept-Language: en renders the English shell", () => {
  const handler = devHandler();
  const response = handler(
    request({ headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN, "accept-language": "en" } }),
  );
  assert.equal(response.status, 200);
  assert.match(response.body, /<html lang="en">/);
  assert.match(response.body, /Overall status/);
});

test("I21 (deterministic unsupported-locale fallback, end-to-end): a request naming only an unsupported locale still renders the Turkish default, never a blank/error page", () => {
  const handler = devHandler();
  const response = handler(
    request({ headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN, "accept-language": "fr-FR,fr;q=0.9" } }),
  );
  assert.equal(response.status, 200);
  assert.match(response.body, /<html lang="tr">/);
});

test("I22 (unchanged authorization semantics): locale never affects authentication - a missing session token still resolves 401 in either locale, with no snapshot data reachable", () => {
  const handler = devHandler();
  const trResponse = handler(request({ headers: {} }));
  const enResponse = handler(request({ headers: { "accept-language": "en" } }));
  assert.equal(trResponse.status, 401);
  assert.equal(enResponse.status, 401);
});

test("I23 (unchanged authorization semantics): locale never affects tenant scoping - a cross-tenant request still resolves 403 in either locale", () => {
  const handler = devHandler();
  const crossTenantPath = "/portal/some-other-tenant/some-other-customer/some-other-project";
  const trResponse = handler(
    request({ path: crossTenantPath, headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN } }),
  );
  const enResponse = handler(
    request({
      path: crossTenantPath,
      headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN, "accept-language": "en" },
    }),
  );
  assert.equal(trResponse.status, 403);
  assert.equal(enResponse.status, 403);
});
