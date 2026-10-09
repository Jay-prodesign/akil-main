import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createOrganizationMembership, revokeOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { resolveEffectiveOrganizationAccess } from "../src/domain/effective-organization-access.js";
import {
  createDelegatedAccessGrant,
  revokeDelegatedAccessGrant,
  isDelegatedAccessGrantActive,
  resolveEffectiveDelegatedAccess,
  InvalidDelegatedAccessGrantError,
  InvalidDelegatedAccessGrantTransitionError,
} from "../src/domain/delegated-access-grant.js";

/**
 * OS-V1-02 ("temporary/scoped delegated grants with expiry" + "fail-closed
 * ... stale delegated authority" + cross-org/cross-identity substitution):
 * `DelegatedAccessGrant` is a new primitive composing already-accepted
 * `OrganizationMembership`/`AuthorityContext`/`EffectiveAccessResolution`
 * rather than inventing a parallel RBAC/ABAC system. These witnesses prove
 * no-escalation-at-mint-time, mandatory expiry, cross-org/cross-identity
 * fail-closed substitution, and - the load-bearing property - that a
 * delegation can never outlive or exceed its delegator's OWN current
 * standing, re-resolved fresh at the moment of use.
 */

const tenantScope = createTenantScope("tenant-delegated-access");

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
  return createAuthorityContext({ tenantScope, permissions: ["READ", "WRITE", "EXECUTE"], canPerformProtectedActions: true });
}

function readOnlyAuthority() {
  return createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });
}

test("OS-V1-02 W1: a valid delegation grants the delegate the intersection of grant and delegator's current authority", () => {
  const organization = org("org-w1");
  const delegator = delegatorMembership("membership-w1", "principal-delegator-w1");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-w1",
    delegatePrincipalRef: "principal-delegate-w1",
    permissions: ["READ", "WRITE"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  });

  const delegatorCurrentAccess = resolveEffectiveOrganizationAccess({
    organization,
    membership: delegator,
    currentPrincipalRef: "principal-delegator-w1",
    authority: fullAuthority(),
  });
  assert.equal(delegatorCurrentAccess.decision, "GRANTED");

  const resolution = resolveEffectiveDelegatedAccess({
    organization,
    grant,
    currentPrincipalRef: "principal-delegate-w1",
    now: "2026-10-09T00:30:00.000Z",
    delegatorCurrentAccess,
  });
  assert.equal(resolution.decision, "GRANTED");
  assert.deepEqual([...resolution.permissions].sort(), ["READ", "WRITE"]);
  assert.equal(resolution.canPerformProtectedActions, false);
});

test("OS-V1-02 W2: construction rejects a permission the delegator's own current authority does not hold - no escalation", () => {
  const organization = org("org-w2");
  const delegator = delegatorMembership("membership-w2", "principal-delegator-w2");
  assert.throws(
    () =>
      createDelegatedAccessGrant({
        tenantScope,
        organization,
        delegatorMembership: delegator,
        delegatorAuthority: readOnlyAuthority(),
        delegationId: "delegation-w2",
        delegatePrincipalRef: "principal-delegate-w2",
        permissions: ["WRITE"],
        canPerformProtectedActions: false,
        issuedAt: "2026-10-09T00:00:00.000Z",
        expiresAt: "2026-10-09T01:00:00.000Z",
      }),
    InvalidDelegatedAccessGrantError,
  );
});

test("OS-V1-02 W3: construction rejects canPerformProtectedActions:true when the delegator's own authority does not hold it", () => {
  const organization = org("org-w3");
  const delegator = delegatorMembership("membership-w3", "principal-delegator-w3");
  assert.throws(
    () =>
      createDelegatedAccessGrant({
        tenantScope,
        organization,
        delegatorMembership: delegator,
        delegatorAuthority: readOnlyAuthority(),
        delegationId: "delegation-w3",
        delegatePrincipalRef: "principal-delegate-w3",
        permissions: ["READ"],
        canPerformProtectedActions: true,
        issuedAt: "2026-10-09T00:00:00.000Z",
        expiresAt: "2026-10-09T01:00:00.000Z",
      }),
    InvalidDelegatedAccessGrantError,
  );
});

test("OS-V1-02 W4: construction rejects a revoked/incoherent delegator membership", () => {
  const organization = org("org-w4");
  const delegator = delegatorMembership("membership-w4", "principal-delegator-w4");
  const revokedDelegator = revokeOrganizationMembership({ membership: delegator, revokedAt: "2026-10-09T00:00:00.000Z", revokedReason: "offboarded" });
  assert.throws(
    () =>
      createDelegatedAccessGrant({
        tenantScope,
        organization,
        delegatorMembership: revokedDelegator,
        delegatorAuthority: fullAuthority(),
        delegationId: "delegation-w4",
        delegatePrincipalRef: "principal-delegate-w4",
        permissions: ["READ"],
        canPerformProtectedActions: false,
        issuedAt: "2026-10-09T00:00:00.000Z",
        expiresAt: "2026-10-09T01:00:00.000Z",
      }),
    InvalidDelegatedAccessGrantError,
  );
});

