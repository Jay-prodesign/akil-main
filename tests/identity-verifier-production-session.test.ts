import { test } from "node:test";
import assert from "node:assert/strict";
import { createProductionSessionProvider } from "../src/web/production-session-provider.js";
import type { IdentityVerifier, VerifiedIdentityAssertion } from "../src/web/identity-verifier.js";

function verifierReturning(assertion: VerifiedIdentityAssertion | undefined): IdentityVerifier {
  return { verify: () => assertion };
}

function verifierThrowing(): IdentityVerifier {
  return {
    verify: () => {
      throw new Error("verifier backend unreachable");
    },
  };
}

const VALID_ASSERTION: VerifiedIdentityAssertion = {
  principalId: "principal-site-integration-001",
  tenantId: "tenant-a",
  customerId: "customer-a",
  displayName: "Site Integration Customer",
  projectId: "project-a",
  issuedAt: "2026-09-18T00:00:00Z",
};

test("SITE-INTEGRATION-001 A8 preserved: no deps and no verifier both still always report unauthenticated, regardless of the token supplied", () => {
  const noDeps = createProductionSessionProvider();
  assert.equal(noDeps.resolveSession(undefined), undefined);
  assert.equal(noDeps.resolveSession("any-token"), undefined);

  const noVerifier = createProductionSessionProvider({});
  assert.equal(noVerifier.resolveSession("any-token"), undefined);
});

test("SITE-INTEGRATION-001 adversarial proof 1: missing/invalid external identity never resolves a session", () => {
  const missingToken = createProductionSessionProvider({ verifier: verifierReturning(VALID_ASSERTION) });
  assert.equal(missingToken.resolveSession(undefined), undefined);

  const unresolvedByVerifier = createProductionSessionProvider({ verifier: verifierReturning(undefined) });
  assert.equal(unresolvedByVerifier.resolveSession("token-1"), undefined);

  const throwingVerifier = createProductionSessionProvider({ verifier: verifierThrowing() });
  assert.equal(throwingVerifier.resolveSession("token-1"), undefined);
});

test("a valid external identity assertion resolves a real session carrying exactly the verifier's own tenant/customer/project/displayName", () => {
  const provider = createProductionSessionProvider({ verifier: verifierReturning(VALID_ASSERTION) });
  const session = provider.resolveSession("token-1");
  assert.notEqual(session, undefined);
  assert.equal(session?.principal.tenantId, "tenant-a");
  assert.equal(session?.principal.customerId, "customer-a");
  assert.equal(session?.principal.displayName, "Site Integration Customer");
  assert.equal(session?.tenant.projectId, "project-a");
});

test("SITE-INTEGRATION-001 adversarial proof: a malformed verifier assertion (empty/whitespace field) fails closed rather than resolving a partially-invalid session", () => {
  const malformed: VerifiedIdentityAssertion = { ...VALID_ASSERTION, tenantId: "" };
  const provider = createProductionSessionProvider({ verifier: verifierReturning(malformed) });
  assert.equal(provider.resolveSession("token-1"), undefined);
});

test("SITE-INTEGRATION-001: two different verified assertions resolve to their own independent tenant/customer scope - one cannot substitute another", () => {
  const otherAssertion: VerifiedIdentityAssertion = {
    principalId: "principal-2",
    tenantId: "tenant-b",
    customerId: "customer-b",
    displayName: "Other Customer",
    issuedAt: "2026-09-18T00:00:00Z",
  };
  const provider = createProductionSessionProvider({
    verifier: {
      verify: (token) => (token === "token-a" ? VALID_ASSERTION : token === "token-b" ? otherAssertion : undefined),
    },
  });
  const sessionA = provider.resolveSession("token-a");
  const sessionB = provider.resolveSession("token-b");
  assert.equal(sessionA?.principal.tenantId, "tenant-a");
  assert.equal(sessionB?.principal.tenantId, "tenant-b");
  assert.notEqual(sessionA?.principal.tenantId, sessionB?.principal.tenantId);
  assert.equal(provider.resolveSession("unknown-token"), undefined);
});
