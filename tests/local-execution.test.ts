import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { resolveWorkerRoute } from "../src/domain/worker-routing-policy.js";
import {
  createExecutionPolicy,
  registerDevice,
  markDeviceOnline,
  markDeviceOffline,
  revokeDevice,
  quarantineDevice,
  createDeviceCapabilitySnapshot,
  createDevicePolicy,
  engageKillSwitch,
  isWorkspaceRootAllowed,
  createLocalWorkerRegistration,
  toAdmittedWorker,
  resolveEligibleLocalWorkers,
  createLocalTaskLease,
  transitionLocalTaskLease,
  createLocalTaskCheckpoint,
  InvalidLocalExecutionError,
  InvalidDeviceTransitionError,
  InvalidLocalTaskLeaseTransitionError,
  type LocalWorkerRegistration,
  type DeviceRegistration,
} from "../src/domain/local-execution.js";

const tenantScope = createTenantScope("tenant-local-1");
const otherTenantScope = createTenantScope("tenant-local-other");
const targetOwnership = createProjectOwnershipRef({
  tenantId: "tenant-local-1",
  customerId: "customer-1",
  projectId: "project-1",
});
const otherProjectOwnership = createProjectOwnershipRef({
  tenantId: "tenant-local-1",
  customerId: "customer-1",
  projectId: "project-other",
});

function onlineDevice(seed: string, ownerMembershipRef = "owner-1", scope = tenantScope): DeviceRegistration {
  const device = registerDevice({
    tenantScope: scope,
    deviceId: `device-${seed}`,
    ownerMembershipRef,
    publicKeyFingerprint: `fingerprint-${seed}`,
    platform: "linux",
    bridgeVersion: "0.1.0",
  });
  return markDeviceOnline(device);
}

function makeWorker(
  seed: string,
  device: DeviceRegistration,
  overrides?: Partial<{
    poolMode: "PRIVATE" | "ORG_POOL";
    boundProjectOwnerships: ReadonlyArray<ReturnType<typeof createProjectOwnershipRef>>;
    availability: "AVAILABLE" | "UNAVAILABLE" | "DEGRADED";
    ownerMembershipRef: string;
  }>,
): LocalWorkerRegistration {
  return createLocalWorkerRegistration({
    workerId: `worker-${seed}`,
    device,
    ownerMembershipRef: overrides?.ownerMembershipRef ?? device.ownerMembershipRef,
    adapterKind: "CODEX_LOCAL",
    declaredCapabilityRefs: ["cap:code-edit"],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: overrides?.availability ?? "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: `evidence-${seed}`,
    poolMode: overrides?.poolMode ?? "PRIVATE",
    boundProjectOwnerships: overrides?.boundProjectOwnerships ?? [],
  });
}

// --- ExecutionPolicy ---

test("L1: createExecutionPolicy defaults to CLOUD_NORMAL/PRIVATE (Local default OFF)", () => {
  const policy = createExecutionPolicy({ tenantScope });
  assert.equal(policy.executionMode, "CLOUD_NORMAL");
  assert.equal(policy.collaborationMode, "PRIVATE");
});

test("L2: createExecutionPolicy accepts explicit modes independently", () => {
  const policy = createExecutionPolicy({
    tenantScope,
    executionMode: "TEAM_LOCAL",
    collaborationMode: "SHARED_REPO",
  });
  assert.equal(policy.executionMode, "TEAM_LOCAL");
  assert.equal(policy.collaborationMode, "SHARED_REPO");
});

test("L3: createExecutionPolicy rejects an unrecognized executionMode", () => {
  assert.throws(
    () => createExecutionPolicy({ tenantScope, executionMode: "QUANTUM_LOCAL" }),
    InvalidLocalExecutionError,
  );
});

test("L4: createExecutionPolicy rejects an unrecognized collaborationMode", () => {
  assert.throws(
    () => createExecutionPolicy({ tenantScope, collaborationMode: "TELEPATHIC" }),
    InvalidLocalExecutionError,
  );
});

