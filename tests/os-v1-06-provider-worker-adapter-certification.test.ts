import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateBridgeMessageReplay,
  validateBridgeProtocolEnvelope,
} from "../src/domain/local-execution-bridge.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  registerDevice,
  markDeviceOnline,
  revokeDevice,
  quarantineDevice,
  createLocalWorkerRegistration,
  createLocalTaskLease,
  transitionLocalTaskLease,
  InvalidLocalTaskLeaseTransitionError,
  type DeviceRegistration,
  type LocalWorkerRegistration,
} from "../src/domain/local-execution.js";
import {
  admitLocalWorkerAdapterResult,
  resolveAmbiguousLocalRunDisposition,
  InvalidLocalExecutionAdapterCertificationError,
} from "../src/domain/local-execution-adapter-certification.js";
import {
  resolveClaudeRunOutcome,
  createClaudeRunRequest,
  createClaudeCheckpointRecord,
  InvalidClaudeAdapterError,
  resolveClaudeAdapterCapabilityReadiness,
  resolveClaudeRunReadiness,
} from "../src/domain/claude-local-adapter.js";
import {
  createCodexRunRequest,
  resolveCodexRunReadiness,
} from "../src/domain/codex-local-adapter.js";
import { createDevicePolicy } from "../src/domain/local-execution.js";

const tenantScope = createTenantScope("tenant-os-v1-06");

function envelope(
  seq: string,
  deviceId: DeviceRegistration["deviceId"],
  overrides?: Partial<{ eventSeq: number; messageId: string }>,
) {
  return validateBridgeProtocolEnvelope({
    protocolVersion: 1,
    kind: "RUN_EVENT",
    tenantScope,
    deviceId,
    eventSeq: overrides?.eventSeq ?? 1,
    messageId: overrides?.messageId ?? `msg-${seq}`,
  });
}

function freshDevice(): DeviceRegistration {
  return markDeviceOnline(
    registerDevice({
      tenantScope,
      deviceId: "device-v1-06",
      ownerMembershipRef: "member-owner-1",
      publicKeyFingerprint: "fp-1",
      platform: "linux",
      bridgeVersion: "1.0.0",
    }),
  );
}

function freshWorker(device: DeviceRegistration): LocalWorkerRegistration {
  return createLocalWorkerRegistration({
    workerId: "worker-v1-06",
    device,
    ownerMembershipRef: device.ownerMembershipRef,
    adapterKind: "claude-local",
    declaredCapabilityRefs: ["cap-1"],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: "eval-1",
    poolMode: "PRIVATE",
    boundProjectOwnerships: [],
  });
}

test("G1: validateBridgeMessageReplay reports gapDetected: false on exact sequential eventSeq; DUPLICATE shape unaffected", () => {
  const device = freshDevice();
  const first = validateBridgeMessageReplay({
    envelope: envelope("g1a", device.deviceId, { eventSeq: 1 }),
    priorState: undefined,
  });
  assert.equal(first.disposition, "ACCEPTED");
  assert.equal((first as { gapDetected: boolean }).gapDetected, false);

  const second = validateBridgeMessageReplay({
    envelope: envelope("g1b", device.deviceId, { eventSeq: 2 }),
    priorState: first.nextState,
  });
  assert.equal(second.disposition, "ACCEPTED");
  assert.equal((second as { gapDetected: boolean }).gapDetected, false);

  const duplicate = validateBridgeMessageReplay({
    envelope: envelope("g1b", device.deviceId, { eventSeq: 2, messageId: "msg-g1b" }),
    priorState: second.nextState,
  });
  assert.equal(duplicate.disposition, "DUPLICATE");
  assert.equal("gapDetected" in duplicate, false);
});

test("G2 (event loss): validateBridgeMessageReplay reports gapDetected: true when an intervening eventSeq is skipped", () => {
  const device = freshDevice();
  const first = validateBridgeMessageReplay({
    envelope: envelope("g2a", device.deviceId, { eventSeq: 1 }),
    priorState: undefined,
  });
  // eventSeq 2,3,4 were never received (lost) - 5 arrives next.
  const afterGap = validateBridgeMessageReplay({
    envelope: envelope("g2b", device.deviceId, { eventSeq: 5 }),
    priorState: first.nextState,
  });
  assert.equal(afterGap.disposition, "ACCEPTED");
  assert.equal((afterGap as { gapDetected: boolean }).gapDetected, true);
  assert.equal(afterGap.nextState.lastAcceptedEventSeq, 5);
});

