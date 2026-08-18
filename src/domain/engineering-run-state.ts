import type { EngineeringEventEnvelope, EventId, TaskId, RunId } from "./engineering-event-envelope.js";

export class InvalidEngineeringRunStateError extends Error {
  constructor(reason: string) {
    super(`Invalid EngineeringRunState transition input: ${reason}`);
    this.name = "InvalidEngineeringRunStateError";
  }
}

/**
 * ENG-ORCH-001 "First bounded vertical slice" #2. All 13 states the
 * packet names; not every state is reached by a distinct edge in this
 * bounded slice's transition graph (see `applyEvent` doc comment for
 * which are collapsed and why), but every one is representable.
 */
export type EngineeringRunStatus =
  | "CHECKPOINT_RECEIVED"
  | "VERIFYING"
  | "PASS"
  | "CHANGES_REQUIRED"
  | "REVIEW_REQUIRED"
  | "QUESTION"
  | "WAITING"
  | "ANSWER_RECEIVED"
  | "RESUME_AUTHORIZED"
  | "OWNER_GATE"
  | "BLOCKED"
  | "RECONCILIATION_REQUIRED"
  | "COMPLETED";

export type BrainResolutionDecision = "PASS" | "CHANGES_REQUIRED";

/**
 * ENG-ORCH-001 "First bounded vertical slice" #3: "the only object that
 * authorizes the next worker/continuation after canonical resolution."
 * Constructed only inside `applyEvent`'s RESOLVE handling, from an event
 * that itself carries the exact project/task/branch/checkpointSha binding
 * required for the resolution to apply - never self-granted by a worker.
 */
export interface BrainResolution {
  readonly projectRef: string;
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly branch: string;
  readonly checkpointSha: string;
  readonly decision: BrainResolutionDecision;
  readonly authorityRef: string;
  readonly evidenceRef: string;
  readonly decidedAt: string;
  readonly resolutionEventId: EventId;
}

interface PendingAnswer {
  readonly responseTo: EventId;
  readonly answerEventId: EventId;
  readonly authorityRef?: string;
  readonly evidenceRef?: string;
  readonly timestamp: string;
}

/**
 * Pure, deterministically-reconstructible projection of one engineering
 * run. `currentFencingToken` and `appliedEventIds`/`appliedIdempotencyKeys`
 * are the mechanisms behind the idempotency/fencing invariants - exposed
 * (not private) so tests can assert on them directly, matching this
 * repo's existing convention of testing invariants concretely rather than
 * through opaque black-box behavior only.
 */
export interface EngineeringRunState {
  readonly projectRef: string;
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly branch: string;
  readonly baseSha: string;
  readonly checkpointSha?: string;
  readonly status: EngineeringRunStatus;
  readonly currentFencingToken: number;
  readonly awaiting?: { readonly questionEventId: EventId; readonly reason: string } | undefined;
  readonly resolution?: BrainResolution | undefined;
  readonly appliedEventIds: ReadonlyArray<EventId>;
  readonly appliedIdempotencyKeys: ReadonlyArray<string>;
  readonly pendingAnswers: ReadonlyArray<PendingAnswer>;
  readonly answeredQuestionEventIds: ReadonlyArray<EventId>;
  readonly reconciliation?: { readonly reason: string; readonly relatedEventId: EventId } | undefined;
}

const CHECKPOINT_ACCEPTING_STATUSES: ReadonlySet<EngineeringRunStatus | "NONE"> = new Set([
  "NONE",
  "CHANGES_REQUIRED",
  "RESUME_AUTHORIZED",
]);

const QUESTION_ACCEPTING_STATUSES: ReadonlySet<EngineeringRunStatus> = new Set([
  "CHECKPOINT_RECEIVED",
  "VERIFYING",
  "REVIEW_REQUIRED",
  "PASS",
]);

const OWNER_GATE_ACCEPTING_STATUSES: ReadonlySet<EngineeringRunStatus> = new Set([
  "CHECKPOINT_RECEIVED",
  "VERIFYING",
  "REVIEW_REQUIRED",
  "PASS",
  "CHANGES_REQUIRED",
  "WAITING",
]);

const RECONCILIATION_ACCEPTING_STATUSES: ReadonlySet<EngineeringRunStatus> = new Set([
  "CHECKPOINT_RECEIVED",
  "VERIFYING",
  "REVIEW_REQUIRED",
  "PASS",
  "CHANGES_REQUIRED",
  "WAITING",
  "RESUME_AUTHORIZED",
  "OWNER_GATE",
]);

