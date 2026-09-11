import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  registerDevice,
  markDeviceOnline,
  revokeDevice,
  quarantineDevice,
  createDevicePolicy,
  createLocalWorkerRegistration,
  createLocalTaskLease,
  transitionLocalTaskLease,
  createLocalTaskCheckpoint,
  type DeviceRegistration,
} from "../src/domain/local-execution.js";
import {
  validateBridgeProtocolEnvelope,
  validateBridgeMessageReplay,
  isRecognizedBridgeMessageKind,
  createEnrollmentChallenge,
  completeDeviceEnrollment,
  transitionBridgeConnectionState,
  processBridgeHeartbeat,
  resolveAllowedWorkspacePath,
  validateLeaseMessageEnvelope,
  validateCheckpointMessageEnvelope,
  InvalidBridgeProtocolError,
  InvalidBridgeReplayError,
  InvalidBridgeEnrollmentError,
  InvalidBridgeConnectionTransitionError,
  type BridgeDeviceReplayState,
} from "../src/domain/local-execution-bridge.js";

const tenantScope = createTenantScope("tenant-bridge-1");

function pendingDevice(seed: string): DeviceRegistration {
  return registerDevice({
    tenantScope,
    deviceId: `device-${seed}`,
    ownerMembershipRef: "owner-1",
    publicKeyFingerprint: `fingerprint-${seed}`,
    platform: "linux",
    bridgeVersion: "0.1.0",
  });
}

function onlineDevice(seed: string): DeviceRegistration {
  return markDeviceOnline(pendingDevice(seed));
}

function envelope(seed: string, device: DeviceRegistration, overrides?: Partial<{
  kind: string;
  eventSeq: number;
  messageId: string;
  workerId: string;
  taskRef: string;
}>) {
  return validateBridgeProtocolEnvelope({
    protocolVersion: 1,
    kind: overrides?.kind ?? "HEARTBEAT",
    tenantScope,
    deviceId: device.deviceId,
    workerId: overrides?.workerId,
    taskRef: overrides?.taskRef,
    eventSeq: overrides?.eventSeq ?? 1,
    messageId: overrides?.messageId ?? `msg-${seed}`,
  });
}

// --- BridgeProtocolEnvelope ---

test("B1: validateBridgeProtocolEnvelope accepts a well-formed envelope", () => {
  const device = onlineDevice("1");
  const env = envelope("1", device);
  assert.equal(env.deviceId, device.deviceId);
  assert.equal(env.tenantId, tenantScope.tenantId);
  assert.equal(env.kind, "HEARTBEAT");
});

test("B2: validateBridgeProtocolEnvelope rejects an unsupported protocolVersion", () => {
  const device = onlineDevice("2");
  assert.throws(
    () =>
      validateBridgeProtocolEnvelope({
        protocolVersion: 99,
        kind: "HEARTBEAT",
        tenantScope,
        deviceId: device.deviceId,
        eventSeq: 1,
        messageId: "msg-2",
      }),
    InvalidBridgeProtocolError,
  );
});

test("B3: validateBridgeProtocolEnvelope rejects an unrecognized kind", () => {
  const device = onlineDevice("3");
  assert.throws(
    () =>
      validateBridgeProtocolEnvelope({
        protocolVersion: 1,
        kind: "SOMETHING_ELSE",
        tenantScope,
        deviceId: device.deviceId,
        eventSeq: 1,
        messageId: "msg-3",
      }),
    InvalidBridgeProtocolError,
  );
});

test("B4: validateBridgeProtocolEnvelope rejects a negative or non-integer eventSeq", () => {
  const device = onlineDevice("4");
  assert.throws(
    () => envelope("4a", device, { eventSeq: -1 }),
    InvalidBridgeProtocolError,
  );
  assert.throws(
    () => envelope("4b", device, { eventSeq: 1.5 }),
    InvalidBridgeProtocolError,
  );
});

