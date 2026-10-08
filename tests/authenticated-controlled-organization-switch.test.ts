import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createAssignmentReference } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { type StaffAccessGrant } from "../src/web/internal-os-access.js";
import { StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import { NoStaffMembershipError } from "../src/web/staff-membership-guard.js";
import { resolveControlledOrganizationSwitchAsAuthenticatedStaff } from "../src/web/authenticated-controlled-organization-switch.js";

/**
 * Rev205 F2-R2: `resolveSwitch`'s own `currentPrincipalRef` parameter
 * (Rev204 F2-R1) is caller-supplied, not authenticated-session-derived - a
 * caller holding any valid ACTIVE B-bound membership object could simply
 * assert that membership's own `principalRef` and pass the exact-match
 * check without ever having authenticated as that principal.
 * `resolveControlledOrganizationSwitchAsAuthenticatedStaff`
 * (`src/web/authenticated-controlled-organization-switch.ts`) is the
 * missing authenticated ingress boundary: a forged identity must fail
 * inside `requireInternalOsAccess` itself, before `resolveSwitch` is ever
 * reached, and `currentPrincipalRef` is always
 * `session.principal.principalId` - never a value the caller supplies
 * directly.
 */

const TENANT = createTenantScope("tenant-authenticated-switch-rev205");

function newStoreDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `authenticated-switch-rev205-${label}-`));
}

function readAuthority() {
  return createAuthorityContext({ tenantScope: TENANT, permissions: ["READ"], canPerformProtectedActions: false });
}

function sessionFixture(principalId: string, sessionToken: string) {
  const principal = createAuthenticatedStaffPrincipal({ principalId, displayName: `Staff ${principalId}` });
  return createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-08T00:00:00.000Z" }]]),
    isProduction: false,
  });
}

test("Rev205 F2-R2: an authenticated B founder session succeeds the switch, with currentPrincipalRef derived strictly from the session", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("valid-b"));
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-rev205-b",
    displayName: "Org Rev205 B",
    founderMembershipId: "founder-rev205-b",
    founderPrincipalRef: "principal-rev205-b",
    idempotencyKey: "provision-rev205-b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const membershipB = resultB.mintedFounderMembership!;
  const assignmentB = createAssignmentReference({
    assignmentId: "assignment-rev205-b",
    membership: membershipB,
    customerId: resultB.snapshot.project.customerId,
    projectId: resultB.snapshot.project.projectId,
  });
  const sessionToken = "token-rev205-b";
  const provider = sessionFixture("principal-rev205-b", sessionToken);
  const grant: StaffAccessGrant = { membership: membershipB, authority: readAuthority(), assignments: [assignmentB] };

  const result = resolveControlledOrganizationSwitchAsAuthenticatedStaff({
    store,
    tenantScope: TENANT,
    organizationId: "org-rev205-b",
    provider,
    sessionToken,
    grants: [grant],
  });
  assert.equal(result.state, "READY");
  assert.equal(result.nextRequiredActor, "NONE");
});

test("Rev205 F2-R2 adversarial (stolen membership): a session authenticated as A, supplying B's real correctly-bound membership object in its own grants set, cannot override A's session identity - NoStaffMembershipError before the switch is ever reached", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("stolen"));
  store.provision({
    tenantScope: TENANT,
    organizationId: "org-rev205-stolen-a",
    displayName: "Org Rev205 Stolen-A",
    founderMembershipId: "founder-rev205-stolen-a",
    founderPrincipalRef: "principal-rev205-stolen-a",
    idempotencyKey: "provision-rev205-stolen-a",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-rev205-stolen-b",
    displayName: "Org Rev205 Stolen-B",
    founderMembershipId: "founder-rev205-stolen-b",
    founderPrincipalRef: "principal-rev205-stolen-b",
    idempotencyKey: "provision-rev205-stolen-b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const membershipB = resultB.mintedFounderMembership!;
  const assignmentB = createAssignmentReference({
    assignmentId: "assignment-rev205-stolen-b",
    membership: membershipB,
    customerId: resultB.snapshot.project.customerId,
    projectId: resultB.snapshot.project.projectId,
  });

  // Authenticated as A's own real session - never B's.
  const sessionToken = "token-rev205-stolen-a";
  const provider = sessionFixture("principal-rev205-stolen-a", sessionToken);
  // The caller's own grants set carries B's real, currently-ACTIVE,
  // correctly-bound membership object (e.g. leaked/stolen) - there is no
  // `currentPrincipalRef` field anywhere in this wrapper's own input shape
  // for the caller to additionally assert "I am B" with; identity comes
  // ONLY from the session the token above resolves to.
  const stolenGrant: StaffAccessGrant = { membership: membershipB, authority: readAuthority(), assignments: [assignmentB] };

  assert.throws(
    () =>
      resolveControlledOrganizationSwitchAsAuthenticatedStaff({
        store,
        tenantScope: TENANT,
        organizationId: "org-rev205-stolen-b",
        provider,
        sessionToken,
        grants: [stolenGrant],
      }),
    NoStaffMembershipError,
  );
});

