import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAuthenticatedStaffPrincipal,
  InvalidStaffSessionContextError,
  type StaffSessionContext,
} from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider, DevFixtureStaffSessionProviderInProductionError } from "../src/web/dev-fixture-staff-session-provider.js";
import { createProductionStaffSessionProvider } from "../src/web/production-staff-session-provider.js";
import { requireStaffSession, StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import {
  resolveMatchingStaffMembership,
  requireMatchingStaffMembership,
  NoStaffMembershipError,
  AmbiguousStaffMembershipError,
} from "../src/web/staff-membership-guard.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";

const tenantScope = createTenantScope("tenant-a");
const otherTenantScope = createTenantScope("tenant-b");

function staffSession(principalId = "staff-1"): StaffSessionContext {
  return {
    principal: createAuthenticatedStaffPrincipal({ principalId, displayName: "Ada Staffer" }),
    issuedAt: "2026-01-01T00:00:00.000Z",
  };
}

function membership(overrides: Partial<Parameters<typeof createOrganizationMembership>[0]> = {}): OrganizationMembership {
  return createOrganizationMembership({
    membershipId: "membership-1",
    tenantScope,
    principalRef: "staff-1",
    role: "STAFF",
    ...overrides,
  });
}

// --- staff-session-context.ts ---

test("F2-1: createAuthenticatedStaffPrincipal rejects an empty principalId", () => {
  assert.throws(
    () => createAuthenticatedStaffPrincipal({ principalId: "", displayName: "x" }),
    InvalidStaffSessionContextError,
  );
});

test("F2-2: createAuthenticatedStaffPrincipal rejects an empty displayName", () => {
  assert.throws(
    () => createAuthenticatedStaffPrincipal({ principalId: "staff-1", displayName: "" }),
    InvalidStaffSessionContextError,
  );
});

test("F2-3: createAuthenticatedStaffPrincipal rejects leading/trailing whitespace", () => {
  assert.throws(
    () => createAuthenticatedStaffPrincipal({ principalId: " staff-1", displayName: "x" }),
    InvalidStaffSessionContextError,
  );
});

// --- dev-fixture-staff-session-provider.ts ---

test("F2-4: createDevFixtureStaffSessionProvider throws immediately when isProduction is true - a mechanical guard, not a per-request check", () => {
  assert.throws(
    () => createDevFixtureStaffSessionProvider({ fixtures: new Map(), isProduction: true }),
    DevFixtureStaffSessionProviderInProductionError,
  );
});

test("F2-5: dev fixture provider resolves a known token to its fixture session", () => {
  const session = staffSession();
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([["token-1", session]]),
    isProduction: false,
  });
  assert.equal(provider.resolveStaffSession("token-1"), session);
});

test("F2-6: dev fixture provider returns undefined for an unknown token or undefined token", () => {
  const provider = createDevFixtureStaffSessionProvider({ fixtures: new Map(), isProduction: false });
  assert.equal(provider.resolveStaffSession("unknown"), undefined);
  assert.equal(provider.resolveStaffSession(undefined), undefined);
});

// --- production-staff-session-provider.ts ---

test("F2-7 (adversarial): production provider never resolves a session for ANY token, including a real fixture token reused by coincidence", () => {
  const provider = createProductionStaffSessionProvider();
  assert.equal(provider.resolveStaffSession("token-1"), undefined);
  assert.equal(provider.resolveStaffSession(undefined), undefined);
  assert.equal(provider.resolveStaffSession(""), undefined);
});

// --- staff-route-guard.ts ---

test("F2-8: requireStaffSession returns the session for a valid token", () => {
  const session = staffSession();
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([["token-1", session]]),
    isProduction: false,
  });
  assert.equal(requireStaffSession(provider, "token-1"), session);
});

test("F2-9 (adversarial): requireStaffSession throws StaffUnauthenticatedError for an undefined token", () => {
  const provider = createDevFixtureStaffSessionProvider({ fixtures: new Map(), isProduction: false });
  assert.throws(() => requireStaffSession(provider, undefined), StaffUnauthenticatedError);
});

test("F2-10 (adversarial): requireStaffSession throws StaffUnauthenticatedError against the production provider regardless of token", () => {
  const provider = createProductionStaffSessionProvider();
  assert.throws(() => requireStaffSession(provider, "any-token"), StaffUnauthenticatedError);
});

// --- staff-membership-guard.ts ---

test("F2-11: resolveMatchingStaffMembership finds the matching membership for the session's principal in the given tenant", () => {
  const found = resolveMatchingStaffMembership({
    session: staffSession("staff-1"),
    tenantId: tenantScope.tenantId,
    memberships: [membership()],
  });
  assert.equal(found?.principalRef, "staff-1");
});

test("F2-12: resolveMatchingStaffMembership returns undefined (never throws) when no membership matches - an unbound session is expected, not an error", () => {
  const found = resolveMatchingStaffMembership({
    session: staffSession("staff-unknown"),
    tenantId: tenantScope.tenantId,
    memberships: [membership()],
  });
  assert.equal(found, undefined);
});

test("F2-13 (adversarial cross-tenant): resolveMatchingStaffMembership never matches a membership from a different tenant, even with the same principalRef", () => {
  const found = resolveMatchingStaffMembership({
    session: staffSession("staff-1"),
    tenantId: otherTenantScope.tenantId,
    memberships: [membership()],
  });
  assert.equal(found, undefined);
});

test("F2-14 (adversarial ambiguity): resolveMatchingStaffMembership throws, never guesses, when more than one membership matches the same principal/tenant", () => {
  assert.throws(
    () =>
      resolveMatchingStaffMembership({
        session: staffSession("staff-1"),
        tenantId: tenantScope.tenantId,
        memberships: [
          membership({ membershipId: "membership-1" }),
          membership({ membershipId: "membership-2" }),
        ],
      }),
    AmbiguousStaffMembershipError,
  );
});

test("F2-15: requireMatchingStaffMembership returns the membership when exactly one match exists", () => {
  const found = requireMatchingStaffMembership({
    session: staffSession("staff-1"),
    tenantId: tenantScope.tenantId,
    memberships: [membership()],
  });
  assert.equal(found.principalRef, "staff-1");
});

test("F2-16 (adversarial): requireMatchingStaffMembership throws NoStaffMembershipError rather than returning undefined when no membership matches - an authenticated session alone is never sufficient authority", () => {
  assert.throws(
    () =>
      requireMatchingStaffMembership({
        session: staffSession("staff-unknown"),
        tenantId: tenantScope.tenantId,
        memberships: [membership()],
      }),
    NoStaffMembershipError,
  );
});
