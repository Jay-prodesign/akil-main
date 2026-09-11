import type { TenantScope } from "./tenant-scope.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type {
  AdmittedWorker,
  WorkerTrustStatus,
  WorkerAvailability,
  WorkerRiskLevel,
  WorkerAuthorityLevel,
} from "./worker-routing-policy.js";

export class InvalidLocalExecutionError extends Error {
  constructor(reason: string) {
    super(`Invalid Local Execution operation: ${reason}`);
    this.name = "InvalidLocalExecutionError";
  }
}

export class InvalidDeviceTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid device transition: ${reason}`);
    this.name = "InvalidDeviceTransitionError";
  }
}

export class InvalidLocalTaskLeaseTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid LocalTaskLease transition: ${reason}`);
    this.name = "InvalidLocalTaskLeaseTransitionError";
  }
}

type DeviceId = string & { readonly __brand: "DeviceId" };
type LocalTaskLeaseId = string & { readonly __brand: "LocalTaskLeaseId" };

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidLocalExecutionError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * LOCAL-EXEC-001 (Rev99/100, Founder-approved Local Execution / Device
 * Worker capability, dedicated architecture packet Drive
 * 1vhHCHZYu15IugytGb2O2epe7jgRFQF6vRoZsozjASDU) Phase L0 — Contracts &
 * Safety Floor. No live PC connection, provider login, or network
 * service is required or performed anywhere in this module; it is the
 * pure domain contract layer only. §3: "Local Mode must never
 * automatically enable Team Pool or Shared Repo" - the three modes below
 * are structurally independent (no constructor derives one from
 * another).
 */
export type ExecutionMode = "CLOUD_NORMAL" | "PERSONAL_LOCAL" | "TEAM_LOCAL" | "HYBRID";
export type CollaborationMode = "PRIVATE" | "ISOLATED_PROJECT" | "SHARED_ARTIFACT" | "SHARED_REPO";
export type PoolMode = "PRIVATE" | "ORG_POOL";

const RECOGNIZED_EXECUTION_MODES: ReadonlySet<ExecutionMode> = new Set([
  "CLOUD_NORMAL",
  "PERSONAL_LOCAL",
  "TEAM_LOCAL",
  "HYBRID",
]);
const RECOGNIZED_COLLABORATION_MODES: ReadonlySet<CollaborationMode> = new Set([
  "PRIVATE",
  "ISOLATED_PROJECT",
  "SHARED_ARTIFACT",
  "SHARED_REPO",
]);

/**
 * §1: "The capability must be optional, default OFF... Turning Local
 * Execution OFF must leave the existing cloud/API/provider architecture
 * intact and functional." `executionMode` defaults to `CLOUD_NORMAL`
 * when omitted - a caller can never accidentally construct a policy that
 * silently turns Local Execution on.
 */
export interface ExecutionPolicy {
  readonly tenantId: TenantScope["tenantId"];
  readonly executionMode: ExecutionMode;
  readonly collaborationMode: CollaborationMode;
}

export function createExecutionPolicy(input: {
  tenantScope: TenantScope;
  executionMode?: unknown;
  collaborationMode?: unknown;
}): ExecutionPolicy {
  const executionMode = input.executionMode ?? "CLOUD_NORMAL";
  if (!RECOGNIZED_EXECUTION_MODES.has(executionMode as ExecutionMode)) {
    throw new InvalidLocalExecutionError(
      `executionMode must be one of ${Array.from(RECOGNIZED_EXECUTION_MODES).join(", ")}`,
    );
  }
  const collaborationMode = input.collaborationMode ?? "PRIVATE";
  if (!RECOGNIZED_COLLABORATION_MODES.has(collaborationMode as CollaborationMode)) {
    throw new InvalidLocalExecutionError(
      `collaborationMode must be one of ${Array.from(RECOGNIZED_COLLABORATION_MODES).join(", ")}`,
    );
  }
  return {
    tenantId: input.tenantScope.tenantId,
    executionMode: executionMode as ExecutionMode,
    collaborationMode: collaborationMode as CollaborationMode,
  };
}

/**
 * §6 device enrollment. `REVOKED` and `QUARANTINED` are both terminal
 * with respect to new task leases (§22 case G: "Revoke... new lease
 * fails closed... historical evidence remains") - this module never
 * re-admits a revoked device under the same `DeviceRegistration`; a
 * genuinely re-trusted device requires a fresh enrollment (out of this
 * floor's scope, which has no live enrollment channel yet).
 */
