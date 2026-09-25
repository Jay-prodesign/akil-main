import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import {
  createOrganizationMembership,
  createAssignmentReference,
  revokeOrganizationMembership,
  type OrganizationMembership,
  type AssignmentReference,
} from "../src/domain/organization-membership.js";
import { createAuthorityContext, type AuthorityContext } from "../src/domain/authority.js";
import { createProject, type Project } from "../src/domain/project.js";
import {
  resolveEffectiveOrganizationAccess,
  type EffectiveAccessResolution,
} from "../src/domain/effective-organization-access.js";

const tenantScope = createTenantScope("tenant-os-v0-02");
const otherTenantScope = createTenantScope("tenant-os-v0-02-other");
const NOW = "2026-09-25T00:00:00.000Z";
const PRINCIPAL_REF = "principal-os-v0-02";

function buildOrganization(overrides: { tenantScope?: typeof tenantScope } = {}): Organization {
  return createOrganization({
    organizationId: "org-os-v0-02",
    tenantScope: overrides.tenantScope ?? tenantScope,
    displayName: "Reference Organization",
    createdAt: NOW,
  });
}

function buildMembership(overrides: {
  tenantScope?: typeof tenantScope;
  role?: "STAFF" | "JUNIOR" | "STUDENT" | "CLIENT_ASSOCIATE";
  principalRef?: string;
  membershipId?: string;
} = {}): OrganizationMembership {
  return createOrganizationMembership({
    membershipId: overrides.membershipId ?? "membership-os-v0-02",
    tenantScope: overrides.tenantScope ?? tenantScope,
    principalRef: overrides.principalRef ?? PRINCIPAL_REF,
    role: overrides.role ?? "STAFF",
  });
}

function buildAuthority(overrides: {
  tenantScope?: typeof tenantScope;
  permissions?: ReadonlyArray<"READ" | "WRITE" | "EXECUTE">;
  canPerformProtectedActions?: boolean;
} = {}): AuthorityContext {
  return createAuthorityContext({
    tenantScope: overrides.tenantScope ?? tenantScope,
    permissions: overrides.permissions ?? ["READ", "WRITE"],
    canPerformProtectedActions: overrides.canPerformProtectedActions ?? false,
  });
}

function buildProject(overrides: { tenantScope?: typeof tenantScope } = {}): Project {
  const scope = overrides.tenantScope ?? tenantScope;
  const customer = createCustomer({
    tenantScope: scope,
    customerId: "cust-os-v0-02",
    displayName: "Reference Customer",
  });
  return createProject({
    tenantScope: scope,
    customer,
    projectId: "proj-os-v0-02",
    ownerRef: "owner-os-v0-02",
    state: "active",
  });
}

// Rev130 Phase B: exact assignment evidence, built from the existing
// OrganizationMembership.createAssignmentReference/resolveAssignmentStatus
// primitives (never a new persistence/store concept).
function buildAssignment(overrides: {
  membership?: OrganizationMembership;
  customerId?: string;
  projectId?: string;
} = {}): AssignmentReference {
  const membership = overrides.membership ?? buildMembership();
  return createAssignmentReference({
    assignmentId: "assignment-os-v0-02",
    membership,
    customerId: overrides.customerId ?? "cust-os-v0-02",
    projectId: overrides.projectId ?? "proj-os-v0-02",
  });
}

// ---------------------------------------------------------------------------
// A1: same-tenant deterministic success
// ---------------------------------------------------------------------------

test("A1: same-tenant Organization/Membership/Authority resolves GRANTED with the exact authority permissions (exact matching currentPrincipalRef)", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: ["READ", "WRITE"] });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
  });
  assert.equal(result.decision, "GRANTED");
  assert.equal(result.tenantId, tenantScope.tenantId);
  assert.equal(result.organizationId, organization.organizationId);
  assert.equal(result.membershipId, membership.membershipId);
  assert.equal(result.role, "MEMBER");
  assert.deepEqual([...result.permissions].sort(), ["READ", "WRITE"]);
  assert.equal(result.canPerformProtectedActions, false);
  assert.ok(result.reasons.length > 0);
  assert.match(result.reasons[0] ?? "", /principal matches/);
});