test("OS-V1-02 W5: construction rejects expiresAt not strictly after issuedAt", () => {
  const organization = org("org-w5");
  const delegator = delegatorMembership("membership-w5", "principal-delegator-w5");
  assert.throws(
    () =>
      createDelegatedAccessGrant({
        tenantScope,
        organization,
        delegatorMembership: delegator,
        delegatorAuthority: fullAuthority(),
        delegationId: "delegation-w5",
        delegatePrincipalRef: "principal-delegate-w5",
        permissions: ["READ"],
        canPerformProtectedActions: false,
        issuedAt: "2026-10-09T00:00:00.000Z",
        expiresAt: "2026-10-09T00:00:00.000Z",
      }),
    InvalidDelegatedAccessGrantError,
  );
});

test("OS-V1-02 W6: resolution denies a grant whose expiresAt has passed", () => {
  const organization = org("org-w6");
  const delegator = delegatorMembership("membership-w6", "principal-delegator-w6");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-w6",
    delegatePrincipalRef: "principal-delegate-w6",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  });
  assert.equal(isDelegatedAccessGrantActive(grant, "2026-10-09T01:00:00.000Z"), false);
  const delegatorCurrentAccess = resolveEffectiveOrganizationAccess({
    organization,
    membership: delegator,
    currentPrincipalRef: "principal-delegator-w6",
    authority: fullAuthority(),
  });
  const resolution = resolveEffectiveDelegatedAccess({
    organization,
    grant,
    currentPrincipalRef: "principal-delegate-w6",
    now: "2026-10-09T01:00:00.000Z",
    delegatorCurrentAccess,
  });
  assert.equal(resolution.decision, "DENIED");
});

test("OS-V1-02 W7: resolution denies a revoked grant, and double-revoke is rejected", () => {
  const organization = org("org-w7");
  const delegator = delegatorMembership("membership-w7", "principal-delegator-w7");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-w7",
    delegatePrincipalRef: "principal-delegate-w7",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  });
  const revoked = revokeDelegatedAccessGrant({ grant, revokedAt: "2026-10-09T00:10:00.000Z", revokedReason: "delegation withdrawn" });
  const delegatorCurrentAccess = resolveEffectiveOrganizationAccess({
    organization,
    membership: delegator,
    currentPrincipalRef: "principal-delegator-w7",
    authority: fullAuthority(),
  });
  const resolution = resolveEffectiveDelegatedAccess({
    organization,
    grant: revoked,
    currentPrincipalRef: "principal-delegate-w7",
    now: "2026-10-09T00:30:00.000Z",
    delegatorCurrentAccess,
  });
  assert.equal(resolution.decision, "DENIED");
  assert.throws(
    () => revokeDelegatedAccessGrant({ grant: revoked, revokedAt: "2026-10-09T00:20:00.000Z", revokedReason: "double revoke" }),
    InvalidDelegatedAccessGrantTransitionError,
  );
});

test("OS-V1-02 W8 (cross-identity substitution): a caller asserting a DIFFERENT currentPrincipalRef than the grant's own delegatePrincipalRef is denied", () => {
  const organization = org("org-w8");
  const delegator = delegatorMembership("membership-w8", "principal-delegator-w8");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-w8",
    delegatePrincipalRef: "principal-delegate-w8",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  });
  const delegatorCurrentAccess = resolveEffectiveOrganizationAccess({
    organization,
    membership: delegator,
    currentPrincipalRef: "principal-delegator-w8",
    authority: fullAuthority(),
  });
  const resolution = resolveEffectiveDelegatedAccess({
    organization,
    grant,
    currentPrincipalRef: "principal-impostor-w8",
    now: "2026-10-09T00:30:00.000Z",
    delegatorCurrentAccess,
  });
  assert.equal(resolution.decision, "DENIED");
  assert.match(resolution.reasons[0]!, /different delegate/);
});

test("OS-V1-02 W9 (cross-org substitution): a grant minted for organization A is denied when resolved against organization B", () => {
  const organizationA = org("org-w9-a");
  const organizationB = org("org-w9-b");
  const delegator = delegatorMembership("membership-w9", "principal-delegator-w9");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization: organizationA,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-w9",
    delegatePrincipalRef: "principal-delegate-w9",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  });
  const delegatorCurrentAccess = resolveEffectiveOrganizationAccess({
    organization: organizationA,
    membership: delegator,
    currentPrincipalRef: "principal-delegator-w9",
    authority: fullAuthority(),
  });
  const resolution = resolveEffectiveDelegatedAccess({
    organization: organizationB,
    grant,
    currentPrincipalRef: "principal-delegate-w9",
    now: "2026-10-09T00:30:00.000Z",
    delegatorCurrentAccess,
  });
  assert.equal(resolution.decision, "DENIED");
  assert.match(resolution.reasons[0]!, /different organization/);
});

