import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAuthenticatedStaffPrincipal,
  isStaffSessionContextActive,
  revokeStaffSessionContext,
  InvalidStaffSessionContextTransitionError,
  type StaffSessionContext,
} from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { requireStaffSession, StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { requireInternalOsAccess, type StaffAccessGrant } from "../src/web/internal-os-access.js";

/**
 * OS-V1-02 ("session expiry/revoke/recovery" + "membership/session
 * revocation during queued work"): `StaffSessionContext` previously carried
 * only `principal`/`issuedAt` - no expiry, no revocation. `state`/
 * `revokedAt`/`revokedReason`/`expiresAt` are new, OPTIONAL fields (an
 * absent `state` reads as ACTIVE, an absent `expiresAt` reads as
 * never-expiring) so every pre-existing fixture across this repository is
 * completely unaffected. These witnesses prove the new expiry/revoke
 * semantics themselves, that "recovery" is always a fresh session (never a
 * resurrection), and that a session revoked mid-flight (between two
 * admission checks, simulating queued/async work) fails closed on the
 * later check even though it passed the earlier one.
 */

function principal(id: string) {
  return createAuthenticatedStaffPrincipal({ principalId: id, displayName: `Staff ${id}` });
}

test("OS-V1-02 W1: a legacy session with no state/expiresAt fields is unaffected - requireStaffSession succeeds with no now supplied", () => {
  const session: StaffSessionContext = { principal: principal("p-legacy"), issuedAt: "2026-10-09T00:00:00.000Z" };
  const provider = createDevFixtureStaffSessionProvider({ fixtures: new Map([["tok-legacy", session]]), isProduction: false });
  const resolved = requireStaffSession(provider, "tok-legacy");
  assert.equal(resolved.principal.principalId, "p-legacy");
});

test("OS-V1-02 W2: a session with a future expiresAt succeeds when now is supplied before expiry", () => {
  const session: StaffSessionContext = {
    principal: principal("p-future"),
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  };
  const provider = createDevFixtureStaffSessionProvider({ fixtures: new Map([["tok-future", session]]), isProduction: false });
  const resolved = requireStaffSession(provider, "tok-future", "2026-10-09T00:30:00.000Z");
  assert.equal(resolved.principal.principalId, "p-future");
});

test("OS-V1-02 W3: a session with a past expiresAt is denied (StaffUnauthenticatedError) when now is supplied after expiry", () => {
  const session: StaffSessionContext = {
    principal: principal("p-expired"),
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  };
  const provider = createDevFixtureStaffSessionProvider({ fixtures: new Map([["tok-expired", session]]), isProduction: false });
  assert.throws(() => requireStaffSession(provider, "tok-expired", "2026-10-09T01:00:00.001Z"), StaffUnauthenticatedError);
  // Exactly-at-expiry is already expired (half-open window).
  assert.throws(() => requireStaffSession(provider, "tok-expired", "2026-10-09T01:00:00.000Z"), StaffUnauthenticatedError);
});

test("OS-V1-02 W4: a session with an expiresAt but no now supplied fails closed, never silently open", () => {
  const session: StaffSessionContext = {
    principal: principal("p-no-clock"),
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  };
  const provider = createDevFixtureStaffSessionProvider({ fixtures: new Map([["tok-no-clock", session]]), isProduction: false });
  assert.equal(isStaffSessionContextActive(session), false);
  assert.throws(() => requireStaffSession(provider, "tok-no-clock"), StaffUnauthenticatedError);
});

test("OS-V1-02 W5: a REVOKED session is always denied, regardless of now, and double-revoke is rejected", () => {
  const active: StaffSessionContext = { principal: principal("p-revoked"), issuedAt: "2026-10-09T00:00:00.000Z" };
  const revoked = revokeStaffSessionContext({ session: active, revokedAt: "2026-10-09T00:05:00.000Z", revokedReason: "staff offboarded" });
  assert.equal(revoked.state, "REVOKED");
  assert.equal(isStaffSessionContextActive(revoked), false);
  assert.equal(isStaffSessionContextActive(revoked, "2026-10-09T00:00:00.000Z"), false);

  const provider = createDevFixtureStaffSessionProvider({ fixtures: new Map([["tok-revoked", revoked]]), isProduction: false });
  assert.throws(() => requireStaffSession(provider, "tok-revoked"), StaffUnauthenticatedError);

  assert.throws(
    () => revokeStaffSessionContext({ session: revoked, revokedAt: "2026-10-09T00:10:00.000Z", revokedReason: "double revoke" }),
    InvalidStaffSessionContextTransitionError,
  );
});

test("OS-V1-02 W6 (recovery): a revoked session's own token never resurrects, but the same principal authenticating fresh under a NEW token succeeds", () => {
  const active: StaffSessionContext = { principal: principal("p-recover"), issuedAt: "2026-10-09T00:00:00.000Z" };
  const revoked = revokeStaffSessionContext({ session: active, revokedAt: "2026-10-09T00:05:00.000Z", revokedReason: "token compromised" });
  const freshSession: StaffSessionContext = { principal: principal("p-recover"), issuedAt: "2026-10-09T00:06:00.000Z" };
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([
      ["tok-old-compromised", revoked],
      ["tok-new-recovered", freshSession],
    ]),
    isProduction: false,
  });
  assert.throws(() => requireStaffSession(provider, "tok-old-compromised"), StaffUnauthenticatedError);
  const resolved = requireStaffSession(provider, "tok-new-recovered");
  assert.equal(resolved.principal.principalId, "p-recover");
});