test("B5: validateBridgeProtocolEnvelope rejects an empty deviceId/messageId", () => {
  assert.throws(
    () =>
      validateBridgeProtocolEnvelope({
        protocolVersion: 1,
        kind: "HEARTBEAT",
        tenantScope,
        deviceId: "",
        eventSeq: 1,
        messageId: "msg-5",
      }),
    InvalidBridgeProtocolError,
  );
  assert.throws(
    () =>
      validateBridgeProtocolEnvelope({
        protocolVersion: 1,
        kind: "HEARTBEAT",
        tenantScope,
        deviceId: "device-5",
        eventSeq: 1,
        messageId: "",
      }),
    InvalidBridgeProtocolError,
  );
});

test("B6: isRecognizedBridgeMessageKind is a fail-closed guard over exactly the packet's §17 message families", () => {
  for (const kind of [
    "ENROLL_CHALLENGE",
    "ENROLL_PROOF",
    "DEVICE_HELLO",
    "CAPABILITY_SNAPSHOT",
    "HEARTBEAT",
    "LEASE_OFFER",
    "LEASE_ACCEPT",
    "LEASE_REJECT",
    "RUN_STARTED",
    "RUN_EVENT",
    "PERMISSION_REQUEST",
    "PERMISSION_DECISION",
    "CHECKPOINT",
    "RUN_COMPLETED",
    "RUN_FAILED",
    "RUN_BLOCKED",
    "CANCEL",
    "DEVICE_POLICY_REFRESH",
    "REVOKE",
  ]) {
    assert.equal(isRecognizedBridgeMessageKind(kind), true);
  }
  assert.equal(isRecognizedBridgeMessageKind("NOT_A_REAL_KIND"), false);
  assert.equal(isRecognizedBridgeMessageKind(123), false);
});

// --- Replay/idempotency ---

test("B7: validateBridgeMessageReplay accepts a device's first-ever message unconditionally (bootstraps state)", () => {
  const device = onlineDevice("7");
  const env = envelope("7", device, { eventSeq: 5 });
  const outcome = validateBridgeMessageReplay({ envelope: env, priorState: undefined });
  assert.equal(outcome.disposition, "ACCEPTED");
  assert.equal(outcome.nextState.lastAcceptedEventSeq, 5);
});

test("B8: validateBridgeMessageReplay accepts a strictly greater eventSeq and advances state", () => {
  const device = onlineDevice("8");
  const first = validateBridgeMessageReplay({ envelope: envelope("8a", device, { eventSeq: 1 }), priorState: undefined });
  const second = validateBridgeMessageReplay({
    envelope: envelope("8b", device, { eventSeq: 2 }),
    priorState: first.nextState,
  });
  assert.equal(second.disposition, "ACCEPTED");
  assert.equal(second.nextState.lastAcceptedEventSeq, 2);
});

test("B9 (adversarial replay attack): validateBridgeMessageReplay fails closed on an eventSeq equal to or lower than the last accepted one", () => {
  const device = onlineDevice("9");
  const first = validateBridgeMessageReplay({ envelope: envelope("9a", device, { eventSeq: 5 }), priorState: undefined });
  assert.throws(
    () => validateBridgeMessageReplay({ envelope: envelope("9b", device, { eventSeq: 5, messageId: "msg-9b" }), priorState: first.nextState }),
    InvalidBridgeReplayError,
  );
  assert.throws(
    () => validateBridgeMessageReplay({ envelope: envelope("9c", device, { eventSeq: 3, messageId: "msg-9c" }), priorState: first.nextState }),
    InvalidBridgeReplayError,
  );
});

test("B10 (at-least-once redelivery): validateBridgeMessageReplay recognizes an exact messageId repeat as DUPLICATE, not a hard failure or a double-apply", () => {
  const device = onlineDevice("10");
  const env = envelope("10", device, { eventSeq: 1, messageId: "msg-10-fixed" });
  const first = validateBridgeMessageReplay({ envelope: env, priorState: undefined });
  const redelivered = validateBridgeMessageReplay({ envelope: env, priorState: first.nextState });
  assert.equal(redelivered.disposition, "DUPLICATE");
  assert.equal(redelivered.nextState.lastAcceptedEventSeq, first.nextState.lastAcceptedEventSeq);
});

