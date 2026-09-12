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
  resolveClaudeAdapterPolicyCheck,
  resolveClaudeRunReadiness,
  createClaudeRunRequest,
  resolveClaudeUsageLimitDisposition,
  mapClaudeRunEventKindToBridgeMessageKind,
  resolveClaudeRunOutcome,
  createClaudeCheckpointRecord,
  resolveClaudeAdapterCapabilityReadiness,
  InvalidClaudeAdapterError,
  type ClaudeAdapterPolicyCheck,
} from "../src/domain/claude-local-adapter.js";

const tenantScope = createTenantScope("tenant-claude-1");

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
    adapterKind: "claude",
    declaredCapabilityRefs: ["cap:code-edit"],
    declaredToolRefs: ["tool:claude-code-cli"],
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

function safePolicyCheck(): ClaudeAdapterPolicyCheck {
  return resolveClaudeAdapterPolicyCheck({
    disposition: "POLICY_SAFE",
    checkedAt: "2026-09-12T00:00:00.000Z",
    reason: "ADR-0003: local single-machine officially-authenticated CLI automation",
  });
}

function blockedPolicyCheck(): ClaudeAdapterPolicyCheck {
  return resolveClaudeAdapterPolicyCheck({
    disposition: "POLICY_BLOCKED",
    checkedAt: "2026-09-12T00:00:00.000Z",
    reason: "provider terms changed materially",
  });
}

// --- resolveClaudeAdapterPolicyCheck ---

test("P1: resolveClaudeAdapterPolicyCheck builds a valid POLICY_SAFE check", () => {
  const check = safePolicyCheck();
  assert.equal(check.disposition, "POLICY_SAFE");
});

test("P2 (adversarial): resolveClaudeAdapterPolicyCheck rejects an unrecognized disposition", () => {
  assert.throws(
    () =>
      resolveClaudeAdapterPolicyCheck({
        disposition: "MAYBE_SAFE",
        checkedAt: "2026-09-12T00:00:00.000Z",
        reason: "x",
      }),
    InvalidClaudeAdapterError,
  );
});

// --- resolveClaudeRunReadiness ---

test("C1: resolveClaudeRunReadiness is READY for a subscription-session-authenticated device under a POLICY_SAFE check", () => {
  const readiness = resolveClaudeRunReadiness({
    policyCheck: safePolicyCheck(),
    authReadiness: "READY_SUBSCRIPTION_SESSION",
  });
  assert.equal(readiness.status, "READY");
});

test("C2: resolveClaudeRunReadiness is READY for an API-key-authenticated device under a POLICY_SAFE check", () => {
  const readiness = resolveClaudeRunReadiness({
    policyCheck: safePolicyCheck(),
    authReadiness: "READY_API_KEY",
  });
  assert.equal(readiness.status, "READY");
});

test("C3: resolveClaudeRunReadiness is NOT_READY for an unauthenticated device", () => {
  const readiness = resolveClaudeRunReadiness({
    policyCheck: safePolicyCheck(),
    authReadiness: "NOT_AUTHENTICATED",
  });
  assert.equal(readiness.status, "NOT_READY");
});

test("C4 (adversarial): resolveClaudeRunReadiness rejects an unrecognized authReadiness value", () => {
  assert.throws(
    () => resolveClaudeRunReadiness({ policyCheck: safePolicyCheck(), authReadiness: "some-other-status" }),
    InvalidClaudeAdapterError,
  );
});

test("C5 (never a credential): ClaudeAuthReadinessStatus values carry no token/cookie shape - only the three closed status strings are ever accepted", () => {
  assert.throws(
    () => resolveClaudeRunReadiness({ policyCheck: safePolicyCheck(), authReadiness: "sk-fake-api-key-value" }),
    InvalidClaudeAdapterError,
  );
});

test("C6 (ADR-0003 adversarial): resolveClaudeRunReadiness is NOT_READY when the policy check is POLICY_BLOCKED, even with a fully authenticated session - policy is checked before auth, never bypassable", () => {
  const readiness = resolveClaudeRunReadiness({
    policyCheck: blockedPolicyCheck(),
    authReadiness: "READY_SUBSCRIPTION_SESSION",
  });
  assert.equal(readiness.status, "NOT_READY");
  assert.match(readiness.reason, /policy blocked/);
});

