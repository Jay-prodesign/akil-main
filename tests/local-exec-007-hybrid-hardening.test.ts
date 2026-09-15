import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  registerDevice,
  markDeviceOnline,
  createLocalWorkerRegistration,
  createDeviceCapabilitySnapshot,
  createExecutionPolicy,
  createLocalTaskLease,
  transitionLocalTaskLease,
} from "../src/domain/local-execution.js";
import {
  createLocalExecutionKillSwitch,
  engageLocalExecutionKillSwitch,
  disengageLocalExecutionKillSwitch,
  resolveEligibleLocalWorkersUnderKillSwitch,
  planExecutionModeTransition,
  resolveLocalDeviceHeartbeatFreshness,
  projectLocalWorkerHealth,
  InvalidKillSwitchTransitionError,
  InvalidExecutionModeTransitionError,
  InvalidLocalExecutionHardeningError,
} from "../src/domain/local-execution-hardening.js";
import {
  createAuthorityContext,
  ProtectedActionNotAuthorizedError,
  CrossTenantAuthorityError,
} from "../src/domain/authority.js";

const tenantScope = createTenantScope("tenant-a");
const otherTenantScope = createTenantScope("tenant-b");
const targetOwnership = createProjectOwnershipRef({
  tenantId: "tenant-a",
  customerId: "cust-1",
  projectId: "proj-1",
});

function onlineDevice() {
  return markDeviceOnline(
    registerDevice({
      tenantScope,
      deviceId: "device-1",
      ownerMembershipRef: "member-1",
      publicKeyFingerprint: "fp-1",
      platform: "darwin",
      bridgeVersion: "1.0.0",
    }),
  );
}

function privateWorker(device = onlineDevice()) {
  return createLocalWorkerRegistration({
    workerId: "worker-1",
    device,
    ownerMembershipRef: "member-1",
    adapterKind: "codex-local",
    declaredCapabilityRefs: ["cap:engineering.typescript"],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: "evidence:worker-1",
    poolMode: "PRIVATE",
    boundProjectOwnerships: [],
  });
}

function protectedAuthority(scope = tenantScope) {
  return createAuthorityContext({
    tenantScope: scope,
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: true,
  });
}