test("A1: an activated Organization (ACTIVE state) still resolves GRANTED the same way - this resolver does not gate on lifecycle state", () => {
  const organization = activateOrganization({
    organization: buildOrganization(),
    activatedAt: "2026-09-25T01:00:00.000Z",
  });
  const membership = buildMembership();
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
  });
  assert.equal(result.decision, "GRANTED");
});

// ---------------------------------------------------------------------------
// A2/A3/A4: cross-tenant denial
// ---------------------------------------------------------------------------

test("A2: a membership belonging to a foreign tenant is denied", () => {
  const organization = buildOrganization();
  const membership = buildMembership({ tenantScope: otherTenantScope });
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
  });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.permissions.size, 0);
  assert.equal(result.canPerformProtectedActions, false);
  assert.match(result.reasons[0] ?? "", /membership belongs to a different tenant/);
});

test("A3: an authority belonging to a foreign tenant is denied, even with a legitimate same-tenant membership", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ tenantScope: otherTenantScope });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
  });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /authority belongs to a different tenant/);
});

test("A4: a Project belonging to a foreign tenant is denied, even with legitimate same-tenant membership and authority", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject({ tenantScope: otherTenantScope });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
  });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /project belongs to a different tenant/);
});

test("A4/B2: a same-tenant Project scope with exact assignment evidence resolves GRANTED and carries the exact projectId", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject();
  const assignment = buildAssignment({ membership });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
    assignments: [assignment],
  });
  assert.equal(result.decision, "GRANTED");
  assert.equal(result.projectId, project.projectId);
});

// ---------------------------------------------------------------------------
// A5/A6/A7/A8: permission never escalates beyond the exact AuthorityContext
// ---------------------------------------------------------------------------

test("A5: READ-only authority never yields WRITE/EXECUTE in the resolution", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: ["READ"] });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
  });
  assert.equal(result.decision, "GRANTED");
  assert.deepEqual([...result.permissions], ["READ"]);
});

test("A6: EXECUTE permission alone never yields protected-action eligibility", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: ["EXECUTE"], canPerformProtectedActions: false });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
  });
  assert.equal(result.decision, "GRANTED");
  assert.ok(result.permissions.has("EXECUTE"));
  assert.equal(result.canPerformProtectedActions, false);
});

test("A6: canPerformProtectedActions is granted only when the AuthorityContext explicitly carries it", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: ["EXECUTE"], canPerformProtectedActions: true });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
  });
  assert.equal(result.canPerformProtectedActions, true);
});

test("A7: every legacy membership role (STAFF/JUNIOR/STUDENT/CLIENT_ASSOCIATE) resolves the identical MEMBER role and never escalates permission beyond authority", () => {
  const authority = buildAuthority({ permissions: ["READ"] });
  const organization = buildOrganization();
  for (const role of ["STAFF", "JUNIOR", "STUDENT", "CLIENT_ASSOCIATE"] as const) {
    const membership = buildMembership({ role });
    const result = resolveEffectiveOrganizationAccess({
      organization,
      membership,
      currentPrincipalRef: membership.principalRef,
      authority,
    });
    assert.equal(result.decision, "GRANTED");
    assert.equal(result.role, "MEMBER");
    assert.deepEqual([...result.permissions], ["READ"]);
  }
});

test("A8/B8: Project.ownerRef cannot grant permission or approval - the resolution is identical regardless of ownerRef, and the resolver never reads it (with matching assignment evidence supplied for both projects)", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: [] });
  const projectA = buildProject();
  const scope = tenantScope;
  const customer = createCustomer({ tenantScope: scope, customerId: "cust-os-v0-02-b", displayName: "Other Customer" });
  const projectB = createProject({
    tenantScope: scope,
    customer,
    projectId: "proj-os-v0-02-b",
    ownerRef: "a-completely-different-owner-ref",
    state: "active",
  });
  const assignmentA = buildAssignment({ membership, customerId: projectA.customerId, projectId: projectA.projectId });
  const assignmentB = buildAssignment({ membership, customerId: projectB.customerId, projectId: projectB.projectId });
  const resultA = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project: projectA,
    assignments: [assignmentA],
  });
  const resultB = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project: projectB,
    assignments: [assignmentB],
  });
  assert.equal(resultA.decision, "GRANTED");
  assert.equal(resultB.decision, "GRANTED");
  assert.deepEqual([...resultA.permissions], [...resultB.permissions]);
  assert.equal(resultA.canPerformProtectedActions, resultB.canPerformProtectedActions);
  assert.equal(resultA.role, resultB.role);
});