// --- Device lifecycle ---

test("L5: registerDevice always starts PENDING, never born trusted", () => {
  const device = registerDevice({
    tenantScope,
    deviceId: "device-5",
    ownerMembershipRef: "owner-1",
    publicKeyFingerprint: "fp-5",
    platform: "macos",
    bridgeVersion: "0.1.0",
  });
  assert.equal(device.status, "PENDING");
});

test("L6: markDeviceOnline transitions PENDING -> ONLINE", () => {
  const device = registerDevice({
    tenantScope,
    deviceId: "device-6",
    ownerMembershipRef: "owner-1",
    publicKeyFingerprint: "fp-6",
    platform: "linux",
    bridgeVersion: "0.1.0",
  });
  assert.equal(markDeviceOnline(device).status, "ONLINE");
});

test("L7: markDeviceOnline rejects a QUARANTINED device (cannot self-clear quarantine)", () => {
  const device = quarantineDevice(onlineDevice("7"));
  assert.throws(() => markDeviceOnline(device), InvalidDeviceTransitionError);
});

test("L8 (§22 case G): REVOKED is terminal - no further transition is ever permitted", () => {
  const device = revokeDevice(onlineDevice("8"));
  assert.throws(() => markDeviceOnline(device), InvalidDeviceTransitionError);
  assert.throws(() => markDeviceOffline(device), InvalidDeviceTransitionError);
  assert.throws(() => quarantineDevice(device), InvalidDeviceTransitionError);
});

test("L9: markDeviceOffline works from ONLINE", () => {
  const device = onlineDevice("9");
  assert.equal(markDeviceOffline(device).status, "OFFLINE");
});

test("L10: revokeDevice is always permitted, even from QUARANTINED", () => {
  const device = quarantineDevice(onlineDevice("10"));
  assert.equal(revokeDevice(device).status, "REVOKED");
});

// --- DeviceCapabilitySnapshot / DevicePolicy ---

test("L11: createDeviceCapabilitySnapshot rejects an unrecognized readiness value", () => {
  const device = onlineDevice("11");
  assert.throws(
    () =>
      createDeviceCapabilitySnapshot({
        device,
        adapterKind: "CODEX_LOCAL",
        readiness: "SUPER_READY",
        capturedAt: "2026-09-11T00:00:00.000Z",
        evidenceRef: "evidence:x",
      }),
    InvalidLocalExecutionError,
  );
});

test("L12: createDeviceCapabilitySnapshot happy path", () => {
  const device = onlineDevice("12");
  const snapshot = createDeviceCapabilitySnapshot({
    device,
    adapterKind: "CODEX_LOCAL",
    readiness: "AVAILABLE",
    capturedAt: "2026-09-11T00:00:00.000Z",
    evidenceRef: "evidence:x",
  });
  assert.equal(snapshot.readiness, "AVAILABLE");
  assert.equal(snapshot.deviceId, device.deviceId);
});

test("L13: createDevicePolicy rejects an invalid maxRiskLevel", () => {
  const device = onlineDevice("13");
  assert.throws(
    () => createDevicePolicy({ device, allowedWorkspaceRootRefs: ["/repo"], maxRiskLevel: "EXTREME" }),
    InvalidLocalExecutionError,
  );
});

test("L14: isWorkspaceRootAllowed is true for an explicitly allowed root", () => {
  const device = onlineDevice("14");
  const policy = createDevicePolicy({
    device,
    allowedWorkspaceRootRefs: ["/repo/akilta"],
    maxRiskLevel: "STANDARD",
  });
  assert.equal(isWorkspaceRootAllowed(policy, "/repo/akilta"), true);
});