test("B11: validateBridgeMessageReplay fails closed when priorState belongs to a different device than the envelope", () => {
  const deviceA = onlineDevice("11a");
  const deviceB = onlineDevice("11b");
  const stateA: BridgeDeviceReplayState = { deviceId: deviceA.deviceId, lastAcceptedEventSeq: 1, seenMessageIds: new Set() };
  assert.throws(
    () => validateBridgeMessageReplay({ envelope: envelope("11b", deviceB, { eventSeq: 2 }), priorState: stateA }),
    InvalidBridgeReplayError,
  );
});

// --- Enrollment ---

test("B12: createEnrollmentChallenge succeeds for a PENDING device", () => {
  const device = pendingDevice("12");
  const challenge = createEnrollmentChallenge({
    device,
    challengeId: "challenge-12",
    issuedAt: "2026-09-11T00:00:00.000Z",
    expiresAt: "2026-09-11T00:05:00.000Z",
  });
  assert.equal(challenge.deviceId, device.deviceId);
});

test("B13: createEnrollmentChallenge fails closed for an already-ONLINE device", () => {
  const device = onlineDevice("13");
  assert.throws(
    () =>
      createEnrollmentChallenge({
        device,
        challengeId: "challenge-13",
        issuedAt: "2026-09-11T00:00:00.000Z",
        expiresAt: "2026-09-11T00:05:00.000Z",
      }),
    InvalidBridgeEnrollmentError,
  );
});

test("B14: createEnrollmentChallenge rejects expiresAt not strictly after issuedAt", () => {
  const device = pendingDevice("14");
  assert.throws(
    () =>
      createEnrollmentChallenge({
        device,
        challengeId: "challenge-14",
        issuedAt: "2026-09-11T00:05:00.000Z",
        expiresAt: "2026-09-11T00:05:00.000Z",
      }),
    InvalidBridgeEnrollmentError,
  );
});

test("B15: completeDeviceEnrollment transitions a PENDING device to ONLINE on a matching, timely proof", () => {
  const device = pendingDevice("15");
  const challenge = createEnrollmentChallenge({
    device,
    challengeId: "challenge-15",
    issuedAt: "2026-09-11T00:00:00.000Z",
    expiresAt: "2026-09-11T00:05:00.000Z",
  });
  const enrolled = completeDeviceEnrollment({
    device,
    challenge,
    proofChallengeId: "challenge-15",
    proofRef: "proof:signed-blob",
    provedAt: "2026-09-11T00:01:00.000Z",
  });
  assert.equal(enrolled.status, "ONLINE");
});

test("B16 (adversarial foreign-challenge substitution): completeDeviceEnrollment fails closed when proofChallengeId does not match the issued challenge", () => {
  const device = pendingDevice("16");
  const challenge = createEnrollmentChallenge({
    device,
    challengeId: "challenge-16-real",
    issuedAt: "2026-09-11T00:00:00.000Z",
    expiresAt: "2026-09-11T00:05:00.000Z",
  });
  assert.throws(
    () =>
      completeDeviceEnrollment({
        device,
        challenge,
        proofChallengeId: "challenge-16-forged",
        proofRef: "proof:signed-blob",
        provedAt: "2026-09-11T00:01:00.000Z",
      }),
    InvalidBridgeEnrollmentError,
  );
});

test("B17 (adversarial cross-device challenge): completeDeviceEnrollment fails closed when the challenge was issued to a different device", () => {
  const deviceA = pendingDevice("17a");
  const deviceB = pendingDevice("17b");
  const challengeForA = createEnrollmentChallenge({
    device: deviceA,
    challengeId: "challenge-17",
    issuedAt: "2026-09-11T00:00:00.000Z",
    expiresAt: "2026-09-11T00:05:00.000Z",
  });
  assert.throws(
    () =>
      completeDeviceEnrollment({
        device: deviceB,
        challenge: challengeForA,
        proofChallengeId: "challenge-17",
        proofRef: "proof:signed-blob",
        provedAt: "2026-09-11T00:01:00.000Z",
      }),
    InvalidBridgeEnrollmentError,
  );
});

