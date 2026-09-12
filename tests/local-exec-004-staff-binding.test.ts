import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerDeviceForAuthenticatedStaff,
  createLocalWorkerRegistrationForAuthenticatedStaff,
  resolveEligibleLocalWorkersForAuthenticatedStaff,
} from "../src/web/local-execution-staff-binding.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { NoStaffMembershipError, AmbiguousStaffMembershipError } from "../src/web/staff-membership-guard.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createExecutionPolicy, InvalidLocalExecutionError } from "../src/domain/local-execution.js";

const tenantScope = createTenantScope("tenant-a");
const otherTenantScope = createTenantScope("tenant-b");
const targetOwnership = createProjectOwnershipRef({
  tenantId: tenantScope.tenantId,
  customerId: "cust-1",
  projectId: "proj-1",
});

function staffSession(principalId = "staff-1"): StaffSessionContext {
  return {
    principal: createAuthenticatedStaffPrincipal({ principalId, displayName: "Ada Staffer" }),
    issuedAt: "2026-01-01T00:00:00.000Z",
  };
}

function membership(overrides: Partial<Parameters<typeof createOrganizationMembership>[0]> = {}): OrganizationMembership {
  return createOrganizationMembership({
    membershipId: "membership-1",
    tenantScope,
    principalRef: "staff-1",
    role: "STAFF",
    ...overrides,
  });
}

// --- registerDeviceForAuthenticatedStaff ---

test("L4-1: registerDeviceForAuthenticatedStaff binds the device to the resolved membership's membershipId, never a caller-supplied string", () => {
  const device = registerDeviceForAuthenticatedStaff({
    session: staffSession(),
    tenantScope,
    memberships: [membership()],
    deviceId: "device-1",
    publicKeyFingerprint: "fp-1",
    platform: "macos",
    bridgeVersion: "1.0.0",
  });
  assert.equal(device.ownerMembershipRef, "membership-1");
  assert.equal(device.status, "PENDING");
});

test("L4-2 (adversarial): registerDeviceForAuthenticatedStaff throws NoStaffMembershipError - never registers a device - when the session has no membership in this tenant", () => {
  assert.throws(
    () =>
      registerDeviceForAuthenticatedStaff({
        session: staffSession("staff-unknown"),
        tenantScope,
        memberships: [membership()],
        deviceId: "device-1",
        publicKeyFingerprint: "fp-1",
        platform: "macos",
        bridgeVersion: "1.0.0",
      }),
    NoStaffMembershipError,
  );
});

test("L4-3 (adversarial cross-tenant): registerDeviceForAuthenticatedStaff never accepts a same-principalRef membership from a different tenant", () => {
  assert.throws(
    () =>
      registerDeviceForAuthenticatedStaff({
        session: staffSession("staff-1"),
        tenantScope: otherTenantScope,
        memberships: [membership()],
        deviceId: "device-1",
        publicKeyFingerprint: "fp-1",
        platform: "macos",
        bridgeVersion: "1.0.0",
      }),
    NoStaffMembershipError,
  );
});

test("L4-4 (adversarial ambiguity): registerDeviceForAuthenticatedStaff throws AmbiguousStaffMembershipError rather than guessing which membership to trust", () => {
  assert.throws(
    () =>
      registerDeviceForAuthenticatedStaff({
        session: staffSession("staff-1"),
        tenantScope,
        memberships: [
          membership({ membershipId: "membership-1" }),
          membership({ membershipId: "membership-2" }),
        ],
        deviceId: "device-1",
        publicKeyFingerprint: "fp-1",
        platform: "macos",
        bridgeVersion: "1.0.0",
      }),
    AmbiguousStaffMembershipError,
  );
});

// --- createLocalWorkerRegistrationForAuthenticatedStaff ---

function baseWorkerFields() {
  return {
    workerId: "worker-1",
    adapterKind: "codex",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 0,
    evaluationEvidenceRef: "evidence:worker-eval-1",
    poolMode: "PRIVATE",
    boundProjectOwnerships: [],
  } as const;
}

test("L4-5: createLocalWorkerRegistrationForAuthenticatedStaff binds the worker's ownerMembershipRef to the resolved membership, matching its device's own owner", () => {
  const device = registerDeviceForAuthenticatedStaff({
    session: staffSession(),
    tenantScope,
    memberships: [membership()],
    deviceId: "device-1",
    publicKeyFingerprint: "fp-1",
    platform: "macos",
    bridgeVersion: "1.0.0",
  });
  const registration = createLocalWorkerRegistrationForAuthenticatedStaff({
    session: staffSession(),
    tenantScope,
    memberships: [membership()],
    device,
    ...baseWorkerFields(),
  });
  assert.equal(registration.ownerMembershipRef, "membership-1");
  assert.equal(registration.deviceId, device.deviceId);
});

