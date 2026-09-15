import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  registerDevice,
  markDeviceOnline,
  createDevicePolicy,
  createLocalWorkerRegistration,
  createLocalTaskLease,
  transitionLocalTaskLease,
} from "../src/domain/local-execution.js";
import {
  resolveCodexRunReadiness,
  createCodexRunRequest,
  resolveCodexUsageLimitDisposition,
  mapCodexRunEventKindToBridgeMessageKind,
  resolveCodexRunOutcome,
  createCodexCheckpointRecord,
  InvalidCodexAdapterError,
} from "../src/domain/codex-local-adapter.js";

const tenantScope = createTenantScope("tenant-codex-1");

function onlineDevice() {
  return markDeviceOnline(
    registerDevice({
      tenantScope,
      deviceId: "device-1",
      ownerMembershipRef: "owner-1",
      publicKeyFingerprint: "fingerprint-1",
      platform: "linux",
      bridgeVersion: "0.1.0",
    }),
  );
}

function devicePolicy(device: ReturnType<typeof onlineDevice>) {
  return createDevicePolicy({
    device,
    allowedWorkspaceRootRefs: ["/workspace/project-a"],
    maxRiskLevel: "STANDARD",
  });
}

function worker(device: ReturnType<typeof onlineDevice>) {
  return createLocalWorkerRegistration({
    workerId: "worker-1",
    device,
    ownerMembershipRef: "owner-1",
    adapterKind: "codex",
    declaredCapabilityRefs: ["cap:code-edit"],
    declaredToolRefs: ["tool:codex-cli"],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: "evidence:eval-1",
    poolMode: "PRIVATE",
    boundProjectOwnerships: [],
  });
}

function lease() {
  const device = onlineDevice();
  return createLocalTaskLease({
    leaseId: "lease-1",
    taskRef: "task-1",
    worker: worker(device),
    device,
  });
}

// --- resolveCodexRunReadiness ---

test("C1: resolveCodexRunReadiness is READY for a ChatGPT-session-authenticated device", () => {
  const readiness = resolveCodexRunReadiness({ authReadiness: "READY_CHATGPT_SESSION" });
  assert.equal(readiness.status, "READY");
});

test("C2: resolveCodexRunReadiness is READY for an API-key-authenticated device", () => {
  const readiness = resolveCodexRunReadiness({ authReadiness: "READY_API_KEY" });
  assert.equal(readiness.status, "READY");
});

test("C3: resolveCodexRunReadiness is NOT_READY for an unauthenticated device", () => {
  const readiness = resolveCodexRunReadiness({ authReadiness: "NOT_AUTHENTICATED" });
  assert.equal(readiness.status, "NOT_READY");
});

test("C4 (adversarial): resolveCodexRunReadiness rejects an unrecognized authReadiness value", () => {
  assert.throws(
    () => resolveCodexRunReadiness({ authReadiness: "some-other-status" }),
    InvalidCodexAdapterError,
  );
});

test("C5 (never a credential): CodexAuthReadinessStatus values carry no token/cookie shape - only the three closed status strings are ever accepted", () => {
  assert.throws(
    () => resolveCodexRunReadiness({ authReadiness: "sk-fake-api-key-value" }),
    InvalidCodexAdapterError,
  );
});

// --- createCodexRunRequest ---

function baseRunRequestInput(overrides?: Partial<Parameters<typeof createCodexRunRequest>[0]>) {
  const l = lease();
  const device = onlineDevice();
  return {
    lease: l,
    devicePolicy: devicePolicy(device),
    workingDirectoryRef: "/workspace/project-a",
    mode: "START" as const,
    sandboxMode: "WORKSPACE_WRITE" as const,
    approvalPolicy: "ON_REQUEST" as const,
    networkPolicy: "DISABLED" as const,
    ...overrides,
  };
}

test("C6: createCodexRunRequest builds a valid START request with an allowed workspace root", () => {
  const request = createCodexRunRequest(baseRunRequestInput());
  assert.equal(request.mode, "START");
  assert.equal(request.workingDirectoryRef, "/workspace/project-a");
  assert.equal(request.priorSessionRef, undefined);
});

