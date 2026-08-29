import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOrganizationMembership,
  createAssignmentReference,
  resolveAssignmentStatus,
  InvalidOrganizationMembershipError,
  InvalidAssignmentReferenceError,
} from "../src/domain/organization-membership.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";

const tenantA = createTenantScope("tenant-a");
const tenantB = createTenantScope("tenant-b");

function membershipInput(overrides: Partial<{ membershipId: unknown; principalRef: unknown; role: unknown }> = {}) {
  return {
    membershipId: "membership-1",
    tenantScope: tenantA,
    principalRef: "principal-1",
    role: "STAFF",
    ...overrides,
  };
}

test("a valid membership is constructed deterministically", () => {
  const a = createOrganizationMembership(membershipInput());
  const b = createOrganizationMembership(membershipInput());
  assert.deepEqual(a, b);
  assert.equal(a.tenantId, "tenant-a");
});

test("all four representable roles construct without implying ownership - the type has no owner-role literal", () => {
  for (const role of ["STAFF", "JUNIOR", "STUDENT", "CLIENT_ASSOCIATE"]) {
    const membership = createOrganizationMembership(membershipInput({ role }));
    assert.equal(membership.role, role);
    assert.equal("permissions" in membership, false);
    assert.equal("canPerformProtectedActions" in membership, false);
  }
});

test("an invalid role rejects, including an attempted Owner-like role", () => {
  assert.throws(
    () => createOrganizationMembership(membershipInput({ role: "ACCOUNT_OWNER" })),
    InvalidOrganizationMembershipError,
  );
  assert.throws(
    () => createOrganizationMembership(membershipInput({ role: "" })),
    InvalidOrganizationMembershipError,
  );
});

test("empty/whitespace membershipId or principalRef rejects", () => {
  assert.throws(
    () => createOrganizationMembership(membershipInput({ membershipId: "" })),
    InvalidOrganizationMembershipError,
  );
  assert.throws(
    () => createOrganizationMembership(membershipInput({ principalRef: "  " })),
    InvalidOrganizationMembershipError,
  );
});

test("an assignment reference always inherits tenantId from its own membership, never a separately supplied value", () => {
  const membership = createOrganizationMembership(membershipInput());
  const assignment = createAssignmentReference({
    assignmentId: "assignment-1",
    membership,
    customerId: "customer-1",
  });
  assert.equal(assignment.tenantId, membership.tenantId);
  assert.equal(assignment.membershipId, membership.membershipId);
  assert.equal(assignment.projectId, undefined);
});

test("empty customerId/projectId on an assignment rejects", () => {
  const membership = createOrganizationMembership(membershipInput());
  assert.throws(
    () => createAssignmentReference({ assignmentId: "a-1", membership, customerId: "" }),
    InvalidAssignmentReferenceError,
  );
  assert.throws(
    () =>
      createAssignmentReference({
        assignmentId: "a-1",
        membership,
        customerId: "customer-1",
        projectId: "",
      }),
    InvalidAssignmentReferenceError,
  );
});

test("resolveAssignmentStatus: a matching assignment resolves ASSIGNED; no match resolves UNASSIGNED", () => {
  const membership = createOrganizationMembership(membershipInput());
  const assignment = createAssignmentReference({
    assignmentId: "assignment-1",
    membership,
    customerId: "customer-1",
    projectId: "project-1",
  });

  assert.equal(
    resolveAssignmentStatus({ membership, assignments: [assignment], customerId: "customer-1", projectId: "project-1" }),
    "ASSIGNED",
  );
  assert.equal(
    resolveAssignmentStatus({ membership, assignments: [assignment], customerId: "customer-2" }),
    "UNASSIGNED",
  );
  assert.equal(
    resolveAssignmentStatus({ membership, assignments: [], customerId: "customer-1" }),
    "UNASSIGNED",
  );
});

test("resolveAssignmentStatus: a customer-level assignment (no projectId) does not resolve a project-scoped query as ASSIGNED", () => {
  const membership = createOrganizationMembership(membershipInput());
  const customerLevelAssignment = createAssignmentReference({
    assignmentId: "assignment-1",
    membership,
    customerId: "customer-1",
  });
  assert.equal(
    resolveAssignmentStatus({
      membership,
      assignments: [customerLevelAssignment],
      customerId: "customer-1",
      projectId: "project-1",
    }),
    "UNASSIGNED",
  );
  assert.equal(
    resolveAssignmentStatus({ membership, assignments: [customerLevelAssignment], customerId: "customer-1" }),
    "ASSIGNED",
  );
});

test("no cross-tenant membership leakage: a same-membershipId collision across tenants resolves UNAVAILABLE, never ASSIGNED", () => {
  const membershipTenantA = createOrganizationMembership({
    membershipId: "shared-membership-id",
    tenantScope: tenantA,
    principalRef: "principal-1",
    role: "STAFF",
  });
  const membershipTenantB = createOrganizationMembership({
    membershipId: "shared-membership-id",
    tenantScope: tenantB,
    principalRef: "principal-1",
    role: "STAFF",
  });
  const assignmentUnderTenantB = createAssignmentReference({
    assignmentId: "assignment-1",
    membership: membershipTenantB,
    customerId: "customer-1",
  });

  const status = resolveAssignmentStatus({
    membership: membershipTenantA,
    assignments: [assignmentUnderTenantB],
    customerId: "customer-1",
  });
  assert.equal(status, "UNAVAILABLE");
  assert.notEqual(status, "ASSIGNED");
});

test("stale role/membership state cannot grant access: this module has no permission/protected-action concept at all", async () => {
  const moduleExports = await import("../src/domain/organization-membership.js");
  const exportNames = Object.keys(moduleExports);
  assert.equal(exportNames.includes("AuthorityContext"), false);
  assert.equal(exportNames.includes("requirePermission"), false);
  assert.equal(exportNames.includes("requireProtectedActionAuthorization"), false);
  const membership = createOrganizationMembership(membershipInput());
  assert.equal("permissions" in membership, false);
  assert.equal("canPerformProtectedActions" in membership, false);
});