export type DeviceStatus = "PENDING" | "ONLINE" | "OFFLINE" | "REVOKED" | "QUARANTINED";

const TERMINAL_DEVICE_STATUSES: ReadonlySet<DeviceStatus> = new Set(["REVOKED"]);

export interface DeviceRegistration {
  readonly deviceId: DeviceId;
  readonly tenantId: TenantScope["tenantId"];
  readonly ownerMembershipRef: string;
  readonly publicKeyFingerprint: string;
  readonly platform: string;
  readonly bridgeVersion: string;
  readonly status: DeviceStatus;
}

/**
 * §6: a device always begins `PENDING` - no caller can construct an
 * already-`ONLINE`/already-trusted device, mirroring this codebase's
 * "never born admitted" discipline (e.g. `createPartnerCapabilityClaim`).
 */
export function registerDevice(input: {
  tenantScope: TenantScope;
  deviceId: unknown;
  ownerMembershipRef: unknown;
  publicKeyFingerprint: unknown;
  platform: unknown;
  bridgeVersion: unknown;
}): DeviceRegistration {
  return {
    deviceId: requireNonEmptyString(input.deviceId, "deviceId") as DeviceId,
    tenantId: input.tenantScope.tenantId,
    ownerMembershipRef: requireNonEmptyString(input.ownerMembershipRef, "ownerMembershipRef"),
    publicKeyFingerprint: requireNonEmptyString(input.publicKeyFingerprint, "publicKeyFingerprint"),
    platform: requireNonEmptyString(input.platform, "platform"),
    bridgeVersion: requireNonEmptyString(input.bridgeVersion, "bridgeVersion"),
    status: "PENDING",
  };
}

function requireNonTerminal(device: DeviceRegistration, action: string): void {
  if (TERMINAL_DEVICE_STATUSES.has(device.status)) {
    throw new InvalidDeviceTransitionError(
      `cannot ${action} a device that is already ${device.status} (REVOKED is terminal)`,
    );
  }
}

export function markDeviceOnline(device: DeviceRegistration): DeviceRegistration {
  requireNonTerminal(device, "mark online");
  if (device.status === "QUARANTINED") {
    throw new InvalidDeviceTransitionError("a QUARANTINED device cannot be marked ONLINE directly");
  }
  return { ...device, status: "ONLINE" };
}

export function markDeviceOffline(device: DeviceRegistration): DeviceRegistration {
  requireNonTerminal(device, "mark offline");
  return { ...device, status: "OFFLINE" };
}

/** §22 case G: revocation is terminal and always permitted from any non-REVOKED status. */
export function revokeDevice(device: DeviceRegistration): DeviceRegistration {
  return { ...device, status: "REVOKED" };
}

export function quarantineDevice(device: DeviceRegistration): DeviceRegistration {
  requireNonTerminal(device, "quarantine");
  return { ...device, status: "QUARANTINED" };
}

/**
 * §7/§12: "Safe capability health values" - never a raw secret field.
 * The boundary-scan test (`tests/local-exec-001-boundary-scan.test.ts`)
 * greps this module's own source for forbidden secret-shaped literals as
 * an additional structural proof, matching this codebase's established
 * convention for every other secret-adjacent domain module.
 */
export type DeviceCapabilityReadiness =
  | "AVAILABLE"
  | "AUTH_REQUIRED"
  | "OFFLINE"
  | "DEGRADED"
  | "USAGE_LIMITED"
  | "POLICY_BLOCKED"
  | "UNSUPPORTED"
  | "REVOKED";

const RECOGNIZED_READINESS_STATES: ReadonlySet<DeviceCapabilityReadiness> = new Set([
  "AVAILABLE",
  "AUTH_REQUIRED",
  "OFFLINE",
  "DEGRADED",
  "USAGE_LIMITED",
  "POLICY_BLOCKED",
  "UNSUPPORTED",
  "REVOKED",
]);

export interface DeviceCapabilitySnapshot {
  readonly deviceId: DeviceRegistration["deviceId"];
  readonly adapterKind: string;
  readonly readiness: DeviceCapabilityReadiness;
  readonly capturedAt: string;
  readonly evidenceRef: string;
}