test("C7: createCodexRunRequest builds a valid RESUME request with a priorSessionRef", () => {
  const request = createCodexRunRequest(
    baseRunRequestInput({ mode: "RESUME", priorSessionRef: "session-abc" }),
  );
  assert.equal(request.mode, "RESUME");
  assert.equal(request.priorSessionRef, "session-abc");
});

test("C8 (adversarial): createCodexRunRequest rejects a RESUME with no priorSessionRef", () => {
  assert.throws(
    () => createCodexRunRequest(baseRunRequestInput({ mode: "RESUME" })),
    InvalidCodexAdapterError,
  );
});

test("C9 (adversarial): createCodexRunRequest rejects a START that carries a priorSessionRef", () => {
  assert.throws(
    () => createCodexRunRequest(baseRunRequestInput({ mode: "START", priorSessionRef: "stale-session" })),
    InvalidCodexAdapterError,
  );
});

test("C10 (adversarial, reuses isWorkspaceRootAllowed unmodified): createCodexRunRequest rejects a workingDirectoryRef outside the device policy's allowlist", () => {
  assert.throws(
    () => createCodexRunRequest(baseRunRequestInput({ workingDirectoryRef: "/etc" })),
    InvalidCodexAdapterError,
  );
});

test("C11: createCodexRunRequest rejects an unrecognized sandboxMode", () => {
  assert.throws(
    () =>
      createCodexRunRequest(
        baseRunRequestInput({ sandboxMode: "FULL_TRUST" as unknown as "WORKSPACE_WRITE" }),
      ),
    InvalidCodexAdapterError,
  );
});

test("C12: createCodexRunRequest rejects an unrecognized approvalPolicy", () => {
  assert.throws(
    () =>
      createCodexRunRequest(
        baseRunRequestInput({ approvalPolicy: "ALWAYS" as unknown as "ON_REQUEST" }),
      ),
    InvalidCodexAdapterError,
  );
});

test("C13: createCodexRunRequest rejects an unrecognized networkPolicy", () => {
  assert.throws(
    () =>
      createCodexRunRequest(
        baseRunRequestInput({ networkPolicy: "MAYBE" as unknown as "DISABLED" }),
      ),
    InvalidCodexAdapterError,
  );
});

// --- resolveCodexUsageLimitDisposition ---

test("C14: resolveCodexUsageLimitDisposition is AVAILABLE for a positive remaining fraction", () => {
  assert.equal(
    resolveCodexUsageLimitDisposition({ windowKind: "FIVE_HOUR", remainingFraction: 0.4 }),
    "AVAILABLE",
  );
});

test("C15: resolveCodexUsageLimitDisposition is EXHAUSTED at exactly zero remaining", () => {
  assert.equal(
    resolveCodexUsageLimitDisposition({ windowKind: "WEEKLY", remainingFraction: 0 }),
    "EXHAUSTED",
  );
});

test("C16 (adversarial): resolveCodexUsageLimitDisposition rejects a negative fraction", () => {
  assert.throws(
    () => resolveCodexUsageLimitDisposition({ windowKind: "FIVE_HOUR", remainingFraction: -0.1 }),
    InvalidCodexAdapterError,
  );
});

test("C17 (adversarial): resolveCodexUsageLimitDisposition rejects a fraction greater than 1", () => {
  assert.throws(
    () => resolveCodexUsageLimitDisposition({ windowKind: "FIVE_HOUR", remainingFraction: 1.5 }),
    InvalidCodexAdapterError,
  );
});

// --- mapCodexRunEventKindToBridgeMessageKind ---

test("C18: mapCodexRunEventKindToBridgeMessageKind projects every Codex event kind onto an existing, recognized bridge message kind", () => {
  const pairs: Array<[string, string]> = [
    ["TASK_STARTED", "RUN_STARTED"],
    ["AGENT_MESSAGE", "RUN_EVENT"],
    ["APPROVAL_REQUESTED", "PERMISSION_REQUEST"],
    ["APPROVAL_DECIDED", "PERMISSION_DECISION"],
    ["USAGE_REPORTED", "RUN_EVENT"],
    ["TASK_COMPLETED", "RUN_COMPLETED"],
    ["TASK_FAILED", "RUN_FAILED"],
    ["TASK_CANCELLED", "CANCEL"],
  ];
  for (const [codexKind, bridgeKind] of pairs) {
    assert.equal(
      mapCodexRunEventKindToBridgeMessageKind(codexKind as Parameters<typeof mapCodexRunEventKindToBridgeMessageKind>[0]),
      bridgeKind,
    );
  }
});