test("L15 (§22 case J): isWorkspaceRootAllowed is false for an unauthorized root", () => {
  const device = onlineDevice("15");
  const policy = createDevicePolicy({
    device,
    allowedWorkspaceRootRefs: ["/repo/akilta"],
    maxRiskLevel: "STANDARD",
  });
  assert.equal(isWorkspaceRootAllowed(policy, "/"), false);
  assert.equal(isWorkspaceRootAllowed(policy, "C:\\Users\\jay"), false);
});

test("L16: isWorkspaceRootAllowed is false once the kill switch is engaged, even for an otherwise-allowed root", () => {
  const device = onlineDevice("16");
  const policy = engageKillSwitch(
    createDevicePolicy({ device, allowedWorkspaceRootRefs: ["/repo/akilta"], maxRiskLevel: "STANDARD" }),
  );
  assert.equal(isWorkspaceRootAllowed(policy, "/repo/akilta"), false);
});

// --- LocalWorkerRegistration / toAdmittedWorker ---

test("L17: createLocalWorkerRegistration rejects an invalid poolMode", () => {
  const device = onlineDevice("17");
  assert.throws(
    () =>
      createLocalWorkerRegistration({
        workerId: "worker-17",
        device,
        ownerMembershipRef: "owner-1",
        adapterKind: "CODEX_LOCAL",
        declaredCapabilityRefs: [],
        declaredToolRefs: [],
        declaredPolicyConstraintRefs: [],
        trustStatus: "ADMITTED",
        availability: "AVAILABLE",
        maxRiskLevel: "STANDARD",
        authorityLevel: "STANDARD",
        costWeight: 1,
        evaluationEvidenceRef: "evidence:x",
        poolMode: "SHARED",
        boundProjectOwnerships: [],
      }),
    InvalidLocalExecutionError,
  );
});

test("L18: createLocalWorkerRegistration rejects a non-finite costWeight", () => {
  const device = onlineDevice("18");
  assert.throws(
    () =>
      createLocalWorkerRegistration({
        workerId: "worker-18",
        device,
        ownerMembershipRef: "owner-1",
        adapterKind: "CODEX_LOCAL",
        declaredCapabilityRefs: [],
        declaredToolRefs: [],
        declaredPolicyConstraintRefs: [],
        trustStatus: "ADMITTED",
        availability: "AVAILABLE",
        maxRiskLevel: "STANDARD",
        authorityLevel: "STANDARD",
        costWeight: Number.NaN,
        evaluationEvidenceRef: "evidence:x",
        poolMode: "PRIVATE",
        boundProjectOwnerships: [],
      }),
    InvalidLocalExecutionError,
  );
});

test("L19: createLocalWorkerRegistration rejects a non-array boundProjectOwnerships", () => {
  const device = onlineDevice("19");
  assert.throws(
    () =>
      createLocalWorkerRegistration({
        workerId: "worker-19",
        device,
        ownerMembershipRef: "owner-1",
        adapterKind: "CODEX_LOCAL",
        declaredCapabilityRefs: [],
        declaredToolRefs: [],
        declaredPolicyConstraintRefs: [],
        trustStatus: "ADMITTED",
        availability: "AVAILABLE",
        maxRiskLevel: "STANDARD",
        authorityLevel: "STANDARD",
        costWeight: 1,
        evaluationEvidenceRef: "evidence:x",
        poolMode: "PRIVATE",
        boundProjectOwnerships: "not-an-array" as unknown as [],
      }),
    InvalidLocalExecutionError,
  );
});

test("L20: toAdmittedWorker projects exactly the fields resolveWorkerRoute needs, nothing local-specific leaks in", () => {
  const worker = makeWorker("20", onlineDevice("20"));
  const admitted = toAdmittedWorker(worker);
  assert.deepEqual(Object.keys(admitted).sort(), [
    "authorityLevel",
    "availability",
    "costWeight",
    "declaredCapabilityRefs",
    "declaredPolicyConstraintRefs",
    "declaredToolRefs",
    "evaluationEvidenceRef",
    "maxRiskLevel",
    "trustStatus",
    "workerId",
  ]);
  assert.equal(admitted.workerId, worker.workerId);
});