test("B8: Project.ownerRef matching currentPrincipalRef cannot substitute for missing AssignmentReference evidence - still DENIED", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = createProject({
    tenantScope,
    customer: createCustomer({ tenantScope, customerId: "cust-os-v0-02", displayName: "Reference Customer" }),
    projectId: "proj-os-v0-02",
    ownerRef: membership.principalRef,
    state: "active",
  });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
  });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.permissions.size, 0);
  assert.match(result.reasons[0] ?? "", /assignment evidence/);
});

// ---------------------------------------------------------------------------
// Rev130 Phase B: project-scope assignment enforcement (B1-B13)
// ---------------------------------------------------------------------------

test("B3: a Project scope with no assignment evidence at all fails closed", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
    assignments: [],
  });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.permissions.size, 0);
  assert.equal(result.canPerformProtectedActions, false);
  assert.match(result.reasons[0] ?? "", /assignment evidence/);
});

test("B4: an assignment that belongs to a DIFFERENT membershipId (wrong member) does not satisfy the current membership's project scope", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const otherMembership = buildMembership({ membershipId: "membership-someone-else" });
  const authority = buildAuthority();
  const project = buildProject();
  const wrongMemberAssignment = buildAssignment({ membership: otherMembership });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
    assignments: [wrongMemberAssignment],
  });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /assignment evidence/);
});

test("B5: an assignment for the current membership but a DIFFERENT projectId does not satisfy this project's scope", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject();
  const wrongProjectAssignment = buildAssignment({ membership, projectId: "proj-os-v0-02-different" });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
    assignments: [wrongProjectAssignment],
  });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /assignment evidence/);
});

test("B6: an assignment for the current membership/project's projectId but a DIFFERENT customerId does not satisfy this project's scope", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject();
  const wrongCustomerAssignment = buildAssignment({ membership, customerId: "cust-os-v0-02-different" });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
    assignments: [wrongCustomerAssignment],
  });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /assignment evidence/);
});

test("B7 (adversarial): a same-membershipId assignment collision from a FOREIGN tenant resolves UNAVAILABLE via resolveAssignmentStatus, not ASSIGNED - still fails closed", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject();
  // A hand-built cross-tenant collision: same membershipId as the current
  // membership, but tagged with a foreign tenantId - the same adversarial
  // shape resolveAssignmentStatus's own tests (organization-membership.ts)
  // already prove resolves to "UNAVAILABLE", never "ASSIGNED".
  const collidingAssignment = {
    assignmentId: "assignment-colliding",
    tenantId: otherTenantScope.tenantId,
    membershipId: membership.membershipId,
    customerId: project.customerId,
    projectId: project.projectId,
  } as unknown as AssignmentReference;
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
    assignments: [collidingAssignment],
  });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /assignment evidence/);
});

test("B9: a JUNIOR/STUDENT/CLIENT_ASSOCIATE role membership needs the identical exact assignment evidence as STAFF - role never substitutes for or waives assignment", () => {
  const organization = buildOrganization();
  const authority = buildAuthority({ permissions: ["READ"] });
  const project = buildProject();
  for (const role of ["JUNIOR", "STUDENT", "CLIENT_ASSOCIATE"] as const) {
    const membership = buildMembership({ role });
    const deniedResult = resolveEffectiveOrganizationAccess({
      organization,
      membership,
      currentPrincipalRef: membership.principalRef,
      authority,
      project,
      assignments: [],
    });
    assert.equal(deniedResult.decision, "DENIED", `role ${role} must not bypass assignment gating`);
    const grantedResult = resolveEffectiveOrganizationAccess({
      organization,
      membership,
      currentPrincipalRef: membership.principalRef,
      authority,
      project,
      assignments: [buildAssignment({ membership })],
    });
    assert.equal(grantedResult.decision, "GRANTED");
    assert.equal(grantedResult.role, "MEMBER");
    assert.deepEqual([...grantedResult.permissions], ["READ"]);
  }
});

