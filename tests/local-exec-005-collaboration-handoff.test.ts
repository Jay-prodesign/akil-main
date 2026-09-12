import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  createExecutionPolicy,
  registerDevice,
  markDeviceOnline,
  createLocalWorkerRegistration,
  createLocalTaskLease,
  transitionLocalTaskLease,
  createLocalTaskCheckpoint,
  type DeviceRegistration,
  type LocalWorkerRegistration,
} from "../src/domain/local-execution.js";
import {
  planCollaborationModeTransition,
  createWorkspaceBinding,
  createWorkspaceSnapshotPackage,
  claimSharedRepoBranch,
  verifySharedRepoBaseBeforeContinuing,
  createTaskPacket,
  rehydrateTaskPacketForHandoff,
  resolveLocalExecutionFailover,
  InvalidCollaborationTransitionError,
  InvalidWorkspaceSnapshotError,
  InvalidSharedRepoLeaseError,
  InvalidTaskPacketError,
  InvalidLocalFailoverError,
  type SharedRepoBranchClaim,
} from "../src/domain/local-execution-collaboration.js";

const tenantScope = createTenantScope("tenant-collab-1");
const targetOwnership = createProjectOwnershipRef({
  tenantId: "tenant-collab-1",
  customerId: "customer-1",
  projectId: "project-1",
});