// --- resolveEligibleLocalWorkers (mandatory acceptance cases B/C/D/E) ---

test("L21 (§22 case B, Local OFF): CLOUD_NORMAL excludes every local worker unconditionally", () => {
  const device = onlineDevice("21");
  const worker = makeWorker("21", device);
  const policy = createExecutionPolicy({ tenantScope, executionMode: "CLOUD_NORMAL" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [worker],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: device.ownerMembershipRef,
  });
  assert.deepEqual(eligible, []);
});

test("L22: PERSONAL_LOCAL admits the requester's own PRIVATE worker", () => {
  const device = onlineDevice("22", "owner-22");
  const worker = makeWorker("22", device, { poolMode: "PRIVATE" });
  const policy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [worker],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "owner-22",
  });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]?.workerId, worker.workerId);
});

test("L23 (§22 case C, employee isolation): PERSONAL_LOCAL excludes another owner's PRIVATE worker", () => {
  const device = onlineDevice("23", "owner-employee-a");
  const worker = makeWorker("23", device, { poolMode: "PRIVATE", ownerMembershipRef: "owner-employee-a" });
  const policy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [worker],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "owner-employee-b",
  });
  assert.deepEqual(eligible, []);
});

test("L24: PERSONAL_LOCAL excludes ORG_POOL workers entirely, even ones bound to the target project", () => {
  const device = onlineDevice("24", "owner-24");
  const worker = makeWorker("24", device, { poolMode: "ORG_POOL", boundProjectOwnerships: [targetOwnership] });
  const policy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [worker],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "owner-24",
  });
  assert.deepEqual(eligible, []);
});

test("L25 (§22 case E, shared project opt-in): TEAM_LOCAL admits an ORG_POOL worker bound to the target project", () => {
  const device = onlineDevice("25", "owner-25");
  const worker = makeWorker("25", device, { poolMode: "ORG_POOL", boundProjectOwnerships: [targetOwnership] });
  const policy = createExecutionPolicy({ tenantScope, executionMode: "TEAM_LOCAL" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [worker],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "requester-25",
  });
  assert.equal(eligible.length, 1);
});

test("L26 (§22 case D, independent projects): TEAM_LOCAL excludes an ORG_POOL worker NOT bound to the target project", () => {
  const device = onlineDevice("26", "owner-26");
  const worker = makeWorker("26", device, { poolMode: "ORG_POOL", boundProjectOwnerships: [otherProjectOwnership] });
  const policy = createExecutionPolicy({ tenantScope, executionMode: "TEAM_LOCAL" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [worker],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "requester-26",
  });
  assert.deepEqual(eligible, []);
});

test("L27: HYBRID admits both the requester's own PRIVATE worker and a bound ORG_POOL worker", () => {
  const deviceA = onlineDevice("27a", "owner-27");
  const privateWorker = makeWorker("27a", deviceA, { poolMode: "PRIVATE" });
  const deviceB = onlineDevice("27b", "owner-other-27");
  const orgWorker = makeWorker("27b", deviceB, { poolMode: "ORG_POOL", boundProjectOwnerships: [targetOwnership] });
  const policy = createExecutionPolicy({ tenantScope, executionMode: "HYBRID" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [privateWorker, orgWorker],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "owner-27",
  });
  assert.equal(eligible.length, 2);
});

test("L28 (§22 case J, cross-tenant device/worker substitution): a worker registered under a different tenant is never eligible, regardless of pool/ownership match", () => {
  const foreignDevice = onlineDevice("28", "owner-28", otherTenantScope);
  const foreignWorker = makeWorker("28", foreignDevice, { poolMode: "PRIVATE", ownerMembershipRef: "owner-28" });
  const policy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [foreignWorker],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "owner-28",
  });
  assert.deepEqual(eligible, []);
});

