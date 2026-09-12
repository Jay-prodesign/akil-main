import type { TenantScope } from "./tenant-scope.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { AdmittedWorker, WorkerRiskLevel, WorkerAuthorityLevel } from "./worker-routing-policy.js";
import { resolveWorkerRoute } from "./worker-routing-policy.js";
import type {
  CollaborationMode,
  LocalTaskLease,
  LocalTaskCheckpoint,
  LocalWorkerRegistration,
} from "./local-execution.js";
import { resolveEligibleLocalWorkers, toAdmittedWorker } from "./local-execution.js";
import type { ExternalEffectAttemptState } from "./external-effect-envelope.js";

export class InvalidCollaborationTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid CollaborationMode transition: ${reason}`);
    this.name = "InvalidCollaborationTransitionError";
  }
}

export class InvalidWorkspaceSnapshotError extends Error {
  constructor(reason: string) {
    super(`Invalid WorkspaceSnapshotPackage: ${reason}`);
    this.name = "InvalidWorkspaceSnapshotError";
  }
}

export class InvalidSharedRepoLeaseError extends Error {
  constructor(reason: string) {
    super(`Invalid shared-repo lease claim: ${reason}`);
    this.name = "InvalidSharedRepoLeaseError";
  }
}

export class InvalidTaskPacketError extends Error {
  constructor(reason: string) {
    super(`Invalid TaskPacket: ${reason}`);
    this.name = "InvalidTaskPacketError";
  }
}

export class InvalidLocalFailoverError extends Error {
  constructor(reason: string) {
    super(`Invalid local-execution failover: ${reason}`);
    this.name = "InvalidLocalFailoverError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidCollaborationTransitionError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * LOCAL-EXEC-005 (Rev103/105, dedicated architecture packet Drive
 * 1vhHCHZYu15IugytGb2O2epe7jgRFQF6vRoZsozjASDU §12-15) Phase L4 —
 * Collaboration & Cross-Worker Handoff. Composes L0's unmodified
 * `CollaborationMode`/`LocalTaskLease`/`LocalTaskCheckpoint`/
 * `LocalWorkerRegistration` and V4-EFF-001's unmodified
 * `ExternalEffectAttemptState`; no new routing engine, no new IAM
 * primitive, no real Git/transport/crypto anywhere in this module.
 */

const COLLABORATION_RANK: Readonly<Record<CollaborationMode, number>> = {
  PRIVATE: 0,
  ISOLATED_PROJECT: 1,
  SHARED_ARTIFACT: 2,
  SHARED_REPO: 3,
};

/**
 * §14: "Changing PRIVATE -> SHARED requires a preflight showing exactly
 * what project data/code will become visible. Changing SHARED -> PRIVATE
 * stops future access but cannot make a human/device forget data already
 * legitimately downloaded; the UI and audit log must state this
 * honestly." This preflight is the one required artifact of any
 * collaboration-mode transition - it is never optional, in either
 * direction.
 */
export interface CollaborationTransitionPreflight {
  readonly from: CollaborationMode;
  readonly to: CollaborationMode;
  readonly direction: "WIDENING" | "NARROWING" | "UNCHANGED";
  readonly newlyVisibleToRefs: ReadonlyArray<string>;
  readonly disclosure: string;
}

/**
 * `newlyVisibleToRefs` is the set of worker/device refs that will gain
 * access on a widening transition - required (may be empty, never
 * omitted) so a caller cannot silently widen visibility without stating
 * who gains it. A narrowing transition ignores this list entirely (it
 * describes future grants, not the past exposure narrowing can never
 * undo) and always carries the honest "cannot un-download" disclosure
 * §14 requires verbatim.
 */
export function planCollaborationModeTransition(input: {
  from: CollaborationMode;
  to: CollaborationMode;
  newlyVisibleToRefs: ReadonlyArray<unknown>;
}): CollaborationTransitionPreflight {
  const fromRank = COLLABORATION_RANK[input.from];
  const toRank = COLLABORATION_RANK[input.to];
  if (fromRank === undefined || toRank === undefined) {
    throw new InvalidCollaborationTransitionError("from/to must both be recognized CollaborationMode values");
  }
  if (
    !Array.isArray(input.newlyVisibleToRefs) ||
    input.newlyVisibleToRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)
  ) {
    throw new InvalidCollaborationTransitionError(
      "newlyVisibleToRefs must be an array of non-empty strings (an empty array is valid)",
    );
  }
  if (toRank > fromRank) {
    return {
      from: input.from,
      to: input.to,
      direction: "WIDENING",
      newlyVisibleToRefs: input.newlyVisibleToRefs as ReadonlyArray<string>,
      disclosure: `Moving from ${input.from} to ${input.to} makes this project's workspace visible to: ${
        input.newlyVisibleToRefs.length > 0 ? (input.newlyVisibleToRefs as string[]).join(", ") : "(no additional workers named)"
      }.`,
    };
  }
  if (toRank < fromRank) {
    return {
      from: input.from,
      to: input.to,
      direction: "NARROWING",
      newlyVisibleToRefs: [],
      disclosure:
        `Moving from ${input.from} to ${input.to} stops future access, but cannot make any worker/device that already ` +
        `legitimately downloaded this project's data forget it - narrowing is not retroactive.`,
    };
  }
  return {
    from: input.from,
    to: input.to,
    direction: "UNCHANGED",
    newlyVisibleToRefs: [],
    disclosure: `${input.from} to ${input.to} is not a mode change.`,
  };
}

