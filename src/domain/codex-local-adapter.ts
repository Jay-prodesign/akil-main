import type { DevicePolicy, LocalTaskLease, LocalTaskCheckpoint, LocalWorkerAdapterOutcome, LocalWorkerAdapterResult } from "./local-execution.js";
import { isWorkspaceRootAllowed, createLocalTaskCheckpoint } from "./local-execution.js";
import type { BridgeProtocolMessageKind } from "./local-execution-bridge.js";
import { isRecognizedBridgeMessageKind } from "./local-execution-bridge.js";

export class InvalidCodexAdapterError extends Error {
  constructor(reason: string) {
    super(`Invalid Codex local adapter operation: ${reason}`);
    this.name = "InvalidCodexAdapterError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidCodexAdapterError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * LOCAL-EXEC-003 (Rev98/Rev101 Phase L2, Codex Local Adapter). See
 * `docs/architecture/ADR/0002-local-exec-003-codex-adapter-fit.md` for the
 * sourced dependency-fit research this module implements. Every type here
 * is a direct, honestly-scoped projection of currently-documented Codex
 * CLI/App Server behavior - never a fabricated or guessed protocol detail
 * - and this module composes LOCAL-EXEC-001's/LOCAL-EXEC-002's existing
 * generic adapter port and bridge protocol rather than inventing a second
 * worker/protocol system, per Rev99/100's explicit instruction.
 */
export type CodexSandboxMode = "READ_ONLY" | "WORKSPACE_WRITE" | "DANGER_FULL_ACCESS";

const RECOGNIZED_SANDBOX_MODES: ReadonlySet<string> = new Set([
  "READ_ONLY",
  "WORKSPACE_WRITE",
  "DANGER_FULL_ACCESS",
]);

export type CodexApprovalPolicy = "UNTRUSTED" | "ON_REQUEST" | "NEVER";

const RECOGNIZED_APPROVAL_POLICIES: ReadonlySet<string> = new Set([
  "UNTRUSTED",
  "ON_REQUEST",
  "NEVER",
]);

/**
 * Codex's own real default is network access off. This module has no
 * function that can produce `"ENABLED"` implicitly - a caller must
 * explicitly request it.
 */
export type CodexNetworkPolicy = "DISABLED" | "ENABLED";

const RECOGNIZED_NETWORK_POLICIES: ReadonlySet<string> = new Set(["DISABLED", "ENABLED"]);

/**
 * A locally-reported readiness status only. No field on this type, or
 * anywhere else in this module, can carry a session secret, a browser
 * session marker, or the contents of the device's own local
 * authentication-state file - structurally, this module cannot ingest a
 * credential even if a caller tried to pass one.
 */
export type CodexAuthReadinessStatus = "READY_CHATGPT_SESSION" | "READY_API_KEY" | "NOT_AUTHENTICATED";

const RECOGNIZED_AUTH_READINESS_STATUSES: ReadonlySet<string> = new Set([
  "READY_CHATGPT_SESSION",
  "READY_API_KEY",
  "NOT_AUTHENTICATED",
]);

export type CodexRunReadinessStatus = "READY" | "NOT_READY";

export interface CodexRunReadiness {
  readonly status: CodexRunReadinessStatus;
  readonly reason: string;
}

/**
 * Fails closed unless the locally-reported status is one of the two
 * authenticated-readiness statuses - never treats the mere absence of an
 * explicit `NOT_AUTHENTICATED` as sufficient.
 */
export function resolveCodexRunReadiness(input: { authReadiness: unknown }): CodexRunReadiness {
  if (
    typeof input.authReadiness !== "string" ||
    !RECOGNIZED_AUTH_READINESS_STATUSES.has(input.authReadiness)
  ) {
    throw new InvalidCodexAdapterError(
      'authReadiness must be one of "READY_CHATGPT_SESSION", "READY_API_KEY", "NOT_AUTHENTICATED"',
    );
  }
  if (input.authReadiness === "NOT_AUTHENTICATED") {
    return { status: "NOT_READY", reason: "device has not completed Codex authentication" };
  }
  return { status: "READY", reason: `authenticated via ${input.authReadiness}` };
}

export type CodexRunMode = "START" | "RESUME";

export interface CodexRunRequest {
  readonly leaseId: LocalTaskLease["leaseId"];
  readonly workingDirectoryRef: string;
  readonly mode: CodexRunMode;
  readonly priorSessionRef?: string;
  readonly sandboxMode: CodexSandboxMode;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly networkPolicy: CodexNetworkPolicy;
}

/**
 * §ADR-0002: `RESUME` without a `priorSessionRef` and `START` carrying one
 * are both structurally invalid - a resume must reference something real
 * (`codex exec resume <id>`), and a fresh start must never silently
 * inherit a stale session. `workingDirectoryRef` is validated via the
 * existing, unmodified `isWorkspaceRootAllowed` gate - this module adds
 * no second workspace-authorization check.
 */
export function createCodexRunRequest(input: {
  lease: LocalTaskLease;
  devicePolicy: DevicePolicy;
  workingDirectoryRef: unknown;
  mode: unknown;
  priorSessionRef?: unknown;
  sandboxMode: unknown;
  approvalPolicy: unknown;
  networkPolicy: unknown;
}): CodexRunRequest {
  const workingDirectoryRef = requireNonEmptyString(input.workingDirectoryRef, "workingDirectoryRef");
  if (!isWorkspaceRootAllowed(input.devicePolicy, workingDirectoryRef)) {
    throw new InvalidCodexAdapterError(
      `workingDirectoryRef "${workingDirectoryRef}" is not an allowed workspace root for this device policy`,
    );
  }
  if (input.mode !== "START" && input.mode !== "RESUME") {
    throw new InvalidCodexAdapterError('mode must be "START" or "RESUME"');
  }
  if (input.mode === "RESUME") {
    requireNonEmptyString(input.priorSessionRef, "priorSessionRef");
  } else if (input.priorSessionRef !== undefined) {
    throw new InvalidCodexAdapterError('priorSessionRef must not be supplied when mode is "START"');
  }
  if (typeof input.sandboxMode !== "string" || !RECOGNIZED_SANDBOX_MODES.has(input.sandboxMode)) {
    throw new InvalidCodexAdapterError(
      'sandboxMode must be one of "READ_ONLY", "WORKSPACE_WRITE", "DANGER_FULL_ACCESS"',
    );
  }
  if (
    typeof input.approvalPolicy !== "string" ||
    !RECOGNIZED_APPROVAL_POLICIES.has(input.approvalPolicy)
  ) {
    throw new InvalidCodexAdapterError('approvalPolicy must be one of "UNTRUSTED", "ON_REQUEST", "NEVER"');
  }
  if (
    typeof input.networkPolicy !== "string" ||
    !RECOGNIZED_NETWORK_POLICIES.has(input.networkPolicy)
  ) {
    throw new InvalidCodexAdapterError('networkPolicy must be one of "DISABLED", "ENABLED"');
  }
  return {
    leaseId: input.lease.leaseId,
    workingDirectoryRef,
    mode: input.mode,
    ...(input.mode === "RESUME" ? { priorSessionRef: input.priorSessionRef as string } : {}),
    sandboxMode: input.sandboxMode as CodexSandboxMode,
    approvalPolicy: input.approvalPolicy as CodexApprovalPolicy,
    networkPolicy: input.networkPolicy as CodexNetworkPolicy,
  };
}

export type CodexUsageLimitWindowKind = "FIVE_HOUR" | "WEEKLY";

export interface CodexUsageLimitStatus {
  readonly windowKind: CodexUsageLimitWindowKind;
  readonly remainingFraction: number;
}

export type CodexUsageLimitDisposition = "AVAILABLE" | "EXHAUSTED";

/**
 * Fails closed on a malformed fraction (non-finite, negative, or greater
 * than 1) rather than treating an invalid report as available capacity.
 */
export function resolveCodexUsageLimitDisposition(
  status: CodexUsageLimitStatus,
): CodexUsageLimitDisposition {
  if (
    typeof status.remainingFraction !== "number" ||
    !Number.isFinite(status.remainingFraction) ||
    status.remainingFraction < 0 ||
    status.remainingFraction > 1
  ) {
    throw new InvalidCodexAdapterError("remainingFraction must be a finite number between 0 and 1");
  }
  return status.remainingFraction > 0 ? "AVAILABLE" : "EXHAUSTED";
}

/**
 * A closed, honestly-scoped repository-native projection of Codex's
 * documented structural event categories (task lifecycle, agent output,
 * approval request/response, usage reporting) - see ADR-0002. This is not
 * a claim of the literal, undisclosed App Server JSON-RPC method names.
 */
export type CodexRunEventKind =
  | "TASK_STARTED"
  | "AGENT_MESSAGE"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_DECIDED"
  | "USAGE_REPORTED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_CANCELLED";

const CODEX_EVENT_TO_BRIDGE_KIND: Readonly<Record<CodexRunEventKind, BridgeProtocolMessageKind>> = {
  TASK_STARTED: "RUN_STARTED",
  AGENT_MESSAGE: "RUN_EVENT",
  APPROVAL_REQUESTED: "PERMISSION_REQUEST",
  APPROVAL_DECIDED: "PERMISSION_DECISION",
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
export function mapCodexRunEventKindToBridgeMessageKind(
  kind: CodexRunEventKind,
): BridgeProtocolMessageKind {
  const mapped = CODEX_EVENT_TO_BRIDGE_KIND[kind];
  if (!isRecognizedBridgeMessageKind(mapped)) {
    throw new InvalidCodexAdapterError(
      `mapped bridge message kind "${mapped}" for Codex event "${kind}" is not recognized by local-execution-bridge.ts`,
    );
  }
  return mapped;
}

const TERMINAL_CODEX_EVENT_TO_ADAPTER_OUTCOME: Readonly<
  Record<"TASK_COMPLETED" | "TASK_FAILED" | "TASK_CANCELLED", LocalWorkerAdapterOutcome>
> = {
  TASK_COMPLETED: "SUCCEEDED",
  TASK_FAILED: "FAILED",
  TASK_CANCELLED: "BLOCKED",
};

/**
 * Binds a terminal Codex run event to the existing, unmodified
 * `LocalWorkerAdapterResult` shape - never a second result type. Fails
 * closed on a non-terminal event kind and on an empty evidence reference.
 */
export function resolveCodexRunOutcome(input: {
  codexEventKind: CodexRunEventKind;
  evidenceRef: unknown;
  checkpointRef?: unknown;
}): LocalWorkerAdapterResult {
  if (
    input.codexEventKind !== "TASK_COMPLETED" &&
    input.codexEventKind !== "TASK_FAILED" &&
    input.codexEventKind !== "TASK_CANCELLED"
  ) {
    throw new InvalidCodexAdapterError(
      `codexEventKind "${input.codexEventKind}" is not a terminal event`,
    );
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  const outcome = TERMINAL_CODEX_EVENT_TO_ADAPTER_OUTCOME[input.codexEventKind];
  return {
    outcome,
    evidenceRef,
    ...(input.checkpointRef !== undefined
      ? { checkpointRef: requireNonEmptyString(input.checkpointRef, "checkpointRef") }
      : {}),
  };
}

export interface CodexCheckpointRecord {
  readonly checkpoint: LocalTaskCheckpoint;
  readonly codexSessionRef: string;
}

/**
 * Delegates the checkpoint itself entirely to the existing, unmodified
 * `createLocalTaskCheckpoint` (never redefining `LocalTaskCheckpoint`) and
 * adds only the one Codex-specific field a checkpoint needs to be
 * resumable later via `CodexRunRequest`'s own `priorSessionRef`.
 */
export function createCodexCheckpointRecord(input: {
  lease: LocalTaskLease;
  checkpointRef: unknown;
  capturedAt: unknown;
  evidenceRef: unknown;
  codexSessionRef: unknown;
}): CodexCheckpointRecord {
  const checkpoint = createLocalTaskCheckpoint({
    lease: input.lease,
    checkpointRef: input.checkpointRef,
    capturedAt: input.capturedAt,
    evidenceRef: input.evidenceRef,
  });
  const codexSessionRef = requireNonEmptyString(input.codexSessionRef, "codexSessionRef");
  return { checkpoint, codexSessionRef };
}