test("B11: a wrong-principal currentPrincipalRef is still denied even when exact assignment evidence exists for the (substituted) membership and project", () => {
  const organization = buildOrganization();
  const membership = buildMembership({ principalRef: "principal-real-owner" });
  const authority = buildAuthority();
  const project = buildProject();
  const assignment = buildAssignment({ membership });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "principal-impersonator",
    authority,
    project,
    assignments: [assignment],
  });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.permissions.size, 0);
  assert.match(result.reasons[0] ?? "", /different principal/);
});

test("B13: org_akilta and a controlled second organization resolve project-scoped access through the identical resolver, each with its own matching membership/assignment/principal", () => {
  const akiltaTenantScope = createTenantScope("tenant-akilta-os-v0-02-b");
  const controlledTenantScope = createTenantScope("tenant-controlled-os-v0-02-b");

  const orgAkilta = createOrganization({
    organizationId: "org_akilta",
    tenantScope: akiltaTenantScope,
    displayName: "AKILTA (Organization Zero)",
    createdAt: NOW,
  });
  const orgControlled = createOrganization({
    organizationId: "org-controlled-os-v0-02-b",
    tenantScope: controlledTenantScope,
    displayName: "Controlled Second Organization",
    createdAt: NOW,
  });

  const membershipAkilta = createOrganizationMembership({
    membershipId: "membership-akilta-b",
    tenantScope: akiltaTenantScope,
    principalRef: "principal-akilta-b",
    role: "STAFF",
  });
  const membershipControlled = createOrganizationMembership({
    membershipId: "membership-controlled-b",
    tenantScope: controlledTenantScope,
    principalRef: "principal-controlled-b",
    role: "STAFF",
  });

  const authorityAkilta = createAuthorityContext({
    tenantScope: akiltaTenantScope,
    permissions: ["READ"],
    canPerformProtectedActions: false,
  });
  const authorityControlled = createAuthorityContext({
    tenantScope: controlledTenantScope,
    permissions: ["READ"],
    canPerformProtectedActions: false,
  });

  const customerAkilta = createCustomer({
    tenantScope: akiltaTenantScope,
    customerId: "cust-akilta-b",
    displayName: "AKILTA Customer",
  });
  const customerControlled = createCustomer({
    tenantScope: controlledTenantScope,
    customerId: "cust-controlled-b",
    displayName: "Controlled Customer",
  });
  const projectAkilta = createProject({
    tenantScope: akiltaTenantScope,
    customer: customerAkilta,
    projectId: "proj-akilta-b",
    ownerRef: "owner-akilta-b",
    state: "active",
  });
  const projectControlled = createProject({
    tenantScope: controlledTenantScope,
    customer: customerControlled,
    projectId: "proj-controlled-b",
    ownerRef: "owner-controlled-b",
    state: "active",
  });

  const assignmentAkilta = createAssignmentReference({
    assignmentId: "assignment-akilta-b",
    membership: membershipAkilta,
    customerId: customerAkilta.customerId,
    projectId: projectAkilta.projectId,
  });
  const assignmentControlled = createAssignmentReference({
    assignmentId: "assignment-controlled-b",
    membership: membershipControlled,
    customerId: customerControlled.customerId,
    projectId: projectControlled.projectId,
  });

  const resultAkilta = resolveEffectiveOrganizationAccess({
    organization: orgAkilta,
    membership: membershipAkilta,
    currentPrincipalRef: membershipAkilta.principalRef,
    authority: authorityAkilta,
    project: projectAkilta,
    assignments: [assignmentAkilta],
  });
  const resultControlled = resolveEffectiveOrganizationAccess({
    organization: orgControlled,
    membership: membershipControlled,
    currentPrincipalRef: membershipControlled.principalRef,
    authority: authorityControlled,
    project: projectControlled,
    assignments: [assignmentControlled],
  });

  assert.equal(resultAkilta.decision, "GRANTED");
  assert.equal(resultControlled.decision, "GRANTED");
  assert.equal(resultAkilta.role, resultControlled.role);
  assert.deepEqual([...resultAkilta.permissions].sort(), [...resultControlled.permissions].sort());
});