test("S1: admitLocalWorkerAdapterResult accepts a current ONLINE device + ADMITTED worker; rejects a device/worker deviceId mismatch", () => {
  const device = freshDevice();
  const worker = freshWorker(device);
  const result = admitLocalWorkerAdapterResult({
    result: { outcome: "SUCCEEDED", evidenceRef: "ev-1" },
    currentDevice: device,
    currentWorker: worker,
  });
  assert.equal(result.outcome, "SUCCEEDED");

  const otherDevice = { ...freshDevice(), deviceId: "device-other" as DeviceRegistration["deviceId"] };
  assert.throws(
    () =>
      admitLocalWorkerAdapterResult({
        result: { outcome: "SUCCEEDED", evidenceRef: "ev-1" },
        currentDevice: otherDevice,
        currentWorker: worker,
      }),
    InvalidLocalExecutionAdapterCertificationError,
  );
});

test("S2 (stale authority): admitLocalWorkerAdapterResult rejects a result from a device revoked/quarantined since dispatch", () => {
  const onlineDevice = freshDevice();
  const worker = freshWorker(onlineDevice);
  const revoked = revokeDevice(onlineDevice);
  assert.throws(
    () =>
      admitLocalWorkerAdapterResult({
        result: { outcome: "SUCCEEDED", evidenceRef: "ev-2" },
        currentDevice: revoked,
        currentWorker: worker,
      }),
    InvalidLocalExecutionAdapterCertificationError,
  );

  const pending = registerDevice({
    tenantScope,
    deviceId: "device-v1-06-q",
    ownerMembershipRef: "member-owner-1",
    publicKeyFingerprint: "fp-2",
    platform: "linux",
    bridgeVersion: "1.0.0",
  });
  const online2 = markDeviceOnline(pending);
  const quarantined = quarantineDevice(online2);
  const worker2 = freshWorker(online2);
  assert.throws(
    () =>
      admitLocalWorkerAdapterResult({
        result: { outcome: "SUCCEEDED", evidenceRef: "ev-2b" },
        currentDevice: quarantined,
        currentWorker: worker2,
      }),
    InvalidLocalExecutionAdapterCertificationError,
  );
});

test("S3 (stale authority): admitLocalWorkerAdapterResult rejects a result from a worker no longer ADMITTED", () => {
  const device = freshDevice();
  const worker = freshWorker(device);
  const revokedWorker: LocalWorkerRegistration = { ...worker, trustStatus: "REVOKED" };
  assert.throws(
    () =>
      admitLocalWorkerAdapterResult({
        result: { outcome: "SUCCEEDED", evidenceRef: "ev-3" },
        currentDevice: device,
        currentWorker: revokedWorker,
      }),
    InvalidLocalExecutionAdapterCertificationError,
  );
  const untrustedWorker: LocalWorkerRegistration = { ...worker, trustStatus: "UNTRUSTED" };
  assert.throws(
    () =>
      admitLocalWorkerAdapterResult({
        result: { outcome: "SUCCEEDED", evidenceRef: "ev-3b" },
        currentDevice: device,
        currentWorker: untrustedWorker,
      }),
    InvalidLocalExecutionAdapterCertificationError,
  );
});

test("U1 (partial effect -> UNKNOWN): resolveAmbiguousLocalRunDisposition returns UNKNOWN/BLOCKED on connection loss mid-RUNNING with no terminal event", () => {
  const resolution = resolveAmbiguousLocalRunDisposition({
    leaseStatus: "RUNNING",
    connectionState: "DISCONNECTED",
    terminalEventObserved: false,
    deadlineExceeded: false,
  });
  assert.equal(resolution.disposition, "UNKNOWN");
  assert.equal(resolution.allowedLeaseTarget, "BLOCKED");
});