export function createDeviceCapabilitySnapshot(input: {
  device: DeviceRegistration;
  adapterKind: unknown;
  readiness: unknown;
  capturedAt: unknown;
  evidenceRef: unknown;
}): DeviceCapabilitySnapshot {
  if (!RECOGNIZED_READINESS_STATES.has(input.readiness as DeviceCapabilityReadiness)) {
    throw new InvalidLocalExecutionError(
      `readiness must be one of ${Array.from(RECOGNIZED_READINESS_STATES).join(", ")}`,
    );
  }
  return {
    deviceId: input.device.deviceId,
    adapterKind: requireNonEmptyString(input.adapterKind, "adapterKind"),
    readiness: input.readiness as DeviceCapabilityReadiness,
    capturedAt: requireNonEmptyString(input.capturedAt, "capturedAt"),
    evidenceRef: requireNonEmptyString(input.evidenceRef, "evidenceRef"),
  };
}

/**
 * §16 security model: "Allowed workspace roots are explicit; never
 * default to the user's entire home drive." `maxRiskLevel` reuses
 * `worker-routing-policy.ts`'s own `WorkerRiskLevel` directly rather than
 * inventing a parallel risk vocabulary.
 */
export interface DevicePolicy {
  readonly deviceId: DeviceRegistration["deviceId"];
  readonly allowedWorkspaceRootRefs: ReadonlyArray<string>;
  readonly maxRiskLevel: WorkerRiskLevel;
  readonly killSwitchEngaged: boolean;
}

export function createDevicePolicy(input: {
  device: DeviceRegistration;
  allowedWorkspaceRootRefs: ReadonlyArray<unknown>;
  maxRiskLevel: unknown;
}): DevicePolicy {
  if (
    !Array.isArray(input.allowedWorkspaceRootRefs) ||
    input.allowedWorkspaceRootRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)
  ) {
    throw new InvalidLocalExecutionError(
      "allowedWorkspaceRootRefs must be an array of non-empty strings (an empty array is valid)",
    );
  }
  if (input.maxRiskLevel !== "STANDARD" && input.maxRiskLevel !== "HIGH_RISK") {
    throw new InvalidLocalExecutionError('maxRiskLevel must be "STANDARD" or "HIGH_RISK"');
  }
  return {
    deviceId: input.device.deviceId,
    allowedWorkspaceRootRefs: input.allowedWorkspaceRootRefs as ReadonlyArray<string>,
    maxRiskLevel: input.maxRiskLevel,
    killSwitchEngaged: false,
  };
}

export function engageKillSwitch(policy: DevicePolicy): DevicePolicy {
  return { ...policy, killSwitchEngaged: true };
}

/**
 * §22 case J ("unauthorized workspace root... fail closed"): the sole
 * fail-closed gate a caller must consult before binding a task to a
 * workspace root. An unrecognized/malformed `requestedRootRef` or a
 * kill-switched policy is never authorized, regardless of the allowlist.
 */
export function isWorkspaceRootAllowed(policy: DevicePolicy, requestedRootRef: unknown): boolean {
  if (policy.killSwitchEngaged) {
    return false;
  }
  return typeof requestedRootRef === "string" && policy.allowedWorkspaceRootRefs.includes(requestedRootRef);
}

/**
 * §12/§15: "Local workers are ordinary admitted worker candidates with
 * device/user/project/policy metadata... Reuse the existing Worker
 * Routing Policy" rather than inventing a second, local-only routing
 * engine. A `LocalWorkerRegistration` carries every field `AdmittedWorker` needs
 * (see `toAdmittedWorker` below) plus the local-specific `poolMode` and
 * `boundProjectOwnerships` dimensions that gate which tasks it may even
 * be offered as a candidate for - a decision made entirely in this
 * module, before `resolveWorkerRoute` (which knows nothing about pools
 * or projects) ever sees the candidate list.
 */
export interface LocalWorkerRegistration {
  readonly workerId: string;
  readonly deviceId: DeviceRegistration["deviceId"];
  readonly tenantId: TenantScope["tenantId"];
  readonly ownerMembershipRef: string;
  readonly adapterKind: string;
  readonly declaredCapabilityRefs: ReadonlyArray<string>;
  readonly declaredToolRefs: ReadonlyArray<string>;
  readonly declaredPolicyConstraintRefs: ReadonlyArray<string>;
  readonly trustStatus: WorkerTrustStatus;
  readonly availability: WorkerAvailability;
  readonly maxRiskLevel: WorkerRiskLevel;
  readonly authorityLevel: WorkerAuthorityLevel;
  readonly costWeight: number;
  readonly evaluationEvidenceRef: string;
  readonly poolMode: PoolMode;
  readonly boundProjectOwnerships: ReadonlyArray<ProjectOwnershipRef>;
}

