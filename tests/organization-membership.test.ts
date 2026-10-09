import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOrganizationMembership,
  createAssignmentReference,
  resolveAssignmentStatus,
  isOrganizationMembershipActive,
  revokeOrganizationMembership,
  InvalidOrganizationMembershipError,
  InvalidAssignmentReferenceError,
  InvalidOrganizationMembershipTransitionError,
  type OrganizationMembership,
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

// ---------------------------------------------------------------------------
// Rev131 Phase C: membership revocation / currentness floor (C1-C6, C11, C12)
// ---------------------------------------------------------------------------

test("C1: createOrganizationMembership always produces a coherent ACTIVE record with no revocation metadata", () => {
  const membership = createOrganizationMembership(membershipInput());
  assert.equal(membership.state, "ACTIVE");
  assert.equal(membership.revokedAt, undefined);
  assert.equal(membership.revokedReason, undefined);
  assert.equal(isOrganizationMembershipActive(membership), true);
});

test("C2: revokeOrganizationMembership transitions ACTIVE -> REVOKED, recording a valid timestamp/reason and preserving identity/tenant/principal/role", () => {
  const membership = createOrganizationMembership(membershipInput());
  const revoked = revokeOrganizationMembership({
    membership,
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "offboarded",
  });
  assert.equal(revoked.state, "REVOKED");
  assert.equal(revoked.revokedAt, "2026-09-25T00:00:00.000Z");
  assert.equal(revoked.revokedReason, "offboarded");
  assert.equal(revoked.membershipId, membership.membershipId);
  assert.equal(revoked.tenantId, membership.tenantId);
  assert.equal(revoked.principalRef, membership.principalRef);
  assert.equal(revoked.role, membership.role);
  assert.equal(isOrganizationMembershipActive(revoked), false);
});

test("C3: a double revoke rejects, and no reactivation API exists", async () => {
  const membership = createOrganizationMembership(membershipInput());
  const revoked = revokeOrganizationMembership({
    membership,
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "offboarded",
  });
  assert.throws(
    () =>
      revokeOrganizationMembership({
        membership: revoked,
        revokedAt: "2026-09-26T00:00:00.000Z",
        revokedReason: "offboarded again",
      }),
    InvalidOrganizationMembershipTransitionError,
  );
  const moduleExports = await import("../src/domain/organization-membership.js");
  assert.equal("reactivateOrganizationMembership" in moduleExports, false);
  assert.equal("activateOrganizationMembership" in moduleExports, false);
});

test("C3 (adversarial): revoking from a hand-built incoherent 'ACTIVE' record (already carrying revocation metadata) rejects rather than silently succeeding", () => {
  const forged = {
    ...createOrganizationMembership(membershipInput()),
    state: "ACTIVE",
    revokedAt: "2026-01-01T00:00:00.000Z",
    revokedReason: "stale",
  } as unknown as OrganizationMembership;
  assert.throws(
    () =>
      revokeOrganizationMembership({
        membership: forged,
        revokedAt: "2026-09-25T00:00:00.000Z",
        revokedReason: "offboarded",
      }),
    InvalidOrganizationMembershipTransitionError,
  );
});

test("C4: malformed/unknown lifecycle shapes are never treated ACTIVE", () => {
  const base = createOrganizationMembership(membershipInput());
  const unknownState = { ...base, state: "PENDING" } as unknown as OrganizationMembership;
  assert.equal(isOrganizationMembershipActive(unknownState), false);
  const { state: _omittedState, ...withoutState } = base;
  const missingState = withoutState as unknown as OrganizationMembership;
  assert.equal(isOrganizationMembershipActive(missingState), false);
});

test("C5: ACTIVE carrying stale revokedAt/revokedReason fails lifecycle validation (is not treated active)", () => {
  const base = createOrganizationMembership(membershipInput());
  const staleRevokedAt = { ...base, revokedAt: "2026-01-01T00:00:00.000Z" } as unknown as OrganizationMembership;
  assert.equal(isOrganizationMembershipActive(staleRevokedAt), false);
  const staleRevokedReason = { ...base, revokedReason: "stale" } as unknown as OrganizationMembership;
  assert.equal(isOrganizationMembershipActive(staleRevokedReason), false);
});

test("C6: REVOKED missing/invalid revokedAt or revokedReason fails lifecycle validation (is not treated active)", () => {
  const base = createOrganizationMembership(membershipInput());
  const missingRevokedAt = { ...base, state: "REVOKED", revokedReason: "offboarded" } as unknown as OrganizationMembership;
  assert.equal(isOrganizationMembershipActive(missingRevokedAt), false);
  const missingRevokedReason = { ...base, state: "REVOKED", revokedAt: "2026-09-25T00:00:00.000Z" } as unknown as OrganizationMembership;
  assert.equal(isOrganizationMembershipActive(missingRevokedReason), false);
  const emptyRevokedReason = {
    ...base,
    state: "REVOKED",
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "",
  } as unknown as OrganizationMembership;
  assert.equal(isOrganizationMembershipActive(emptyRevokedReason), false);
});

test("C2 (adversarial): revokeOrganizationMembership rejects an empty/whitespace revokedReason and a malformed revokedAt", () => {
  const membership = createOrganizationMembership(membershipInput());
  assert.throws(
    () => revokeOrganizationMembership({ membership, revokedAt: "2026-09-25T00:00:00.000Z", revokedReason: "" }),
    InvalidOrganizationMembershipTransitionError,
  );
  assert.throws(
    () => revokeOrganizationMembership({ membership, revokedAt: "not-a-date", revokedReason: "offboarded" }),
    InvalidOrganizationMembershipTransitionError,
  );
});

test("C11: one ACTIVE + one REVOKED membership for the same principal/tenant - the active-only predicate isolates exactly the ACTIVE record", () => {
  const active = createOrganizationMembership(membershipInput({ membershipId: "membership-active" }));
  const revoked = revokeOrganizationMembership({
    membership: createOrganizationMembership(membershipInput({ membershipId: "membership-revoked" })),
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "offboarded",
  });
  const usable = [active, revoked].filter(isOrganizationMembershipActive);
  assert.deepEqual(usable, [active]);
});

test("C12: cross-tenant membership substitution remains fail-closed independently of lifecycle state (ACTIVE on both sides)", () => {
  const membershipTenantA = createOrganizationMembership({
    membershipId: "shared-membership-id-c12",
    tenantScope: tenantA,
    principalRef: "principal-1",
    role: "STAFF",
  });
  const membershipTenantB = createOrganizationMembership({
    membershipId: "shared-membership-id-c12",
    tenantScope: tenantB,
    principalRef: "principal-1",
    role: "STAFF",
  });
  assert.equal(isOrganizationMembershipActive(membershipTenantA), true);
  assert.equal(isOrganizationMembershipActive(membershipTenantB), true);
  const assignmentUnderTenantB = createAssignmentReference({
    assignmentId: "assignment-c12",
    membership: membershipTenantB,
    customerId: "customer-1",
  });
  const status = resolveAssignmentStatus({
    membership: membershipTenantA,
    assignments: [assignmentUnderTenantB],
    customerId: "customer-1",
  });
  assert.equal(status, "UNAVAILABLE");
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