// --- resolveCodexRunOutcome ---

test("C19: resolveCodexRunOutcome binds TASK_COMPLETED to SUCCEEDED", () => {
  const result = resolveCodexRunOutcome({ codexEventKind: "TASK_COMPLETED", evidenceRef: "evidence:run-1" });
  assert.equal(result.outcome, "SUCCEEDED");
  assert.equal(result.evidenceRef, "evidence:run-1");
});

test("C20: resolveCodexRunOutcome binds TASK_FAILED to FAILED", () => {
  const result = resolveCodexRunOutcome({ codexEventKind: "TASK_FAILED", evidenceRef: "evidence:run-2" });
  assert.equal(result.outcome, "FAILED");
});

test("C21: resolveCodexRunOutcome binds TASK_CANCELLED to BLOCKED", () => {
  const result = resolveCodexRunOutcome({ codexEventKind: "TASK_CANCELLED", evidenceRef: "evidence:run-3" });
  assert.equal(result.outcome, "BLOCKED");
});

test("C22 (adversarial): resolveCodexRunOutcome rejects a non-terminal event kind", () => {
  assert.throws(
    () => resolveCodexRunOutcome({ codexEventKind: "AGENT_MESSAGE", evidenceRef: "evidence:x" }),
    InvalidCodexAdapterError,
  );
});

test("C23 (adversarial): resolveCodexRunOutcome rejects an empty evidenceRef", () => {
  assert.throws(
    () => resolveCodexRunOutcome({ codexEventKind: "TASK_COMPLETED", evidenceRef: "" }),
    InvalidCodexAdapterError,
  );
});

test("C24: resolveCodexRunOutcome carries an optional checkpointRef through when supplied", () => {
  const result = resolveCodexRunOutcome({
    codexEventKind: "TASK_COMPLETED",
    evidenceRef: "evidence:run-4",
    checkpointRef: "checkpoint-4",
  });
  assert.equal(result.checkpointRef, "checkpoint-4");
});

// --- createCodexCheckpointRecord ---

test("C25: createCodexCheckpointRecord delegates to createLocalTaskCheckpoint and adds codexSessionRef", () => {
  const running = transitionLocalTaskLease({
    lease: transitionLocalTaskLease({ lease: lease(), to: "LEASED" }),
    to: "RUNNING",
  });
  const record = createCodexCheckpointRecord({
    lease: running,
    checkpointRef: "checkpoint-1",
    capturedAt: "2026-01-01T00:00:00.000Z",
    evidenceRef: "evidence:checkpoint-1",
    codexSessionRef: "session-xyz",
  });
  assert.equal(record.checkpoint.checkpointRef, "checkpoint-1");
  assert.equal(record.codexSessionRef, "session-xyz");
});

test("C26 (adversarial, reuses createLocalTaskCheckpoint unmodified): createCodexCheckpointRecord fails closed on a QUEUED lease, same as the underlying checkpoint gate", () => {
  assert.throws(
    () =>
      createCodexCheckpointRecord({
        lease: lease(),
        checkpointRef: "checkpoint-1",
        capturedAt: "2026-01-01T00:00:00.000Z",
        evidenceRef: "evidence:checkpoint-1",
        codexSessionRef: "session-xyz",
      }),
    Error,
  );
});

test("C27 (adversarial): createCodexCheckpointRecord rejects an empty codexSessionRef", () => {
  const running = transitionLocalTaskLease({
    lease: transitionLocalTaskLease({ lease: lease(), to: "LEASED" }),
    to: "RUNNING",
  });
  assert.throws(
    () =>
      createCodexCheckpointRecord({
        lease: running,
        checkpointRef: "checkpoint-1",
        capturedAt: "2026-01-01T00:00:00.000Z",
        evidenceRef: "evidence:checkpoint-1",
        codexSessionRef: "",
      }),
    InvalidCodexAdapterError,
  );
});