// ---------------------------------------------------------------------------
// A9: missing/substituted membership fails closed (cross-tenant AND
// same-tenant wrong-principal substitution - Rev129)
// ---------------------------------------------------------------------------

test("A9: a missing membership fails closed with zero permissions", () => {
  const organization = buildOrganization();
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    currentPrincipalRef: PRINCIPAL_REF,
    authority,
  });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.membershipId, undefined);
  assert.equal(result.permissions.size, 0);
  assert.match(result.reasons[0] ?? "", /membership is required/);
});

test("A9: a substituted (foreign-tenant) membership fails closed identically to a missing one - zero permissions either way", () => {
  const organization = buildOrganization();
  const authority = buildAuthority();
  const missing = resolveEffectiveOrganizationAccess({
    organization,
    currentPrincipalRef: PRINCIPAL_REF,
    authority,
  });
  const substituted = resolveEffectiveOrganizationAccess({
    organization,
    membership: buildMembership({ tenantScope: otherTenantScope }),
    currentPrincipalRef: PRINCIPAL_REF,
    authority,
  });
  assert.equal(missing.decision, "DENIED");
  assert.equal(substituted.decision, "DENIED");
  assert.equal(missing.permissions.size, 0);
  assert.equal(substituted.permissions.size, 0);
});

test("A9 (Rev129): a same-tenant membership belonging to a DIFFERENT principal than the current caller identity fails closed, even though every tenant correlation passes", () => {
  const organization = buildOrganization();
  const membership = buildMembership({ principalRef: "principal-real-owner" });
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "principal-impersonator",
    authority,
  });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.permissions.size, 0);
  assert.equal(result.canPerformProtectedActions, false);
  assert.match(result.reasons[0] ?? "", /different principal/);
});

test("A9 (Rev129): a same-tenant, same-role membership with the correct principalRef resolves GRANTED - proves the mismatch above is caused by principal identity, not tenant/role", () => {
  const organization = buildOrganization();
  const membership = buildMembership({ principalRef: "principal-real-owner" });
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "principal-real-owner",
    authority,
  });
  assert.equal(result.decision, "GRANTED");
});

// ---------------------------------------------------------------------------
// A9/A13 (Rev129): malformed/blank currentPrincipalRef fails closed
// ---------------------------------------------------------------------------

test("A9 (Rev129): an empty-string currentPrincipalRef fails closed even with an otherwise-valid same-tenant membership", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "",
    authority,
  });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.permissions.size, 0);
  assert.match(result.reasons[0] ?? "", /currentPrincipalRef/);
});

test("A9 (Rev129): a whitespace-only currentPrincipalRef fails closed", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "   ",
    authority,
  });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /currentPrincipalRef/);
});

test("A9 (Rev129): a currentPrincipalRef with leading/trailing whitespace fails closed, even though its trimmed form would match membership.principalRef exactly", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: ` ${membership.principalRef} `,
    authority,
  });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /currentPrincipalRef/);
});

test("A9 (Rev129, adversarial): a hand-built non-string currentPrincipalRef fails closed - the resolver does not coerce or trust the declared type alone", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: undefined as unknown as string,
    authority,
  });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /currentPrincipalRef/);
});

// ---------------------------------------------------------------------------
// A10: explainable context/reasons
// ---------------------------------------------------------------------------

test("A10: every resolution (granted, cross-tenant-denied, or same-tenant-wrong-principal-denied) carries explicit tenantId/organizationId provenance and a non-empty reasons list", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const granted = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
  });
  const missingMembershipDenied = resolveEffectiveOrganizationAccess({
    organization,
    currentPrincipalRef: PRINCIPAL_REF,
    authority,
  });
  const wrongPrincipalDenied = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "principal-someone-else",
    authority,
  });
  for (const result of [granted, missingMembershipDenied, wrongPrincipalDenied]) {
    assert.equal(result.tenantId, tenantScope.tenantId);
    assert.equal(result.organizationId, organization.organizationId);
    assert.ok(result.reasons.length > 0, "expected a non-empty reasons list");
    assert.equal(typeof result.reasons[0], "string");
  }
});

