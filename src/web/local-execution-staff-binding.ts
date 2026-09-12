import type { StaffSessionContext } from "./staff-session-context.js";
import { requireCurrentStaffMembership } from "./staff-membership-guard.js";
import type { OrganizationMembership } from "../domain/organization-membership.js";
import type { TenantScope } from "../domain/tenant-scope.js";
import type { ProjectOwnershipRef } from "../domain/project-ownership.js";
import {
  registerDevice,
  createLocalWorkerRegistration,
  resolveEligibleLocalWorkers,
  type DeviceRegistration,
  type LocalWorkerRegistration,
  type ExecutionPolicy,
} from "../domain/local-execution.js";
import type { AdmittedWorker } from "../domain/worker-routing-policy.js";

/**
 * Rev98 §12/§21 `LOCAL-EXEC-004` (Phase L3). `local-execution.ts`'s own
 * doc comments record, verbatim, that its `ownerMembershipRef`/
 * `requestingOwnerMembershipRef` fields are "deliberately opaque
 * caller-supplied strings, never resolved against any real
 * authentication system, exactly matching this floor's own stated
 * dependency boundary" on Rev98 Family 2. Family 2 now exists
 * (`staff-session-context.ts`/`staff-membership-guard.ts`): this module
 * is the composition point Rev99/Rev102 named - it never redefines or
 * modifies `local-execution.ts`, `staff-membership-guard.ts`, or
 * `organization-membership.ts`, it only binds them together so a device/
 * worker/eligibility call can no longer be made with a bare,
 * unauthenticated `ownerMembershipRef` string.
 *
 * Every function here follows the same shape: resolve the caller's
 * authenticated `StaffSessionContext` to a real, current, tenant-scoped
 * `OrganizationMembership` via `requireCurrentStaffMembership` (fails
 * closed, never guesses), then call the corresponding unmodified
 * `local-execution.ts` function with that membership's own
 * `membershipId` as the trusted `ownerMembershipRef` - never a value the
 * caller supplied directly for that field. `local-execution.ts`'s own
 * Rev101 F1 guard (a worker's `ownerMembershipRef` must match its
 * device's) still applies underneath and is not weakened or bypassed by
 * this binding layer.
 */

export function registerDeviceForAuthenticatedStaff(input: {
  session: StaffSessionContext;
  tenantScope: TenantScope;
  memberships: ReadonlyArray<OrganizationMembership>;
  deviceId: unknown;
  publicKeyFingerprint: unknown;
  platform: unknown;
  bridgeVersion: unknown;
}): DeviceRegistration {
  const membership = requireCurrentStaffMembership({
    session: input.session,
    tenantId: input.tenantScope.tenantId,
    memberships: input.memberships,
  });
  return registerDevice({
    tenantScope: input.tenantScope,
    deviceId: input.deviceId,
    ownerMembershipRef: membership.membershipId,
    publicKeyFingerprint: input.publicKeyFingerprint,
    platform: input.platform,
    bridgeVersion: input.bridgeVersion,
  });
}

export function createLocalWorkerRegistrationForAuthenticatedStaff(input: {
  session: StaffSessionContext;
  tenantScope: TenantScope;
  memberships: ReadonlyArray<OrganizationMembership>;
  workerId: unknown;
  device: DeviceRegistration;
  adapterKind: unknown;
  declaredCapabilityRefs: ReadonlyArray<unknown>;
  declaredToolRefs: ReadonlyArray<unknown>;
  declaredPolicyConstraintRefs: ReadonlyArray<unknown>;
  trustStatus: unknown;
  availability: unknown;
  maxRiskLevel: unknown;
  authorityLevel: unknown;
  costWeight: unknown;
  evaluationEvidenceRef: unknown;
  poolMode: unknown;
  boundProjectOwnerships: ReadonlyArray<ProjectOwnershipRef>;
}): LocalWorkerRegistration {
  const membership = requireCurrentStaffMembership({
    session: input.session,
    tenantId: input.tenantScope.tenantId,
    memberships: input.memberships,
  });
  return createLocalWorkerRegistration({
    workerId: input.workerId,
    device: input.device,
    ownerMembershipRef: membership.membershipId,
    adapterKind: input.adapterKind,
    declaredCapabilityRefs: input.declaredCapabilityRefs,
    declaredToolRefs: input.declaredToolRefs,
    declaredPolicyConstraintRefs: input.declaredPolicyConstraintRefs,
    trustStatus: input.trustStatus,
    availability: input.availability,
    maxRiskLevel: input.maxRiskLevel,
    authorityLevel: input.authorityLevel,
    costWeight: input.costWeight,
    evaluationEvidenceRef: input.evaluationEvidenceRef,
    poolMode: input.poolMode,
    boundProjectOwnerships: input.boundProjectOwnerships,
  });
}

export function resolveEligibleLocalWorkersForAuthenticatedStaff(input: {
  session: StaffSessionContext;
  tenantScope: TenantScope;
  memberships: ReadonlyArray<OrganizationMembership>;
  executionPolicy: ExecutionPolicy;
  registrations: ReadonlyArray<LocalWorkerRegistration>;
  targetOwnership: ProjectOwnershipRef;
}): ReadonlyArray<AdmittedWorker> {
  const membership = requireCurrentStaffMembership({
    session: input.session,
    tenantId: input.tenantScope.tenantId,
    memberships: input.memberships,
  });
  return resolveEligibleLocalWorkers({
    executionPolicy: input.executionPolicy,
    registrations: input.registrations,
    requestingTenantId: input.tenantScope.tenantId,
    targetOwnership: input.targetOwnership,
    requestingOwnerMembershipRef: membership.membershipId,
  });
}