function onlineDevice(seed: string, ownerMembershipRef = "owner-1"): DeviceRegistration {
  const device = registerDevice({
    tenantScope,
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
    adapterKind: string;
    ownerMembershipRef: string;
    boundProjectOwnerships: ReadonlyArray<ReturnType<typeof createProjectOwnershipRef>>;
  }>,
): LocalWorkerRegistration {
  return createLocalWorkerRegistration({
    workerId: `worker-${seed}`,
    device,
    ownerMembershipRef: overrides?.ownerMembershipRef ?? device.ownerMembershipRef,
    adapterKind: overrides?.adapterKind ?? "CODEX_LOCAL",
    declaredCapabilityRefs: ["cap:code-edit"],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: `evidence-${seed}`,
    poolMode: "PRIVATE",
    boundProjectOwnerships: overrides?.boundProjectOwnerships ?? [],
  });
}

function runningCheckpoint(worker: LocalWorkerRegistration, device: DeviceRegistration, seed: string) {
  const lease = createLocalTaskLease({ leaseId: `lease-${seed}`, taskRef: `task-${seed}`, worker, device });
  const leased = transitionLocalTaskLease({ lease, to: "LEASED" });
  const running = transitionLocalTaskLease({ lease: leased, to: "RUNNING" });
  const checkpoint = createLocalTaskCheckpoint({
    lease: running,
    checkpointRef: `checkpoint-${seed}`,
    capturedAt: "2026-09-12T00:00:00.000Z",
    evidenceRef: `evidence-checkpoint-${seed}`,
  });
  return { lease: running, checkpoint };
}

function taskPacket() {
  return createTaskPacket({
    taskId: "task-1",
    projectOwnership: targetOwnership,
    goal: "Implement LOCAL-EXEC-005",
    acceptanceCriteria: ["all acceptance cases pass"],
    protectedGateRefs: [],
    baseIdentity: "main@abc123",
    relevantFileRefs: ["src/domain/local-execution-collaboration.ts"],
    completedWork: ["domain module"],
    remainingWork: ["docs"],
    evidenceRefs: ["evidence-1"],
    blockers: [],
    nextAuthorizedAction: "write tests",
  });
}

// --- planCollaborationModeTransition ---

test("C1: PRIVATE -> SHARED_ARTIFACT is WIDENING and discloses newly visible refs and resources", () => {
  const preflight = planCollaborationModeTransition({
    from: "PRIVATE",
    to: "SHARED_ARTIFACT",
    newlyVisibleToRefs: ["worker-2"],
    visibleResourceRefs: ["file:src/domain/local-execution-collaboration.ts"],
  });
  assert.equal(preflight.direction, "WIDENING");
  assert.deepEqual(preflight.newlyVisibleToRefs, ["worker-2"]);
  assert.deepEqual(preflight.visibleResourceRefs, ["file:src/domain/local-execution-collaboration.ts"]);
  assert.match(preflight.disclosure, /worker-2/);
  assert.match(preflight.disclosure, /local-execution-collaboration\.ts/);
});

test("C1b (Rev108 adversarial): a widening transition with an empty newlyVisibleToRefs fails closed - visibility cannot widen to no one", () => {
  assert.throws(
    () =>
      planCollaborationModeTransition({
        from: "PRIVATE",
        to: "SHARED_ARTIFACT",
        newlyVisibleToRefs: [],
        visibleResourceRefs: ["file:x"],
      }),
    InvalidCollaborationTransitionError,
  );
});

test("C1c (Rev108 adversarial): a widening transition with an empty visibleResourceRefs fails closed - visibility cannot widen to nothing", () => {
  assert.throws(
    () =>
      planCollaborationModeTransition({
        from: "PRIVATE",
        to: "SHARED_ARTIFACT",
        newlyVisibleToRefs: ["worker-2"],
        visibleResourceRefs: [],
      }),
    InvalidCollaborationTransitionError,
  );
});

test("C2: SHARED_REPO -> PRIVATE is NARROWING and always states data already downloaded cannot be forgotten", () => {
  const preflight = planCollaborationModeTransition({
    from: "SHARED_REPO",
    to: "PRIVATE",
    newlyVisibleToRefs: [],
    visibleResourceRefs: [],
  });
  assert.equal(preflight.direction, "NARROWING");
  assert.match(preflight.disclosure, /cannot make any worker\/device.*forget it/);
});

test("C3: same mode -> same mode is UNCHANGED", () => {
  const preflight = planCollaborationModeTransition({
    from: "ISOLATED_PROJECT",
    to: "ISOLATED_PROJECT",
    newlyVisibleToRefs: [],
    visibleResourceRefs: [],
  });
  assert.equal(preflight.direction, "UNCHANGED");
});

test("C4: unrecognized CollaborationMode fails closed", () => {
  assert.throws(
    () =>
      planCollaborationModeTransition({
        from: "PRIVATE",
        to: "BOGUS" as never,
        newlyVisibleToRefs: [],
        visibleResourceRefs: [],
      }),
    InvalidCollaborationTransitionError,
  );
});

// --- WorkspaceBinding ---

test("C5: LOCAL_FOLDER binding requires only a workspaceRootRef", () => {
  const binding = createWorkspaceBinding({ kind: "LOCAL_FOLDER", workspaceRootRef: "/home/user/project" });
  assert.equal(binding.kind, "LOCAL_FOLDER");
  assert.equal(binding.branchRef, undefined);
});

test("C6: GIT_WORKTREE_SHARED_REPO binding requires a non-empty branchRef", () => {
  assert.throws(
    () => createWorkspaceBinding({ kind: "GIT_WORKTREE_SHARED_REPO", workspaceRootRef: "/repo" }),
    InvalidCollaborationTransitionError,
  );
  const binding = createWorkspaceBinding({ kind: "GIT_WORKTREE_SHARED_REPO", workspaceRootRef: "/repo", branchRef: "feature-x" });
  assert.equal(binding.branchRef, "feature-x");
});

// --- WorkspaceSnapshotPackage ---

test("C7: createWorkspaceSnapshotPackage only permitted under SHARED_ARTIFACT", () => {
  const device = onlineDevice("s1");
  const worker = makeWorker("s1", device);
  const { checkpoint } = runningCheckpoint(worker, device, "s1");
  assert.throws(
    () => createWorkspaceSnapshotPackage({ collaborationMode: "PRIVATE", checkpoint, snapshotVersion: 1 }),
    InvalidWorkspaceSnapshotError,
  );
  const pkg = createWorkspaceSnapshotPackage({ collaborationMode: "SHARED_ARTIFACT", checkpoint, snapshotVersion: 1 });
  assert.equal(pkg.snapshotVersion, 1);
  assert.equal(pkg.checkpointRef, checkpoint.checkpointRef);
  assert.equal(pkg.diffRef, undefined);
});

test("C8: createWorkspaceSnapshotPackage rejects a non-positive-integer snapshotVersion", () => {
  const device = onlineDevice("s2");
  const worker = makeWorker("s2", device);
  const { checkpoint } = runningCheckpoint(worker, device, "s2");
  assert.throws(
    () => createWorkspaceSnapshotPackage({ collaborationMode: "SHARED_ARTIFACT", checkpoint, snapshotVersion: 0 }),
    InvalidWorkspaceSnapshotError,
  );
});

// --- SharedRepoBranchClaim ---

const otherOwnership = createProjectOwnershipRef({
  tenantId: "tenant-collab-1",
  customerId: "customer-1",
  projectId: "project-other",
});

test("C9: claimSharedRepoBranch grants an unclaimed branch to a worker bound to the target project", () => {
  const device = onlineDevice("b1");
  const worker = makeWorker("b1", device, { boundProjectOwnerships: [targetOwnership] });
  const { lease } = runningCheckpoint(worker, device, "b1");
  const claims = claimSharedRepoBranch({ branchRef: "feature-x", lease, worker, targetOwnership, existingClaims: [] });
  assert.deepEqual(claims, [{ branchRef: "feature-x", leaseId: lease.leaseId, accessVerified: false }]);
});

test("C9e (Rev109 adversarial): a caller-supplied boundProjectOwnerships alone can never produce accessVerified: true - even a worker self-declared for the exact target project only ever gets a structurally-false claim", () => {
  const device = onlineDevice("b1v");
  // Self-declared by the caller at worker-registration time (see
  // local-execution-staff-binding.ts) - not backed by any independent
  // repository-access grant. Passing isBoundToTargetOwnership proves only
  // declared-scope consistency, never authorization.
  const worker = makeWorker("b1v", device, { boundProjectOwnerships: [targetOwnership] });
  const { lease } = runningCheckpoint(worker, device, "b1v");
  const claims = claimSharedRepoBranch({ branchRef: "feature-x", lease, worker, targetOwnership, existingClaims: [] });
  assert.equal(claims[0]?.accessVerified, false);
  // No SharedRepoBranchClaim value this module can construct has any other
  // shape for this field - proving by construction, not merely by this one
  // input, that a self-declared project binding alone cannot authorize
  // SHARED_REPO access.
  assert.ok(claims.every((claim) => claim.accessVerified === false));
});

test("C9b (Rev108 adversarial): claimSharedRepoBranch fails closed when the worker is not bound to the target project - a bare branch/lease claim is never itself authority", () => {
  const device = onlineDevice("b1u");
  const worker = makeWorker("b1u", device, { boundProjectOwnerships: [] });
  const { lease } = runningCheckpoint(worker, device, "b1u");
  assert.throws(
    () => claimSharedRepoBranch({ branchRef: "feature-x", lease, worker, targetOwnership, existingClaims: [] }),
    InvalidSharedRepoLeaseError,
  );
});

test("C9c (Rev108 adversarial): claimSharedRepoBranch fails closed when the worker is bound to a different project than the one being claimed for", () => {
  const device = onlineDevice("b1d");
  const worker = makeWorker("b1d", device, { boundProjectOwnerships: [otherOwnership] });
  const { lease } = runningCheckpoint(worker, device, "b1d");
  assert.throws(
    () => claimSharedRepoBranch({ branchRef: "feature-x", lease, worker, targetOwnership, existingClaims: [] }),
    InvalidSharedRepoLeaseError,
  );
});

test("C9d (Rev108 adversarial): claimSharedRepoBranch fails closed when the supplied worker does not match the lease's own workerId", () => {
  const device = onlineDevice("b1w");
  const worker = makeWorker("b1w", device, { boundProjectOwnerships: [targetOwnership] });
  const otherWorker = makeWorker("b1w-other", device, { boundProjectOwnerships: [targetOwnership] });
  const { lease } = runningCheckpoint(worker, device, "b1w");
  assert.throws(
    () => claimSharedRepoBranch({ branchRef: "feature-x", lease, worker: otherWorker, targetOwnership, existingClaims: [] }),
    InvalidSharedRepoLeaseError,
  );
});

test("C10: claimSharedRepoBranch fails closed on a second concurrent writer for the same branch", () => {
  const device = onlineDevice("b2");
  const workerA = makeWorker("b2a", device, { boundProjectOwnerships: [targetOwnership] });
  const workerB = makeWorker("b2b", device, { boundProjectOwnerships: [targetOwnership] });
  const { lease: leaseA } = runningCheckpoint(workerA, device, "b2a");
  const { lease: leaseB } = runningCheckpoint(workerB, device, "b2b");
  const existingClaims: ReadonlyArray<SharedRepoBranchClaim> = [
    { branchRef: "feature-x", leaseId: leaseA.leaseId, accessVerified: false },
  ];
  assert.throws(
    () => claimSharedRepoBranch({ branchRef: "feature-x", lease: leaseB, worker: workerB, targetOwnership, existingClaims }),
    InvalidSharedRepoLeaseError,
  );
});

test("C11: claimSharedRepoBranch is idempotent for the same lease re-claiming its own branch", () => {
  const device = onlineDevice("b3");
  const worker = makeWorker("b3", device, { boundProjectOwnerships: [targetOwnership] });
  const { lease } = runningCheckpoint(worker, device, "b3");
  const first = claimSharedRepoBranch({ branchRef: "feature-x", lease, worker, targetOwnership, existingClaims: [] });
  const second = claimSharedRepoBranch({ branchRef: "feature-x", lease, worker, targetOwnership, existingClaims: first });
  assert.deepEqual(second, [{ branchRef: "feature-x", leaseId: lease.leaseId, accessVerified: false }]);
});

// --- verifySharedRepoBaseBeforeContinuing ---

test("C12: verifySharedRepoBaseBeforeContinuing passes when observed matches actual head", () => {
  assert.equal(verifySharedRepoBaseBeforeContinuing({ observedHeadRef: "sha-1", actualHeadRef: "sha-1" }), true);
});

test("C13: verifySharedRepoBaseBeforeContinuing fails closed on any mismatch", () => {
  assert.throws(
    () => verifySharedRepoBaseBeforeContinuing({ observedHeadRef: "sha-1", actualHeadRef: "sha-2" }),
    InvalidSharedRepoLeaseError,
  );
});

// --- TaskPacket ---

test("C14: createTaskPacket carries exactly the packet's §12 fields, rejecting empty required arrays elements", () => {
  const packet = taskPacket();
  assert.equal(packet.taskId, "task-1");
  assert.equal(packet.priorWorkerFinalSummary, undefined);
  assert.throws(
    () =>
      createTaskPacket({
        taskId: "task-2",
        projectOwnership: targetOwnership,
        goal: "x",
        acceptanceCriteria: [""],
        protectedGateRefs: [],
        baseIdentity: "main@abc",
        relevantFileRefs: [],
        completedWork: [],
        remainingWork: [],
        evidenceRefs: [],
        blockers: [],
        nextAuthorizedAction: "y",
      }),
    InvalidTaskPacketError,
  );
});

test("C15: createTaskPacket accepts an optional priorWorkerFinalSummary as a plain string", () => {
  const packet = createTaskPacket({
    taskId: "task-3",
    projectOwnership: targetOwnership,
    goal: "x",
    acceptanceCriteria: [],
    protectedGateRefs: [],
    baseIdentity: "main@abc",
    relevantFileRefs: [],
    completedWork: [],
    remainingWork: [],
    evidenceRefs: [],
    blockers: [],
    nextAuthorizedAction: "y",
    priorWorkerFinalSummary: "Handed off after implementing the domain contracts.",
  });
  assert.equal(packet.priorWorkerFinalSummary, "Handed off after implementing the domain contracts.");
});

// --- rehydrateTaskPacketForHandoff ---

test("C16: same provider + same device with a nativeThreadRef resumes the native thread", () => {
  const device = onlineDevice("h1");
  const worker = makeWorker("h1", device);
  const handoff = rehydrateTaskPacketForHandoff({
    taskPacket: taskPacket(),
    fromWorker: worker,
    toWorker: worker,
    nativeThreadRef: "thread-abc",
  });
  assert.equal(handoff.kind, "RESUME_NATIVE_THREAD");
  assert.equal(handoff.nativeThreadRef, "thread-abc");
});

test("C17: different device always yields a fresh hydration, never a thread-copy attempt", () => {
  const deviceA = onlineDevice("h2a");
  const deviceB = onlineDevice("h2b");
  const workerA = makeWorker("h2a", deviceA);
  const workerB = makeWorker("h2b", deviceB);
  const handoff = rehydrateTaskPacketForHandoff({
    taskPacket: taskPacket(),
    fromWorker: workerA,
    toWorker: workerB,
    nativeThreadRef: "thread-abc",
  });
  assert.equal(handoff.kind, "FRESH_HYDRATION");
  assert.equal(handoff.nativeThreadRef, undefined);
});

test("C18: different provider (adapterKind) on the same device also yields a fresh hydration", () => {
  const device = onlineDevice("h3");
  const codexWorker = makeWorker("h3codex", device, { adapterKind: "CODEX_LOCAL" });
  const claudeWorker = makeWorker("h3claude", device, { adapterKind: "CLAUDE_LOCAL" });
  const handoff = rehydrateTaskPacketForHandoff({
    taskPacket: taskPacket(),
    fromWorker: codexWorker,
    toWorker: claudeWorker,
    nativeThreadRef: "thread-abc",
  });
  assert.equal(handoff.kind, "FRESH_HYDRATION");
});

test("C19: same provider/device but no nativeThreadRef still yields a fresh hydration", () => {
  const device = onlineDevice("h4");
  const worker = makeWorker("h4", device);
  const handoff = rehydrateTaskPacketForHandoff({
    taskPacket: taskPacket(),
    fromWorker: worker,
    toWorker: worker,
  });
  assert.equal(handoff.kind, "FRESH_HYDRATION");
});

// --- resolveLocalExecutionFailover ---

function failoverExecutionPolicy() {
  return createExecutionPolicy({ tenantScope, executionMode: "PERSONAL_LOCAL", collaborationMode: "PRIVATE" });
}

test("F1: resolveLocalExecutionFailover selects the next eligible worker under the same requirements", () => {
  const device = onlineDevice("f1", "owner-f1");
  const primary = makeWorker("f1-primary", device, { ownerMembershipRef: "owner-f1" });
  const fallback = makeWorker("f1-fallback", device, { ownerMembershipRef: "owner-f1" });
  const { lease, checkpoint } = runningCheckpoint(primary, device, "f1");
  const checkpointed = transitionLocalTaskLease({ lease, to: "CHECKPOINTED", workspaceCheckpointRef: checkpoint.checkpointRef });
  const result = resolveLocalExecutionFailover({
    outgoingWorker: primary,
    checkpoint,
    currentLease: checkpointed,
    expectedTaskRef: lease.taskRef,
    reason: "USAGE_LIMITED",
    executionPolicy: failoverExecutionPolicy(),
    registrations: [primary, fallback],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership,
    requestingOwnerMembershipRef: "owner-f1",
    requiredCapabilityRef: "cap:code-edit",
    riskLevel: "STANDARD",
    requiredToolRefs: [],
    requiredPolicyConstraintRefs: [],
    requiredAuthorityLevel: "STANDARD",
    evidenceRef: "evidence-failover-1",
  });
  assert.equal(result.outgoingWorkerId, primary.workerId);
  assert.equal(result.incomingWorker.workerId, fallback.workerId);
  assert.equal(result.checkpointRef, checkpoint.checkpointRef);
  assert.equal(result.endedLease.status, "CANCELLED");
  assert.equal(result.endedLease.leaseId, lease.leaseId);
});

test("F2: resolveLocalExecutionFailover fails closed while the external-effect state is UNKNOWN - no blind retry on another worker", () => {
  const device = onlineDevice("f2", "owner-f2");
  const primary = makeWorker("f2-primary", device, { ownerMembershipRef: "owner-f2" });
  const fallback = makeWorker("f2-fallback", device, { ownerMembershipRef: "owner-f2" });
  const { lease, checkpoint } = runningCheckpoint(primary, device, "f2");
  const checkpointed = transitionLocalTaskLease({ lease, to: "CHECKPOINTED", workspaceCheckpointRef: checkpoint.checkpointRef });
  assert.throws(
    () =>
      resolveLocalExecutionFailover({
        outgoingWorker: primary,
        checkpoint,
        currentLease: checkpointed,
        expectedTaskRef: lease.taskRef,
        reason: "OFFLINE",
        externalEffectState: "UNKNOWN",
        executionPolicy: failoverExecutionPolicy(),
        registrations: [primary, fallback],
        requestingTenantId: tenantScope.tenantId,
        targetOwnership,
        requestingOwnerMembershipRef: "owner-f2",
        requiredCapabilityRef: "cap:code-edit",
        riskLevel: "STANDARD",
        requiredToolRefs: [],
        requiredPolicyConstraintRefs: [],
        requiredAuthorityLevel: "STANDARD",
        evidenceRef: "evidence-failover-2",
      }),
    InvalidLocalFailoverError,
  );
});

test("F3: resolveLocalExecutionFailover fails closed when no other eligible worker exists", () => {
  const device = onlineDevice("f3", "owner-f3");
  const primary = makeWorker("f3-primary", device, { ownerMembershipRef: "owner-f3" });
  const { lease, checkpoint } = runningCheckpoint(primary, device, "f3");
  const checkpointed = transitionLocalTaskLease({ lease, to: "CHECKPOINTED", workspaceCheckpointRef: checkpoint.checkpointRef });
  assert.throws(
    () =>
      resolveLocalExecutionFailover({
        outgoingWorker: primary,
        checkpoint,
        currentLease: checkpointed,
        expectedTaskRef: lease.taskRef,
        reason: "DEGRADED",
        executionPolicy: failoverExecutionPolicy(),
        registrations: [primary],
        requestingTenantId: tenantScope.tenantId,
        targetOwnership,
        requestingOwnerMembershipRef: "owner-f3",
        requiredCapabilityRef: "cap:code-edit",
        riskLevel: "STANDARD",
        requiredToolRefs: [],
        requiredPolicyConstraintRefs: [],
        requiredAuthorityLevel: "STANDARD",
        evidenceRef: "evidence-failover-3",
      }),
    InvalidLocalFailoverError,
  );
});

test("F4: resolveLocalExecutionFailover never silently routes to a different employee's PRIVATE worker", () => {
  const device = onlineDevice("f4", "owner-f4");
  const otherDevice = onlineDevice("f4-other", "owner-other");
  const primary = makeWorker("f4-primary", device, { ownerMembershipRef: "owner-f4" });
  const otherEmployeeWorker = makeWorker("f4-other-worker", otherDevice, { ownerMembershipRef: "owner-other" });
  const { lease, checkpoint } = runningCheckpoint(primary, device, "f4");
  const checkpointed = transitionLocalTaskLease({ lease, to: "CHECKPOINTED", workspaceCheckpointRef: checkpoint.checkpointRef });
  assert.throws(
    () =>
      resolveLocalExecutionFailover({
        outgoingWorker: primary,
        checkpoint,
        currentLease: checkpointed,
        expectedTaskRef: lease.taskRef,
        reason: "OFFLINE",
        executionPolicy: failoverExecutionPolicy(),
        registrations: [primary, otherEmployeeWorker],
        requestingTenantId: tenantScope.tenantId,
        targetOwnership,
        requestingOwnerMembershipRef: "owner-f4",
        requiredCapabilityRef: "cap:code-edit",
        riskLevel: "STANDARD",
        requiredToolRefs: [],
        requiredPolicyConstraintRefs: [],
        requiredAuthorityLevel: "STANDARD",
        evidenceRef: "evidence-failover-4",
      }),
    InvalidLocalFailoverError,
  );
});

test("F5: resolveLocalExecutionFailover requires a non-empty evidenceRef", () => {
  const device = onlineDevice("f5", "owner-f5");
  const primary = makeWorker("f5-primary", device, { ownerMembershipRef: "owner-f5" });
  const fallback = makeWorker("f5-fallback", device, { ownerMembershipRef: "owner-f5" });
  const { lease, checkpoint } = runningCheckpoint(primary, device, "f5");
  const checkpointed = transitionLocalTaskLease({ lease, to: "CHECKPOINTED", workspaceCheckpointRef: checkpoint.checkpointRef });
  assert.throws(
    () =>
      resolveLocalExecutionFailover({
        outgoingWorker: primary,
        checkpoint,
        currentLease: checkpointed,
        expectedTaskRef: lease.taskRef,
        reason: "USAGE_LIMITED",
        executionPolicy: failoverExecutionPolicy(),
        registrations: [primary, fallback],
        requestingTenantId: tenantScope.tenantId,
        targetOwnership,
        requestingOwnerMembershipRef: "owner-f5",
        requiredCapabilityRef: "cap:code-edit",
        riskLevel: "STANDARD",
        requiredToolRefs: [],
        requiredPolicyConstraintRefs: [],
        requiredAuthorityLevel: "STANDARD",
        evidenceRef: "",
      }),
    InvalidCollaborationTransitionError,
  );
});

// --- Rev108 correction (F1 - failover checkpoint/lease lineage) ---

test("F6 (Rev108 adversarial): resolveLocalExecutionFailover fails closed when the checkpoint's leaseId does not match the supplied currentLease - a foreign checkpoint cannot authorize failover", () => {
  const device = onlineDevice("f6", "owner-f6");
  const primary = makeWorker("f6-primary", device, { ownerMembershipRef: "owner-f6" });
  const fallback = makeWorker("f6-fallback", device, { ownerMembershipRef: "owner-f6" });
  const { lease: leaseA, checkpoint: checkpointA } = runningCheckpoint(primary, device, "f6a");
  const { lease: leaseB } = runningCheckpoint(primary, device, "f6b");
  const checkpointedB = transitionLocalTaskLease({ lease: leaseB, to: "CHECKPOINTED", workspaceCheckpointRef: "cp" });
  assert.throws(
    () =>
      resolveLocalExecutionFailover({
        outgoingWorker: primary,
        checkpoint: checkpointA,
        currentLease: checkpointedB,
        expectedTaskRef: leaseB.taskRef,
        reason: "OFFLINE",
        executionPolicy: failoverExecutionPolicy(),
        registrations: [primary, fallback],
        requestingTenantId: tenantScope.tenantId,
        targetOwnership,
        requestingOwnerMembershipRef: "owner-f6",
        requiredCapabilityRef: "cap:code-edit",
        riskLevel: "STANDARD",
        requiredToolRefs: [],
        requiredPolicyConstraintRefs: [],
        requiredAuthorityLevel: "STANDARD",
        evidenceRef: "evidence-failover-6",
      }),
    InvalidLocalFailoverError,
  );
});

test("F7 (Rev108 adversarial): resolveLocalExecutionFailover fails closed when currentLease.workerId does not match the outgoing worker - cross-worker substitution", () => {
  const device = onlineDevice("f7", "owner-f7");
  const primary = makeWorker("f7-primary", device, { ownerMembershipRef: "owner-f7" });
  const otherWorker = makeWorker("f7-other", device, { ownerMembershipRef: "owner-f7" });
  const fallback = makeWorker("f7-fallback", device, { ownerMembershipRef: "owner-f7" });
  const { lease, checkpoint } = runningCheckpoint(otherWorker, device, "f7");
  const checkpointed = transitionLocalTaskLease({ lease, to: "CHECKPOINTED", workspaceCheckpointRef: checkpoint.checkpointRef });
  assert.throws(
    () =>
      resolveLocalExecutionFailover({
        outgoingWorker: primary,
        checkpoint,
        currentLease: checkpointed,
        expectedTaskRef: lease.taskRef,
        reason: "OFFLINE",
        executionPolicy: failoverExecutionPolicy(),
        registrations: [primary, otherWorker, fallback],
        requestingTenantId: tenantScope.tenantId,
        targetOwnership,
        requestingOwnerMembershipRef: "owner-f7",
        requiredCapabilityRef: "cap:code-edit",
        riskLevel: "STANDARD",
        requiredToolRefs: [],
        requiredPolicyConstraintRefs: [],
        requiredAuthorityLevel: "STANDARD",
        evidenceRef: "evidence-failover-7",
      }),
    InvalidLocalFailoverError,
  );
});

test("F8 (Rev108 adversarial): resolveLocalExecutionFailover fails closed when currentLease.tenantId does not match requestingTenantId - cross-tenant substitution", () => {
  const otherTenantScope = createTenantScope("tenant-collab-other");
  const device = onlineDevice("f8", "owner-f8");
  const primary = makeWorker("f8-primary", device, { ownerMembershipRef: "owner-f8" });
  const fallback = makeWorker("f8-fallback", device, { ownerMembershipRef: "owner-f8" });
  const { lease, checkpoint } = runningCheckpoint(primary, device, "f8");
  const checkpointed = transitionLocalTaskLease({ lease, to: "CHECKPOINTED", workspaceCheckpointRef: checkpoint.checkpointRef });
  assert.throws(
    () =>
      resolveLocalExecutionFailover({
        outgoingWorker: primary,
        checkpoint,
        currentLease: checkpointed,
        expectedTaskRef: lease.taskRef,
        reason: "OFFLINE",
        executionPolicy: failoverExecutionPolicy(),
        registrations: [primary, fallback],
        requestingTenantId: otherTenantScope.tenantId,
        targetOwnership,
        requestingOwnerMembershipRef: "owner-f8",
        requiredCapabilityRef: "cap:code-edit",
        riskLevel: "STANDARD",
        requiredToolRefs: [],
        requiredPolicyConstraintRefs: [],
        requiredAuthorityLevel: "STANDARD",
        evidenceRef: "evidence-failover-8",
      }),
    InvalidLocalFailoverError,
  );
});

test("F9 (Rev108 adversarial): resolveLocalExecutionFailover fails closed when currentLease.taskRef does not match expectedTaskRef - cross-task substitution", () => {
  const device = onlineDevice("f9", "owner-f9");
  const primary = makeWorker("f9-primary", device, { ownerMembershipRef: "owner-f9" });
  const fallback = makeWorker("f9-fallback", device, { ownerMembershipRef: "owner-f9" });
  const { lease, checkpoint } = runningCheckpoint(primary, device, "f9");
  const checkpointed = transitionLocalTaskLease({ lease, to: "CHECKPOINTED", workspaceCheckpointRef: checkpoint.checkpointRef });
  assert.throws(
    () =>
      resolveLocalExecutionFailover({
        outgoingWorker: primary,
        checkpoint,
        currentLease: checkpointed,
        expectedTaskRef: "some-other-task",
        reason: "OFFLINE",
        executionPolicy: failoverExecutionPolicy(),
        registrations: [primary, fallback],
        requestingTenantId: tenantScope.tenantId,
        targetOwnership,
        requestingOwnerMembershipRef: "owner-f9",
        requiredCapabilityRef: "cap:code-edit",
        riskLevel: "STANDARD",
        requiredToolRefs: [],
        requiredPolicyConstraintRefs: [],
        requiredAuthorityLevel: "STANDARD",
        evidenceRef: "evidence-failover-9",
      }),
    InvalidLocalFailoverError,
  );
});

test("F10 (Rev108 adversarial): resolveLocalExecutionFailover fails closed when currentLease is not CHECKPOINTED - the checkpoint step must have just completed, not be an unrelated historical record", () => {
  const device = onlineDevice("f10", "owner-f10");
  const primary = makeWorker("f10-primary", device, { ownerMembershipRef: "owner-f10" });
  const fallback = makeWorker("f10-fallback", device, { ownerMembershipRef: "owner-f10" });
  const { lease, checkpoint } = runningCheckpoint(primary, device, "f10");
  assert.throws(
    () =>
      resolveLocalExecutionFailover({
        outgoingWorker: primary,
        checkpoint,
        currentLease: lease,
        expectedTaskRef: lease.taskRef,
        reason: "OFFLINE",
        executionPolicy: failoverExecutionPolicy(),
        registrations: [primary, fallback],
        requestingTenantId: tenantScope.tenantId,
        targetOwnership,
        requestingOwnerMembershipRef: "owner-f10",
        requiredCapabilityRef: "cap:code-edit",
        riskLevel: "STANDARD",
        requiredToolRefs: [],
        requiredPolicyConstraintRefs: [],
        requiredAuthorityLevel: "STANDARD",
        evidenceRef: "evidence-failover-10",
      }),
    InvalidLocalFailoverError,
  );
});