test("L29: a mismatched executionPolicy.tenantId vs requestingTenantId excludes all local workers (defense in depth)", () => {
  const device = onlineDevice("29", "owner-29");
  const worker = makeWorker("29", device, { poolMode: "PRIVATE" });
  const policy = createExecutionPolicy({ tenantScope: otherTenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [worker],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "owner-29",
  });
  assert.deepEqual(eligible, []);
});

// --- Composition proof: no second router ---

test("L30 (§2/§15 'do not build a second router'): a resolved local candidate routes successfully through the existing, unmodified resolveWorkerRoute", () => {
  const device = onlineDevice("30", "owner-30");
  const worker = makeWorker("30", device, { poolMode: "PRIVATE" });
  const policy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [worker],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "owner-30",
  });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef: "cap:code-edit",
    riskLevel: "STANDARD",
    requiredToolRefs: [],
    requiredPolicyConstraintRefs: [],
    requiredAuthorityLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: eligible,
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, worker.workerId);
});

test("L31 (§22 case F, failover): a DEGRADED primary is skipped and an equally-authorized AVAILABLE fallback is selected, with no authority relaxation", () => {
  const primaryDevice = onlineDevice("31a", "owner-31");
  const primary = makeWorker("31a", primaryDevice, { poolMode: "PRIVATE", availability: "DEGRADED" });
  const fallbackDevice = onlineDevice("31b", "owner-31");
  const fallback = makeWorker("31b", fallbackDevice, { poolMode: "PRIVATE", availability: "AVAILABLE" });
  const policy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: policy,
    registrations: [primary, fallback],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "owner-31",
  });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef: "cap:code-edit",
    riskLevel: "STANDARD",
    requiredToolRefs: [],
    requiredPolicyConstraintRefs: [],
    requiredAuthorityLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: eligible,
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, fallback.workerId);
});

// --- LocalTaskLease ---

test("L32 (§22 case G): createLocalTaskLease fails closed against a non-ONLINE device", () => {
  const device = registerDevice({
    tenantScope,
    deviceId: "device-32",
    ownerMembershipRef: "owner-32",
    publicKeyFingerprint: "fp-32",
    platform: "linux",
    bridgeVersion: "0.1.0",
  });
  const worker = makeWorker("32", markDeviceOnline(device));
  assert.throws(
    () => createLocalTaskLease({ leaseId: "lease-32", taskRef: "task-32", worker, device }),
    InvalidLocalExecutionError,
  );
});

test("L33 (§22 case J, adversarial device substitution): createLocalTaskLease rejects a worker whose deviceId does not match the given device", () => {
  const deviceA = onlineDevice("33a");
  const deviceB = onlineDevice("33b");
  const worker = makeWorker("33a", deviceA);
  assert.throws(
    () => createLocalTaskLease({ leaseId: "lease-33", taskRef: "task-33", worker, device: deviceB }),
    InvalidLocalExecutionError,
  );
});

test("L34: createLocalTaskLease succeeds against an ONLINE device, starting QUEUED", () => {
  const device = onlineDevice("34");
  const worker = makeWorker("34", device);
  const lease = createLocalTaskLease({ leaseId: "lease-34", taskRef: "task-34", worker, device });
  assert.equal(lease.status, "QUEUED");
});

test("L35: a valid QUEUED -> LEASED -> RUNNING -> SUCCEEDED chain is permitted", () => {
  const device = onlineDevice("35");
  const worker = makeWorker("35", device);
  let lease = createLocalTaskLease({ leaseId: "lease-35", taskRef: "task-35", worker, device });
  lease = transitionLocalTaskLease({ lease, to: "LEASED" });
  lease = transitionLocalTaskLease({ lease, to: "RUNNING" });
  lease = transitionLocalTaskLease({ lease, to: "SUCCEEDED" });
  assert.equal(lease.status, "SUCCEEDED");
});

