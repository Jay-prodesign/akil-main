import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPartnerOrganization,
  createPartnerEmployeeMembership,
  createPartnerClientAssignment,
  revokePartnerClientAssignment,
  resolvePartnerClientAccess,
  InvalidPartnerOrganizationError,
  InvalidPartnerEmployeeMembershipError,
  InvalidPartnerClientAssignmentError,
} from "../src/domain/partner-organization.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";

const tenantA = createTenantScope("tenant-a");
const tenantB = createTenantScope("tenant-b");

const ownershipClient1 = createProjectOwnershipRef({
  tenantId: "tenant-a",
  customerId: "customer-1",
  projectId: "project-1",
});
const ownershipClient2 = createProjectOwnershipRef({
  tenantId: "tenant-a",
  customerId: "customer-2",
  projectId: "project-2",
});

const partnerOrgA = createPartnerOrganization({
  partnerOrganizationId: "partner-org-1",
  tenantScope: tenantA,
  relationshipType: "AGENCY",
});

const partnerOrgB = createPartnerOrganization({
  partnerOrganizationId: "partner-org-2",
  tenantScope: tenantB,
  relationshipType: "RESELLER",
});

const employeeA1 = createPartnerEmployeeMembership({
  partnerEmployeeMembershipId: "employee-1",
  partnerOrganization: partnerOrgA,
  principalRef: "principal-1",
});

test("a valid partner organization constructs deterministically for each representable relationship type", () => {
  for (const relationshipType of ["AGENCY", "RESELLER", "CO_BRAND", "WHOLESALE"]) {
    const org = createPartnerOrganization({
      partnerOrganizationId: "org-x",
      tenantScope: tenantA,
      relationshipType,
    });
    assert.equal(org.relationshipType, relationshipType);
    assert.equal(org.tenantId, "tenant-a");
  }
});

test("an invalid relationshipType rejects", () => {
  assert.throws(
    () =>
      createPartnerOrganization({
        partnerOrganizationId: "org-x",
        tenantScope: tenantA,
        relationshipType: "DISTRIBUTOR",
      }),
    InvalidPartnerOrganizationError,
  );
});

test("a partner employee membership always inherits tenantId from its own partner organization", () => {
  assert.equal(employeeA1.tenantId, partnerOrgA.tenantId);
  assert.equal(employeeA1.partnerOrganizationId, partnerOrgA.partnerOrganizationId);
});

test("empty principalRef rejects", () => {
  assert.throws(
    () =>
      createPartnerEmployeeMembership({
        partnerEmployeeMembershipId: "e-1",
        partnerOrganization: partnerOrgA,
        principalRef: "",
      }),
    InvalidPartnerEmployeeMembershipError,
  );
});

test("agency employee membership alone grants no client visibility: with zero assignments, access is UNAUTHORIZED for any client", () => {
  const status = resolvePartnerClientAccess({
    partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
    assignments: [],
    ownership: ownershipClient1,
  });
  assert.equal(status, "UNAUTHORIZED");
});

test("an explicit ACTIVE assignment authorizes access to exactly that client, and no other", () => {
  const assignment = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-1",
    partnerEmployeeMembership: employeeA1,
    ownership: ownershipClient1,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  assert.equal(
    resolvePartnerClientAccess({
      partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
      assignments: [assignment],
      ownership: ownershipClient1,
    }),
    "AUTHORIZED",
  );
});

test("cross-client substitution fails closed: an assignment for client 1 does not authorize access to client 2 (adversarial)", () => {
  const assignment = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-1",
    partnerEmployeeMembership: employeeA1,
    ownership: ownershipClient1,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  assert.equal(
    resolvePartnerClientAccess({
      partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
      assignments: [assignment],
      ownership: ownershipClient2,
    }),
    "UNAUTHORIZED",
  );
});

