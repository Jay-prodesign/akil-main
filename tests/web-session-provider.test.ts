import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDevFixtureSessionProvider,
  DevFixtureSessionProviderInProductionError,
} from "../src/web/dev-fixture-session-provider.js";
import { createProductionSessionProvider } from "../src/web/production-session-provider.js";
import { createAuthenticatedPrincipal, createSessionContext } from "../src/web/session-context.js";

function testSession() {
  return createSessionContext({
    principal: createAuthenticatedPrincipal({
      principalId: "principal-1",
      tenantId: "tenant-1",
      customerId: "cust-1",
      displayName: "Test User",
    }),
    issuedAt: "2026-08-26T00:00:00Z",
  });
}

test("A7: DevFixtureSessionProvider cannot be constructed when isProduction is true - a mechanical, construction-time guard", () => {
  assert.throws(
    () =>
      createDevFixtureSessionProvider({
        fixtures: new Map([["token-1", testSession()]]),
        isProduction: true,
      }),
    DevFixtureSessionProviderInProductionError,
  );
});

test("DevFixtureSessionProvider resolves a known token deterministically and rejects unknown tokens/undefined", () => {
  const session = testSession();
  const provider = createDevFixtureSessionProvider({
    fixtures: new Map([["token-1", session]]),
    isProduction: false,
  });
  assert.equal(provider.resolveSession("token-1"), session);
  assert.equal(provider.resolveSession("unknown-token"), undefined);
  assert.equal(provider.resolveSession(undefined), undefined);
});

test("A8: ProductionSessionProvider always reports unauthenticated, regardless of the token supplied", () => {
  const provider = createProductionSessionProvider();
  assert.equal(provider.resolveSession(undefined), undefined);
  assert.equal(provider.resolveSession("token-1"), undefined);
  assert.equal(provider.resolveSession("any-arbitrary-value"), undefined);
});

test("A7: the exact dev-fixture token that authenticates in dev mode is meaningless to the production provider - it does not somehow leak fixture identities", () => {
  const session = testSession();
  const devProvider = createDevFixtureSessionProvider({
    fixtures: new Map([["shared-token", session]]),
    isProduction: false,
  });
  const prodProvider = createProductionSessionProvider();
  assert.equal(devProvider.resolveSession("shared-token"), session);
  assert.equal(prodProvider.resolveSession("shared-token"), undefined);
});
