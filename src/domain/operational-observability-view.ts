import {
  ATTEMPT_TERMINAL_STATUSES,
  type OutcomeJobExecutionAttemptStatus,
  type OutcomeJobExecutionRunState,
  type OutcomeJobExecutionRunStatus,
  type PendingControlRequest,
} from "./outcome-job-execution-run-state.js";
import type { ConnectionBinding, ConnectionState } from "./connection-authority.js";
import type { QuotaReadModel } from "./execution-quota-admission.js";
import type { ProtectedDecisionResumeAuthorization, ProtectedDecisionWaitRequest } from "./protected-decision-wait-gate.js";
import type { EvidenceReference } from "./evidence.js";
import type { VerificationResult, VerificationStatus } from "./verification-result.js";

/**
 * OS-V0-12 "Observability, Audit & Recovery View" (Rev194 dispatch): a pure,
 * stateless composer over V0's ALREADY-EXISTING durable truth - never a
 * second authority system, never a speculative platform. Every field here
 * is derived verbatim from a primitive this repository already accepted
 * (`OutcomeJobExecutionRunState` for task/worker truth, `ConnectionBinding`
 * for connection/kill-switch truth, `QuotaReadModel` for cost/quota truth,
 * `ProtectedDecisionWaitRequest`/`ProtectedDecisionResumeAuthorization` for
 * pending-approval truth, `EvidenceReference`/`VerificationResult` for
 * audit/evidence truth) - this module invents no new domain authority, no
 * new persistence, and reuses every status vocabulary exactly as its own
 * owner defined it rather than lossily remapping it onto a new shared enum.
 *
 * "Worker health vs task state" (Rev194's own distinction): `runStatus`/
 * `currentAttemptStatus` are the TASK's own truth (what the job has
 * reached); `workerHealth` is a narrower, separately-derived signal for
 * "is a worker currently actively processing this task" - `ACTIVE` while
 * the current attempt is `RUNNING` with no outstanding control request,
 * `AWAITING_CONTROL_ACK` while `RUNNING` with one, `IDLE` once the current
 * attempt reaches an ordinary terminal outcome (SUCCEEDED/FAILED/
 * CANCELLED/TIMED_OUT) or no attempt has started yet, and `UNKNOWN`
 * whenever the attempt's own status is itself ambiguous
 * (STALLED/DEGRADED/BLOCKED/UNKNOWN/UNSUPPORTED) - exactly the cases this
 * repository's own reducer already refuses to resolve further without a
 * fresh attempt or operator intervention.
 *
 * "Scoped kill switch" (Rev194's own term): this repository has no
 * generalized kill-switch abstraction today (confirmed by inspection before
 * this packet) - the only real existing scoped-disable mechanism is a
 * `ConnectionBinding`'s own `connectionState` reaching `REVOKED` (via the
 * existing `mutateConnectorConnectionStateAsAdmin` admin mutation boundary).
 * `killSwitchEngaged` surfaces exactly that real state, per connection,
 * rather than inventing a new generalized kill-switch object.
 *
 * "Pending approvals": `DurableProtectedDecisionWaitStore` has no
 * enumeration method (by design - see that module's own exact-lookup-by-id
 * contract), so this composer never invents one either; it takes caller-
 * supplied wait-request/resume pairs (a caller who already knows which
 * `waitRequestId`s are outstanding for its own job/run) and reports whether
 * each has a durable resume authorization yet.
 */

export type WorkerHealth = "ACTIVE" | "AWAITING_CONTROL_ACK" | "IDLE" | "UNKNOWN";

export interface TaskObservability {
  readonly runStatus: OutcomeJobExecutionRunStatus;
  readonly currentAttempt: number;
  readonly currentAttemptStatus?: OutcomeJobExecutionAttemptStatus;
  readonly pendingControlRequest?: PendingControlRequest;
  readonly workerHealth: WorkerHealth;
}

export interface ConnectionObservability {
  readonly connectionBindingId: string;
  readonly connectionState: ConnectionState;
  readonly killSwitchEngaged: boolean;
  readonly degraded: boolean;
}

export interface PendingApprovalObservability {
  readonly waitRequestId: string;
  readonly effectRef: string;
  readonly decisionRef: string;
  readonly raisedAt: string;
  readonly resolved: boolean;
  readonly resolvedAt?: string;
}

export interface AuditEvidenceObservability {
  readonly evidenceId: string;
  readonly evidenceType: string;
  readonly capturedAt: string;
  readonly verificationStatus?: VerificationStatus;
}