test("granting access into a foreign-tenant ownership scope fails closed at construction", () => {
  const employeeB1 = createPartnerEmployeeMembership({
    partnerEmployeeMembershipId: "employee-b-1",
    partnerOrganization: partnerOrgB,
    principalRef: "principal-2",
  });
  assert.throws(
    () =>
      createPartnerClientAssignment({
        partnerClientAssignmentId: "assignment-x",
        partnerEmployeeMembership: employeeB1,
        ownership: ownershipClient1,
        grantedAt: "2026-08-27T00:00:00Z",
      }),
    InvalidPartnerClientAssignmentError,
  );
});

test("revoked assignment removes access deterministically: AUTHORIZED before revocation, REVOKED (never AUTHORIZED) after", () => {
  const assignment = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-1",
    partnerEmployeeMembership: employeeA1,
    ownership: ownershipClient1,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  assert.equal(
    resolvePartnerClientAccess({
      partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
      assignments: [assignment],
      ownership: ownershipClient1,
    }),
    "AUTHORIZED",
  );
  const revoked = revokePartnerClientAssignment({
    assignment,
    revokedAt: "2026-08-27T01:00:00Z",
  });
  assert.equal(revoked.status, "REVOKED");
  assert.equal(assignment.status, "ACTIVE", "the original grant object is never mutated in place");
  const status = resolvePartnerClientAccess({
    partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
    assignments: [revoked],
    ownership: ownershipClient1,
  });
  assert.equal(status, "REVOKED");
  assert.notEqual(status, "AUTHORIZED");
});

test("REVOKED is distinct from UNAUTHORIZED - a caller can tell 'access was removed' from 'access never existed'", () => {
  const assignment = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-1",
    partnerEmployeeMembership: employeeA1,
    ownership: ownershipClient1,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  const revoked = revokePartnerClientAssignment({ assignment, revokedAt: "2026-08-27T01:00:00Z" });
  const revokedStatus = resolvePartnerClientAccess({
    partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
    assignments: [revoked],
    ownership: ownershipClient1,
  });
  const neverGrantedStatus = resolvePartnerClientAccess({
    partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
    assignments: [],
    ownership: ownershipClient2,
  });
  assert.equal(revokedStatus, "REVOKED");
  assert.equal(neverGrantedStatus, "UNAUTHORIZED");
  assert.notEqual(revokedStatus, neverGrantedStatus);
});

test("an already-revoked assignment cannot be revoked again", () => {
  const assignment = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-1",
    partnerEmployeeMembership: employeeA1,
    ownership: ownershipClient1,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  const revoked = revokePartnerClientAssignment({ assignment, revokedAt: "2026-08-27T01:00:00Z" });
  assert.throws(
    () => revokePartnerClientAssignment({ assignment: revoked, revokedAt: "2026-08-27T02:00:00Z" }),
    InvalidPartnerClientAssignmentError,
  );
});

test("Rev62 AUD-V3-01: an immutable [ACTIVE, REVOKED] history for the same assignment identity resolves REVOKED, never AUTHORIZED", () => {
  const assignment = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-1",
    partnerEmployeeMembership: employeeA1,
    ownership: ownershipClient1,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  const revoked = revokePartnerClientAssignment({ assignment, revokedAt: "2026-08-27T01:00:00Z" });
  // The original ACTIVE record is never mutated (provenance is preserved),
  // so a truthful immutable history can legitimately contain both the
  // original grant and its revocation successor for the same identity.
  const status = resolvePartnerClientAccess({
    partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
    assignments: [assignment, revoked],
    ownership: ownershipClient1,
  });
  assert.equal(status, "REVOKED");
  assert.notEqual(status, "AUTHORIZED");
});

test("Rev62 AUD-V3-01: history order does not matter - [REVOKED, ACTIVE] for the same identity also resolves REVOKED", () => {
  const assignment = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-1",
    partnerEmployeeMembership: employeeA1,
    ownership: ownershipClient1,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  const revoked = revokePartnerClientAssignment({ assignment, revokedAt: "2026-08-27T01:00:00Z" });
  const status = resolvePartnerClientAccess({
    partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
    assignments: [revoked, assignment],
    ownership: ownershipClient1,
  });
  assert.equal(status, "REVOKED");
  assert.notEqual(status, "AUTHORIZED");
});