function unprotectedAuthority(scope = tenantScope) {
  return createAuthorityContext({
    tenantScope: scope,
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: false,
  });
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

test("K1: createLocalExecutionKillSwitch always starts disengaged", () => {
  const killSwitch = createLocalExecutionKillSwitch(tenantScope);
  assert.equal(killSwitch.engaged, false);
  assert.equal(killSwitch.tenantId, "tenant-a");
});

test("K2: engageLocalExecutionKillSwitch requires a non-empty reason and timestamp, sets engaged true", () => {
  const engaged = engageLocalExecutionKillSwitch({
    killSwitch: createLocalExecutionKillSwitch(tenantScope),
    engagedAt: "2026-09-15T12:00:00.000Z",
    reason: "suspected compromised device fleet",
  });
  assert.equal(engaged.engaged, true);
  assert.equal(engaged.engagedAt, "2026-09-15T12:00:00.000Z");
  assert.equal(engaged.engagedReason, "suspected compromised device fleet");
});

test("K3: engaging an already-engaged kill switch throws", () => {
  const engaged = engageLocalExecutionKillSwitch({
    killSwitch: createLocalExecutionKillSwitch(tenantScope),
    engagedAt: "2026-09-15T12:00:00.000Z",
    reason: "incident",
  });
  assert.throws(
    () => engageLocalExecutionKillSwitch({ killSwitch: engaged, engagedAt: "2026-09-15T12:05:00.000Z", reason: "incident 2" }),
    InvalidKillSwitchTransitionError,
  );
});

test("K4: disengageLocalExecutionKillSwitch clears engaged state and records auditable release provenance, given protected authority", () => {
  const engaged = engageLocalExecutionKillSwitch({
    killSwitch: createLocalExecutionKillSwitch(tenantScope),
    engagedAt: "2026-09-15T12:00:00.000Z",
    reason: "incident",
  });
  const disengaged = disengageLocalExecutionKillSwitch({
    killSwitch: engaged,
    authority: protectedAuthority(),
    disengagedAt: "2026-09-15T13:00:00.000Z",
    disengagedByRef: "staff:incident-commander-1",
    reason: "incident resolved, fleet re-verified clean",
  });
  assert.equal(disengaged.engaged, false);
  assert.equal("engagedAt" in disengaged, false);
  assert.equal("engagedReason" in disengaged, false);
  assert.equal(disengaged.disengagedAt, "2026-09-15T13:00:00.000Z");
  assert.equal(disengaged.disengagedByRef, "staff:incident-commander-1");
  assert.equal(disengaged.disengagedReason, "incident resolved, fleet re-verified clean");
});

test("K5: disengaging an already-disengaged kill switch throws", () => {
  assert.throws(
    () =>
      disengageLocalExecutionKillSwitch({
        killSwitch: createLocalExecutionKillSwitch(tenantScope),
        authority: protectedAuthority(),
        disengagedAt: "2026-09-15T13:00:00.000Z",
        disengagedByRef: "staff:incident-commander-1",
        reason: "incident resolved",
      }),
    InvalidKillSwitchTransitionError,
  );
});

test("K9 (Brain Rev125 adversarial): disengageLocalExecutionKillSwitch fails closed without protected-action authorization - an ordinary WRITE/EXECUTE caller cannot release a tenant-wide kill switch", () => {
  const engaged = engageLocalExecutionKillSwitch({
    killSwitch: createLocalExecutionKillSwitch(tenantScope),
    engagedAt: "2026-09-15T12:00:00.000Z",
    reason: "incident",
  });
  assert.throws(
    () =>
      disengageLocalExecutionKillSwitch({
        killSwitch: engaged,
        authority: unprotectedAuthority(),
        disengagedAt: "2026-09-15T13:00:00.000Z",
        disengagedByRef: "staff:someone",
        reason: "trying to release without protected authority",
      }),
    ProtectedActionNotAuthorizedError,
  );
});

test("K10 (Brain Rev125 adversarial): disengageLocalExecutionKillSwitch fails closed for a cross-tenant authority even with protected-action authorization", () => {
  const engaged = engageLocalExecutionKillSwitch({
    killSwitch: createLocalExecutionKillSwitch(tenantScope),
    engagedAt: "2026-09-15T12:00:00.000Z",
    reason: "incident",
  });
  assert.throws(
    () =>
      disengageLocalExecutionKillSwitch({
        killSwitch: engaged,
        authority: protectedAuthority(otherTenantScope),
        disengagedAt: "2026-09-15T13:00:00.000Z",
        disengagedByRef: "staff:someone",
        reason: "cross-tenant attempt",
      }),
    CrossTenantAuthorityError,
  );
});

test("K11 (Brain Rev125 adversarial): disengageLocalExecutionKillSwitch requires a non-empty disengagedByRef even with protected authority", () => {
  const engaged = engageLocalExecutionKillSwitch({
    killSwitch: createLocalExecutionKillSwitch(tenantScope),
    engagedAt: "2026-09-15T12:00:00.000Z",
    reason: "incident",
  });
  assert.throws(
    () =>
      disengageLocalExecutionKillSwitch({
        killSwitch: engaged,
        authority: protectedAuthority(),
        disengagedAt: "2026-09-15T13:00:00.000Z",
        disengagedByRef: "   ",
        reason: "incident resolved",
      }),
    InvalidLocalExecutionHardeningError,
  );
});

test("K6: an engaged kill switch returns zero eligible local workers even when the execution policy and worker would otherwise admit one", () => {
  const engaged = engageLocalExecutionKillSwitch({
    killSwitch: createLocalExecutionKillSwitch(tenantScope),
    engagedAt: "2026-09-15T12:00:00.000Z",
    reason: "incident",
  });
  const executionPolicy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkersUnderKillSwitch({
    killSwitch: engaged,
    executionPolicy,
    registrations: [privateWorker()],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "member-1",
  });
  assert.deepEqual(eligible, []);
});

test("K7: a disengaged kill switch delegates entirely to resolveEligibleLocalWorkers - the same worker becomes eligible", () => {
  const executionPolicy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  const eligible = resolveEligibleLocalWorkersUnderKillSwitch({
    killSwitch: createLocalExecutionKillSwitch(tenantScope),
    executionPolicy,
    registrations: [privateWorker()],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "member-1",
  });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]?.workerId, "worker-1");
});

