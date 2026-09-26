import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { OutcomeJob } from "./outcome-job.js";
import type { OutcomeJobExecutionEvent, OutcomeJobExecutionEventType } from "./outcome-job-execution-event.js";

export class InvalidOutcomeJobExecutionTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid OutcomeJob execution transition: ${reason}`);
    this.name = "InvalidOutcomeJobExecutionTransitionError";
  }
}

/**
 * Every non-RUNNING attempt status is terminal-for-that-attempt: once an
 * attempt reaches one of these, no further PROGRESS/CHECKPOINT/result event
 * can apply to it (only an identical eventId replay, or a stale/superseded
 * event, both handled as no-ops - Minimum Adversarial Evidence #3/#4). A new
 * attempt (`ATTEMPT_STARTED`) is required to continue. This mirrors
 * `outcome-job.ts`'s own "do not invent an unspecified recovery/exception
 * graph" discipline: the Package Contract names these as the bounded state
 * set the activated lane needs (Contract E), not a richer per-status
 * transition graph the contract does not specify.
 */
export type OutcomeJobExecutionAttemptStatus =
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "STALLED"
  | "DEGRADED"
  | "BLOCKED"
  | "UNKNOWN"
  | "UNSUPPORTED";

const ATTEMPT_TERMINAL_STATUSES: ReadonlySet<OutcomeJobExecutionAttemptStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "STALLED",
  "DEGRADED",
  "BLOCKED",
  "UNKNOWN",
  "UNSUPPORTED",
]);

export interface OutcomeJobExecutionAttemptState {
  readonly attempt: number;
  readonly status: OutcomeJobExecutionAttemptStatus;
  readonly lastSequence: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly lastProgressRef?: string;
  readonly lastCheckpointRef?: string;
  readonly reason?: string;
  readonly executorRef?: string;
}

/**
 * `"ACCEPTED"` is the run-level status before any attempt has started
 * (Package Contract B: durable acceptance exists before anything is
 * in-flight). Once an attempt starts, run status mirrors that attempt's own
 * status, and a retry (`ATTEMPT_STARTED` for the next attempt) always resets
 * it back to `"RUNNING"`.
 */
export type OutcomeJobExecutionRunStatus = "ACCEPTED" | OutcomeJobExecutionAttemptStatus;

export interface OutcomeJobExecutionRunState {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly runId: string;
  readonly correlationId: string;
  readonly acceptedAt: string;
  readonly currentAttempt: number;
  readonly attempts: ReadonlyMap<number, OutcomeJobExecutionAttemptState>;
  readonly status: OutcomeJobExecutionRunStatus;
  readonly appliedEventIds: ReadonlySet<string>;
}

function terminalStatusForEventType(type: OutcomeJobExecutionEventType): OutcomeJobExecutionAttemptStatus | undefined {
  switch (type) {
    case "SUCCEEDED":
    case "FAILED":
    case "CANCELLED":
    case "TIMED_OUT":
    case "STALLED":
    case "DEGRADED":
    case "BLOCKED":
    case "UNKNOWN":
    case "UNSUPPORTED":
      return type;
    default:
      return undefined;
  }
}

/**
 * Pure, deterministic reducer. No persistence, clock, randomness or
 * provider/model call - identical to this repository's other event-sourced
 * reducers (`plan-admission-run-state.ts`). Every structural violation
 * (foreign identity, ACCEPTED not first/not exactly once, a result/progress
 * event with no started attempt, an attempt starting out of sequence while
 * the current one is still RUNNING) throws
 * `InvalidOutcomeJobExecutionTransitionError` - fail-closed on adversarial or
 * corrupted input (Minimum Adversarial Evidence #2, #5, #15). Stale/
 * out-of-order/duplicate-but-structurally-valid events are silent no-ops
 * that return the exact same `state` reference, never regressing already-
 * durable truth (#3, #4).
 */
export function applyOutcomeJobExecutionEvent(
  state: OutcomeJobExecutionRunState | undefined,
  event: OutcomeJobExecutionEvent,
): OutcomeJobExecutionRunState {
  if (state === undefined) {
    if (event.type !== "ACCEPTED") {
      throw new InvalidOutcomeJobExecutionTransitionError(
        "the first event applied to a run must be ACCEPTED - durable acceptance must exist before any in-flight truth",
      );
    }
    if (event.attempt !== 1 || event.sequence !== 1) {
      throw new InvalidOutcomeJobExecutionTransitionError(
        "the initial ACCEPTED event must be attempt 1, sequence 1",
      );
    }
    return {
      tenantId: event.tenantId,
      customerId: event.customerId,
      projectId: event.projectId,
      jobId: event.jobId,
      runId: event.runId,
      correlationId: event.correlationId,
      acceptedAt: event.occurredAt,
      currentAttempt: 0,
      attempts: new Map(),
      status: "ACCEPTED",
      appliedEventIds: new Set([event.eventId]),
    };
  }

  if (
    event.tenantId !== state.tenantId ||
    event.customerId !== state.customerId ||
    event.projectId !== state.projectId ||
    event.jobId !== state.jobId ||
    event.runId !== state.runId
  ) {
    throw new InvalidOutcomeJobExecutionTransitionError(
      "event tenant/customer/project/job/run identity does not match this run's own identity - cross-scope substitution",
    );
  }
  if (event.correlationId !== state.correlationId) {
    throw new InvalidOutcomeJobExecutionTransitionError(
      "event correlationId does not match this run's own correlationId",
    );
  }

  if (state.appliedEventIds.has(event.eventId)) {
    return state;
  }

  if (event.type === "ACCEPTED") {
    throw new InvalidOutcomeJobExecutionTransitionError("a run can only be durably ACCEPTED once");
  }

  if (event.type === "ATTEMPT_STARTED") {
    if (event.attempt <= state.currentAttempt) {
      return state;
    }
    if (event.attempt !== state.currentAttempt + 1) {
      throw new InvalidOutcomeJobExecutionTransitionError(
        `attempt ${event.attempt} cannot start - the next expected attempt is ${state.currentAttempt + 1}`,
      );
    }
    const priorAttempt = state.currentAttempt > 0 ? state.attempts.get(state.currentAttempt) : undefined;
    if (priorAttempt !== undefined && !ATTEMPT_TERMINAL_STATUSES.has(priorAttempt.status)) {
      throw new InvalidOutcomeJobExecutionTransitionError(
        `attempt ${state.currentAttempt} is still RUNNING - a new attempt cannot start until it is terminal`,
      );
    }
    if (event.sequence !== 1) {
      throw new InvalidOutcomeJobExecutionTransitionError(
        "ATTEMPT_STARTED must be sequence 1 within its own attempt",
      );
    }
    const newAttempt: OutcomeJobExecutionAttemptState = {
      attempt: event.attempt,
      status: "RUNNING",
      lastSequence: 1,
      startedAt: event.occurredAt,
      updatedAt: event.occurredAt,
      ...(event.executorRef !== undefined ? { executorRef: event.executorRef } : {}),
    };
    const attempts = new Map(state.attempts);
    attempts.set(event.attempt, newAttempt);
    return {
      ...state,
      currentAttempt: event.attempt,
      attempts,
      status: "RUNNING",
      appliedEventIds: new Set([...state.appliedEventIds, event.eventId]),
    };
  }

  if (event.attempt < 1 || event.attempt > state.currentAttempt) {
    throw new InvalidOutcomeJobExecutionTransitionError(
      `event targets attempt ${event.attempt}, but no such attempt has been started for this run`,
    );
  }
  if (event.attempt < state.currentAttempt) {
    return state;
  }
  const attemptState = state.attempts.get(event.attempt);
  if (attemptState === undefined) {
    throw new InvalidOutcomeJobExecutionTransitionError("internal error: currentAttempt has no attempt state");
  }
  if (ATTEMPT_TERMINAL_STATUSES.has(attemptState.status)) {
    return state;
  }
  if (event.sequence <= attemptState.lastSequence) {
    return state;
  }

  const terminal = terminalStatusForEventType(event.type);
  let updatedAttempt: OutcomeJobExecutionAttemptState;
  if (terminal !== undefined) {
    updatedAttempt = {
      ...attemptState,
      status: terminal,
      lastSequence: event.sequence,
      updatedAt: event.occurredAt,
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      ...(event.executorRef !== undefined ? { executorRef: event.executorRef } : {}),
    };
  } else if (event.type === "PROGRESS") {
    updatedAttempt = {
      ...attemptState,
      lastSequence: event.sequence,
      updatedAt: event.occurredAt,
      ...(event.progressRef !== undefined ? { lastProgressRef: event.progressRef } : {}),
      ...(event.executorRef !== undefined ? { executorRef: event.executorRef } : {}),
    };
  } else if (event.type === "CHECKPOINT") {
    updatedAttempt = {
      ...attemptState,
      lastSequence: event.sequence,
      updatedAt: event.occurredAt,
      ...(event.checkpointRef !== undefined ? { lastCheckpointRef: event.checkpointRef } : {}),
      ...(event.executorRef !== undefined ? { executorRef: event.executorRef } : {}),
    };
  } else {
    throw new InvalidOutcomeJobExecutionTransitionError(`unhandled event type: ${event.type}`);
  }

  const attempts = new Map(state.attempts);
  attempts.set(event.attempt, updatedAttempt);
  return {
    ...state,
    attempts,
    status: updatedAttempt.status,
    appliedEventIds: new Set([...state.appliedEventIds, event.eventId]),
  };
}

/**
 * Restart-safety proof (Minimum Adversarial Evidence #13): folding the full
 * durable event log from scratch through the same pure reducer always
 * reconstructs the identical run state - there is no separate in-memory
 * index that could diverge from the durable log.
 */
export function reconstructOutcomeJobExecutionRunState(
  events: ReadonlyArray<OutcomeJobExecutionEvent>,
): OutcomeJobExecutionRunState | undefined {
  let state: OutcomeJobExecutionRunState | undefined;
  for (const event of events) {
    state = applyOutcomeJobExecutionEvent(state, event);
  }
  return state;
}