test("Rev62 AUD-V3-01: a genuinely distinct, later assignment (fresh id) for the same employee/client still resolves AUTHORIZED even alongside an earlier revoked one", () => {
  const firstGrant = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-1",
    partnerEmployeeMembership: employeeA1,
    ownership: ownershipClient1,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  const firstRevoked = revokePartnerClientAssignment({
    assignment: firstGrant,
    revokedAt: "2026-08-27T01:00:00Z",
  });
  const regrant = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-2",
    partnerEmployeeMembership: employeeA1,
    ownership: ownershipClient1,
    grantedAt: "2026-08-27T02:00:00Z",
  });
  const status = resolvePartnerClientAccess({
    partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
    assignments: [firstGrant, firstRevoked, regrant],
    ownership: ownershipClient1,
  });
  assert.equal(status, "AUTHORIZED");
});

test("Rev62 AUD-V3-02: an assignment scoped to Service A does not authorize a request scoped to Service B", () => {
  const serviceAOwnership = createProjectOwnershipRef({
    tenantId: "tenant-a",
    customerId: "customer-1",
    projectId: "project-1",
    serviceRef: "service-a",
  });
  const serviceBOwnership = createProjectOwnershipRef({
    tenantId: "tenant-a",
    customerId: "customer-1",
    projectId: "project-1",
    serviceRef: "service-b",
  });
  const assignment = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-service-a",
    partnerEmployeeMembership: employeeA1,
    ownership: serviceAOwnership,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  const status = resolvePartnerClientAccess({
    partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
    assignments: [assignment],
    ownership: serviceBOwnership,
  });
  assert.equal(status, "UNAUTHORIZED");
});

test("Rev62 AUD-V3-02: a service-scoped assignment does not authorize an absent-serviceRef request, and vice versa", () => {
  const serviceScopedOwnership = createProjectOwnershipRef({
    tenantId: "tenant-a",
    customerId: "customer-1",
    projectId: "project-1",
    serviceRef: "service-a",
  });
  const serviceScopedAssignment = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-service-scoped",
    partnerEmployeeMembership: employeeA1,
    ownership: serviceScopedOwnership,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  assert.equal(
    resolvePartnerClientAccess({
      partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
      assignments: [serviceScopedAssignment],
      ownership: ownershipClient1,
    }),
    "UNAUTHORIZED",
  );

  const unscopedAssignment = createPartnerClientAssignment({
    partnerClientAssignmentId: "assignment-unscoped",
    partnerEmployeeMembership: employeeA1,
    ownership: ownershipClient1,
    grantedAt: "2026-08-27T00:00:00Z",
  });
  assert.equal(
    resolvePartnerClientAccess({
      partnerEmployeeMembershipId: employeeA1.partnerEmployeeMembershipId,
      assignments: [unscopedAssignment],
      ownership: serviceScopedOwnership,
    }),
    "UNAUTHORIZED",
  );
});

test("relationshipType (reseller/co-brand/wholesale) is never consulted by resolvePartnerClientAccess - representable, but grants no rights by presence", () => {
  const resellerOrg = createPartnerOrganization({
    partnerOrganizationId: "reseller-org",
    tenantScope: tenantA,
    relationshipType: "WHOLESALE",
  });
  const resellerEmployee = createPartnerEmployeeMembership({
    partnerEmployeeMembershipId: "reseller-employee-1",
    partnerOrganization: resellerOrg,
    principalRef: "principal-3",
  });
  // No assignment was ever granted for this employee - WHOLESALE status
  // alone must not produce access.
  const status = resolvePartnerClientAccess({
    partnerEmployeeMembershipId: resellerEmployee.partnerEmployeeMembershipId,
    assignments: [],
    ownership: ownershipClient1,
  });
  assert.equal(status, "UNAUTHORIZED");
});