test("K8 adversarial: a kill switch belonging to a different tenant than requestingTenantId fails closed", () => {
  const executionPolicy = createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL" });
  assert.throws(
    () =>
      resolveEligibleLocalWorkersUnderKillSwitch({
        killSwitch: createLocalExecutionKillSwitch(otherTenantScope),
        executionPolicy,
        registrations: [privateWorker()],
        requestingTenantId: tenantScope.tenantId,
        targetOwnership,
        requestingOwnerMembershipRef: "member-1",
      }),
    InvalidLocalExecutionHardeningError,
  );
});

// ---------------------------------------------------------------------------
// ExecutionMode transition preflight
// ---------------------------------------------------------------------------

test("M1: CLOUD_NORMAL -> PERSONAL_LOCAL is WIDENING", () => {
  const plan = planExecutionModeTransition({ from: "CLOUD_NORMAL", to: "PERSONAL_LOCAL" });
  assert.equal(plan.direction, "WIDENING");
});

test("M2: PERSONAL_LOCAL -> TEAM_LOCAL is WIDENING", () => {
  const plan = planExecutionModeTransition({ from: "PERSONAL_LOCAL", to: "TEAM_LOCAL" });
  assert.equal(plan.direction, "WIDENING");
});

test("M3: TEAM_LOCAL -> HYBRID is LATERAL, not UNCHANGED and not WIDENING/NARROWING", () => {
  const plan = planExecutionModeTransition({ from: "TEAM_LOCAL", to: "HYBRID" });
  assert.equal(plan.direction, "LATERAL");
});

test("M4: HYBRID -> TEAM_LOCAL is LATERAL", () => {
  const plan = planExecutionModeTransition({ from: "HYBRID", to: "TEAM_LOCAL" });
  assert.equal(plan.direction, "LATERAL");
});

test("M5: TEAM_LOCAL -> PERSONAL_LOCAL is NARROWING", () => {
  const plan = planExecutionModeTransition({ from: "TEAM_LOCAL", to: "PERSONAL_LOCAL" });
  assert.equal(plan.direction, "NARROWING");
});

test("M6: PERSONAL_LOCAL -> CLOUD_NORMAL is NARROWING", () => {
  const plan = planExecutionModeTransition({ from: "PERSONAL_LOCAL", to: "CLOUD_NORMAL" });
  assert.equal(plan.direction, "NARROWING");
});

test("M7: CLOUD_NORMAL -> CLOUD_NORMAL is UNCHANGED", () => {
  const plan = planExecutionModeTransition({ from: "CLOUD_NORMAL", to: "CLOUD_NORMAL" });
  assert.equal(plan.direction, "UNCHANGED");
});

test("M8 adversarial: an unrecognized ExecutionMode value fails closed", () => {
  assert.throws(
    () => planExecutionModeTransition({ from: "CLOUD_NORMAL", to: "BOGUS_MODE" }),
    InvalidExecutionModeTransitionError,
  );
});