/**
 * §14: the three binding kinds a task's workspace may use. `GIT_WORKTREE_SHARED_REPO`
 * is the packet's own "GIT_WORKTREE / SHARED_REPO" pairing named as one
 * kind, since a worktree binding only exists in service of shared-repo
 * collaboration in this module's scope.
 */
export type WorkspaceBindingKind = "LOCAL_FOLDER" | "GIT_WORKTREE_SHARED_REPO" | "AKILTA_ARTIFACT_SNAPSHOT";

const RECOGNIZED_WORKSPACE_BINDING_KINDS: ReadonlySet<WorkspaceBindingKind> = new Set([
  "LOCAL_FOLDER",
  "GIT_WORKTREE_SHARED_REPO",
  "AKILTA_ARTIFACT_SNAPSHOT",
]);

export interface WorkspaceBinding {
  readonly kind: WorkspaceBindingKind;
  readonly workspaceRootRef: string;
  readonly branchRef?: string;
}

export function createWorkspaceBinding(input: {
  kind: unknown;
  workspaceRootRef: unknown;
  branchRef?: unknown;
}): WorkspaceBinding {
  if (!RECOGNIZED_WORKSPACE_BINDING_KINDS.has(input.kind as WorkspaceBindingKind)) {
    throw new InvalidCollaborationTransitionError(
      `kind must be one of ${Array.from(RECOGNIZED_WORKSPACE_BINDING_KINDS).join(", ")}`,
    );
  }
  const workspaceRootRef = requireNonEmptyString(input.workspaceRootRef, "workspaceRootRef");
  if (input.kind === "GIT_WORKTREE_SHARED_REPO") {
    return { kind: input.kind, workspaceRootRef, branchRef: requireNonEmptyString(input.branchRef, "branchRef") };
  }
  return { kind: input.kind as WorkspaceBindingKind, workspaceRootRef };
}

/**
 * §12/§14: "AKILTA publishes a versioned source/artifact snapshot/diff
 * package and checkpoint... useful where a full shared Git repo is
 * unnecessary." Only meaningful for `SHARED_ARTIFACT` mode - this module
 * never lets a `PRIVATE`/`ISOLATED_PROJECT` collaboration mode produce
 * one, since no sharing was ever authorized in those modes.
 */
export interface WorkspaceSnapshotPackage {
  readonly leaseId: LocalTaskLease["leaseId"];
  readonly snapshotVersion: number;
  readonly diffRef?: string;
  readonly checkpointRef: LocalTaskCheckpoint["checkpointRef"];
}

