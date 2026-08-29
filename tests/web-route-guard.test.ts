import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requireSession,
  requireTenantOwnership,
  UnauthenticatedError,
  TenantScopeMismatchError,
} from "../src/web/route-guard.js";
import { createDevFixtureSessionProvider } from "../src/web/dev-fixture-session-provider.js";
import { createAuthenticatedPrincipal, createSessionContext } from "../src/web/session-context.js";

function sessionWithProject(tenantId: string, customerId: string, projectId?: string) {
  return createSessionContext({
    principal: createAuthenticatedPrincipal({
      principalId: `principal-${tenantId}-${customerId}`,
      tenantId,
      customerId,
      displayName: "Test User",
    }),
    ...(projectId !== undefined ? { projectId } : {}),
    issuedAt: "2026-08-26T00:00:00Z",
  });
}

test("A4: requireSession rejects when the token is undefined", () => {
  const provider = createDevFixtureSessionProvider({ fixtures: new Map(), isProduction: false });
  assert.throws(() => requireSession(provider, undefined), UnauthenticatedError);
});

test("A4: requireSession rejects when the token does not resolve to any known session (invalid session)", () => {
  const provider = createDevFixtureSessionProvider({ fixtures: new Map(), isProduction: false });
  assert.throws(() => requireSession(provider, "not-a-real-token"), UnauthenticatedError);
});

test("A4: requireSession succeeds and returns the exact resolved SessionContext for a valid token", () => {
  const session = sessionWithProject("tenant-1", "cust-1", "proj-1");
  const provider = createDevFixtureSessionProvider({
    fixtures: new Map([["token-1", session]]),
    isProduction: false,
  });
  assert.equal(requireSession(provider, "token-1"), session);
});

test("A5: requireTenantOwnership accepts when the requested tenant/customer/project exactly matches the session's own scope", () => {
  const session = sessionWithProject("tenant-1", "cust-1", "proj-1");
  assert.doesNotThrow(() =>
    requireTenantOwnership(session, { tenantId: "tenant-1", customerId: "cust-1", projectId: "proj-1" }),
  );
});

test("A5: requireTenantOwnership rejects a different tenantId even with a matching customerId/projectId", () => {
  const session = sessionWithProject("tenant-1", "cust-1", "proj-1");
  assert.throws(
    () => requireTenantOwnership(session, { tenantId: "tenant-2", customerId: "cust-1", projectId: "proj-1" }),
    TenantScopeMismatchError,
  );
});

test("A5: requireTenantOwnership rejects a different customerId within the same tenant", () => {
  const session = sessionWithProject("tenant-1", "cust-1", "proj-1");
  assert.throws(
    () => requireTenantOwnership(session, { tenantId: "tenant-1", customerId: "cust-2", projectId: "proj-1" }),
    TenantScopeMismatchError,
  );
});

test("A5: requireTenantOwnership rejects a different projectId even within the same tenant/customer - a route cannot widen a project-scoped session to a sibling project", () => {
  const session = sessionWithProject("tenant-1", "cust-1", "proj-1");
  assert.throws(
    () => requireTenantOwnership(session, { tenantId: "tenant-1", customerId: "cust-1", projectId: "proj-2" }),
    TenantScopeMismatchError,
  );
});

test("A5: a customer-scoped session (no projectId) does not automatically authorize an exact-project-scoped route", () => {
  const session = sessionWithProject("tenant-1", "cust-1");
  assert.throws(
    () => requireTenantOwnership(session, { tenantId: "tenant-1", customerId: "cust-1", projectId: "proj-1" }),
    TenantScopeMismatchError,
  );
});