test("C6b (ADR-0003 adversarial): resolveClaudeRunReadiness returns the policy-blocked NOT_READY result without even validating a malformed authReadiness - a blocked policy short-circuits before auth shape is inspected at all", () => {
  const readiness = resolveClaudeRunReadiness({
    policyCheck: blockedPolicyCheck(),
    authReadiness: "totally-malformed-value",
  });
  assert.equal(readiness.status, "NOT_READY");
  assert.match(readiness.reason, /policy blocked/);
});

// --- createClaudeRunRequest ---

function baseRunRequestInput(overrides?: Partial<Parameters<typeof createClaudeRunRequest>[0]>) {
  const l = lease();
  const device = onlineDevice();
  return {
    lease: l,
    devicePolicy: devicePolicy(device),
    workingDirectoryRef: "/workspace/project-a",
    mode: "START" as const,
    permissionMode: "ACCEPT_EDITS" as const,
    allowedToolRefs: ["tool:claude-code-cli"],
    ...overrides,
  };
}

test("C7: createClaudeRunRequest builds a valid START request with an allowed workspace root", () => {
  const request = createClaudeRunRequest(baseRunRequestInput());
  assert.equal(request.mode, "START");
  assert.equal(request.workingDirectoryRef, "/workspace/project-a");
  assert.equal(request.priorSessionRef, undefined);
});

test("C8: createClaudeRunRequest builds a valid RESUME request with a priorSessionRef", () => {
  const request = createClaudeRunRequest(
    baseRunRequestInput({ mode: "RESUME", priorSessionRef: "session-abc" }),
  );
  assert.equal(request.mode, "RESUME");
  assert.equal(request.priorSessionRef, "session-abc");
});

test("C9 (adversarial): createClaudeRunRequest rejects a RESUME with no priorSessionRef", () => {
  assert.throws(
    () => createClaudeRunRequest(baseRunRequestInput({ mode: "RESUME" })),
    InvalidClaudeAdapterError,
  );
});

test("C10 (adversarial): createClaudeRunRequest rejects a START that carries a priorSessionRef", () => {
  assert.throws(
    () => createClaudeRunRequest(baseRunRequestInput({ mode: "START", priorSessionRef: "stale-session" })),
    InvalidClaudeAdapterError,
  );
});

test("C11 (adversarial, reuses isWorkspaceRootAllowed unmodified): createClaudeRunRequest rejects a workingDirectoryRef outside the device policy's allowlist", () => {
  assert.throws(
    () => createClaudeRunRequest(baseRunRequestInput({ workingDirectoryRef: "/etc" })),
    InvalidClaudeAdapterError,
  );
});

test("C12: createClaudeRunRequest rejects an unrecognized permissionMode", () => {
  assert.throws(
    () =>
      createClaudeRunRequest(
        baseRunRequestInput({ permissionMode: "GOD_MODE" as unknown as "ACCEPT_EDITS" }),
      ),
    InvalidClaudeAdapterError,
  );
});

test("C13 (adversarial): createClaudeRunRequest rejects a non-array allowedToolRefs", () => {
  assert.throws(
    () =>
      createClaudeRunRequest(
        baseRunRequestInput({ allowedToolRefs: "tool:claude-code-cli" as unknown as ReadonlyArray<string> }),
      ),
    InvalidClaudeAdapterError,
  );
});

test("C14: createClaudeRunRequest accepts an empty allowedToolRefs array - no implicit all-tools default is fabricated by omission", () => {
  const request = createClaudeRunRequest(baseRunRequestInput({ allowedToolRefs: [] }));
  assert.deepEqual(request.allowedToolRefs, []);
});

// --- resolveClaudeUsageLimitDisposition ---

test("C15: resolveClaudeUsageLimitDisposition is AVAILABLE for a positive remaining fraction", () => {
  assert.equal(
    resolveClaudeUsageLimitDisposition({ windowKind: "FIVE_HOUR", remainingFraction: 0.4 }),
    "AVAILABLE",
  );
});