test("B18 (expired challenge): completeDeviceEnrollment fails closed when provedAt is after the challenge's expiresAt", () => {
  const device = pendingDevice("18");
  const challenge = createEnrollmentChallenge({
    device,
    challengeId: "challenge-18",
    issuedAt: "2026-09-11T00:00:00.000Z",
    expiresAt: "2026-09-11T00:05:00.000Z",
  });
  assert.throws(
    () =>
      completeDeviceEnrollment({
        device,
        challenge,
        proofChallengeId: "challenge-18",
        proofRef: "proof:signed-blob",
        provedAt: "2026-09-11T00:10:00.000Z",
      }),
    InvalidBridgeEnrollmentError,
  );
});

test("B19 (replay of a redeemed challenge): completeDeviceEnrollment fails closed on a second redemption attempt against the already-enrolled (no longer PENDING) device", () => {
  const device = pendingDevice("19");
  const challenge = createEnrollmentChallenge({
    device,
    challengeId: "challenge-19",
    issuedAt: "2026-09-11T00:00:00.000Z",
    expiresAt: "2026-09-11T00:05:00.000Z",
  });
  const enrolled = completeDeviceEnrollment({
    device,
    challenge,
    proofChallengeId: "challenge-19",
    proofRef: "proof:signed-blob",
    provedAt: "2026-09-11T00:01:00.000Z",
  });
  assert.throws(
    () =>
      completeDeviceEnrollment({
        device: enrolled,
        challenge,
        proofChallengeId: "challenge-19",
        proofRef: "proof:signed-blob-again",
        provedAt: "2026-09-11T00:02:00.000Z",
      }),
    InvalidBridgeEnrollmentError,
  );
});

// --- Connection state machine ---

test("B20: bridge connection state moves DISCONNECTED -> CONNECTING -> CONNECTED -> RECONNECTING -> CONNECTED -> DISCONNECTED", () => {
  let state = transitionBridgeConnectionState("DISCONNECTED", "CONNECTING");
  state = transitionBridgeConnectionState(state, "CONNECTED");
  state = transitionBridgeConnectionState(state, "RECONNECTING");
  state = transitionBridgeConnectionState(state, "CONNECTED");
  state = transitionBridgeConnectionState(state, "DISCONNECTED");
  assert.equal(state, "DISCONNECTED");
});

test("B21 (adversarial illegal jump): DISCONNECTED cannot transition directly to CONNECTED or RECONNECTING", () => {
  assert.throws(() => transitionBridgeConnectionState("DISCONNECTED", "CONNECTED"), InvalidBridgeConnectionTransitionError);
  assert.throws(() => transitionBridgeConnectionState("DISCONNECTED", "RECONNECTING"), InvalidBridgeConnectionTransitionError);
});

test("B22: a lost CONNECTED session moves only to RECONNECTING or DISCONNECTED, never back to CONNECTING directly", () => {
  assert.throws(() => transitionBridgeConnectionState("CONNECTED", "CONNECTING"), InvalidBridgeConnectionTransitionError);
});

// --- Heartbeat ---

test("B23: processBridgeHeartbeat accepts a heartbeat from an ONLINE device and advances replay/heartbeat state", () => {
  const device = onlineDevice("23");
  const env = envelope("23", device, { kind: "HEARTBEAT", eventSeq: 1 });
  const result = processBridgeHeartbeat({ device, envelope: env, observedAt: "2026-09-11T00:00:00.000Z", priorReplayState: undefined });
  assert.equal(result.replay.disposition, "ACCEPTED");
  assert.equal(result.heartbeatState.lastEventSeq, 1);
});

test("B24 (§16 revoked device fails closed): processBridgeHeartbeat rejects a heartbeat from a REVOKED device", () => {
  const device = revokeDevice(onlineDevice("24"));
  const env = envelope("24", device, { kind: "HEARTBEAT", eventSeq: 1 });
  assert.throws(
    () => processBridgeHeartbeat({ device, envelope: env, observedAt: "2026-09-11T00:00:00.000Z", priorReplayState: undefined }),
    InvalidBridgeProtocolError,
  );
});