const TERMINAL_STATUSES: ReadonlySet<EngineeringRunStatus> = new Set(["COMPLETED"]);

function isFresh(event: EngineeringEventEnvelope, state: EngineeringRunState | undefined): boolean {
  if (state === undefined) {
    return true;
  }
  if (state.appliedEventIds.includes(event.eventId)) {
    return false;
  }
  if (state.appliedIdempotencyKeys.includes(event.idempotencyKey)) {
    return false;
  }
  return true;
}

function recordApplied(state: EngineeringRunState, event: EngineeringEventEnvelope): {
  appliedEventIds: EventId[];
  appliedIdempotencyKeys: string[];
} {
  return {
    appliedEventIds: [...state.appliedEventIds, event.eventId],
    appliedIdempotencyKeys: [...state.appliedIdempotencyKeys, event.idempotencyKey],
  };
}

/**
 * Given a run just moved into WAITING for `questionEventId`, consumes any
 * already-buffered pending answer for that exact question and, if one
 * exists, immediately advances to RESUME_AUTHORIZED - the deterministic
 * counterpart to `applyEvent`'s ANSWER handling buffering an out-of-order
 * answer. This is what makes "callback before WAITING is durable" (E6)
 * reconcile correctly regardless of append order.
 */
function consumePendingAnswerIfAny(
  waitingState: EngineeringRunState,
  questionEventId: EventId,
): EngineeringRunState {
  const pending = waitingState.pendingAnswers.find((p) => p.responseTo === questionEventId);
  if (pending === undefined) {
    return waitingState;
  }
  return {
    ...waitingState,
    status: "RESUME_AUTHORIZED",
    awaiting: undefined,
    pendingAnswers: waitingState.pendingAnswers.filter((p) => p.responseTo !== questionEventId),
    answeredQuestionEventIds: [...waitingState.answeredQuestionEventIds, questionEventId],
  };
}

/**
 * ENG-ORCH-001 "First bounded vertical slice" #5-#9 + deterministic
 * invariants: the single pure reducer every live event and every replayed
 * historical event passes through. Returns a NEW state (or the same
 * `state` reference, unchanged, for a rejected/duplicate/no-op event) -
 * never mutates its input, and never throws for a routine
 * out-of-order/stale/duplicate event (those are expected protocol
 * traffic, not caller bugs; see doc comments below for exactly which
 * checks are treated as errors versus safe no-ops).
 *
 * QUESTION and ANSWER_RECEIVED are declared in `EngineeringRunStatus` (the
 * packet requires the state machine be able to represent them) but are not
 * independently reachable resting states in this bounded slice: ASK_QUESTION
 * moves straight to the durable WAITING state, and a valid ANSWER moves
 * straight to RESUME_AUTHORIZED, both in one atomic transition. Inventing a
 * separately-persisted intermediate resting point for either is not
 * required by any of E1-E16 and is not attempted here (this repo's
 * standing discipline: do not invent unspecified business states).
 */