test("L36: an invalid direct jump QUEUED -> SUCCEEDED is rejected", () => {
  const device = onlineDevice("36");
  const worker = makeWorker("36", device);
  const lease = createLocalTaskLease({ leaseId: "lease-36", taskRef: "task-36", worker, device });
  assert.throws(
    () => transitionLocalTaskLease({ lease, to: "SUCCEEDED" }),
    InvalidLocalTaskLeaseTransitionError,
  );
});

test("L37: no transition is ever permitted out of a terminal SUCCEEDED lease", () => {
  const device = onlineDevice("37");
  const worker = makeWorker("37", device);
  let lease = createLocalTaskLease({ leaseId: "lease-37", taskRef: "task-37", worker, device });
  lease = transitionLocalTaskLease({ lease, to: "LEASED" });
  lease = transitionLocalTaskLease({ lease, to: "RUNNING" });
  lease = transitionLocalTaskLease({ lease, to: "SUCCEEDED" });
  assert.throws(
    () => transitionLocalTaskLease({ lease, to: "RUNNING" }),
    InvalidLocalTaskLeaseTransitionError,
  );
});

test("L38: transitioning to CHECKPOINTED requires a non-empty workspaceCheckpointRef", () => {
  const device = onlineDevice("38");
  const worker = makeWorker("38", device);
  let lease = createLocalTaskLease({ leaseId: "lease-38", taskRef: "task-38", worker, device });
  lease = transitionLocalTaskLease({ lease, to: "LEASED" });
  lease = transitionLocalTaskLease({ lease, to: "RUNNING" });
  assert.throws(
    () => transitionLocalTaskLease({ lease, to: "CHECKPOINTED" }),
    InvalidLocalExecutionError,
  );
  const checkpointed = transitionLocalTaskLease({
    lease,
    to: "CHECKPOINTED",
    workspaceCheckpointRef: "checkpoint:abc123",
  });
  assert.equal(checkpointed.workspaceCheckpointRef, "checkpoint:abc123");
});

test("L39: RUNNING -> BLOCKED -> RUNNING (recovery) -> FAILED is a valid sequence", () => {
  const device = onlineDevice("39");
  const worker = makeWorker("39", device);
  let lease = createLocalTaskLease({ leaseId: "lease-39", taskRef: "task-39", worker, device });
  lease = transitionLocalTaskLease({ lease, to: "LEASED" });
  lease = transitionLocalTaskLease({ lease, to: "RUNNING" });
  lease = transitionLocalTaskLease({ lease, to: "BLOCKED" });
  lease = transitionLocalTaskLease({ lease, to: "RUNNING" });
  lease = transitionLocalTaskLease({ lease, to: "FAILED" });
  assert.equal(lease.status, "FAILED");
});

test("L40: createLocalTaskCheckpoint fails closed for a QUEUED (not-yet-started) lease", () => {
  const device = onlineDevice("40");
  const worker = makeWorker("40", device);
  const lease = createLocalTaskLease({ leaseId: "lease-40", taskRef: "task-40", worker, device });
  assert.throws(
    () =>
      createLocalTaskCheckpoint({
        lease,
        checkpointRef: "checkpoint:x",
        capturedAt: "2026-09-11T00:00:00.000Z",
        evidenceRef: "evidence:x",
      }),
    InvalidLocalExecutionError,
  );
});

test("L41: createLocalTaskCheckpoint succeeds for a RUNNING lease", () => {
  const device = onlineDevice("41");
  const worker = makeWorker("41", device);
  let lease = createLocalTaskLease({ leaseId: "lease-41", taskRef: "task-41", worker, device });
  lease = transitionLocalTaskLease({ lease, to: "LEASED" });
  lease = transitionLocalTaskLease({ lease, to: "RUNNING" });
  const checkpoint = createLocalTaskCheckpoint({
    lease,
    checkpointRef: "checkpoint:x",
    capturedAt: "2026-09-11T00:00:00.000Z",
    evidenceRef: "evidence:x",
  });
  assert.equal(checkpoint.leaseId, lease.leaseId);
});