test("U2 (timeout): resolveAmbiguousLocalRunDisposition returns UNKNOWN/BLOCKED when the tracked deadline is exceeded while still CONNECTED", () => {
  const resolution = resolveAmbiguousLocalRunDisposition({
    leaseStatus: "CHECKPOINTED",
    connectionState: "CONNECTED",
    terminalEventObserved: false,
    deadlineExceeded: true,
  });
  assert.equal(resolution.disposition, "UNKNOWN");
  assert.equal(resolution.allowedLeaseTarget, "BLOCKED");
});

test("U3: resolveAmbiguousLocalRunDisposition never overrides a real terminal event, even if the connection later drops", () => {
  const resolution = resolveAmbiguousLocalRunDisposition({
    leaseStatus: "RUNNING",
    connectionState: "DISCONNECTED",
    terminalEventObserved: true,
    deadlineExceeded: true,
  });
  assert.equal(resolution.disposition, "NOT_APPLICABLE");
});

test("U4 (cancel race): resolveAmbiguousLocalRunDisposition never reopens an already-terminal (e.g. CANCELLED) lease", () => {
  const resolution = resolveAmbiguousLocalRunDisposition({
    leaseStatus: "CANCELLED",
    connectionState: "DISCONNECTED",
    terminalEventObserved: false,
    deadlineExceeded: true,
  });
  assert.equal(resolution.disposition, "NOT_APPLICABLE");
});

test("C1 (cancel race, direct): once a lease is CANCELLED a later attempt to transition it to SUCCEEDED throws", () => {
  const device = freshDevice();
  const worker = freshWorker(device);
  const lease = createLocalTaskLease({ leaseId: "lease-c1", taskRef: "task-c1", worker, device });
  const leased = transitionLocalTaskLease({ lease, to: "LEASED" });
  const running = transitionLocalTaskLease({ lease: leased, to: "RUNNING" });
  const cancelled = transitionLocalTaskLease({ lease: running, to: "CANCELLED" });
  assert.equal(cancelled.status, "CANCELLED");
  assert.throws(
    () => transitionLocalTaskLease({ lease: cancelled, to: "SUCCEEDED" }),
    InvalidLocalTaskLeaseTransitionError,
  );
});

test("F1 (false success, direct): resolveClaudeRunOutcome throws on TASK_COMPLETED with an empty evidenceRef", () => {
  assert.throws(
    () => resolveClaudeRunOutcome({ claudeEventKind: "TASK_COMPLETED", evidenceRef: "" }),
    InvalidClaudeAdapterError,
  );
  assert.throws(
    () => resolveClaudeRunOutcome({ claudeEventKind: "TASK_COMPLETED", evidenceRef: undefined }),
    InvalidClaudeAdapterError,
  );
  const real = resolveClaudeRunOutcome({ claudeEventKind: "TASK_COMPLETED", evidenceRef: "ev-real" });
  assert.equal(real.outcome, "SUCCEEDED");
});

test("R1 (restart/resume composition): RUNNING -> CHECKPOINTED -> RUNNING(RESUME w/ priorSessionRef) -> TASK_COMPLETED", () => {
  const device = freshDevice();
  const worker = freshWorker(device);
  const policy = createDevicePolicy({ device, allowedWorkspaceRootRefs: ["/workspace"], maxRiskLevel: "STANDARD" });
  const lease = createLocalTaskLease({ leaseId: "lease-r1", taskRef: "task-r1", worker, device });
  const leased = transitionLocalTaskLease({ lease, to: "LEASED" });
  const running = transitionLocalTaskLease({ lease: leased, to: "RUNNING" });

  const checkpointRecord = createClaudeCheckpointRecord({
    lease: running,
    checkpointRef: "ckpt-r1",
    capturedAt: "2026-10-09T10:00:00Z",
    evidenceRef: "ev-ckpt-r1",
    claudeSessionRef: "claude-session-r1",
  });
  const checkpointed = transitionLocalTaskLease({
    lease: running,
    to: "CHECKPOINTED",
    workspaceCheckpointRef: checkpointRecord.checkpoint.checkpointRef,
  });
  assert.equal(checkpointed.workspaceCheckpointRef, "ckpt-r1");

  const resumedLease = transitionLocalTaskLease({ lease: checkpointed, to: "RUNNING" });
  assert.equal(resumedLease.status, "RUNNING");

  const resumeRequest = createClaudeRunRequest({
    lease: resumedLease,
    devicePolicy: policy,
    workingDirectoryRef: "/workspace",
    mode: "RESUME",
    priorSessionRef: checkpointRecord.claudeSessionRef,
    permissionMode: "DEFAULT",
    allowedToolRefs: [],
  });
  assert.equal(resumeRequest.mode, "RESUME");
  assert.equal(resumeRequest.priorSessionRef, "claude-session-r1");

  const outcome = resolveClaudeRunOutcome({
    claudeEventKind: "TASK_COMPLETED",
    evidenceRef: "ev-final-r1",
    checkpointRef: checkpointRecord.checkpoint.checkpointRef,
  });
  assert.equal(outcome.outcome, "SUCCEEDED");
  assert.equal(outcome.checkpointRef, "ckpt-r1");

  const completed = transitionLocalTaskLease({ lease: resumedLease, to: "SUCCEEDED" });
  assert.equal(completed.status, "SUCCEEDED");
});