test("OS-V1-02 W7 (revocation during queued work): a session ACTIVE at an earlier admission check is denied on a LATER admission check for the exact same token once revoked - simulating a session held across queued/async work", () => {
  const tenantScope = createTenantScope("tenant-session-lifecycle-w7");
  const organization = activateOrganization({
    organization: createOrganization({ organizationId: "org-w7", tenantScope, displayName: "Org W7", createdAt: "2026-10-09T00:00:00.000Z" }),
    activatedAt: "2026-10-09T00:00:01.000Z",
  });
  const membership = createOrganizationMembership({ membershipId: "membership-w7", tenantScope, principalRef: "p-w7", role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });
  const grants: ReadonlyArray<StaffAccessGrant> = [{ membership, authority, assignments: [] }];

  const activeSession: StaffSessionContext = { principal: principal("p-w7"), issuedAt: "2026-10-09T00:00:00.000Z" };
  const providerAtWaitTime = createDevFixtureStaffSessionProvider({ fixtures: new Map([["tok-w7", activeSession]]), isProduction: false });
  const firstCheck = requireInternalOsAccess({ provider: providerAtWaitTime, sessionToken: "tok-w7", organization, grants });
  assert.equal(firstCheck.access.decision, "GRANTED");

  const revokedSession = revokeStaffSessionContext({
    session: activeSession,
    revokedAt: "2026-10-09T00:30:00.000Z",
    revokedReason: "revoked while underlying job was queued",
  });
  const providerAtResumeTime = createDevFixtureStaffSessionProvider({ fixtures: new Map([["tok-w7", revokedSession]]), isProduction: false });
  assert.throws(
    () => requireInternalOsAccess({ provider: providerAtResumeTime, sessionToken: "tok-w7", organization, grants }),
    StaffUnauthenticatedError,
  );
});

test("OS-V1-02 W8: revokeStaffSessionContext rejects malformed revokedAt/revokedReason", () => {
  const active: StaffSessionContext = { principal: principal("p-malformed"), issuedAt: "2026-10-09T00:00:00.000Z" };
  assert.throws(
    () => revokeStaffSessionContext({ session: active, revokedAt: "not-a-timestamp", revokedReason: "reason" }),
    InvalidStaffSessionContextTransitionError,
  );
  assert.throws(
    () => revokeStaffSessionContext({ session: active, revokedAt: "2026-10-09T00:00:00.000Z", revokedReason: "   " }),
    InvalidStaffSessionContextTransitionError,
  );
});