// ---------------------------------------------------------------------------
// A11: Organization Zero symmetry
// ---------------------------------------------------------------------------

test("A11: org_akilta and a controlled second organization resolve access through the identical public resolver, with no special branch", () => {
  const akiltaTenantScope = createTenantScope("tenant-akilta-os-v0-02");
  const controlledTenantScope = createTenantScope("tenant-controlled-os-v0-02");

  const orgAkilta = createOrganization({
    organizationId: "org_akilta",
    tenantScope: akiltaTenantScope,
    displayName: "AKILTA (Organization Zero)",
    createdAt: NOW,
  });
  const orgControlled = createOrganization({
    organizationId: "org-controlled-os-v0-02",
    tenantScope: controlledTenantScope,
    displayName: "Controlled Second Organization",
    createdAt: NOW,
  });

  const membershipAkilta = createOrganizationMembership({
    membershipId: "membership-akilta",
    tenantScope: akiltaTenantScope,
    principalRef: "principal-akilta",
    role: "STAFF",
  });
  const membershipControlled = createOrganizationMembership({
    membershipId: "membership-controlled",
    tenantScope: controlledTenantScope,
    principalRef: "principal-controlled",
    role: "STAFF",
  });

  const authorityAkilta = createAuthorityContext({
    tenantScope: akiltaTenantScope,
    permissions: ["READ", "WRITE"],
    canPerformProtectedActions: false,
  });
  const authorityControlled = createAuthorityContext({
    tenantScope: controlledTenantScope,
    permissions: ["READ", "WRITE"],
    canPerformProtectedActions: false,
  });

  const resultAkilta = resolveEffectiveOrganizationAccess({
    organization: orgAkilta,
    membership: membershipAkilta,
    currentPrincipalRef: membershipAkilta.principalRef,
    authority: authorityAkilta,
  });
  const resultControlled = resolveEffectiveOrganizationAccess({
    organization: orgControlled,
    membership: membershipControlled,
    currentPrincipalRef: membershipControlled.principalRef,
    authority: authorityControlled,
  });

  assert.equal(resultAkilta.decision, "GRANTED");
  assert.equal(resultControlled.decision, "GRANTED");
  assert.equal(resultAkilta.role, resultControlled.role);
  assert.deepEqual([...resultAkilta.permissions].sort(), [...resultControlled.permissions].sort());
});

// ---------------------------------------------------------------------------
// A12: deterministic replay
// ---------------------------------------------------------------------------

test("A12: identical inputs (including currentPrincipalRef and assignment evidence) produce a deep-equal GRANTED resolution", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject();
  const assignment = buildAssignment({ membership });
  const resultA = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
    assignments: [assignment],
  });
  const resultB = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
    assignments: [assignment],
  });
  assert.equal(resultA.decision, "GRANTED");
  assert.deepEqual(resultA, resultB);
});

test("B12: reordering irrelevant assignment evidence ahead of the matching one produces the identical deterministic GRANTED resolution", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject();
  const matching = buildAssignment({ membership });
  const irrelevant = buildAssignment({
    membership,
    customerId: "cust-os-v0-02-other",
    projectId: "proj-os-v0-02-other",
  });
  const resultOrderA = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
    assignments: [irrelevant, matching],
  });
  const resultOrderB = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
    project,
    assignments: [matching, irrelevant],
  });
  assert.equal(resultOrderA.decision, "GRANTED");
  assert.deepEqual(resultOrderA, resultOrderB);
});

test("A12 (Rev129): identical inputs with a wrong-principal currentPrincipalRef produce a deep-equal DENIED resolution on repeat calls - principal binding is deterministic, not just tenant correlation", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const resultA = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "principal-not-the-member",
    authority,
  });
  const resultB = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "principal-not-the-member",
    authority,
  });
  assert.deepEqual(resultA, resultB);
  assert.equal(resultA.decision, "DENIED");
});

// ---------------------------------------------------------------------------
// A13: malformed structural dependency records cannot bypass scope
// ---------------------------------------------------------------------------

