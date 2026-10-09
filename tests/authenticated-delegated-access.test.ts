import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createOrganizationMembership, revokeOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createDelegatedAccessGrant } from "../src/domain/delegated-access-grant.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import { resolveEffectiveDelegatedAccessAsAuthenticatedStaff } from "../src/web/authenticated-delegated-access.js";

/**
 * Brain targeted review (PR #125 comment id `6076214816`): the pure
 * `resolveEffectiveDelegatedAccess` treats `currentPrincipalRef` and
 * `delegatorCurrentAccess` as caller-supplied evidence, exactly like every
 * other domain resolver in this repository - it never authenticates
 * either. `resolveEffectiveDelegatedAccessAsAuthenticatedStaff`
 * (`src/web/authenticated-delegated-access.ts`) is the missing
 * authenticated ingress boundary: the delegate's identity must come from a
 * REAL resolved session, never a caller-asserted string, and the
 * delegator's standing must be freshly recomputed from raw evidence, never
 * accepted as a pre-built snapshot.
 */

const tenantScope = createTenantScope("tenant-authenticated-delegated-access");

function org(id: string): Organization {
  return activateOrganization({
    organization: createOrganization({ organizationId: id, tenantScope, displayName: `Org ${id}`, createdAt: "2026-10-09T00:00:00.000Z" }),
    activatedAt: "2026-10-09T00:00:01.000Z",
  });
}

function delegatorMembership(id: string, principalRef: string): OrganizationMembership {
  return createOrganizationMembership({ membershipId: id, tenantScope, principalRef, role: "STAFF" });
}

function fullAuthority() {
  return createAuthorityContext({ tenantScope, permissions: ["READ", "WRITE"], canPerformProtectedActions: false });
}

function sessionFixture(principalId: string, sessionToken: string) {
  const principal = createAuthenticatedStaffPrincipal({ principalId, displayName: `Staff ${principalId}` });
  return createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-09T00:00:00.000Z" }]]),
    isProduction: false,
  });
}

test("authenticated delegated access: a validly authenticated delegate session succeeds, with currentPrincipalRef derived strictly from the session", () => {
  const organization = org("org-ada-1");
  const delegator = delegatorMembership("membership-ada-1", "principal-delegator-ada-1");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-ada-1",
    delegatePrincipalRef: "principal-delegate-ada-1",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  });
  const provider = sessionFixture("principal-delegate-ada-1", "token-ada-1");

  const resolution = resolveEffectiveDelegatedAccessAsAuthenticatedStaff({
    organization,
    grant,
    now: "2026-10-09T00:30:00.000Z",
    provider,
    sessionToken: "token-ada-1",
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
  });
  assert.equal(resolution.decision, "GRANTED");
  assert.deepEqual([...resolution.permissions], ["READ"]);
});

test("authenticated delegated access adversarial (forged/absent session): a forged or undefined sessionToken is denied before the delegation is ever resolved", () => {
  const organization = org("org-ada-2");
  const delegator = delegatorMembership("membership-ada-2", "principal-delegator-ada-2");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-ada-2",
    delegatePrincipalRef: "principal-delegate-ada-2",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  });
  const provider = sessionFixture("principal-delegate-ada-2", "token-ada-2");

  assert.throws(
    () =>
      resolveEffectiveDelegatedAccessAsAuthenticatedStaff({
        organization,
        grant,
        now: "2026-10-09T00:30:00.000Z",
        provider,
        sessionToken: "a-forged-unrelated-session-token",
        delegatorMembership: delegator,
        delegatorAuthority: fullAuthority(),
      }),
    StaffUnauthenticatedError,
  );
  assert.throws(
    () =>
      resolveEffectiveDelegatedAccessAsAuthenticatedStaff({
        organization,
        grant,
        now: "2026-10-09T00:30:00.000Z",
        provider,
        sessionToken: undefined,
        delegatorMembership: delegator,
        delegatorAuthority: fullAuthority(),
      }),
    StaffUnauthenticatedError,
  );
});

test("authenticated delegated access adversarial (stolen delegation): a session authenticated as a DIFFERENT principal than the grant's own delegatePrincipalRef cannot claim the delegation by merely holding the grant object", () => {
  const organization = org("org-ada-3");
  const delegator = delegatorMembership("membership-ada-3", "principal-delegator-ada-3");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-ada-3",
    delegatePrincipalRef: "principal-delegate-ada-3",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  });
  // Authenticated as an impostor - never the real delegate. There is no
  // `currentPrincipalRef` field anywhere in this wrapper's own input shape
  // for the caller to additionally assert "I am the delegate" with;
  // identity comes only from the session the token resolves to.
  const provider = sessionFixture("principal-impostor-ada-3", "token-ada-3-impostor");

  const resolution = resolveEffectiveDelegatedAccessAsAuthenticatedStaff({
    organization,
    grant,
    now: "2026-10-09T00:30:00.000Z",
    provider,
    sessionToken: "token-ada-3-impostor",
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
  });
  assert.equal(resolution.decision, "DENIED");
  assert.match(resolution.reasons[0]!, /different delegate/);
});

test("authenticated delegated access adversarial (revoked delegator after mint): a delegator membership revoked since the grant was minted is denied even though the grant itself is still unexpired/unrevoked", () => {
  const organization = org("org-ada-4");
  const delegator = delegatorMembership("membership-ada-4", "principal-delegator-ada-4");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-ada-4",
    delegatePrincipalRef: "principal-delegate-ada-4",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T02:00:00.000Z",
  });
  const revokedDelegator = revokeOrganizationMembership({
    membership: delegator,
    revokedAt: "2026-10-09T00:30:00.000Z",
    revokedReason: "delegator offboarded after mint",
  });
  const provider = sessionFixture("principal-delegate-ada-4", "token-ada-4");

  const resolution = resolveEffectiveDelegatedAccessAsAuthenticatedStaff({
    organization,
    grant,
    now: "2026-10-09T01:00:00.000Z",
    provider,
    sessionToken: "token-ada-4",
    delegatorMembership: revokedDelegator,
    delegatorAuthority: fullAuthority(),
  });
  assert.equal(resolution.decision, "DENIED");
  assert.match(resolution.reasons[0]!, /delegator's own current effective access is not GRANTED/);
});

test("authenticated delegated access adversarial (same-principal cross-org substitution): a grant minted for organization A is denied when the same authenticated delegate resolves it against organization B", () => {
  const organizationA = org("org-ada-5-a");
  const organizationB = org("org-ada-5-b");
  const delegator = delegatorMembership("membership-ada-5", "principal-delegator-ada-5");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization: organizationA,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-ada-5",
    delegatePrincipalRef: "principal-delegate-ada-5",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T02:00:00.000Z",
  });
  const provider = sessionFixture("principal-delegate-ada-5", "token-ada-5");

  const resolution = resolveEffectiveDelegatedAccessAsAuthenticatedStaff({
    organization: organizationB,
    grant,
    now: "2026-10-09T00:30:00.000Z",
    provider,
    sessionToken: "token-ada-5",
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
  });
  assert.equal(resolution.decision, "DENIED");
  assert.match(resolution.reasons[0]!, /different organization/);
});