test("OS-V1-02 W10 (stale delegated authority): a delegation survives on paper but is denied once the delegator's own membership is revoked, even though the grant itself is still unexpired and unrevoked", () => {
  const organization = org("org-w10");
  const delegator = delegatorMembership("membership-w10", "principal-delegator-w10");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-w10",
    delegatePrincipalRef: "principal-delegate-w10",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T02:00:00.000Z",
  });

  // The delegator's own membership is revoked AFTER the grant was minted.
  const revokedDelegator = revokeOrganizationMembership({
    membership: delegator,
    revokedAt: "2026-10-09T00:30:00.000Z",
    revokedReason: "delegator offboarded",
  });
  const delegatorCurrentAccessAfterRevocation = resolveEffectiveOrganizationAccess({
    organization,
    membership: revokedDelegator,
    currentPrincipalRef: "principal-delegator-w10",
    authority: fullAuthority(),
  });
  assert.equal(delegatorCurrentAccessAfterRevocation.decision, "DENIED");

  const resolution = resolveEffectiveDelegatedAccess({
    organization,
    grant,
    currentPrincipalRef: "principal-delegate-w10",
    now: "2026-10-09T01:00:00.000Z",
    delegatorCurrentAccess: delegatorCurrentAccessAfterRevocation,
  });
  assert.equal(resolution.decision, "DENIED");
  assert.match(resolution.reasons[0]!, /delegator's own current effective access is not GRANTED/);
});

test("OS-V1-02 W11: a delegator re-authenticated under a DIFFERENT membershipId does not carry the old delegation forward", () => {
  const organization = org("org-w11");
  const delegator = delegatorMembership("membership-w11-original", "principal-delegator-w11");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-w11",
    delegatePrincipalRef: "principal-delegate-w11",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T02:00:00.000Z",
  });

  const sameprincipalNewMembership = delegatorMembership("membership-w11-new", "principal-delegator-w11");
  const delegatorCurrentAccessUnderNewMembership = resolveEffectiveOrganizationAccess({
    organization,
    membership: sameprincipalNewMembership,
    currentPrincipalRef: "principal-delegator-w11",
    authority: fullAuthority(),
  });
  assert.equal(delegatorCurrentAccessUnderNewMembership.decision, "GRANTED");

  const resolution = resolveEffectiveDelegatedAccess({
    organization,
    grant,
    currentPrincipalRef: "principal-delegate-w11",
    now: "2026-10-09T00:30:00.000Z",
    delegatorCurrentAccess: delegatorCurrentAccessUnderNewMembership,
  });
  assert.equal(resolution.decision, "DENIED");
  assert.match(resolution.reasons[0]!, /does not match the membership this delegation was issued under/);
});

test("OS-V1-02 W12: effective permissions are clamped to the intersection when the delegator's current authority has shrunk since the grant was minted", () => {
  const organization = org("org-w12");
  const delegator = delegatorMembership("membership-w12", "principal-delegator-w12");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-w12",
    delegatePrincipalRef: "principal-delegate-w12",
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: true,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T02:00:00.000Z",
  });

  // The delegator's own CURRENT authority (independently re-resolved at
  // use-time) has since narrowed to READ-only, non-protected.
  const delegatorCurrentAccess = resolveEffectiveOrganizationAccess({
    organization,
    membership: delegator,
    currentPrincipalRef: "principal-delegator-w12",
    authority: readOnlyAuthority(),
  });
  assert.equal(delegatorCurrentAccess.decision, "GRANTED");

  const resolution = resolveEffectiveDelegatedAccess({
    organization,
    grant,
    currentPrincipalRef: "principal-delegate-w12",
    now: "2026-10-09T00:30:00.000Z",
    delegatorCurrentAccess,
  });
  assert.equal(resolution.decision, "GRANTED");
  assert.deepEqual([...resolution.permissions], ["READ"]);
  assert.equal(resolution.canPerformProtectedActions, false);
});

test("OS-V1-02 W13: isDelegatedAccessGrantActive treats the exact expiry instant as already expired (half-open window)", () => {
  const organization = org("org-w13");
  const delegator = delegatorMembership("membership-w13", "principal-delegator-w13");
  const grant = createDelegatedAccessGrant({
    tenantScope,
    organization,
    delegatorMembership: delegator,
    delegatorAuthority: fullAuthority(),
    delegationId: "delegation-w13",
    delegatePrincipalRef: "principal-delegate-w13",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  });
  assert.equal(isDelegatedAccessGrantActive(grant, "2026-10-09T00:59:59.999Z"), true);
  assert.equal(isDelegatedAccessGrantActive(grant, "2026-10-09T01:00:00.000Z"), false);
});

test("OS-V1-02 W14: resolution requires grant presence - undefined grant is denied, never defaulted open", () => {
  const organization = org("org-w14");
  const delegator = delegatorMembership("membership-w14", "principal-delegator-w14");
  const delegatorCurrentAccess = resolveEffectiveOrganizationAccess({
    organization,
    membership: delegator,
    currentPrincipalRef: "principal-delegator-w14",
    authority: fullAuthority(),
  });
  const resolution = resolveEffectiveDelegatedAccess({
    organization,
    currentPrincipalRef: "principal-delegate-w14",
    now: "2026-10-09T00:30:00.000Z",
    delegatorCurrentAccess,
  });
  assert.equal(resolution.decision, "DENIED");
});