test("A13 (adversarial): a hand-built membership object with a forged tenantId matching the organization cannot be used to smuggle a mismatched principal context - it is still evaluated purely on the tenantId field", () => {
  // The resolver has no way to detect a "forged" membership beyond its
  // structural tenantId - this test proves that field is exactly what
  // gates the decision (not, say, role), so a caller cannot bypass scope
  // by varying any field other than tenantId. currentPrincipalRef is
  // deliberately set to match the forged principalRef here, isolating
  // tenantId as the sole cause of denial (Rev129's own principal-binding
  // gate is exercised separately in the A9 (Rev129) tests above).
  const organization = buildOrganization();
  const authority = buildAuthority();
  const forgedMembership = {
    membershipId: "membership-forged",
    tenantId: otherTenantScope.tenantId,
    principalRef: "principal-forged",
    role: "STAFF",
  } as unknown as OrganizationMembership;
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership: forgedMembership,
    currentPrincipalRef: "principal-forged",
    authority,
  });
  assert.equal(result.decision, "DENIED");
});

test("A13 (adversarial): a hand-built AuthorityContext with an empty permissions set still resolves GRANTED with zero permissions - the resolver never substitutes an implicit default permission set", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const emptyAuthority = createAuthorityContext({
    tenantScope,
    permissions: [],
    canPerformProtectedActions: false,
  });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority: emptyAuthority,
  });
  assert.equal(result.decision, "GRANTED");
  assert.equal(result.permissions.size, 0);
});

// ---------------------------------------------------------------------------
// A14: boundary scan
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESOLVER_SOURCE_PATH = "src/domain/effective-organization-access.ts";

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "persistence/store", pattern: /\b(fs\.|node:fs|readFile|writeFile|Database|Repository)\b/ },
  { label: "network/HTTP/fetch", pattern: /\b(fetch\(|node:http|node:https|XMLHttpRequest)\b/ },
  { label: "provider/secret/credential", pattern: /\b(secret|credential|apiKey|password|token)\b/i },
  { label: "session/IdP", pattern: /\b(session|SessionContext|IdP)\b/ },
  { label: "Shopify/AI Commerce coupling", pattern: /\b(shopify|ai[-_]?commerce)\b/i },
  { label: "Date.now/randomness", pattern: /\b(Date\.now\(\)|Math\.random\(\)|new Date\(\))\b/ },
  { label: "mutable singleton/global registry", pattern: /\b(globalThis\.|global\.|let\s+\w+\s*:\s*Map)\b/ },
];

test("A14/boundary: effective-organization-access.ts contains no session/provider/store/network/persistence/AI-Commerce dependency, no Date.now/randomness, and no mutable singleton/global registry", () => {
  const content = readFileSync(join(REPO_ROOT, RESOLVER_SOURCE_PATH), "utf8");
  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    assert.equal(pattern.test(content), false, `found forbidden pattern "${label}" in ${RESOLVER_SOURCE_PATH}`);
  }
});

test("A14/boundary: effective-organization-access.ts imports only tenant-scope.ts/organization.ts/organization-membership.ts/authority.ts/project.ts - no ownership-assignment.ts/partner-organization.ts/customer.ts import", () => {
  const content = readFileSync(join(REPO_ROOT, RESOLVER_SOURCE_PATH), "utf8");
  // Matched against `from "..."` specifiers directly (not line-by-line
  // "starts with import") so a multi-line named-import statement (e.g.
  // Rev131's `import {\n  resolveAssignmentStatus,\n  ...\n} from "...";`)
  // is scanned correctly regardless of how it wraps.
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(importedModules.length > 0, "expected at least one import statement");
  const allowedModules = [
    "tenant-scope.js",
    "organization.js",
    "organization-membership.js",
    "authority.js",
    "project.js",
  ];
  for (const specifier of importedModules) {
    assert.ok(
      allowedModules.some((mod) => specifier?.includes(mod)),
      `unexpected import specifier: ${specifier}`,
    );
  }
  for (const forbidden of ["ownership-assignment.js", "partner-organization.js", "customer.js", "project-ownership.js"]) {
    assert.equal(content.includes(forbidden), false, `must not import "${forbidden}"`);
  }
});