test("Rev205 F2-R2 adversarial (unauthenticated): an undefined or forged sessionToken is denied inside requireInternalOsAccess itself, before the switch is ever reached", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("unauth"));
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-rev205-unauth-b",
    displayName: "Org Rev205 Unauth-B",
    founderMembershipId: "founder-rev205-unauth-b",
    founderPrincipalRef: "principal-rev205-unauth-b",
    idempotencyKey: "provision-rev205-unauth-b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const membershipB = resultB.mintedFounderMembership!;
  const assignmentB = createAssignmentReference({
    assignmentId: "assignment-rev205-unauth-b",
    membership: membershipB,
    customerId: resultB.snapshot.project.customerId,
    projectId: resultB.snapshot.project.projectId,
  });
  const provider = sessionFixture("principal-rev205-unauth-b", "token-rev205-unauth-b");
  const grant: StaffAccessGrant = { membership: membershipB, authority: readAuthority(), assignments: [assignmentB] };

  assert.throws(
    () =>
      resolveControlledOrganizationSwitchAsAuthenticatedStaff({
        store,
        tenantScope: TENANT,
        organizationId: "org-rev205-unauth-b",
        provider,
        sessionToken: "a-forged-unrelated-session-token",
        grants: [grant],
      }),
    StaffUnauthenticatedError,
  );
  assert.throws(
    () =>
      resolveControlledOrganizationSwitchAsAuthenticatedStaff({
        store,
        tenantScope: TENANT,
        organizationId: "org-rev205-unauth-b",
        provider,
        sessionToken: undefined,
        grants: [grant],
      }),
    StaffUnauthenticatedError,
  );
});

test("Rev205 F2-R2: the SAME authenticated principal holding separate memberships in A and B only gets B with B's own specific membership/assignment - A's membership against B still fails closed", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("same-principal"));
  const sharedPrincipal = "principal-rev205-shared";
  const resultA = store.provision({
    tenantScope: TENANT,
    organizationId: "org-rev205-shared-a",
    displayName: "Org Rev205 Shared-A",
    founderMembershipId: "founder-rev205-shared-a",
    founderPrincipalRef: sharedPrincipal,
    idempotencyKey: "provision-rev205-shared-a",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-rev205-shared-b",
    displayName: "Org Rev205 Shared-B",
    founderMembershipId: "founder-rev205-shared-b",
    founderPrincipalRef: sharedPrincipal,
    idempotencyKey: "provision-rev205-shared-b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const membershipA = resultA.mintedFounderMembership!;
  const membershipB = resultB.mintedFounderMembership!;
  const assignmentB = createAssignmentReference({
    assignmentId: "assignment-rev205-shared-b",
    membership: membershipB,
    customerId: resultB.snapshot.project.customerId,
    projectId: resultB.snapshot.project.projectId,
  });

  const sessionToken = "token-rev205-shared";
  const provider = sessionFixture(sharedPrincipal, sessionToken);

  const succeedsWithB = resolveControlledOrganizationSwitchAsAuthenticatedStaff({
    store,
    tenantScope: TENANT,
    organizationId: "org-rev205-shared-b",
    provider,
    sessionToken,
    grants: [{ membership: membershipB, authority: readAuthority(), assignments: [assignmentB] }],
  });
  assert.equal(succeedsWithB.state, "READY");

  // Same authenticated principal, but asserting A's own membership (never
  // bound to B, and with no current assignment evidence against B's own
  // project) against target organization B still fails closed - the
  // domain's own re-resolution inside resolveSwitch denies at the
  // assignment/binding layer even though requireInternalOsAccess's
  // organization-level (no-project) gate above it was satisfied.
  const deniedWithA = resolveControlledOrganizationSwitchAsAuthenticatedStaff({
    store,
    tenantScope: TENANT,
    organizationId: "org-rev205-shared-b",
    provider,
    sessionToken,
    grants: [{ membership: membershipA, authority: readAuthority(), assignments: [] }],
  });
  assert.equal(deniedWithA.state, "BLOCKED");
});
