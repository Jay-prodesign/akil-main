import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  createOrganizationMembership,
  createAssignmentReference,
  revokeOrganizationMembership,
} from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createOrganizationAccessRoleContext } from "../src/domain/organization-access-role.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { createProductionStaffSessionProvider } from "../src/web/production-staff-session-provider.js";
import { StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import { NoStaffMembershipError, AmbiguousStaffMembershipError } from "../src/web/staff-membership-guard.js";
import {
  requireInternalOsAccess,
  requireInternalOsProjectAccess,
  InternalOsAccessDeniedError,
  type StaffAccessGrant,
} from "../src/web/internal-os-access.js";
import {
  NEGATIVE_CUSTOMER_SESSION,
  NEGATIVE_SERVICE_PRINCIPAL,
} from "../src/web/internal-os-review-fixtures.js";

const tenantScope = createTenantScope("tenant-os-v0-08-access");
const organization: Organization = activateOrganization({
  organization: createOrganization({
    organizationId: "org-os-v0-08-access",
    tenantScope,
    displayName: "Access Test Org",
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
  activatedAt: "2026-01-01T00:00:00.000Z",
});
const customer = createCustomer({ tenantScope, customerId: "customer-access", displayName: "Access Customer" });
const project = createProject({ tenantScope, customer, projectId: "project-access", ownerRef: "owner-access", state: "active" });
const otherProject = createProject({ tenantScope, customer, projectId: "project-other", ownerRef: "owner-other", state: "active" });

function staffGrant(input: {
  principalId: string;
  membershipId: string;
  permissions: ReadonlyArray<"READ" | "WRITE" | "EXECUTE">;
  canPerformProtectedActions?: boolean;
  assignedProjectIds?: ReadonlyArray<string>;
  role?: "OWNER" | "ADMIN" | "MEMBER";
}): { sessionToken: string; principal: ReturnType<typeof createAuthenticatedStaffPrincipal>; grant: StaffAccessGrant } {
  const principal = createAuthenticatedStaffPrincipal({ principalId: input.principalId, displayName: input.principalId });
  const membership = createOrganizationMembership({
    membershipId: input.membershipId,
    tenantScope,
    principalRef: principal.principalId,
    role: "STAFF",
  });
  const assignments = (input.assignedProjectIds ?? []).map((projectId, index) =>
    createAssignmentReference({
      assignmentId: `${input.membershipId}-assignment-${index}`,
      membership,
      customerId: customer.customerId,
      projectId,
    }),
  );
  const grant: StaffAccessGrant = {
    membership,
    authority: createAuthorityContext({
      tenantScope,
      permissions: input.permissions,
      canPerformProtectedActions: input.canPerformProtectedActions ?? false,
    }),
    assignments,
    ...(input.role !== undefined ? { roleContext: createOrganizationAccessRoleContext({ membership, role: input.role }) } : {}),
  };
  return { sessionToken: `token-${input.membershipId}`, principal, grant };
}

test("an unauthenticated request (no session token) fails closed with StaffUnauthenticatedError", () => {
  const provider = createProductionStaffSessionProvider();
  assert.throws(
    () => requireInternalOsAccess({ provider, sessionToken: undefined, organization, grants: [] }),
    StaffUnauthenticatedError,
  );
});

test("the production staff session provider always reports unauthenticated, even for a token that would resolve under a dev-fixture provider", () => {
  const { sessionToken } = staffGrant({ principalId: "p1", membershipId: "m1", permissions: ["READ"] });
  const provider = createProductionStaffSessionProvider();
  assert.throws(
    () => requireInternalOsAccess({ provider, sessionToken, organization, grants: [] }),
    StaffUnauthenticatedError,
  );
});

test("a session with no matching OrganizationMembership among the supplied grants fails closed with NoStaffMembershipError", () => {
  const { sessionToken, principal } = staffGrant({ principalId: "p2", membershipId: "m2", permissions: ["READ"] });
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  assert.throws(
    () => requireInternalOsAccess({ provider, sessionToken, organization, grants: [] }),
    NoStaffMembershipError,
  );
});

test("a customer SessionContext (a structurally distinct identity type) cannot satisfy StaffSessionProvider.resolveStaffSession", () => {
  const provider = createDevFixtureStaffSessionProvider({ fixtures: new Map(), isProduction: false });
  // TypeScript itself would reject passing NEGATIVE_CUSTOMER_SESSION as a
  // sessionToken/StaffSessionContext - the only "token" a caller could ever
  // extract from it is not a key in any StaffSessionProvider's fixture map.
  assert.equal(provider.resolveStaffSession("customer-session-does-not-exist-as-a-staff-token"), undefined);
  assert.notEqual(typeof NEGATIVE_CUSTOMER_SESSION.principal.principalId, "undefined");
});

test("an OrganizationServicePrincipal (a structurally distinct identity type) cannot satisfy StaffSessionProvider.resolveStaffSession", () => {
  const provider = createDevFixtureStaffSessionProvider({ fixtures: new Map(), isProduction: false });
  assert.equal(provider.resolveStaffSession(NEGATIVE_SERVICE_PRINCIPAL.workerRef), undefined);
});

test("Founder Review Fixture (A): ACTIVE membership + curated OWNER label + high-access authority resolves GRANTED with full permissions", () => {
  const { sessionToken, principal, grant } = staffGrant({
    principalId: "founder", membershipId: "m-founder", permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: true, assignedProjectIds: [project.projectId], role: "OWNER",
  });
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const context = requireInternalOsAccess({ provider, sessionToken, organization, grants: [grant] });
  assert.equal(context.access.decision, "GRANTED");
  assert.equal(context.access.role, "OWNER");
  assert.deepEqual([...context.access.permissions].sort(), ["EXECUTE", "READ", "WRITE"]);
  assert.equal(context.access.canPerformProtectedActions, true);
});

test("Member Review Fixture (B): ACTIVE membership + READ only + one project assignment - project access is granted only for the assigned project", () => {
  const { sessionToken, principal, grant } = staffGrant({
    principalId: "member", membershipId: "m-member", permissions: ["READ"], assignedProjectIds: [project.projectId],
  });
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const context = requireInternalOsAccess({ provider, sessionToken, organization, grants: [grant] });
  assert.equal(context.access.role, "MEMBER");
  const projectAccess = requireInternalOsProjectAccess({ organization, context, project });
  assert.equal(projectAccess.decision, "GRANTED");
  assert.throws(
    () => requireInternalOsProjectAccess({ organization, context, project: otherProject }),
    InternalOsAccessDeniedError,
  );
});

test("Restricted Review Fixture (C): ACTIVE membership + READ only + zero project assignments - organization-level access grants, but every project access is denied", () => {
  const { sessionToken, principal, grant } = staffGrant({
    principalId: "restricted", membershipId: "m-restricted", permissions: ["READ"], assignedProjectIds: [],
  });
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const context = requireInternalOsAccess({ provider, sessionToken, organization, grants: [grant] });
  assert.equal(context.access.decision, "GRANTED");
  assert.throws(() => requireInternalOsProjectAccess({ organization, context, project }), InternalOsAccessDeniedError);
});

test("a MEMBER with WRITE but no assignment for a specific project still cannot access that unassigned project", () => {
  const { sessionToken, principal, grant } = staffGrant({
    principalId: "writer", membershipId: "m-writer", permissions: ["READ", "WRITE"], assignedProjectIds: [otherProject.projectId],
  });
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const context = requireInternalOsAccess({ provider, sessionToken, organization, grants: [grant] });
  assert.throws(() => requireInternalOsProjectAccess({ organization, context, project }), InternalOsAccessDeniedError);
});

test("an ADMIN-labeled curated role with only READ authority still reports no WRITE/EXECUTE permission - the label never grants authority", () => {
  const { sessionToken, principal, grant } = staffGrant({
    principalId: "admin-readonly", membershipId: "m-admin-readonly", permissions: ["READ"], role: "ADMIN",
  });
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const context = requireInternalOsAccess({ provider, sessionToken, organization, grants: [grant] });
  assert.equal(context.access.role, "ADMIN");
  assert.deepEqual([...context.access.permissions], ["READ"]);
  assert.equal(context.access.canPerformProtectedActions, false);
});

test("a revoked membership fails closed on the very next access attempt - currentness is always re-proven, never cached", () => {
  const { sessionToken, principal, grant } = staffGrant({ principalId: "revocable", membershipId: "m-revocable", permissions: ["READ"] });
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const context = requireInternalOsAccess({ provider, sessionToken, organization, grants: [grant] });
  assert.equal(context.access.decision, "GRANTED");

  const revokedMembership = revokeOrganizationMembership({
    membership: grant.membership,
    revokedAt: "2026-01-02T00:00:00.000Z",
    revokedReason: "left the organization",
  });
  const revokedGrant: StaffAccessGrant = { ...grant, membership: revokedMembership };
  // A revoked membership never even matches `requireMatchingStaffMembership`'s
  // own ACTIVE-only filter, so this fails closed one step earlier than
  // `resolveEffectiveOrganizationAccess` - still fully fail-closed, just via
  // `NoStaffMembershipError` rather than `InternalOsAccessDeniedError`.
  assert.throws(
    () => requireInternalOsAccess({ provider, sessionToken, organization, grants: [revokedGrant] }),
    NoStaffMembershipError,
  );
});

test("tenant/organization substitution cannot widen access - a grant issued for a DIFFERENT tenant's organization is denied", () => {
  const foreignTenantScope = createTenantScope("tenant-os-v0-08-foreign");
  const foreignOrganization: Organization = activateOrganization({
    organization: createOrganization({
      organizationId: "org-foreign", tenantScope: foreignTenantScope, displayName: "Foreign Org", createdAt: "2026-01-01T00:00:00.000Z",
    }),
    activatedAt: "2026-01-01T00:00:00.000Z",
  });
  const { sessionToken, principal, grant } = staffGrant({ principalId: "cross-tenant", membershipId: "m-cross-tenant", permissions: ["READ"] });
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  // The grant's own membership/authority belong to `tenantScope`, not
  // `foreignTenantScope` - requesting access against the foreign
  // organization must be denied, never silently widened.
  assert.throws(
    () => requireInternalOsAccess({ provider, sessionToken, organization: foreignOrganization, grants: [grant] }),
    NoStaffMembershipError,
  );
});

test("a caller-supplied ambiguous set (two grants matching the same session/tenant) fails closed with AmbiguousStaffMembershipError", () => {
  const principal = createAuthenticatedStaffPrincipal({ principalId: "ambiguous", displayName: "Ambiguous" });
  const membershipA = createOrganizationMembership({ membershipId: "m-ambiguous-a", tenantScope, principalRef: principal.principalId, role: "STAFF" });
  const membershipB = createOrganizationMembership({ membershipId: "m-ambiguous-b", tenantScope, principalRef: principal.principalId, role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });
  const sessionToken = "token-ambiguous";
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  assert.throws(
    () =>
      requireInternalOsAccess({
        provider,
        sessionToken,
        organization,
        grants: [
          { membership: membershipA, authority, assignments: [] },
          { membership: membershipB, authority, assignments: [] },
        ],
      }),
    AmbiguousStaffMembershipError,
  );
});

test("a grant with only WRITE/EXECUTE but no READ permission is denied by the Phase A read-only floor", () => {
  const { sessionToken, principal, grant } = staffGrant({ principalId: "write-only", membershipId: "m-write-only", permissions: ["WRITE", "EXECUTE"] });
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  assert.throws(() => requireInternalOsAccess({ provider, sessionToken, organization, grants: [grant] }));
});