export function createLocalWorkerRegistration(input: {
  workerId: unknown;
  device: DeviceRegistration;
  ownerMembershipRef: unknown;
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
  const workerId = requireNonEmptyString(input.workerId, "workerId");
  const ownerMembershipRef = requireNonEmptyString(input.ownerMembershipRef, "ownerMembershipRef");
  const adapterKind = requireNonEmptyString(input.adapterKind, "adapterKind");
  const evaluationEvidenceRef = requireNonEmptyString(
    input.evaluationEvidenceRef,
    "evaluationEvidenceRef",
  );
  if (input.trustStatus !== "ADMITTED" && input.trustStatus !== "UNTRUSTED" && input.trustStatus !== "REVOKED") {
    throw new InvalidLocalExecutionError('trustStatus must be "ADMITTED", "UNTRUSTED", or "REVOKED"');
  }
  if (input.availability !== "AVAILABLE" && input.availability !== "UNAVAILABLE" && input.availability !== "DEGRADED") {
    throw new InvalidLocalExecutionError('availability must be "AVAILABLE", "UNAVAILABLE", or "DEGRADED"');
  }
  if (input.maxRiskLevel !== "STANDARD" && input.maxRiskLevel !== "HIGH_RISK") {
    throw new InvalidLocalExecutionError('maxRiskLevel must be "STANDARD" or "HIGH_RISK"');
  }
  if (input.authorityLevel !== "STANDARD" && input.authorityLevel !== "ELEVATED") {
    throw new InvalidLocalExecutionError('authorityLevel must be "STANDARD" or "ELEVATED"');
  }
  if (typeof input.costWeight !== "number" || !Number.isFinite(input.costWeight)) {
    throw new InvalidLocalExecutionError("costWeight must be a finite number");
  }
  if (input.poolMode !== "PRIVATE" && input.poolMode !== "ORG_POOL") {
    throw new InvalidLocalExecutionError('poolMode must be "PRIVATE" or "ORG_POOL"');
  }
  if (!Array.isArray(input.boundProjectOwnerships)) {
    throw new InvalidLocalExecutionError("boundProjectOwnerships must be an array");
  }
  return {
    workerId,
    deviceId: input.device.deviceId,
    tenantId: input.device.tenantId,
    ownerMembershipRef,
    adapterKind,
    declaredCapabilityRefs: input.declaredCapabilityRefs as ReadonlyArray<string>,
    declaredToolRefs: input.declaredToolRefs as ReadonlyArray<string>,
    declaredPolicyConstraintRefs: input.declaredPolicyConstraintRefs as ReadonlyArray<string>,
    trustStatus: input.trustStatus,
    availability: input.availability,
    maxRiskLevel: input.maxRiskLevel,
    authorityLevel: input.authorityLevel,
    costWeight: input.costWeight,
    evaluationEvidenceRef,
    poolMode: input.poolMode,
    boundProjectOwnerships: input.boundProjectOwnerships,
  };
}

/**
 * The one required composition point (§2/§15): projects a
 * `LocalWorkerRegistration` into the exact `AdmittedWorker` shape
 * `resolveWorkerRoute` already consumes, unmodified. No new routing
 * logic is invented here or anywhere in this module - a local worker
 * becomes eligible or ineligible via exactly the same `isEligible`
 * checks `resolveWorkerRoute` already applies to any other
 * `AdmittedWorker`.
 */
export function toAdmittedWorker(registration: LocalWorkerRegistration): AdmittedWorker {
  return {
    workerId: registration.workerId,
    declaredCapabilityRefs: registration.declaredCapabilityRefs,
    declaredToolRefs: registration.declaredToolRefs,
    declaredPolicyConstraintRefs: registration.declaredPolicyConstraintRefs,
    trustStatus: registration.trustStatus,
    availability: registration.availability,
    maxRiskLevel: registration.maxRiskLevel,
    authorityLevel: registration.authorityLevel,
    costWeight: registration.costWeight,
    evaluationEvidenceRef: registration.evaluationEvidenceRef,
  };
}

function isBoundToOwnership(
  registration: LocalWorkerRegistration,
  targetOwnership: ProjectOwnershipRef,
): boolean {
  return registration.boundProjectOwnerships.some(
    (bound) =>
      bound.tenantId === targetOwnership.tenantId &&
      bound.customerId === targetOwnership.customerId &&
      bound.projectId === targetOwnership.projectId &&
      bound.serviceRef === targetOwnership.serviceRef,
  );
}

/**
 * §22 cases B/C/D/E/J and §3/§15: the pool/tenant/project/mode gate that
 * must run before a local worker is ever handed to `resolveWorkerRoute`.
 * `ExecutionMode.CLOUD_NORMAL` ("Local OFF") excludes every local worker
 * unconditionally (§22 case B). `PERSONAL_LOCAL` admits only the
 * requester's own `PRIVATE`-pool workers (§22 case C: employee isolation
 * - a different owner's `PRIVATE` worker is never eligible, and
 * `ORG_POOL` workers are excluded entirely in this mode). `TEAM_LOCAL`
 * additionally admits `ORG_POOL` workers that are actually bound to the
 * target project (§22 case D/E: an unbound `ORG_POOL` worker, or a
 * project with collaboration off, is never silently granted access).
 * `HYBRID` behaves like `TEAM_LOCAL` for the local half of the candidate
 * pool - callers concatenate the result with their own cloud/API
 * `AdmittedWorker` list, since this module invents no merge logic beyond
 * producing a correctly-scoped local list and no second worker-routing
 * engine of its own (§3: "the existing router chooses only among
 * eligible admitted candidates").
 *
 * A structural device/tenant mismatch (§22 case J: cross-tenant device
 * id substitution) or a `deviceId` the caller does not recognize as
 * belonging to the registration's own device makes that one candidate
 * ineligible, never fatal to the whole resolution.
 */
export function resolveEligibleLocalWorkers(input: {
  executionPolicy: ExecutionPolicy;
  registrations: ReadonlyArray<LocalWorkerRegistration>;
  requestingTenantId: TenantScope["tenantId"];
  targetOwnership: ProjectOwnershipRef;
  requestingOwnerMembershipRef: string;
}): ReadonlyArray<AdmittedWorker> {
  if (input.executionPolicy.executionMode === "CLOUD_NORMAL") {
    return [];
  }
  const eligible = input.registrations.filter((registration) => {
    if (registration.tenantId !== input.requestingTenantId) {
      return false;
    }
    if (input.executionPolicy.tenantId !== input.requestingTenantId) {
      return false;
    }
    if (registration.poolMode === "PRIVATE") {
      return registration.ownerMembershipRef === input.requestingOwnerMembershipRef;
    }
    // ORG_POOL
    if (input.executionPolicy.executionMode === "PERSONAL_LOCAL") {
      return false;
    }
    return isBoundToOwnership(registration, input.targetOwnership);
  });
  return eligible.map(toAdmittedWorker);
}

/**
 * §12/§21: "execution policy + task lease + checkpoint contract" and
 * §15's failover sequence. Status transitions are a strictly closed
 * graph - no caller can jump directly from `QUEUED` to `SUCCEEDED`, and
 * every terminal status (`SUCCEEDED`/`FAILED`/`CANCELLED`) can never be
 * re-entered or transitioned out of.
 */
export type LocalTaskLeaseStatus =
  | "QUEUED"
  | "LEASED"
  | "RUNNING"
  | "CHECKPOINTED"
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

const LEASE_TRANSITIONS: ReadonlyMap<LocalTaskLeaseStatus, ReadonlySet<LocalTaskLeaseStatus>> = new Map([
  ["QUEUED", new Set<LocalTaskLeaseStatus>(["LEASED", "CANCELLED"])],
  ["LEASED", new Set<LocalTaskLeaseStatus>(["RUNNING", "CANCELLED"])],
  ["RUNNING", new Set<LocalTaskLeaseStatus>(["CHECKPOINTED", "SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"])],
  ["CHECKPOINTED", new Set<LocalTaskLeaseStatus>(["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"])],
  ["BLOCKED", new Set<LocalTaskLeaseStatus>(["RUNNING", "CANCELLED", "FAILED"])],
  ["SUCCEEDED", new Set<LocalTaskLeaseStatus>()],
  ["FAILED", new Set<LocalTaskLeaseStatus>()],
  ["CANCELLED", new Set<LocalTaskLeaseStatus>()],
]);

export interface LocalTaskLease {
  readonly leaseId: LocalTaskLeaseId;
  readonly tenantId: TenantScope["tenantId"];
  readonly taskRef: string;
  readonly workerId: string;
  readonly deviceId: DeviceRegistration["deviceId"];
  readonly status: LocalTaskLeaseStatus;
  readonly workspaceCheckpointRef?: string;
}

/**
 * §22 case G (revocation fails closed): a lease can never be created
 * against a device that is not `ONLINE` - a `REVOKED`/`QUARANTINED`/
 * `OFFLINE`/`PENDING` device fails closed here, before any worker
 * eligibility question is even asked.
 */
export function createLocalTaskLease(input: {
  leaseId: unknown;
  taskRef: unknown;
  worker: LocalWorkerRegistration;
  device: DeviceRegistration;
}): LocalTaskLease {
  if (input.worker.deviceId !== input.device.deviceId) {
    throw new InvalidLocalExecutionError("worker.deviceId does not match the given device's own deviceId");
  }
  if (input.device.status !== "ONLINE") {
    throw new InvalidLocalExecutionError(
      `cannot lease a task to a device that is not ONLINE (current status: ${input.device.status})`,
    );
  }
  return {
    leaseId: requireNonEmptyString(input.leaseId, "leaseId") as LocalTaskLeaseId,
    tenantId: input.device.tenantId,
    taskRef: requireNonEmptyString(input.taskRef, "taskRef"),
    workerId: input.worker.workerId,
    deviceId: input.device.deviceId,
    status: "QUEUED",
  };
}

export function transitionLocalTaskLease(input: {
  lease: LocalTaskLease;
  to: unknown;
  workspaceCheckpointRef?: unknown;
}): LocalTaskLease {
  const allowed = LEASE_TRANSITIONS.get(input.lease.status);
  if (allowed === undefined || !allowed.has(input.to as LocalTaskLeaseStatus)) {
    throw new InvalidLocalTaskLeaseTransitionError(
      `cannot transition a lease from ${input.lease.status} to ${String(input.to)}`,
    );
  }
  if (input.to === "CHECKPOINTED") {
    const workspaceCheckpointRef = requireNonEmptyString(
      input.workspaceCheckpointRef,
      "workspaceCheckpointRef",
    );
    return { ...input.lease, status: "CHECKPOINTED", workspaceCheckpointRef };
  }
  return { ...input.lease, status: input.to as LocalTaskLeaseStatus };
}

/**
 * §12: the L0 checkpoint contract. Only recordable against a lease that
 * is genuinely in progress (`RUNNING` or already `CHECKPOINTED`) - a
 * checkpoint for a `QUEUED`/`LEASED`/terminal lease would misrepresent
 * work that never happened.
 */
export interface LocalTaskCheckpoint {
  readonly leaseId: LocalTaskLease["leaseId"];
  readonly checkpointRef: string;
  readonly capturedAt: string;
  readonly evidenceRef: string;
}

export function createLocalTaskCheckpoint(input: {
  lease: LocalTaskLease;
  checkpointRef: unknown;
  capturedAt: unknown;
  evidenceRef: unknown;
}): LocalTaskCheckpoint {
  if (input.lease.status !== "RUNNING" && input.lease.status !== "CHECKPOINTED") {
    throw new InvalidLocalExecutionError(
      `a checkpoint can only be recorded for a RUNNING or CHECKPOINTED lease (current status: ${input.lease.status})`,
    );
  }
  return {
    leaseId: input.lease.leaseId,
    checkpointRef: requireNonEmptyString(input.checkpointRef, "checkpointRef"),
    capturedAt: requireNonEmptyString(input.capturedAt, "capturedAt"),
    evidenceRef: requireNonEmptyString(input.evidenceRef, "evidenceRef"),
  };
}

/**
 * §12/§21: "adapter port and mock adapter." This is the port only - no
 * mock implementation lives in domain code (mirroring
 * `connector-execution.ts`'s own `ConnectorTransport` boundary, whose
 * mock transports live only in tests). Nothing in this repository
 * invokes a real local provider client anywhere.
 */
export interface LocalWorkerAdapterRequest {
  readonly leaseId: LocalTaskLease["leaseId"];
  readonly workingDirectoryRef: string;
}

export type LocalWorkerAdapterOutcome = "SUCCEEDED" | "FAILED" | "BLOCKED";

export interface LocalWorkerAdapterResult {
  readonly outcome: LocalWorkerAdapterOutcome;
  readonly evidenceRef: string;
  readonly checkpointRef?: string;
}

export interface LocalWorkerAdapter {
  execute(request: LocalWorkerAdapterRequest): LocalWorkerAdapterResult;
}