test("B25: processBridgeHeartbeat rejects a heartbeat from a QUARANTINED device", () => {
  const device = quarantineDevice(onlineDevice("25"));
  const env = envelope("25", device, { kind: "HEARTBEAT", eventSeq: 1 });
  assert.throws(
    () => processBridgeHeartbeat({ device, envelope: env, observedAt: "2026-09-11T00:00:00.000Z", priorReplayState: undefined }),
    InvalidBridgeProtocolError,
  );
});

test("B26: processBridgeHeartbeat rejects a non-HEARTBEAT envelope", () => {
  const device = onlineDevice("26");
  const env = envelope("26", device, { kind: "CANCEL", eventSeq: 1 });
  assert.throws(
    () => processBridgeHeartbeat({ device, envelope: env, observedAt: "2026-09-11T00:00:00.000Z", priorReplayState: undefined }),
    InvalidBridgeProtocolError,
  );
});

test("B27 (adversarial cross-device heartbeat): processBridgeHeartbeat rejects an envelope whose deviceId does not match the given device", () => {
  const deviceA = onlineDevice("27a");
  const deviceB = onlineDevice("27b");
  const envForB = envelope("27b", deviceB, { kind: "HEARTBEAT", eventSeq: 1 });
  assert.throws(
    () => processBridgeHeartbeat({ device: deviceA, envelope: envForB, observedAt: "2026-09-11T00:00:00.000Z", priorReplayState: undefined }),
    InvalidBridgeProtocolError,
  );
});

// --- Workspace path resolution ---

test("B28: resolveAllowedWorkspacePath resolves a relative path under an allowed root", () => {
  const device = onlineDevice("28");
  const policy = createDevicePolicy({ device, allowedWorkspaceRootRefs: ["/repo"], maxRiskLevel: "STANDARD" });
  const resolved = resolveAllowedWorkspacePath({ policy, requestedRootRef: "/repo", relativePath: "src/index.ts" });
  assert.equal(resolved, "/repo/src/index.ts");
});

test("B29 (§22/§16 unauthorized root fails closed): resolveAllowedWorkspacePath rejects a root not on the allowlist", () => {
  const device = onlineDevice("29");
  const policy = createDevicePolicy({ device, allowedWorkspaceRootRefs: ["/repo"], maxRiskLevel: "STANDARD" });
  assert.throws(
    () => resolveAllowedWorkspacePath({ policy, requestedRootRef: "/etc", relativePath: "passwd" }),
    InvalidBridgeProtocolError,
  );
});

test("B30 (adversarial path traversal): resolveAllowedWorkspacePath rejects a relativePath containing a \"..\" segment even under an allowed root", () => {
  const device = onlineDevice("30");
  const policy = createDevicePolicy({ device, allowedWorkspaceRootRefs: ["/repo"], maxRiskLevel: "STANDARD" });
  assert.throws(
    () => resolveAllowedWorkspacePath({ policy, requestedRootRef: "/repo", relativePath: "../../etc/passwd" }),
    InvalidBridgeProtocolError,
  );
});

test("B31 (adversarial absolute-path escape): resolveAllowedWorkspacePath rejects a relativePath that is itself absolute", () => {
  const device = onlineDevice("31");
  const policy = createDevicePolicy({ device, allowedWorkspaceRootRefs: ["/repo"], maxRiskLevel: "STANDARD" });
  assert.throws(
    () => resolveAllowedWorkspacePath({ policy, requestedRootRef: "/repo", relativePath: "/etc/passwd" }),
    InvalidBridgeProtocolError,
  );
});

test("B32: resolveAllowedWorkspacePath fails closed once the device policy's kill switch is engaged, even for an otherwise-allowed root", () => {
  const device = onlineDevice("32");
  const policyBase = createDevicePolicy({ device, allowedWorkspaceRootRefs: ["/repo"], maxRiskLevel: "STANDARD" });
  const killed = { ...policyBase, killSwitchEngaged: true };
  assert.throws(
    () => resolveAllowedWorkspacePath({ policy: killed, requestedRootRef: "/repo", relativePath: "src/index.ts" }),
    InvalidBridgeProtocolError,
  );
});