test("C16: resolveClaudeUsageLimitDisposition is EXHAUSTED at exactly zero remaining", () => {
  assert.equal(
    resolveClaudeUsageLimitDisposition({ windowKind: "WEEKLY", remainingFraction: 0 }),
    "EXHAUSTED",
  );
});

test("C17 (adversarial): resolveClaudeUsageLimitDisposition rejects a negative fraction", () => {
  assert.throws(
    () => resolveClaudeUsageLimitDisposition({ windowKind: "FIVE_HOUR", remainingFraction: -0.1 }),
    InvalidClaudeAdapterError,
  );
});

test("C18 (adversarial): resolveClaudeUsageLimitDisposition rejects a fraction greater than 1", () => {
  assert.throws(
    () => resolveClaudeUsageLimitDisposition({ windowKind: "FIVE_HOUR", remainingFraction: 1.5 }),
    InvalidClaudeAdapterError,
  );
});

// --- mapClaudeRunEventKindToBridgeMessageKind ---

test("C19: mapClaudeRunEventKindToBridgeMessageKind projects every Claude event kind onto an existing, recognized bridge message kind", () => {
  const pairs: Array<[string, string]> = [
    ["TASK_STARTED", "RUN_STARTED"],
    ["AGENT_MESSAGE", "RUN_EVENT"],
    ["TOOL_PERMISSION_REQUESTED", "PERMISSION_REQUEST"],
    ["TOOL_PERMISSION_DECIDED", "PERMISSION_DECISION"],
    ["USAGE_REPORTED", "RUN_EVENT"],
    ["TASK_COMPLETED", "RUN_COMPLETED"],
    ["TASK_FAILED", "RUN_FAILED"],
    ["TASK_CANCELLED", "CANCEL"],
  ];
  for (const [claudeKind, bridgeKind] of pairs) {
    assert.equal(
      mapClaudeRunEventKindToBridgeMessageKind(
        claudeKind as Parameters<typeof mapClaudeRunEventKindToBridgeMessageKind>[0],
      ),
      bridgeKind,
    );
  }
});

// --- resolveClaudeRunOutcome ---

test("C20: resolveClaudeRunOutcome binds TASK_COMPLETED to SUCCEEDED", () => {
  const result = resolveClaudeRunOutcome({ claudeEventKind: "TASK_COMPLETED", evidenceRef: "evidence:run-1" });
  assert.equal(result.outcome, "SUCCEEDED");
  assert.equal(result.evidenceRef, "evidence:run-1");
});

test("C21: resolveClaudeRunOutcome binds TASK_FAILED to FAILED", () => {
  const result = resolveClaudeRunOutcome({ claudeEventKind: "TASK_FAILED", evidenceRef: "evidence:run-2" });
  assert.equal(result.outcome, "FAILED");
});

test("C22: resolveClaudeRunOutcome binds TASK_CANCELLED to BLOCKED", () => {
  const result = resolveClaudeRunOutcome({ claudeEventKind: "TASK_CANCELLED", evidenceRef: "evidence:run-3" });
  assert.equal(result.outcome, "BLOCKED");
});

test("C23 (adversarial): resolveClaudeRunOutcome rejects a non-terminal event kind", () => {
  assert.throws(
    () => resolveClaudeRunOutcome({ claudeEventKind: "AGENT_MESSAGE", evidenceRef: "evidence:x" }),
    InvalidClaudeAdapterError,
  );
});

test("C24 (adversarial): resolveClaudeRunOutcome rejects an empty evidenceRef", () => {
  assert.throws(
    () => resolveClaudeRunOutcome({ claudeEventKind: "TASK_COMPLETED", evidenceRef: "" }),
    InvalidClaudeAdapterError,
  );
});

test("C25: resolveClaudeRunOutcome carries an optional checkpointRef through when supplied", () => {
  const result = resolveClaudeRunOutcome({
    claudeEventKind: "TASK_COMPLETED",
    evidenceRef: "evidence:run-4",
    checkpointRef: "checkpoint-4",
  });
  assert.equal(result.checkpointRef, "checkpoint-4");
});

// --- createClaudeCheckpointRecord ---

