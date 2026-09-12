import type {
  DevicePolicy,
  LocalTaskLease,
  LocalTaskCheckpoint,
  LocalWorkerAdapterOutcome,
  LocalWorkerAdapterResult,
  DeviceCapabilityReadiness,
} from "./local-execution.js";
import { isWorkspaceRootAllowed, createLocalTaskCheckpoint } from "./local-execution.js";
import type { BridgeProtocolMessageKind } from "./local-execution-bridge.js";
import { isRecognizedBridgeMessageKind } from "./local-execution-bridge.js";

export class InvalidClaudeAdapterError extends Error {
  constructor(reason: string) {
    super(`Invalid Claude local adapter operation: ${reason}`);
    this.name = "InvalidClaudeAdapterError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidClaudeAdapterError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * LOCAL-EXEC-006 (Rev98/Rev103 Phase L5, Claude Local Adapter). See
 * `docs/architecture/ADR/0003-local-exec-006-claude-adapter-fit.md` for
 * the sourced dependency-fit research and provider-policy check this
 * module implements. Every type here is a direct, honestly-scoped
 * projection of currently-documented Claude Code CLI behavior - never a
 * fabricated or guessed protocol detail - and this module composes
 * LOCAL-EXEC-001's/LOCAL-EXEC-002's existing generic adapter port and
 * bridge protocol rather than inventing a fourth worker/protocol system,
 * mirroring LOCAL-EXEC-003's own established Codex adapter shape.
 */

/**
 * ADR-0003: today's policy check is POLICY_SAFE for local, single-
 * machine, officially-authenticated CLI automation - but the packet's
 * own §21 requires this be represented as a structural, re-checkable
 * admission gate, not just this ADR's prose. `checkedAt` is caller-
 * supplied (this module never reads the system clock), so a caller must
 * re-check and re-supply a fresh disposition rather than relying on a
 * stale cached value forever.
 */
export type ClaudeAdapterPolicyDisposition = "POLICY_SAFE" | "POLICY_BLOCKED";

export interface ClaudeAdapterPolicyCheck {
  readonly disposition: ClaudeAdapterPolicyDisposition;
  readonly checkedAt: string;
  readonly reason: string;
}

export function resolveClaudeAdapterPolicyCheck(input: {
  disposition: unknown;
  checkedAt: unknown;
  reason: unknown;
}): ClaudeAdapterPolicyCheck {
  if (input.disposition !== "POLICY_SAFE" && input.disposition !== "POLICY_BLOCKED") {
    throw new InvalidClaudeAdapterError('disposition must be "POLICY_SAFE" or "POLICY_BLOCKED"');
  }
  return {
    disposition: input.disposition,
    checkedAt: requireNonEmptyString(input.checkedAt, "checkedAt"),
    reason: requireNonEmptyString(input.reason, "reason"),
  };
}

/**
 * A direct 1:1 projection of the Claude Code CLI's own six real
 * permission-mode values. Rev109 correction: previously corroborated
 * only against this environment's own live session-creation parameter
 * schema, which Brain correctly found insufficient to model as a
 * "provider-officially documented" contract. Independently re-verified
 * directly against the official Claude Code documentation
 * (ADR-0003's Research findings, fetched 2026-09-12) — all six values
 * (`default`/`plan`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`)
 * are named there by exact literal. `auto`/`dontAsk`/`bypassPermissions`
 * availability is plan- and version-gated at actual runtime; this
 * module does not negotiate that itself since no real CLI invocation
 * happens here - a caller at real activation time is responsible for
 * confirming the invoked client version/plan actually supports the mode
 * it requests.
 */
export type ClaudePermissionMode = "DEFAULT" | "PLAN" | "ACCEPT_EDITS" | "DONT_ASK" | "BYPASS_PERMISSIONS" | "AUTO";

const RECOGNIZED_PERMISSION_MODES: ReadonlySet<string> = new Set([
  "DEFAULT",
  "PLAN",
  "ACCEPT_EDITS",
  "DONT_ASK",
  "BYPASS_PERMISSIONS",
  "AUTO",
]);

/**
 * A locally-reported readiness status only. No field on this type, or
 * anywhere else in this module, can carry a session token, a browser
 * session marker, or the contents of the device's own local
 * authentication-state file -
 * structurally, this module cannot ingest a credential even if a caller
 * tried to pass one.
 */
export type ClaudeAuthReadinessStatus = "READY_SUBSCRIPTION_SESSION" | "READY_API_KEY" | "NOT_AUTHENTICATED";

const RECOGNIZED_AUTH_READINESS_STATUSES: ReadonlySet<string> = new Set([
  "READY_SUBSCRIPTION_SESSION",
  "READY_API_KEY",
  "NOT_AUTHENTICATED",
]);

export type ClaudeRunReadinessStatus = "READY" | "NOT_READY";

export interface ClaudeRunReadiness {
  readonly status: ClaudeRunReadinessStatus;
  readonly reason: string;
}

/**
 * ADR-0003: the policy check is consulted strictly before auth
 * readiness - a `POLICY_BLOCKED` disposition can never be bypassed by an
 * otherwise-valid authenticated session, and this ordering is itself the
 * "capability admission gate" the packet requires.
 */
export function resolveClaudeRunReadiness(input: {
  policyCheck: ClaudeAdapterPolicyCheck;
  authReadiness: unknown;
}): ClaudeRunReadiness {
  if (input.policyCheck.disposition === "POLICY_BLOCKED") {
    return { status: "NOT_READY", reason: `policy blocked: ${input.policyCheck.reason}` };
  }
  if (
    typeof input.authReadiness !== "string" ||
    !RECOGNIZED_AUTH_READINESS_STATUSES.has(input.authReadiness)
  ) {
    throw new InvalidClaudeAdapterError(
      'authReadiness must be one of "READY_SUBSCRIPTION_SESSION", "READY_API_KEY", "NOT_AUTHENTICATED"',
    );
  }
  if (input.authReadiness === "NOT_AUTHENTICATED") {
    return { status: "NOT_READY", reason: "device has not completed Claude Code authentication" };
  }
  return { status: "READY", reason: `authenticated via ${input.authReadiness}` };
}

export type ClaudeRunMode = "START" | "RESUME";

export interface ClaudeRunRequest {
  readonly leaseId: LocalTaskLease["leaseId"];
  readonly workingDirectoryRef: string;
  readonly mode: ClaudeRunMode;
  readonly priorSessionRef?: string;
  readonly permissionMode: ClaudePermissionMode;
  readonly allowedToolRefs: ReadonlyArray<string>;
}

function requireStringRefArray(value: unknown, field: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) {
    throw new InvalidClaudeAdapterError(`${field} must be an array of non-empty strings (an empty array is valid)`);
  }
  return value as ReadonlyArray<string>;
}

/**
 * `RESUME` without a `priorSessionRef` and `START` carrying one are both
 * structurally invalid, mirroring `createCodexRunRequest`'s own
 * discipline. `workingDirectoryRef` is validated via the existing,
 * unmodified `isWorkspaceRootAllowed` gate - this module adds no second
 * workspace-authorization check. `allowedToolRefs` is always an explicit
 * caller-declared array, never an implicit "all tools" default.
 */
export function createClaudeRunRequest(input: {
  lease: LocalTaskLease;
  devicePolicy: DevicePolicy;
  workingDirectoryRef: unknown;
  mode: unknown;
  priorSessionRef?: unknown;
  permissionMode: unknown;
  allowedToolRefs: ReadonlyArray<unknown>;
}): ClaudeRunRequest {
  const workingDirectoryRef = requireNonEmptyString(input.workingDirectoryRef, "workingDirectoryRef");
  if (!isWorkspaceRootAllowed(input.devicePolicy, workingDirectoryRef)) {
    throw new InvalidClaudeAdapterError(
      `workingDirectoryRef "${workingDirectoryRef}" is not an allowed workspace root for this device policy`,
    );
  }
  if (input.mode !== "START" && input.mode !== "RESUME") {
    throw new InvalidClaudeAdapterError('mode must be "START" or "RESUME"');
  }
  if (input.mode === "RESUME") {
    requireNonEmptyString(input.priorSessionRef, "priorSessionRef");
  } else if (input.priorSessionRef !== undefined) {
    throw new InvalidClaudeAdapterError('priorSessionRef must not be supplied when mode is "START"');
  }
  if (typeof input.permissionMode !== "string" || !RECOGNIZED_PERMISSION_MODES.has(input.permissionMode)) {
    throw new InvalidClaudeAdapterError(
      `permissionMode must be one of ${Array.from(RECOGNIZED_PERMISSION_MODES).join(", ")}`,
    );
  }
  const allowedToolRefs = requireStringRefArray(input.allowedToolRefs, "allowedToolRefs");
  return {
    leaseId: input.lease.leaseId,
    workingDirectoryRef,
    mode: input.mode,
    ...(input.mode === "RESUME" ? { priorSessionRef: input.priorSessionRef as string } : {}),
    permissionMode: input.permissionMode as ClaudePermissionMode,
    allowedToolRefs,
  };
}

export type ClaudeUsageLimitWindowKind = "FIVE_HOUR" | "WEEKLY";

export interface ClaudeUsageLimitStatus {
  readonly windowKind: ClaudeUsageLimitWindowKind;
  readonly remainingFraction: number;
}

export type ClaudeUsageLimitDisposition = "AVAILABLE" | "EXHAUSTED";

/**
 * Fails closed on a malformed fraction (non-finite, negative, or greater
 * than 1) rather than treating an invalid report as available capacity.
 */
export function resolveClaudeUsageLimitDisposition(
  status: ClaudeUsageLimitStatus,
): ClaudeUsageLimitDisposition {
  if (
    typeof status.remainingFraction !== "number" ||
    !Number.isFinite(status.remainingFraction) ||
    status.remainingFraction < 0 ||
    status.remainingFraction > 1
  ) {
    throw new InvalidClaudeAdapterError("remainingFraction must be a finite number between 0 and 1");
  }
  return status.remainingFraction > 0 ? "AVAILABLE" : "EXHAUSTED";
}

/**
 * A closed, honestly-scoped repository-native projection of Claude
 * Code's documented structural event categories (session lifecycle,
 * assistant output, tool-permission request/decision, usage reporting) -
 * see ADR-0003. This is not a claim of literal internal stream-json
 * field names.
 */
export type ClaudeRunEventKind =
  | "TASK_STARTED"
  | "AGENT_MESSAGE"
  | "TOOL_PERMISSION_REQUESTED"
  | "TOOL_PERMISSION_DECIDED"
  | "USAGE_REPORTED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_CANCELLED";

const CLAUDE_EVENT_TO_BRIDGE_KIND: Readonly<Record<ClaudeRunEventKind, BridgeProtocolMessageKind>> = {
  TASK_STARTED: "RUN_STARTED",
  AGENT_MESSAGE: "RUN_EVENT",
  TOOL_PERMISSION_REQUESTED: "PERMISSION_REQUEST",
  TOOL_PERMISSION_DECIDED: "PERMISSION_DECISION",
  USAGE_REPORTED: "RUN_EVENT",
  TASK_COMPLETED: "RUN_COMPLETED",
  TASK_FAILED: "RUN_FAILED",
  TASK_CANCELLED: "CANCEL",
};

/**
 * Deterministic projection onto LOCAL-EXEC-002's own existing
 * `BridgeProtocolMessageKind` - never a new bridge message kind. The
 * result is asserted against the bridge module's own recognizer so a
 * future edit to either enum cannot silently desynchronize them.
 */
export function mapClaudeRunEventKindToBridgeMessageKind(
  kind: ClaudeRunEventKind,
): BridgeProtocolMessageKind {
  const mapped = CLAUDE_EVENT_TO_BRIDGE_KIND[kind];
  if (!isRecognizedBridgeMessageKind(mapped)) {
    throw new InvalidClaudeAdapterError(
      `mapped bridge message kind "${mapped}" for Claude event "${kind}" is not recognized by local-execution-bridge.ts`,
    );
  }
  return mapped;
}

const TERMINAL_CLAUDE_EVENT_TO_ADAPTER_OUTCOME: Readonly<
  Record<"TASK_COMPLETED" | "TASK_FAILED" | "TASK_CANCELLED", LocalWorkerAdapterOutcome>
> = {
  TASK_COMPLETED: "SUCCEEDED",
  TASK_FAILED: "FAILED",
  TASK_CANCELLED: "BLOCKED",
};

/**
 * Binds a terminal Claude run event to the existing, unmodified
 * `LocalWorkerAdapterResult` shape - never a second result type. Fails
 * closed on a non-terminal event kind and on an empty evidence reference.
 */
export function resolveClaudeRunOutcome(input: {
  claudeEventKind: ClaudeRunEventKind;
  evidenceRef: unknown;
  checkpointRef?: unknown;
}): LocalWorkerAdapterResult {
  if (
    input.claudeEventKind !== "TASK_COMPLETED" &&
    input.claudeEventKind !== "TASK_FAILED" &&
    input.claudeEventKind !== "TASK_CANCELLED"
  ) {
    throw new InvalidClaudeAdapterError(
      `claudeEventKind "${input.claudeEventKind}" is not a terminal event`,
    );
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  const outcome = TERMINAL_CLAUDE_EVENT_TO_ADAPTER_OUTCOME[input.claudeEventKind];
  return {
    outcome,
    evidenceRef,
    ...(input.checkpointRef !== undefined
      ? { checkpointRef: requireNonEmptyString(input.checkpointRef, "checkpointRef") }
      : {}),
  };
}

export interface ClaudeCheckpointRecord {
  readonly checkpoint: LocalTaskCheckpoint;
  readonly claudeSessionRef: string;
}

/**
 * Delegates the checkpoint itself entirely to the existing, unmodified
 * `createLocalTaskCheckpoint` (never redefining `LocalTaskCheckpoint`)
 * and adds only the one Claude-specific field a checkpoint needs to be
 * resumable later via `ClaudeRunRequest`'s own `priorSessionRef`.
 */
export function createClaudeCheckpointRecord(input: {
  lease: LocalTaskLease;
  checkpointRef: unknown;
  capturedAt: unknown;
  evidenceRef: unknown;
  claudeSessionRef: unknown;
}): ClaudeCheckpointRecord {
  const checkpoint = createLocalTaskCheckpoint({
    lease: input.lease,
    checkpointRef: input.checkpointRef,
    capturedAt: input.capturedAt,
    evidenceRef: input.evidenceRef,
  });
  const claudeSessionRef = requireNonEmptyString(input.claudeSessionRef, "claudeSessionRef");
  return { checkpoint, claudeSessionRef };
}

/**
 * ADR-0003: composes the policy check, auth readiness, and usage-limit
 * disposition into L0's own existing, unmodified `DeviceCapabilityReadiness`
 * value set - that floor's own contract already reserved `POLICY_BLOCKED`
 * for exactly this situation, so this function produces no new readiness
 * vocabulary. Checked in the same fail-closed order as
 * `resolveClaudeRunReadiness`: policy first, then auth, then usage.
 */
export function resolveClaudeAdapterCapabilityReadiness(input: {
  policyCheck: ClaudeAdapterPolicyCheck;
  authReadiness: unknown;
  usageLimitStatus?: ClaudeUsageLimitStatus;
}): DeviceCapabilityReadiness {
  if (input.policyCheck.disposition === "POLICY_BLOCKED") {
    return "POLICY_BLOCKED";
  }
  if (
    typeof input.authReadiness !== "string" ||
    !RECOGNIZED_AUTH_READINESS_STATUSES.has(input.authReadiness)
  ) {
    throw new InvalidClaudeAdapterError(
      'authReadiness must be one of "READY_SUBSCRIPTION_SESSION", "READY_API_KEY", "NOT_AUTHENTICATED"',
    );
  }
  if (input.authReadiness === "NOT_AUTHENTICATED") {
    return "AUTH_REQUIRED";
  }
  if (
    input.usageLimitStatus !== undefined &&
    resolveClaudeUsageLimitDisposition(input.usageLimitStatus) === "EXHAUSTED"
  ) {
    return "USAGE_LIMITED";
  }
  return "AVAILABLE";
}
