import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAuthenticatedPrincipal,
  createSessionContext,
  InvalidSessionContextError,
} from "../src/web/session-context.js";

function minimalPrincipalInput() {
  return {
    principalId: "principal-1",
    tenantId: "tenant-1",
    customerId: "cust-1",
    displayName: "Test User",
  };
}

test("A6: a valid AuthenticatedPrincipal is deterministic and explicit", () => {
  const a = createAuthenticatedPrincipal(minimalPrincipalInput());
  const b = createAuthenticatedPrincipal(minimalPrincipalInput());
  assert.deepEqual(a, b);
});

test("A6: an empty/missing principalId, tenantId, customerId, or displayName rejects", () => {
  for (const field of ["principalId", "tenantId", "customerId", "displayName"] as const) {
    const input = { ...minimalPrincipalInput(), [field]: "" };
    assert.throws(() => createAuthenticatedPrincipal(input), InvalidSessionContextError);
  }
});

test("A6: SessionContext.tenant is always derived from the given principal's own tenantId/customerId - never independently supplied", () => {
  const principal = createAuthenticatedPrincipal(minimalPrincipalInput());
  const session = createSessionContext({ principal, projectId: "proj-1", issuedAt: "2026-08-26T00:00:00Z" });
  assert.equal(session.tenant.tenantId, principal.tenantId);
  assert.equal(session.tenant.customerId, principal.customerId);
  assert.equal(session.tenant.projectId, "proj-1");
});

test("A6: SessionContext.tenant.projectId is omitted (not undefined-valued) when no projectId is given - a customer-scoped, not project-scoped, session", () => {
  const principal = createAuthenticatedPrincipal(minimalPrincipalInput());
  const session = createSessionContext({ principal, issuedAt: "2026-08-26T00:00:00Z" });
  assert.equal("projectId" in session.tenant, false);
});

test("A6: an empty projectId or issuedAt rejects", () => {
  const principal = createAuthenticatedPrincipal(minimalPrincipalInput());
  assert.throws(
    () => createSessionContext({ principal, projectId: "", issuedAt: "2026-08-26T00:00:00Z" }),
    InvalidSessionContextError,
  );
  assert.throws(
    () => createSessionContext({ principal, issuedAt: "" }),
    InvalidSessionContextError,
  );
});