// --- Lease / checkpoint message consistency ---

function makeLease(seed: string) {
  const device = onlineDevice(seed);
  const worker = createLocalWorkerRegistration({
    workerId: `worker-${seed}`,
    device,
    ownerMembershipRef: device.ownerMembershipRef,
    adapterKind: "CODEX_LOCAL",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: `evidence-${seed}`,
    poolMode: "PRIVATE",
    boundProjectOwnerships: [],
  });
  const lease = createLocalTaskLease({ leaseId: `lease-${seed}`, taskRef: `task-${seed}`, worker, device });
  return { device, worker, lease };
}

test("B33: validateLeaseMessageEnvelope accepts a LEASE_OFFER whose identity matches the lease", () => {
  const { device, worker, lease } = makeLease("33");
  const env = envelope("33", device, { kind: "LEASE_OFFER", eventSeq: 1, workerId: worker.workerId, taskRef: lease.taskRef });
  assert.doesNotThrow(() => validateLeaseMessageEnvelope({ envelope: env, lease }));
});

test("B34 (adversarial forged lease reference): validateLeaseMessageEnvelope rejects an envelope naming a different workerId than the lease", () => {
  const { device, lease } = makeLease("34");
  const env = envelope("34", device, { kind: "LEASE_ACCEPT", eventSeq: 1, workerId: "worker-forged", taskRef: lease.taskRef });
  assert.throws(() => validateLeaseMessageEnvelope({ envelope: env, lease }), InvalidBridgeProtocolError);
});

test("B35: validateLeaseMessageEnvelope rejects a non-lease-family envelope kind", () => {
  const { device, worker, lease } = makeLease("35");
  const env = envelope("35", device, { kind: "HEARTBEAT", eventSeq: 1, workerId: worker.workerId, taskRef: lease.taskRef });
  assert.throws(() => validateLeaseMessageEnvelope({ envelope: env, lease }), InvalidBridgeProtocolError);
});

test("B36: validateCheckpointMessageEnvelope accepts a CHECKPOINT whose identity matches the lease and checkpoint", () => {
  const { device, worker, lease: queued } = makeLease("36");
  const leased = transitionLocalTaskLease({ lease: queued, to: "LEASED" });
  const running = transitionLocalTaskLease({ lease: leased, to: "RUNNING" });
  const checkpoint = createLocalTaskCheckpoint({
    lease: running,
    checkpointRef: "checkpoint:x",
    capturedAt: "2026-09-11T00:00:00.000Z",
    evidenceRef: "evidence:x",
  });
  const env = envelope("36", device, { kind: "CHECKPOINT", eventSeq: 1, workerId: worker.workerId, taskRef: running.taskRef });
  assert.doesNotThrow(() => validateCheckpointMessageEnvelope({ envelope: env, checkpoint, lease: running }));
});

test("B37 (adversarial cross-lease checkpoint): validateCheckpointMessageEnvelope rejects a checkpoint that does not belong to the given lease", () => {
  const { lease: queuedA } = makeLease("37a");
  const leasedA = transitionLocalTaskLease({ lease: queuedA, to: "LEASED" });
  const runningA = transitionLocalTaskLease({ lease: leasedA, to: "RUNNING" });
  const checkpointA = createLocalTaskCheckpoint({
    lease: runningA,
    checkpointRef: "checkpoint:a",
    capturedAt: "2026-09-11T00:00:00.000Z",
    evidenceRef: "evidence:a",
  });

  const { device: deviceB, worker: workerB, lease: queuedB } = makeLease("37b");
  const leasedB = transitionLocalTaskLease({ lease: queuedB, to: "LEASED" });
  const runningB = transitionLocalTaskLease({ lease: leasedB, to: "RUNNING" });
  const env = envelope("37", deviceB, { kind: "CHECKPOINT", eventSeq: 1, workerId: workerB.workerId, taskRef: runningB.taskRef });
  assert.throws(
    () => validateCheckpointMessageEnvelope({ envelope: env, checkpoint: checkpointA, lease: runningB }),
    InvalidBridgeProtocolError,
  );
});