export function createWorkspaceSnapshotPackage(input: {
  collaborationMode: CollaborationMode;
  checkpoint: LocalTaskCheckpoint;
  snapshotVersion: unknown;
  diffRef?: unknown;
}): WorkspaceSnapshotPackage {
  if (input.collaborationMode !== "SHARED_ARTIFACT") {
    throw new InvalidWorkspaceSnapshotError(
      `a WorkspaceSnapshotPackage can only be published under SHARED_ARTIFACT (current mode: ${input.collaborationMode})`,
    );
  }
  if (typeof input.snapshotVersion !== "number" || !Number.isInteger(input.snapshotVersion) || input.snapshotVersion < 1) {
    throw new InvalidWorkspaceSnapshotError("snapshotVersion must be a positive integer");
  }
  return {
    leaseId: input.checkpoint.leaseId,
    snapshotVersion: input.snapshotVersion,
    ...(input.diffRef === undefined ? {} : { diffRef: requireNonEmptyString(input.diffRef, "diffRef") }),
    checkpointRef: input.checkpoint.checkpointRef,
  };
}

/**
 * §14: "use task branch/worktree/lease strategy to avoid uncontrolled
 * simultaneous writes." A minimal, in-memory mutual-exclusion contract -
 * exactly one lease may hold a given branch at a time; a second
 * concurrent claim fails closed rather than silently queuing or
 * overwriting the first.
 */
export interface SharedRepoBranchClaim {
  readonly branchRef: string;
  readonly leaseId: LocalTaskLease["leaseId"];
}

export function claimSharedRepoBranch(input: {
  branchRef: unknown;
  lease: LocalTaskLease;
  existingClaims: ReadonlyArray<SharedRepoBranchClaim>;
}): ReadonlyArray<SharedRepoBranchClaim> {
  const branchRef = requireNonEmptyString(input.branchRef, "branchRef");
  const conflicting = input.existingClaims.find(
    (claim) => claim.branchRef === branchRef && claim.leaseId !== input.lease.leaseId,
  );
  if (conflicting !== undefined) {
    throw new InvalidSharedRepoLeaseError(
      `branch ${branchRef} is already claimed by lease ${conflicting.leaseId}; a second concurrent writer is not permitted`,
    );
  }
  const withoutThisLease = input.existingClaims.filter((claim) => claim.leaseId !== input.lease.leaseId);
  return [...withoutThisLease, { branchRef, leaseId: input.lease.leaseId }];
}

/**
 * §14: "a worker switching devices should fetch/verify exact base/head
 * before continuing." Fails closed on any mismatch between what the
 * worker last observed and the shared repo's actual current head -
 * never assumes staleness is safe to ignore.
 */
export function verifySharedRepoBaseBeforeContinuing(input: {
  observedHeadRef: unknown;
  actualHeadRef: unknown;
}): true {
  const observedHeadRef = requireNonEmptyString(input.observedHeadRef, "observedHeadRef");
  const actualHeadRef = requireNonEmptyString(input.actualHeadRef, "actualHeadRef");
  if (observedHeadRef !== actualHeadRef) {
    throw new InvalidSharedRepoLeaseError(
      `observed head ${observedHeadRef} does not match the shared repo's actual current head ${actualHeadRef} - fetch and reconcile before continuing`,
    );
  }
  return true;
}

/**
 * §12: the exact TaskPacket field list - "canonical taskId/projectId;
 * exact goal and acceptance criteria; authority/protected gates; current
 * base/branch/SHA or snapshot identity; relevant files/artifacts only;
 * completed work; remaining work; tests/build/evidence; blockers; next
 * authorized action; prior worker final summary/artifacts, not private
 * hidden reasoning." `priorWorkerFinalSummary` is deliberately a plain
 * string, not a transcript/conversation type - nothing in this module
 * can carry raw chain-of-thought.
 */
export interface TaskPacket {
  readonly taskId: string;
  readonly projectOwnership: ProjectOwnershipRef;
  readonly goal: string;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly protectedGateRefs: ReadonlyArray<string>;
  readonly baseIdentity: string;
  readonly relevantFileRefs: ReadonlyArray<string>;
  readonly completedWork: ReadonlyArray<string>;
  readonly remainingWork: ReadonlyArray<string>;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly blockers: ReadonlyArray<string>;
  readonly nextAuthorizedAction: string;
  readonly priorWorkerFinalSummary?: string;
}