export interface OperationalObservabilityView {
  readonly task?: TaskObservability;
  readonly connections: ReadonlyArray<ConnectionObservability>;
  readonly quota?: QuotaReadModel;
  readonly pendingApprovals: ReadonlyArray<PendingApprovalObservability>;
  readonly auditEvidence: ReadonlyArray<AuditEvidenceObservability>;
}

const ORDINARY_TERMINAL_ATTEMPT_STATUSES: ReadonlySet<OutcomeJobExecutionAttemptStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

function deriveWorkerHealth(runState: OutcomeJobExecutionRunState): WorkerHealth {
  if (runState.currentAttempt === 0) {
    return "IDLE";
  }
  const attempt = runState.attempts.get(runState.currentAttempt);
  if (attempt === undefined) {
    return "UNKNOWN";
  }
  if (attempt.status === "RUNNING") {
    return attempt.pendingControlRequest !== undefined ? "AWAITING_CONTROL_ACK" : "ACTIVE";
  }
  if (ORDINARY_TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    return "IDLE";
  }
  // STALLED/DEGRADED/BLOCKED/UNKNOWN/UNSUPPORTED: the reducer itself
  // already refuses to resolve these further without a fresh attempt or
  // operator intervention - this composer is equally honest about them.
  return "UNKNOWN";
}

function composeTaskObservability(runState: OutcomeJobExecutionRunState | undefined): TaskObservability | undefined {
  if (runState === undefined) {
    return undefined;
  }
  const attempt = runState.currentAttempt > 0 ? runState.attempts.get(runState.currentAttempt) : undefined;
  return {
    runStatus: runState.status,
    currentAttempt: runState.currentAttempt,
    ...(attempt !== undefined ? { currentAttemptStatus: attempt.status } : {}),
    ...(attempt?.pendingControlRequest !== undefined ? { pendingControlRequest: attempt.pendingControlRequest } : {}),
    workerHealth: deriveWorkerHealth(runState),
  };
}

function composeConnectionObservability(connection: ConnectionBinding): ConnectionObservability {
  return {
    connectionBindingId: connection.connectionBindingId,
    connectionState: connection.connectionState,
    killSwitchEngaged: connection.connectionState === "REVOKED",
    degraded: connection.connectionState === "DEGRADED",
  };
}

function composePendingApprovalObservability(entry: {
  readonly request: ProtectedDecisionWaitRequest;
  readonly resume?: ProtectedDecisionResumeAuthorization;
}): PendingApprovalObservability {
  return {
    waitRequestId: entry.request.waitRequestId,
    effectRef: entry.request.effectRef,
    decisionRef: entry.request.decisionRef,
    raisedAt: entry.request.raisedAt,
    resolved: entry.resume !== undefined,
    ...(entry.resume !== undefined ? { resolvedAt: entry.resume.resolvedAt } : {}),
  };
}

function composeAuditEvidenceObservability(entry: {
  readonly evidence: EvidenceReference;
  readonly verification?: VerificationResult;
}): AuditEvidenceObservability {
  return {
    evidenceId: entry.evidence.evidenceId,
    evidenceType: entry.evidence.evidenceType,
    capturedAt: entry.evidence.capturedAt,
    ...(entry.verification !== undefined ? { verificationStatus: entry.verification.status } : {}),
  };
}

/**
 * The one composition entry point. Every input is an already-resolved,
 * already-validated real primitive the caller obtained from its own
 * accepted owner (the execution-event store's current run state, the
 * current connection bindings for a project/organization, a freshly
 * projected `QuotaReadModel`, the caller's own known pending-decision
 * wait/resume pairs, and known evidence/verification pairs) - this
 * function never fetches, persists, or re-derives anything on its own.
 */
export function composeOperationalObservabilityView(input: {
  readonly runState?: OutcomeJobExecutionRunState;
  readonly connections?: ReadonlyArray<ConnectionBinding>;
  readonly quota?: QuotaReadModel;
  readonly pendingApprovals?: ReadonlyArray<{
    readonly request: ProtectedDecisionWaitRequest;
    readonly resume?: ProtectedDecisionResumeAuthorization;
  }>;
  readonly auditEvidence?: ReadonlyArray<{
    readonly evidence: EvidenceReference;
    readonly verification?: VerificationResult;
  }>;
}): OperationalObservabilityView {
  const task = composeTaskObservability(input.runState);
  return {
    ...(task !== undefined ? { task } : {}),
    connections: (input.connections ?? []).map(composeConnectionObservability),
    ...(input.quota !== undefined ? { quota: input.quota } : {}),
    pendingApprovals: (input.pendingApprovals ?? []).map(composePendingApprovalObservability),
    auditEvidence: (input.auditEvidence ?? []).map(composeAuditEvidenceObservability),
  };
}