test("L4-6 (adversarial): createLocalWorkerRegistrationForAuthenticatedStaff throws NoStaffMembershipError before ever calling the underlying local-execution.ts constructor when unbound", () => {
  const device = registerDeviceForAuthenticatedStaff({
    session: staffSession(),
    tenantScope,
    memberships: [membership()],
    deviceId: "device-1",
    publicKeyFingerprint: "fp-1",
    platform: "macos",
    bridgeVersion: "1.0.0",
  });
  assert.throws(
    () =>
      createLocalWorkerRegistrationForAuthenticatedStaff({
        session: staffSession("staff-unknown"),
        tenantScope,
        memberships: [membership()],
        device,
        ...baseWorkerFields(),
      }),
    NoStaffMembershipError,
  );
});

test("L4-7 (adversarial, underlying Rev101 F1 guard still applies): a staff member whose resolved membership differs from the device's own enrolled owner still fails closed via local-execution.ts's own ownership-mismatch guard", () => {
  const device = registerDeviceForAuthenticatedStaff({
    session: staffSession("staff-1"),
    tenantScope,
    memberships: [membership({ membershipId: "membership-1", principalRef: "staff-1" })],
    deviceId: "device-1",
    publicKeyFingerprint: "fp-1",
    platform: "macos",
    bridgeVersion: "1.0.0",
  });
  // A different, still-authenticated staff member (a different, distinct
  // membership) tries to register a worker against device-1, which is
  // enrolled under membership-1, not membership-2.
  assert.throws(
    () =>
      createLocalWorkerRegistrationForAuthenticatedStaff({
        session: staffSession("staff-2"),
        tenantScope,
        memberships: [membership({ membershipId: "membership-2", principalRef: "staff-2" })],
        device,
        ...baseWorkerFields(),
      }),
    InvalidLocalExecutionError,
  );
});

// --- resolveEligibleLocalWorkersForAuthenticatedStaff ---

test("L4-8: resolveEligibleLocalWorkersForAuthenticatedStaff derives requestingOwnerMembershipRef from the authenticated session, admitting only that staff member's own PRIVATE worker", () => {
  const device = registerDeviceForAuthenticatedStaff({
    session: staffSession(),
    tenantScope,
    memberships: [membership()],
    deviceId: "device-1",
    publicKeyFingerprint: "fp-1",
    platform: "macos",
    bridgeVersion: "1.0.0",
  });
  const registration = createLocalWorkerRegistrationForAuthenticatedStaff({
    session: staffSession(),
    tenantScope,
    memberships: [membership()],
    device,
    ...baseWorkerFields(),
  });
  const executionPolicy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkersForAuthenticatedStaff({
    session: staffSession(),
    tenantScope,
    memberships: [membership()],
    executionPolicy,
    registrations: [registration],
    targetOwnership,
  });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]?.workerId, "worker-1");
});

test("L4-9 (adversarial employee isolation): resolveEligibleLocalWorkersForAuthenticatedStaff never admits another staff member's PRIVATE worker, even in the same tenant", () => {
  const device = registerDeviceForAuthenticatedStaff({
    session: staffSession("staff-1"),
    tenantScope,
    memberships: [membership({ membershipId: "membership-1", principalRef: "staff-1" })],
    deviceId: "device-1",
    publicKeyFingerprint: "fp-1",
    platform: "macos",
    bridgeVersion: "1.0.0",
  });
  const registration = createLocalWorkerRegistrationForAuthenticatedStaff({
    session: staffSession("staff-1"),
    tenantScope,
    memberships: [membership({ membershipId: "membership-1", principalRef: "staff-1" })],
    device,
    ...baseWorkerFields(),
  });
  const executionPolicy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkersForAuthenticatedStaff({
    session: staffSession("staff-2"),
    tenantScope,
    memberships: [membership({ membershipId: "membership-2", principalRef: "staff-2" })],
    executionPolicy,
    registrations: [registration],
    targetOwnership,
  });
  assert.equal(eligible.length, 0);
});

test("L4-10 (adversarial): resolveEligibleLocalWorkersForAuthenticatedStaff throws NoStaffMembershipError rather than silently resolving zero eligible workers when the requester itself has no membership", () => {
  const executionPolicy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  assert.throws(
    () =>
      resolveEligibleLocalWorkersForAuthenticatedStaff({
        session: staffSession("staff-unknown"),
        tenantScope,
        memberships: [membership()],
        executionPolicy,
        registrations: [],
        targetOwnership,
      }),
    NoStaffMembershipError,
  );
});