function requireStringArray(value: unknown, field: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim().length === 0)) {
    throw new InvalidTaskPacketError(`${field} must be an array of non-empty strings (an empty array is valid)`);
  }
  return value as ReadonlyArray<string>;
}

export function createTaskPacket(input: {
  taskId: unknown;
  projectOwnership: ProjectOwnershipRef;
  goal: unknown;
  acceptanceCriteria: ReadonlyArray<unknown>;
  protectedGateRefs: ReadonlyArray<unknown>;
  baseIdentity: unknown;
  relevantFileRefs: ReadonlyArray<unknown>;
  completedWork: ReadonlyArray<unknown>;
  remainingWork: ReadonlyArray<unknown>;
  evidenceRefs: ReadonlyArray<unknown>;
  blockers: ReadonlyArray<unknown>;
  nextAuthorizedAction: unknown;
  priorWorkerFinalSummary?: unknown;
}): TaskPacket {
  return {
    taskId: requireNonEmptyString(input.taskId, "taskId"),
    projectOwnership: input.projectOwnership,
    goal: requireNonEmptyString(input.goal, "goal"),
    acceptanceCriteria: requireStringArray(input.acceptanceCriteria, "acceptanceCriteria"),
    protectedGateRefs: requireStringArray(input.protectedGateRefs, "protectedGateRefs"),
    baseIdentity: requireNonEmptyString(input.baseIdentity, "baseIdentity"),
    relevantFileRefs: requireStringArray(input.relevantFileRefs, "relevantFileRefs"),
    completedWork: requireStringArray(input.completedWork, "completedWork"),
    remainingWork: requireStringArray(input.remainingWork, "remainingWork"),
    evidenceRefs: requireStringArray(input.evidenceRefs, "evidenceRefs"),
    blockers: requireStringArray(input.blockers, "blockers"),
    nextAuthorizedAction: requireNonEmptyString(input.nextAuthorizedAction, "nextAuthorizedAction"),
    ...(input.priorWorkerFinalSummary === undefined
      ? {}
      : { priorWorkerFinalSummary: requireNonEmptyString(input.priorWorkerFinalSummary, "priorWorkerFinalSummary") }),
  };
}

export type HandoffKind = "RESUME_NATIVE_THREAD" | "FRESH_HYDRATION";

export interface TaskPacketHandoff {
  readonly kind: HandoffKind;
  readonly taskPacket: TaskPacket;
  readonly nativeThreadRef?: string;
}

/**
 * §13: "Same provider + same device: resume native thread/session when
 * supported for efficiency... Different provider or different device: do
 * not attempt to copy private chain-of-thought or entire provider-local
 * conversation database; create a fresh session and hydrate it from the
 * AKILTA TaskPacket + synchronized workspace state + approved evidence/
 * artifacts." `nativeThreadRef` is only ever honored when the provider
 * and device both match the outgoing worker's own values - any mismatch
 * always yields `FRESH_HYDRATION`, never a thread-copy attempt.
 */
export function rehydrateTaskPacketForHandoff(input: {
  taskPacket: TaskPacket;
  fromWorker: Pick<LocalWorkerRegistration, "adapterKind" | "deviceId">;
  toWorker: Pick<LocalWorkerRegistration, "adapterKind" | "deviceId">;
  nativeThreadRef?: unknown;
}): TaskPacketHandoff {
  const sameProviderAndDevice =
    input.fromWorker.adapterKind === input.toWorker.adapterKind && input.fromWorker.deviceId === input.toWorker.deviceId;
  if (sameProviderAndDevice && typeof input.nativeThreadRef === "string" && input.nativeThreadRef.trim().length > 0) {
    return { kind: "RESUME_NATIVE_THREAD", taskPacket: input.taskPacket, nativeThreadRef: input.nativeThreadRef };
  }
  return { kind: "FRESH_HYDRATION", taskPacket: input.taskPacket };
}

export type LocalFailoverReason = "DEGRADED" | "USAGE_LIMITED" | "OFFLINE";