export function applyEvent(
  state: EngineeringRunState | undefined,
  event: EngineeringEventEnvelope,
): EngineeringRunState | undefined {
  if (state !== undefined) {
    if (
      event.projectRef !== state.projectRef ||
      event.taskId !== state.taskId ||
      event.runId !== state.runId
    ) {
      throw new InvalidEngineeringRunStateError(
        "event does not belong to this run's project/task/runId",
      );
    }
  }

  if (!isFresh(event, state)) {
    return state as EngineeringRunState;
  }

  // Fencing: once any event bearing fencingToken N has been accepted for
  // this run, an event bearing a lower token is rejected outright,
  // regardless of event type or replay/append order (E7/E8).
  if (state !== undefined && event.fencingToken < state.currentFencingToken) {
    return state;
  }

  if (state !== undefined && TERMINAL_STATUSES.has(state.status)) {
    // Authority never regresses past COMPLETED (E3).
    return state;
  }

  const appliedTracking = state !== undefined ? recordApplied(state, event) : undefined;
  const nextFencingToken = Math.max(event.fencingToken, state?.currentFencingToken ?? 0);

  switch (event.eventType) {
    case "CHECKPOINT": {
      const currentStatus = state?.status ?? "NONE";
      if (!CHECKPOINT_ACCEPTING_STATUSES.has(currentStatus)) {
        return state;
      }
      if (event.branch === undefined || event.baseSha === undefined || event.checkpointSha === undefined) {
        throw new InvalidEngineeringRunStateError(
          "CHECKPOINT event requires branch, baseSha, and checkpointSha",
        );
      }
      if (state !== undefined && (event.branch !== state.branch || event.baseSha !== state.baseSha)) {
        // Wrong branch/base for an existing run fails closed (E1/E8).
        return state;
      }
      return {
        projectRef: event.projectRef,
        taskId: event.taskId,
        runId: event.runId,
        branch: event.branch,
        baseSha: event.baseSha,
        checkpointSha: event.checkpointSha,
        status: "CHECKPOINT_RECEIVED",
        currentFencingToken: nextFencingToken,
        pendingAnswers: state?.pendingAnswers ?? [],
        answeredQuestionEventIds: state?.answeredQuestionEventIds ?? [],
        appliedEventIds: appliedTracking?.appliedEventIds ?? [event.eventId],
        appliedIdempotencyKeys: appliedTracking?.appliedIdempotencyKeys ?? [event.idempotencyKey],
      };
    }

    case "BEGIN_VERIFICATION": {
      if (state === undefined || state.status !== "CHECKPOINT_RECEIVED") {
        return state;
      }
      if (event.checkpointSha !== undefined && event.checkpointSha !== state.checkpointSha) {
        return state; // E1/E8: mismatched SHA cannot enter VERIFYING.
      }
      return advance(state, appliedTracking, nextFencingToken, { status: "VERIFYING" });
    }

    case "FLAG_REVIEW": {
      if (state === undefined || state.status !== "VERIFYING") {
        return state;
      }
      return advance(state, appliedTracking, nextFencingToken, { status: "REVIEW_REQUIRED" });
    }

    case "RESOLVE": {
      if (state === undefined || (state.status !== "VERIFYING" && state.status !== "REVIEW_REQUIRED")) {
        return state;
      }
      if (event.status !== "PASS" && event.status !== "CHANGES_REQUIRED") {
        throw new InvalidEngineeringRunStateError('RESOLVE event.status must be "PASS" or "CHANGES_REQUIRED"');
      }
      if (event.checkpointSha === undefined || event.checkpointSha !== state.checkpointSha) {
        return state; // E12: BrainResolution must bind the exact checkpointSha.
      }
      if (event.authorityRef === undefined || event.evidenceRef === undefined) {
        throw new InvalidEngineeringRunStateError("RESOLVE event requires authorityRef and evidenceRef");
      }
      const resolution: BrainResolution = {
        projectRef: state.projectRef,
        taskId: state.taskId,
        runId: state.runId,
        branch: state.branch,
        checkpointSha: state.checkpointSha as string,
        decision: event.status,
        authorityRef: event.authorityRef,
        evidenceRef: event.evidenceRef,
        decidedAt: event.timestamp,
        resolutionEventId: event.eventId,
      };
      return advance(state, appliedTracking, nextFencingToken, { status: event.status, resolution });
    }

    case "ASK_QUESTION": {
      if (state === undefined || !QUESTION_ACCEPTING_STATUSES.has(state.status)) {
        return state;
      }
      if (event.waitReason === undefined) {
        throw new InvalidEngineeringRunStateError("ASK_QUESTION event requires waitReason");
      }
      const waitingState = advance(state, appliedTracking, nextFencingToken, {
        status: "WAITING",
        awaiting: { questionEventId: event.eventId, reason: event.waitReason },
      });
      return consumePendingAnswerIfAny(waitingState, event.eventId);
    }

    case "ANSWER": {
      if (event.responseTo === undefined) {
        throw new InvalidEngineeringRunStateError("ANSWER event requires responseTo");
      }
      if (state === undefined) {
        // Nothing durable for this run yet; buffer is not representable
        // without a run, so this is a genuine caller error.
        throw new InvalidEngineeringRunStateError(
          "ANSWER event arrived for a run with no prior state",
        );
      }
      if (state.answeredQuestionEventIds.includes(event.responseTo)) {
        // E5: duplicate delivery of an already-answered question is a
        // safe no-op - at most one RESUME_AUTHORIZED per question.
        return { ...state, ...appliedTracking, currentFencingToken: nextFencingToken };
      }
      if (state.status === "WAITING" && state.awaiting?.questionEventId === event.responseTo) {
        return advance(state, appliedTracking, nextFencingToken, {
          status: "RESUME_AUTHORIZED",
          awaiting: undefined,
          answeredQuestionEventIds: [...state.answeredQuestionEventIds, event.responseTo],
        });
      }
      // E6: the matching WAITING is not (yet) durable/current - buffer
      // the answer rather than losing it; ASK_QUESTION reconciles it once
      // the matching question is applied.
      const pendingAnswer: PendingAnswer = {
        responseTo: event.responseTo,
        answerEventId: event.eventId,
        ...(event.authorityRef !== undefined ? { authorityRef: event.authorityRef } : {}),
        ...(event.evidenceRef !== undefined ? { evidenceRef: event.evidenceRef } : {}),
        timestamp: event.timestamp,
      };
      return {
        ...state,
        ...appliedTracking,
        currentFencingToken: nextFencingToken,
        pendingAnswers: [...state.pendingAnswers, pendingAnswer],
      };
    }

    case "OWNER_GATE": {
      if (state === undefined || !OWNER_GATE_ACCEPTING_STATUSES.has(state.status)) {
        return state;
      }
      return advance(state, appliedTracking, nextFencingToken, { status: "OWNER_GATE" });
    }

    case "OWNER_GATE_CLEARED": {
      if (state === undefined || state.status !== "OWNER_GATE") {
        return state;
      }
      if (event.authorityRef === undefined) {
        throw new InvalidEngineeringRunStateError("OWNER_GATE_CLEARED event requires authorityRef");
      }
      return advance(state, appliedTracking, nextFencingToken, { status: "RESUME_AUTHORIZED" });
    }

    case "TIMEOUT": {
      if (state === undefined || TERMINAL_STATUSES.has(state.status) || state.status === "BLOCKED") {
        return state;
      }
      // E9: timeout/disappearance is always a safe explicit state, never
      // a self-authorized continuation.
      return advance(state, appliedTracking, nextFencingToken, { status: "BLOCKED" });
    }

    case "RECONCILIATION_REQUIRED": {
      if (state === undefined || !RECONCILIATION_ACCEPTING_STATUSES.has(state.status)) {
        return state;
      }
      if (event.waitReason === undefined) {
        throw new InvalidEngineeringRunStateError("RECONCILIATION_REQUIRED event requires waitReason");
      }
      return advance(state, appliedTracking, nextFencingToken, {
        status: "RECONCILIATION_REQUIRED",
        reconciliation: { reason: event.waitReason, relatedEventId: event.eventId },
      });
    }

    case "RECONCILED": {
      if (state === undefined || state.status !== "RECONCILIATION_REQUIRED") {
        return state;
      }
      if (event.evidenceRef === undefined) {
        throw new InvalidEngineeringRunStateError("RECONCILED event requires evidenceRef");
      }
      // E11: reconciliation never blindly replays/auto-resumes - it lands
      // in BLOCKED, which requires a fresh CHECKPOINT to proceed.
      return advance(state, appliedTracking, nextFencingToken, {
        status: "BLOCKED",
        reconciliation: undefined,
      });
    }

    case "COMPLETE": {
      if (state === undefined || (state.status !== "PASS" && state.status !== "RESUME_AUTHORIZED")) {
        return state;
      }
      return advance(state, appliedTracking, nextFencingToken, { status: "COMPLETED" });
    }

    default: {
      const exhaustive: never = event.eventType;
      throw new InvalidEngineeringRunStateError(`unhandled eventType: ${String(exhaustive)}`);
    }
  }
}

function advance(
  state: EngineeringRunState,
  appliedTracking: { appliedEventIds: EventId[]; appliedIdempotencyKeys: string[] } | undefined,
  currentFencingToken: number,
  patch: Partial<
    Pick<EngineeringRunState, "status" | "awaiting" | "resolution" | "reconciliation" | "answeredQuestionEventIds">
  >,
): EngineeringRunState {
  return {
    ...state,
    ...patch,
    currentFencingToken,
    appliedEventIds: appliedTracking?.appliedEventIds ?? state.appliedEventIds,
    appliedIdempotencyKeys: appliedTracking?.appliedIdempotencyKeys ?? state.appliedIdempotencyKeys,
  };
}

/**
 * Deterministically reconstructs a run's state from its full durable event
 * log, in true append/sequence order (not fencingToken order - see the
 * module doc comment on why: replay must be able to buffer an
 * out-of-order ANSWER exactly as a live apply would, for E6 to hold
 * regardless of which order events actually became durable in).
 */
export function reconstructState(
  events: ReadonlyArray<EngineeringEventEnvelope>,
): EngineeringRunState | undefined {
  let state: EngineeringRunState | undefined;
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}
