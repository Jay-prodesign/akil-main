import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
import { createOrganizationServicePrincipal, type OrganizationServicePrincipal } from "../src/domain/organization-service-principal.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { resolveEffectiveOrganizationAccess, resolveEffectiveServicePrincipalAccess } from "../src/domain/effective-organization-access.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import { requireInternalOsAccess, type StaffAccessGrant } from "../src/web/internal-os-access.js";

/**
 * OS-V1-02 Rev208 ("V1-02 Completion Packet Maturation") named three
 * MINIMUM DIRECT WITNESSES this task's own prior evidence left implicit
 * rather than directly proven on this task's own surface:
 *
 * B. expired session + otherwise valid membership => denied (full
 *    requireInternalOsAccess chain, not just requireStaffSession alone -
 *    staff-session-lifecycle.test.ts's own W3 only exercises
 *    requireStaffSession directly).
 * I. a human session/membership cannot be substituted into a
 *    worker/service-principal-only path.
 * J. a worker/service-principal cannot be substituted into a human-only
 *    path.
 *
 * I/J are structural guarantees at the TypeScript type level (the two
 * identity families are disjoint input shapes - see
 * `effective-organization-access.ts`'s own doc comment), so an ordinary
 * caller cannot even compile a substitution attempt. These witnesses
 * deliberately bypass that compile-time guarantee with an explicit
 * `as unknown as` cast - simulating a boundary that received the wrong
 * identity family's object at runtime (e.g. a deserialization/storage
 * mixup) - and confirm the resolver's own RUNTIME field checks still fail
 * closed, never silently accepting the wrong family's shape.
 */

const tenantScope = createTenantScope("tenant-rev208-witnesses");

function org(id: string) {
  return activateOrganization({
    organization: createOrganization({ organizationId: id, tenantScope, displayName: `Org ${id}`, createdAt: "2026-10-09T00:00:00.000Z" }),
    activatedAt: "2026-10-09T00:00:01.000Z",
  });
}

test("Rev208 witness B: an expired session with an otherwise ACTIVE, correctly-bound membership is denied through the full requireInternalOsAccess chain", () => {
  const organization = org("org-rev208-b");
  const membership = createOrganizationMembership({ membershipId: "membership-rev208-b", tenantScope, principalRef: "principal-rev208-b", role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });
  const grants: ReadonlyArray<StaffAccessGrant> = [{ membership, authority, assignments: [] }];

  const principal = createAuthenticatedStaffPrincipal({ principalId: "principal-rev208-b", displayName: "Staff Rev208-B" });
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([
      [
        "token-rev208-b",
        { principal, issuedAt: "2026-10-09T00:00:00.000Z", expiresAt: "2026-10-09T01:00:00.000Z" },
      ],
    ]),
    isProduction: false,
  });

  // Before expiry: succeeds, proving the membership/authority evidence is
  // genuinely otherwise-valid (the denial below is caused by expiry alone).
  const before = requireInternalOsAccess({
    provider,
    sessionToken: "token-rev208-b",
    organization,
    grants,
    now: "2026-10-09T00:30:00.000Z",
  });
  assert.equal(before.access.decision, "GRANTED");

  // After expiry: denied, even though the exact same membership/authority
  // evidence is supplied again.
  assert.throws(
    () =>
      requireInternalOsAccess({
        provider,
        sessionToken: "token-rev208-b",
        organization,
        grants,
        now: "2026-10-09T01:00:00.001Z",
      }),
    StaffUnauthenticatedError,
  );
});

test("Rev208 witness I: a human OrganizationMembership substituted (via forged cast) into resolveEffectiveServicePrincipalAccess's own servicePrincipal slot is denied", () => {
  const organization = org("org-rev208-i");
  const humanMembership = createOrganizationMembership({
    membershipId: "membership-rev208-i",
    tenantScope,
    principalRef: "principal-rev208-i",
    role: "STAFF",
  });
  const authority = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });

  // A real worker-identity service principal, for contrast - this ONE
  // succeeds, proving the denial below is caused by the substitution, not
  // by some unrelated misconfiguration.
  const realWorker = createOrganizationServicePrincipal({ servicePrincipalId: "sp-rev208-i", tenantScope, workerRef: "worker-rev208-i" });
  const genuine = resolveEffectiveServicePrincipalAccess({ organization, servicePrincipal: realWorker, currentWorkerRef: "worker-rev208-i", authority });
  assert.equal(genuine.decision, "GRANTED");

  const forgedAsServicePrincipal = humanMembership as unknown as OrganizationServicePrincipal;
  const resolution = resolveEffectiveServicePrincipalAccess({
    organization,
    servicePrincipal: forgedAsServicePrincipal,
    currentWorkerRef: "worker-rev208-i",
    authority,
  });
  assert.equal(resolution.decision, "DENIED");
});

test("Rev208 witness J: a worker OrganizationServicePrincipal substituted (via forged cast) into resolveEffectiveOrganizationAccess's own membership slot is denied", () => {
  const organization = org("org-rev208-j");
  const authority = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });

  const realHuman = createOrganizationMembership({ membershipId: "membership-rev208-j", tenantScope, principalRef: "principal-rev208-j", role: "STAFF" });
  const genuine = resolveEffectiveOrganizationAccess({ organization, membership: realHuman, currentPrincipalRef: "principal-rev208-j", authority });
  assert.equal(genuine.decision, "GRANTED");

  const servicePrincipal = createOrganizationServicePrincipal({ servicePrincipalId: "sp-rev208-j", tenantScope, workerRef: "worker-rev208-j" });
  const forgedAsMembership = servicePrincipal as unknown as OrganizationMembership;
  const resolution = resolveEffectiveOrganizationAccess({
    organization,
    membership: forgedAsMembership,
    currentPrincipalRef: "principal-rev208-j",
    authority,
  });
  assert.equal(resolution.decision, "DENIED");
});