test("C26: createClaudeCheckpointRecord delegates to createLocalTaskCheckpoint and adds claudeSessionRef", () => {
  const running = transitionLocalTaskLease({
    lease: transitionLocalTaskLease({ lease: lease(), to: "LEASED" }),
    to: "RUNNING",
  });
  const record = createClaudeCheckpointRecord({
    lease: running,
    checkpointRef: "checkpoint-1",
    capturedAt: "2026-01-01T00:00:00.000Z",
    evidenceRef: "evidence:checkpoint-1",
    claudeSessionRef: "session-xyz",
  });
  assert.equal(record.checkpoint.checkpointRef, "checkpoint-1");
  assert.equal(record.claudeSessionRef, "session-xyz");
});

test("C27 (adversarial, reuses createLocalTaskCheckpoint unmodified): createClaudeCheckpointRecord fails closed on a QUEUED lease, same as the underlying checkpoint gate", () => {
  assert.throws(
    () =>
      createClaudeCheckpointRecord({
        lease: lease(),
        checkpointRef: "checkpoint-1",
        capturedAt: "2026-01-01T00:00:00.000Z",
        evidenceRef: "evidence:checkpoint-1",
        claudeSessionRef: "session-xyz",
      }),
    // the underlying local-execution.ts error, not this module's own
    Error,
  );
});

// --- resolveClaudeAdapterCapabilityReadiness ---

test("C28: resolveClaudeAdapterCapabilityReadiness is AVAILABLE for a POLICY_SAFE, authenticated, non-exhausted device", () => {
  const readiness = resolveClaudeAdapterCapabilityReadiness({
    policyCheck: safePolicyCheck(),
    authReadiness: "READY_SUBSCRIPTION_SESSION",
    usageLimitStatus: { windowKind: "FIVE_HOUR", remainingFraction: 0.5 },
  });
  assert.equal(readiness, "AVAILABLE");
});

test("C29 (ADR-0003): resolveClaudeAdapterCapabilityReadiness is POLICY_BLOCKED before any other dimension is even consulted", () => {
  const readiness = resolveClaudeAdapterCapabilityReadiness({
    policyCheck: blockedPolicyCheck(),
    authReadiness: "READY_SUBSCRIPTION_SESSION",
    usageLimitStatus: { windowKind: "FIVE_HOUR", remainingFraction: 0.5 },
  });
  assert.equal(readiness, "POLICY_BLOCKED");
});

test("C29b (ADR-0003 adversarial): resolveClaudeAdapterCapabilityReadiness returns POLICY_BLOCKED without validating a malformed authReadiness at all - policy short-circuits before auth shape is inspected", () => {
  const readiness = resolveClaudeAdapterCapabilityReadiness({
    policyCheck: blockedPolicyCheck(),
    authReadiness: "totally-malformed-value",
  });
  assert.equal(readiness, "POLICY_BLOCKED");
});

test("C30: resolveClaudeAdapterCapabilityReadiness is AUTH_REQUIRED when unauthenticated, even under a POLICY_SAFE check", () => {
  const readiness = resolveClaudeAdapterCapabilityReadiness({
    policyCheck: safePolicyCheck(),
    authReadiness: "NOT_AUTHENTICATED",
  });
  assert.equal(readiness, "AUTH_REQUIRED");
});

test("C31: resolveClaudeAdapterCapabilityReadiness is USAGE_LIMITED when authenticated but the usage window is exhausted", () => {
  const readiness = resolveClaudeAdapterCapabilityReadiness({
    policyCheck: safePolicyCheck(),
    authReadiness: "READY_SUBSCRIPTION_SESSION",
    usageLimitStatus: { windowKind: "WEEKLY", remainingFraction: 0 },
  });
  assert.equal(readiness, "USAGE_LIMITED");
});

test("C32: resolveClaudeAdapterCapabilityReadiness is AVAILABLE when no usageLimitStatus is supplied at all", () => {
  const readiness = resolveClaudeAdapterCapabilityReadiness({
    policyCheck: safePolicyCheck(),
    authReadiness: "READY_API_KEY",
  });
  assert.equal(readiness, "AVAILABLE");
});
