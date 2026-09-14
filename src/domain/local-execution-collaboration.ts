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
import { resolveEligibleLocalWorkers, toAdmittedWorker, transitionLocalTaskLease } from "./local-execution.js";
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
  readonly visibleResourceRefs: ReadonlyArray<string>;
  readonly disclosure: string;
}

/**
 * Rev108 correction (F2 - widening preflight must carry a real
 * visibility/resource set): a widening transition previously accepted an
 * empty `newlyVisibleToRefs` and named no resource/artifact set at all,
 * so the preflight did not actually prove what becomes visible to whom -
 * it could be silently vacuous. `newlyVisibleToRefs` (who gains access)
 * and `visibleResourceRefs` (what becomes visible - files/artifacts/
 * repo refs, opaque to this module) are now both required to be
 * non-empty whenever the transition genuinely widens; a caller cannot
 * claim to widen collaboration without naming at least one real
 * recipient and at least one real resource. A narrowing transition
 * ignores both lists entirely (they describe future grants, not the
 * past exposure narrowing can never undo) and always carries the honest
 * "cannot un-download" disclosure §14 requires verbatim.
 */
export function planCollaborationModeTransition(input: {
  from: CollaborationMode;
  to: CollaborationMode;
  newlyVisibleToRefs: ReadonlyArray<unknown>;
  visibleResourceRefs: ReadonlyArray<unknown>;
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
      "newlyVisibleToRefs must be an array of non-empty strings (an empty array is valid unless the transition widens)",
    );
  }
  if (
    !Array.isArray(input.visibleResourceRefs) ||
    input.visibleResourceRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)
  ) {
    throw new InvalidCollaborationTransitionError(
      "visibleResourceRefs must be an array of non-empty strings (an empty array is valid unless the transition widens)",
    );
  }
  if (toRank > fromRank) {
    if (input.newlyVisibleToRefs.length === 0) {
      throw new InvalidCollaborationTransitionError(
        "a widening transition must name at least one recipient in newlyVisibleToRefs - visibility cannot widen to no one",
      );
    }
    if (input.visibleResourceRefs.length === 0) {
      throw new InvalidCollaborationTransitionError(
        "a widening transition must name at least one resource in visibleResourceRefs - visibility cannot widen to nothing",
      );
    }
    const newlyVisibleToRefs = input.newlyVisibleToRefs as ReadonlyArray<string>;
    const visibleResourceRefs = input.visibleResourceRefs as ReadonlyArray<string>;
    return {
      from: input.from,
      to: input.to,
      direction: "WIDENING",
      newlyVisibleToRefs,
      visibleResourceRefs,
      disclosure: `Moving from ${input.from} to ${input.to} makes the following resources visible to ${newlyVisibleToRefs.join(", ")}: ${visibleResourceRefs.join(", ")}.`,
    };
  }
  if (toRank < fromRank) {
    return {
      from: input.from,
      to: input.to,
      direction: "NARROWING",
      newlyVisibleToRefs: [],
      visibleResourceRefs: [],
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
    visibleResourceRefs: [],
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
/**
 * Rev109 correction (F2-B - `accessVerified` is a structural `false`
 * literal, never a runtime flag): see `claimSharedRepoBranch`'s own
 * doc comment for the full rationale. No input to this module can ever
 * make this field `true` - that is the point. A real per-user/device
 * repository-access grant primitive, if one is later explicitly
 * authorized and built, would need its own separate field/type; it is
 * not fabricated here by widening this literal.
 */
export interface SharedRepoBranchClaim {
  readonly branchRef: string;
  readonly leaseId: LocalTaskLease["leaseId"];
  readonly accessVerified: false;
}

/**
 * Rev109 correction: this is a declared-scope consistency check only,
 * never an authorization check - see `claimSharedRepoBranch`'s doc
 * comment. It still catches a worker that was not even nominally
 * registered for this project claiming its branch, which is worth
 * keeping, but it must never be read as proof of granted repository
 * access.
 */
function isBoundToTargetOwnership(worker: LocalWorkerRegistration, targetOwnership: ProjectOwnershipRef): boolean {
  return worker.boundProjectOwnerships.some(
    (bound) =>
      bound.tenantId === targetOwnership.tenantId &&
      bound.customerId === targetOwnership.customerId &&
      bound.projectId === targetOwnership.projectId &&
      bound.serviceRef === targetOwnership.serviceRef,
  );
}

/**
 * Rev108 correction (F2 - shared-repo access must be separately
 * authorized, not just mutually exclusive) claimed
 * `LocalWorkerRegistration.boundProjectOwnerships` was "the semantically
 * compatible existing primitive" proving a worker's shared-repository
 * access was authorized. Rev109 found this overclaimed: independently
 * re-verified against `local-execution-staff-binding.ts`,
 * `boundProjectOwnerships` is itself a bare caller-supplied parameter to
 * `createLocalWorkerRegistrationForAuthenticatedStaff`, never checked
 * against any independent grant - an authenticated organization member
 * can self-declare any `ProjectOwnershipRef` there. Membership
 * authenticates *who* is calling, never *what project access* they
 * hold; treating that self-declaration as a shared-repository access
 * grant would be exactly the caller-supplied-value-as-authority pattern
 * Rev106/Rev108 already forbid elsewhere. A fresh repo-wide search for
 * an existing repository/project access-grant primitive found
 * `OwnershipAssignment` (`ownership-assignment.ts`), but that binds a
 * *business* ownership role (Lead/Deal/Account/Delivery Owner) to a
 * membership - it proves nothing about who may write to a *shared code
 * repository branch* for that project, and reusing it here would be
 * exactly the cross-domain authority mapping Rev106 already forbade for
 * a structurally identical reason (`service-catalog-admission.ts`'s
 * `AdmittedWorker` gate, rejected there as "a different domain ...
 * not reusable here without inventing a new cross-domain authority
 * mapping").
 *
 * Per Rev109's own second remedy, this function remains explicitly
 * coordination-only: it still requires the claiming worker's
 * self-declared `boundProjectOwnerships` to be scope-consistent with
 * `targetOwnership` (catching a worker not even nominally registered
 * for this project), and it still proves mutual exclusion - exactly
 * one lease may hold a branch at a time. But it can never assert that
 * shared-repository access was actually, independently authorized:
 * every returned `SharedRepoBranchClaim.accessVerified` is the
 * structural literal `false`, not a runtime flag any input could set
 * true. Real per-user/device repository-access admission remains
 * explicitly OPEN, not fabricated here - LOCAL-EXEC-005's own SHARED_REPO
 * completion/status is narrowed accordingly (see its exec-plan).
 */
export function claimSharedRepoBranch(input: {
  branchRef: unknown;
  lease: LocalTaskLease;
  worker: LocalWorkerRegistration;
  targetOwnership: ProjectOwnershipRef;
  existingClaims: ReadonlyArray<SharedRepoBranchClaim>;
}): ReadonlyArray<SharedRepoBranchClaim> {
  const branchRef = requireNonEmptyString(input.branchRef, "branchRef");
  if (input.worker.workerId !== input.lease.workerId) {
    throw new InvalidSharedRepoLeaseError("worker.workerId does not match lease.workerId");
  }
  if (!isBoundToTargetOwnership(input.worker, input.targetOwnership)) {
    throw new InvalidSharedRepoLeaseError(
      "worker is not even declared as scoped to targetOwnership - this is a coordination-scope consistency check only, never proof of authorized repository access",
    );
  }
  const conflicting = input.existingClaims.find(
    (claim) => claim.branchRef === branchRef && claim.leaseId !== input.lease.leaseId,
  );
  if (conflicting !== undefined) {
    throw new InvalidSharedRepoLeaseError(
      `branch ${branchRef} is already claimed by lease ${conflicting.leaseId}; a second concurrent writer is not permitted`,
    );
  }
  const withoutThisLease = input.existingClaims.filter((claim) => claim.leaseId !== input.lease.leaseId);
  return [...withoutThisLease, { branchRef, leaseId: input.lease.leaseId, accessVerified: false }];
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
  readonly endedLease: LocalTaskLease;
  readonly evidenceRef: string;
}

/**
 * §15's exact failover sequence, composed entirely from existing,
 * unmodified primitives.
 *
 * Rev108 correction (F1 - failover checkpoint/lease lineage): this
 * function previously accepted a bare `LocalTaskCheckpoint` with no
 * authoritative `LocalTaskLease` to bind it to, so it could not prove
 * the checkpoint actually belonged to the outgoing worker/device/tenant/
 * task, nor that the current lease was deterministically ended before a
 * replacement was selected - falling short of §15's own sequence
 * ("current-worker durable checkpoint -> current lease ended/expired
 * deterministically -> worker degraded/offline -> unchanged-requirement
 * routing"). This is now a required `currentLease: LocalTaskLease`
 * parameter, fail-closed-verified on every dimension before any
 * candidate is resolved: (1) `checkpoint.leaseId` must equal
 * `currentLease.leaseId` (the checkpoint belongs to this exact lease,
 * not a foreign one); (2) `currentLease.workerId`/`deviceId` must equal
 * the outgoing worker's own (no cross-worker/device substitution); (3)
 * `currentLease.tenantId` must equal `requestingTenantId` (no
 * cross-tenant substitution); (4) `currentLease.taskRef` must equal the
 * caller-declared `expectedTaskRef` (no cross-task substitution); (5)
 * `currentLease.status` must be `CHECKPOINTED` - the one status L0's own
 * closed transition graph produces immediately after a checkpoint is
 * taken, proving the checkpoint step actually just happened rather than
 * being an unrelated historical record. Only then does this function
 * itself represent the deterministic lease-end via the existing,
 * unmodified `transitionLocalTaskLease` (`CHECKPOINTED` -> `CANCELLED`,
 * an already-legal transition in L0's own graph - no new lease/workflow
 * engine, no new status value), returning the ended lease as part of the
 * result so callers hold real proof of the handoff, not just an
 * assumption. Only after this real lease-end does the function proceed
 * to: `resolveEligibleLocalWorkers` (L0, unmodified) re-deriving the SAME
 * eligible candidate set the original routing decision used, so a
 * fallback can never be admitted under relaxed requirements;
 * `resolveWorkerRoute` (V5-WRK-001, unmodified) picking among them; §22
 * case I - an `UNKNOWN` external-effect state still fails closed before
 * any of this is even attempted, since retrying (via a different worker)
 * an effect whose real-world outcome is unverified is exactly the "blind
 * retry" the recovery/readback envelope exists to prevent.
 */
export function resolveLocalExecutionFailover(input: {
  outgoingWorker: LocalWorkerRegistration;
  checkpoint: LocalTaskCheckpoint;
  currentLease: LocalTaskLease;
  expectedTaskRef: unknown;
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
  if (input.checkpoint.leaseId !== input.currentLease.leaseId) {
    throw new InvalidLocalFailoverError(
      "checkpoint.leaseId does not match currentLease.leaseId - a foreign checkpoint cannot authorize failover",
    );
  }
  if (input.currentLease.workerId !== input.outgoingWorker.workerId) {
    throw new InvalidLocalFailoverError("currentLease.workerId does not match the outgoing worker's own workerId");
  }
  if (input.currentLease.deviceId !== input.outgoingWorker.deviceId) {
    throw new InvalidLocalFailoverError("currentLease.deviceId does not match the outgoing worker's own deviceId");
  }
  if (input.currentLease.tenantId !== input.requestingTenantId) {
    throw new InvalidLocalFailoverError("currentLease.tenantId does not match the requesting tenant");
  }
  const expectedTaskRef = requireNonEmptyString(input.expectedTaskRef, "expectedTaskRef");
  if (input.currentLease.taskRef !== expectedTaskRef) {
    throw new InvalidLocalFailoverError("currentLease.taskRef does not match expectedTaskRef");
  }
  if (input.currentLease.status !== "CHECKPOINTED") {
    throw new InvalidLocalFailoverError(
      `currentLease must be CHECKPOINTED to prove the checkpoint step just completed (current status: ${input.currentLease.status})`,
    );
  }
  const endedLease = transitionLocalTaskLease({ lease: input.currentLease, to: "CANCELLED" });
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
    endedLease,
    evidenceRef: requireNonEmptyString(input.evidenceRef, "evidenceRef"),
  };
}