test("M8b adversarial (prototype-pollution guard): Object.prototype-shaped keys ('constructor', 'toString', 'hasOwnProperty', '__proto__') fail closed rather than resolving through the prototype chain to an inherited function value", () => {
  for (const bogus of ["constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "__proto__"]) {
    assert.throws(
      () => planExecutionModeTransition({ from: "CLOUD_NORMAL", to: bogus }),
      InvalidExecutionModeTransitionError,
      `expected "${bogus}" as "to" to fail closed`,
    );
    assert.throws(
      () => planExecutionModeTransition({ from: bogus, to: "CLOUD_NORMAL" }),
      InvalidExecutionModeTransitionError,
      `expected "${bogus}" as "from" to fail closed`,
    );
  }
});

test("M9: every transition's disclosure states CollaborationMode is never altered - the return type itself carries no collaborationMode field", () => {
  const plan = planExecutionModeTransition({ from: "CLOUD_NORMAL", to: "HYBRID" });
  assert.match(plan.disclosure, /CollaborationMode is a fully independent dimension/);
  assert.equal("collaborationMode" in plan, false);
});

test("M10 (Brain Rev125): a NARROWING transition with no active leases and no external-effect states supplied succeeds vacuously", () => {
  const plan = planExecutionModeTransition({ from: "TEAM_LOCAL", to: "PERSONAL_LOCAL", activeLeases: [], externalEffectStates: [] });
  assert.equal(plan.direction, "NARROWING");
});

test("M11 (Brain Rev125 adversarial): a NARROWING transition fails closed while a supplied lease is still active (RUNNING) - narrowing would orphan work already leased to a local worker", () => {
  const device = onlineDevice();
  const worker = privateWorker(device);
  const lease = transitionLocalTaskLease({
    lease: createLocalTaskLease({ leaseId: "lease-1", taskRef: "task-1", worker, device }),
    to: "LEASED",
  });
  const runningLease = transitionLocalTaskLease({ lease, to: "RUNNING" });
  assert.throws(
    () =>
      planExecutionModeTransition({
        from: "TEAM_LOCAL",
        to: "PERSONAL_LOCAL",
        activeLeases: [runningLease],
      }),
    InvalidExecutionModeTransitionError,
  );
});

test("M12 (Brain Rev125): a NARROWING transition succeeds when every supplied lease has already reached a terminal status (SUCCEEDED/FAILED/CANCELLED)", () => {
  const device = onlineDevice();
  const worker = privateWorker(device);
  const leased = transitionLocalTaskLease({
    lease: createLocalTaskLease({ leaseId: "lease-2", taskRef: "task-2", worker, device }),
    to: "LEASED",
  });
  const running = transitionLocalTaskLease({ lease: leased, to: "RUNNING" });
  const succeeded = transitionLocalTaskLease({ lease: running, to: "SUCCEEDED" });
  const plan = planExecutionModeTransition({
    from: "TEAM_LOCAL",
    to: "PERSONAL_LOCAL",
    activeLeases: [succeeded],
  });
  assert.equal(plan.direction, "NARROWING");
});

test("M13 (Brain Rev125 adversarial): a NARROWING transition fails closed while a supplied external-effect state is UNKNOWN, even with no active leases at all", () => {
  assert.throws(
    () =>
      planExecutionModeTransition({
        from: "TEAM_LOCAL",
        to: "PERSONAL_LOCAL",
        activeLeases: [],
        externalEffectStates: ["UNKNOWN"],
      }),
    InvalidExecutionModeTransitionError,
  );
});

test("M14 (Brain Rev125): WIDENING and LATERAL transitions are never blocked by active leases or UNKNOWN effect states - only NARROWING carries this safety check", () => {
  const device = onlineDevice();
  const worker = privateWorker(device);
  const running = transitionLocalTaskLease({
    lease: transitionLocalTaskLease({
      lease: createLocalTaskLease({ leaseId: "lease-3", taskRef: "task-3", worker, device }),
      to: "LEASED",
    }),
    to: "RUNNING",
  });
  const widening = planExecutionModeTransition({
    from: "CLOUD_NORMAL",
    to: "PERSONAL_LOCAL",
    activeLeases: [running],
    externalEffectStates: ["UNKNOWN"],
  });
  assert.equal(widening.direction, "WIDENING");
  const lateral = planExecutionModeTransition({
    from: "TEAM_LOCAL",
    to: "HYBRID",
    activeLeases: [running],
    externalEffectStates: ["UNKNOWN"],
  });
  assert.equal(lateral.direction, "LATERAL");
});

// ---------------------------------------------------------------------------
// Health read-model
// ---------------------------------------------------------------------------

test("H1: full data (device ONLINE, a snapshot, and a fresh heartbeat) surfaces every dimension honestly", () => {
  const device = onlineDevice();
  const worker = privateWorker(device);
  const snapshot = createDeviceCapabilitySnapshot({
    device,
    adapterKind: "codex-local",
    readiness: "AVAILABLE",
    capturedAt: "2026-09-15T11:59:00.000Z",
    evidenceRef: "evidence:snap-1",
  });
  const health = projectLocalWorkerHealth({
    device,
    worker,
    latestSnapshot: snapshot,
    lastHeartbeatAt: "2026-09-15T11:59:30.000Z",
    asOf: "2026-09-15T12:00:00.000Z",
    maxAgeMs: 120000,
  });
  assert.equal(health.deviceStatus, "ONLINE");
  assert.equal(health.workerAvailability, "AVAILABLE");
  assert.equal(health.capabilityReadiness, "AVAILABLE");
  assert.equal(health.latestSnapshotCapturedAt, "2026-09-15T11:59:00.000Z");
  assert.equal(health.heartbeatFreshness, "FRESH");
  assert.equal(health.lastHeartbeatAt, "2026-09-15T11:59:30.000Z");
});

test("H2: no snapshot and no heartbeat supplied - only the always-present base fields are returned, nothing fabricated", () => {
  const device = onlineDevice();
  const worker = privateWorker(device);
  const health = projectLocalWorkerHealth({ device, worker });
  assert.equal(health.deviceStatus, "ONLINE");
  assert.equal(health.workerAvailability, "AVAILABLE");
  assert.equal("capabilityReadiness" in health, false);
  assert.equal("latestSnapshotCapturedAt" in health, false);
  assert.equal("heartbeatFreshness" in health, false);
  assert.equal("lastHeartbeatAt" in health, false);
});

test("H3: a stale heartbeat is honestly reported as STALE, not silently treated as fresh", () => {
  const device = onlineDevice();
  const worker = privateWorker(device);
  const health = projectLocalWorkerHealth({
    device,
    worker,
    lastHeartbeatAt: "2026-09-15T11:00:00.000Z",
    asOf: "2026-09-15T12:00:00.000Z",
    maxAgeMs: 60000,
  });
  assert.equal(health.heartbeatFreshness, "STALE");
});

test("H4 adversarial: a worker whose deviceId does not match the given device fails closed", () => {
  const device = onlineDevice();
  const otherDevice = markDeviceOnline(
    registerDevice({
      tenantScope,
      deviceId: "device-2",
      ownerMembershipRef: "member-1",
      publicKeyFingerprint: "fp-2",
      platform: "linux",
      bridgeVersion: "1.0.0",
    }),
  );
  const worker = privateWorker(otherDevice);
  assert.throws(
    () => projectLocalWorkerHealth({ device, worker }),
    InvalidLocalExecutionHardeningError,
  );
});

test("H5 adversarial: a worker whose tenantId does not match the given device's tenantId fails closed", () => {
  const device = onlineDevice();
  const crossTenantDevice = markDeviceOnline(
    registerDevice({
      tenantScope: otherTenantScope,
      deviceId: "device-1",
      ownerMembershipRef: "member-1",
      publicKeyFingerprint: "fp-1",
      platform: "darwin",
      bridgeVersion: "1.0.0",
    }),
  );
  const crossTenantWorker = privateWorker(crossTenantDevice);
  assert.throws(
    () => projectLocalWorkerHealth({ device, worker: crossTenantWorker }),
    InvalidLocalExecutionHardeningError,
  );
});

test("H6 adversarial: a snapshot whose deviceId does not match the given device fails closed", () => {
  const device = onlineDevice();
  const worker = privateWorker(device);
  const otherDevice = markDeviceOnline(
    registerDevice({
      tenantScope,
      deviceId: "device-2",
      ownerMembershipRef: "member-1",
      publicKeyFingerprint: "fp-2",
      platform: "linux",
      bridgeVersion: "1.0.0",
    }),
  );
  const foreignSnapshot = createDeviceCapabilitySnapshot({
    device: otherDevice,
    adapterKind: "codex-local",
    readiness: "AVAILABLE",
    capturedAt: "2026-09-15T11:59:00.000Z",
    evidenceRef: "evidence:snap-2",
  });
  assert.throws(
    () => projectLocalWorkerHealth({ device, worker, latestSnapshot: foreignSnapshot }),
    InvalidLocalExecutionHardeningError,
  );
});

test("H7 adversarial: resolveLocalDeviceHeartbeatFreshness rejects asOf strictly before lastHeartbeatAt (time-travel guard)", () => {
  assert.throws(
    () =>
      resolveLocalDeviceHeartbeatFreshness({
        lastHeartbeatAt: "2026-09-15T12:00:00.000Z",
        asOf: "2026-09-15T11:00:00.000Z",
        maxAgeMs: 60000,
      }),
    InvalidLocalExecutionHardeningError,
  );
});

test("H8 adversarial: resolveLocalDeviceHeartbeatFreshness rejects a non-positive maxAgeMs", () => {
  assert.throws(
    () =>
      resolveLocalDeviceHeartbeatFreshness({
        lastHeartbeatAt: "2026-09-15T12:00:00.000Z",
        asOf: "2026-09-15T12:00:01.000Z",
        maxAgeMs: 0,
      }),
    InvalidLocalExecutionHardeningError,
  );
});