// ---------------------------------------------------------------------------
// Rev131 Phase C: membership revocation/currentness floor (C7-C9, C15, C16)
// ---------------------------------------------------------------------------

test("C7: a revoked membership is DENIED even when tenant, currentPrincipalRef, AuthorityContext and exact Project assignment all otherwise match", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const revoked = revokeOrganizationMembership({
    membership,
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "offboarded",
  });
  const authority = buildAuthority();
  const project = buildProject();
  const assignment = buildAssignment({ membership });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership: revoked,
    currentPrincipalRef: revoked.principalRef,
    authority,
    project,
    assignments: [assignment],
  });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.permissions.size, 0);
  assert.equal(result.canPerformProtectedActions, false);
  assert.match(result.reasons[0] ?? "", /active, coherent membership/);
});

test("C7: a revoked membership is DENIED at the organization level (no Project) too", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const revoked = revokeOrganizationMembership({
    membership,
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "offboarded",
  });
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership: revoked,
    currentPrincipalRef: revoked.principalRef,
    authority,
  });
  assert.equal(result.decision, "DENIED");
});

test("C9 (adversarial): a revoked membership cannot be rescued by a matching Project.ownerRef, exact AssignmentReference, or canPerformProtectedActions:true", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const revoked = revokeOrganizationMembership({
    membership,
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "offboarded",
  });
  const authority = buildAuthority({ permissions: ["READ", "WRITE", "EXECUTE"], canPerformProtectedActions: true });
  const project = createProject({
    tenantScope,
    customer: createCustomer({ tenantScope, customerId: "cust-os-v0-02", displayName: "Reference Customer" }),
    projectId: "proj-os-v0-02",
    ownerRef: revoked.principalRef,
    state: "active",
  });
  const assignment = buildAssignment({ membership: revoked });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership: revoked,
    currentPrincipalRef: revoked.principalRef,
    authority,
    project,
    assignments: [assignment],
  });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.permissions.size, 0);
  assert.equal(result.canPerformProtectedActions, false);
});

test("C9 (adversarial): a hand-built membership incoherently claiming ACTIVE while already carrying revocation metadata is DENIED, not silently granted", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const forged = {
    ...membership,
    state: "ACTIVE",
    revokedAt: "2026-01-01T00:00:00.000Z",
    revokedReason: "stale",
  } as unknown as OrganizationMembership;
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership: forged,
    currentPrincipalRef: forged.principalRef,
    authority,
  });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /active, coherent membership/);
});

test("C15: repeated resolution against a revoked membership is deterministic (deep-equal DENIED on every call)", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const revoked = revokeOrganizationMembership({
    membership,
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "offboarded",
  });
  const authority = buildAuthority();
  const resultA = resolveEffectiveOrganizationAccess({
    organization,
    membership: revoked,
    currentPrincipalRef: revoked.principalRef,
    authority,
  });
  const resultB = resolveEffectiveOrganizationAccess({
    organization,
    membership: revoked,
    currentPrincipalRef: revoked.principalRef,
    authority,
  });
  assert.deepEqual(resultA, resultB);
  assert.equal(resultA.decision, "DENIED");
});

test("C16: an ACTIVE lifecycle state never widens permissions/protected-action eligibility beyond the exact AuthorityContext - active-vs-revoked only ever narrows, never grants", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: ["READ"], canPerformProtectedActions: false });
  const result = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
  });
  assert.equal(result.decision, "GRANTED");
  assert.deepEqual([...result.permissions], ["READ"]);
  assert.equal(result.canPerformProtectedActions, false);
});

// ---------------------------------------------------------------------------
// A15: dependency-delta check
// ---------------------------------------------------------------------------

test("A15: this task introduced only the one new domain module plus its own test/exec-plan - no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {}, "expected zero runtime dependencies");
});

// A16/A17 (relevant existing suites + final full regression) are proven by
// the repository-wide test run recorded in docs/exec-plans/active/OS-V0-02.md,
// not by a test in this file.

// Type-only reference so `EffectiveAccessResolution` stays exercised by the
// type checker even though no test asserts on its full shape directly.
const _typeCheck: EffectiveAccessResolution["decision"] = "GRANTED";
void _typeCheck;