test("B1 (tool/workspace boundary, cross-adapter): a disallowed workspace root is rejected identically by both adapters", () => {
  const device = freshDevice();
  const worker = freshWorker(device);
  const policy = createDevicePolicy({ device, allowedWorkspaceRootRefs: ["/allowed"], maxRiskLevel: "STANDARD" });
  const lease = createLocalTaskLease({ leaseId: "lease-b1", taskRef: "task-b1", worker, device });
  const leased = transitionLocalTaskLease({ lease, to: "LEASED" });
  const running = transitionLocalTaskLease({ lease: leased, to: "RUNNING" });

  assert.throws(
    () =>
      createClaudeRunRequest({
        lease: running,
        devicePolicy: policy,
        workingDirectoryRef: "/not-allowed",
        mode: "START",
        permissionMode: "DEFAULT",
        allowedToolRefs: [],
      }),
    InvalidClaudeAdapterError,
  );
  assert.throws(
    () =>
      createCodexRunRequest({
        lease: running,
        devicePolicy: policy,
        workingDirectoryRef: "/not-allowed",
        mode: "START",
        sandboxMode: "READ_ONLY",
        approvalPolicy: "ON_REQUEST",
        networkPolicy: "DISABLED",
      }),
    Error,
  );

  const allowedClaude = createClaudeRunRequest({
    lease: running,
    devicePolicy: policy,
    workingDirectoryRef: "/allowed",
    mode: "START",
    permissionMode: "DEFAULT",
    allowedToolRefs: [],
  });
  assert.equal(allowedClaude.workingDirectoryRef, "/allowed");
});

test("UNS1 (unsupported/policy-blocked never simulates success): neither adapter reports AVAILABLE/READY under POLICY_BLOCKED, NOT_AUTHENTICATED, or EXHAUSTED usage", () => {
  const blockedPolicy = { disposition: "POLICY_BLOCKED" as const, checkedAt: "2026-10-09T10:00:00Z", reason: "commercial terms unresolved" };
  assert.equal(
    resolveClaudeAdapterCapabilityReadiness({ policyCheck: blockedPolicy, authReadiness: "READY_API_KEY" }),
    "POLICY_BLOCKED",
  );
  assert.equal(
    resolveClaudeRunReadiness({ policyCheck: blockedPolicy, authReadiness: "READY_API_KEY" }).status,
    "NOT_READY",
  );

  const safePolicy = { disposition: "POLICY_SAFE" as const, checkedAt: "2026-10-09T10:00:00Z", reason: "approved" };
  assert.equal(
    resolveClaudeAdapterCapabilityReadiness({ policyCheck: safePolicy, authReadiness: "NOT_AUTHENTICATED" }),
    "AUTH_REQUIRED",
  );
  assert.equal(
    resolveClaudeAdapterCapabilityReadiness({
      policyCheck: safePolicy,
      authReadiness: "READY_API_KEY",
      usageLimitStatus: { windowKind: "FIVE_HOUR", remainingFraction: 0 },
    }),
    "USAGE_LIMITED",
  );

  assert.equal(resolveCodexRunReadiness({ authReadiness: "NOT_AUTHENTICATED" }).status, "NOT_READY");
});