export interface LocalFailoverResult {
  readonly outgoingWorkerId: string;
  readonly incomingWorker: AdmittedWorker;
  readonly reason: LocalFailoverReason;
  readonly checkpointRef: LocalTaskCheckpoint["checkpointRef"];
  readonly evidenceRef: string;
}

/**
 * §15's exact failover sequence, composed entirely from existing,
 * unmodified primitives: (1) the caller must already hold a durable
 * `LocalTaskCheckpoint` for the outgoing lease - this function never
 * fabricates one; (2) `resolveEligibleLocalWorkers` (L0, unmodified)
 * re-derives the SAME eligible candidate set the original routing
 * decision used, so a fallback can never be admitted under relaxed
 * requirements; (3) `resolveWorkerRoute` (V5-WRK-001, unmodified) picks
 * among them; (4) §22 case I - an `UNKNOWN` external-effect state fails
 * closed here before any candidate is even resolved, since retrying
 * (via a different worker) an effect whose real-world outcome is
 * unverified is exactly the "blind retry" the recovery/readback envelope
 * exists to prevent.
 */
export function resolveLocalExecutionFailover(input: {
  outgoingWorker: LocalWorkerRegistration;
  checkpoint: LocalTaskCheckpoint;
  reason: LocalFailoverReason;
  externalEffectState?: ExternalEffectAttemptState;
  executionPolicy: Parameters<typeof resolveEligibleLocalWorkers>[0]["executionPolicy"];
  registrations: ReadonlyArray<LocalWorkerRegistration>;
  requestingTenantId: TenantScope["tenantId"];
  targetOwnership: ProjectOwnershipRef;
  requestingOwnerMembershipRef: string;
  requiredCapabilityRef: string;
  riskLevel: WorkerRiskLevel;
  requiredToolRefs: ReadonlyArray<string>;
  requiredPolicyConstraintRefs: ReadonlyArray<string>;
  requiredAuthorityLevel: WorkerAuthorityLevel;
  evidenceRef: unknown;
}): LocalFailoverResult {
  if (input.externalEffectState === "UNKNOWN") {
    throw new InvalidLocalFailoverError(
      "cannot fail over while the external-effect state is UNKNOWN - verify/recover via the readback envelope first",
    );
  }
  const eligible = resolveEligibleLocalWorkers({
    executionPolicy: input.executionPolicy,
    registrations: input.registrations,
    requestingTenantId: input.requestingTenantId,
    targetOwnership: input.targetOwnership,
    requestingOwnerMembershipRef: input.requestingOwnerMembershipRef,
  });
  const outgoingAsAdmitted = toAdmittedWorker(input.outgoingWorker);
  const candidates = eligible.filter((candidate) => candidate.workerId !== outgoingAsAdmitted.workerId);
  if (candidates.length === 0) {
    throw new InvalidLocalFailoverError("no equally-eligible fallback worker is available");
  }
  const decision = resolveWorkerRoute({
    requiredCapabilityRef: input.requiredCapabilityRef,
    riskLevel: input.riskLevel,
    requiredToolRefs: input.requiredToolRefs,
    requiredPolicyConstraintRefs: input.requiredPolicyConstraintRefs,
    requiredAuthorityLevel: input.requiredAuthorityLevel,
    requiresIndependentReview: false,
    executorCandidates: candidates,
  });
  if (decision.status !== "ROUTED" || decision.executorWorkerId === undefined) {
    throw new InvalidLocalFailoverError(
      `no eligible fallback worker satisfies the same required dimensions (${decision.reason})`,
    );
  }
  const incomingWorker = candidates.find((candidate) => candidate.workerId === decision.executorWorkerId);
  if (incomingWorker === undefined) {
    throw new InvalidLocalFailoverError("routing selected a worker outside the eligible candidate set");
  }
  return {
    outgoingWorkerId: input.outgoingWorker.workerId,
    incomingWorker,
    reason: input.reason,
    checkpointRef: input.checkpoint.checkpointRef,
    evidenceRef: requireNonEmptyString(input.evidenceRef, "evidenceRef"),
  };
}
