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
  /**
   * E12: reference to the task/branch this resolution authorizes as the
   * next worker/continuation, when the RESOLVE event carried one. Absent
   * when no next-worker continuation is authorized - never invented.
   */
  readonly authorizedNextTaskRef?: string;
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
  /**
   * V5 A/D: durable history of `BrainResolution`s superseded by a later
   * `CHECKPOINT` on the same run (a post-review push) - see
   * `CHECKPOINT_ACCEPTING_STATUSES` and the `CHECKPOINT` case in
   * `applyEvent`. A resolution is superseded, never silently dropped, so a
   * caller can always distinguish "no resolution ever existed" from "an
   * approval existed but is now stale for the current checkpointSha".
   */
  readonly supersededResolutions: ReadonlyArray<BrainResolution>;
}

/**
 * V5 A/D: `PASS` is included so a fresh `CHECKPOINT` (a post-review push)
 * can explicitly invalidate a stale merge approval through an authorized
 * transition, rather than being rejected as a no-op (see the `CHECKPOINT`
 * case's `checkpointSha`-unchanged guard, which still treats a duplicate
 * delivery of the *same* reviewed commit as a no-op rather than a genuine
 * new push). `COMPLETED` is deliberately excluded - it remains terminal per
 * `TERMINAL_STATUSES`, checked before this set is consulted.
 */
const CHECKPOINT_ACCEPTING_STATUSES: ReadonlySet<EngineeringRunStatus | "NONE"> = new Set([
  "NONE",
  "CHANGES_REQUIRED",
  "RESUME_AUTHORIZED",
  "PASS",
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

/**
 * E7 fencing-floor fix: a status-guard rejection (event type valid but
 * wrong current status for it) is still an ACCEPTED, not-stale event -
 * its fencing token must still raise the floor, independently of whether
 * it produced a business-valid transition. Otherwise a worker holding an
 * intermediate token that this run has already seen-but-rejected remains
 * able to mutate state later, defeating the "newer fence revokes stale
 * mutation authority" invariant (E7). Wrong-BINDING rejections (mismatched
 * branch/baseSha/checkpointSha) are deliberately NOT routed through this
 * helper - those represent a forged/misdirected event, not a legitimate
 * out-of-order one, and must leave state (including the fencing floor)
 * completely untouched (see the E1/E8 tests this preserves unchanged).
 */
function noOp(
  state: EngineeringRunState | undefined,
  nextFencingToken: number,
): EngineeringRunState | undefined {
  if (state === undefined || state.currentFencingToken === nextFencingToken) {
    return state;
  }
  return { ...state, currentFencingToken: nextFencingToken };
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
 * packet requires the state machine be able to represent them). This pure
 * reducer deliberately keeps ASK_QUESTION moving straight to the durable
 * WAITING state, and a valid ANSWER moving straight to RESUME_AUTHORIZED,
 * both in one atomic transition - inventing a separately-persisted
 * intermediate resting point here would risk weakening the exactly-once
 * WAITING/RESUME_AUTHORIZED guarantees (E5/E6). Durable, observable
 * representability of QUESTION and ANSWER_RECEIVED as their own lifecycle
 * phases is instead provided by the separate, purely-derived
 * `projectLifecyclePhases` event-sourced projection below, over this same
 * reducer and the same durable log - see its doc comment.
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
        return noOp(state, nextFencingToken);
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
      if (state !== undefined && state.status === "PASS") {
        // V5 A/D: only a STRICTLY newer push - a different checkpointSha
        // AND a fencing token strictly greater than the current one - may
        // invalidate a PASS approval. A duplicate delivery of the exact
        // reviewed commit is not a new push, and an equal fencing token
        // (already known not to be lower, per the global floor check above)
        // is not proof of a newer writer either - both remain safe no-ops
        // that preserve the still-current approval rather than regressing
        // it, matching the Rev36/Rev38 acceptance contract that stale,
        // lower, AND equal fencing must all fail to regress state.
        const isGenuineNewPush =
          event.checkpointSha !== state.checkpointSha && event.fencingToken > state.currentFencingToken;
        if (!isGenuineNewPush) {
          return noOp(state, nextFencingToken);
        }
      }
      const supersededResolutions =
        state?.resolution !== undefined
          ? [...state.supersededResolutions, state.resolution]
          : (state?.supersededResolutions ?? []);
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
        supersededResolutions,
      };
    }

    case "BEGIN_VERIFICATION": {
      if (state === undefined || state.status !== "CHECKPOINT_RECEIVED") {
        return noOp(state, nextFencingToken);
      }
      if (event.checkpointSha !== undefined && event.checkpointSha !== state.checkpointSha) {
        return state; // E1/E8: mismatched SHA cannot enter VERIFYING.
      }
      return advance(state, appliedTracking, nextFencingToken, { status: "VERIFYING" });
    }

    case "FLAG_REVIEW": {
      if (state === undefined || state.status !== "VERIFYING") {
        return noOp(state, nextFencingToken);
      }
      return advance(state, appliedTracking, nextFencingToken, { status: "REVIEW_REQUIRED" });
    }

    case "RESOLVE": {
      if (state === undefined || (state.status !== "VERIFYING" && state.status !== "REVIEW_REQUIRED")) {
        return noOp(state, nextFencingToken);
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
        ...(event.authorizedNextTaskRef !== undefined
          ? { authorizedNextTaskRef: event.authorizedNextTaskRef }
          : {}),
      };
      return advance(state, appliedTracking, nextFencingToken, { status: event.status, resolution });
    }

    case "ASK_QUESTION": {
      if (state === undefined || !QUESTION_ACCEPTING_STATUSES.has(state.status)) {
        return noOp(state, nextFencingToken);
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
        return noOp(state, nextFencingToken);
      }
      return advance(state, appliedTracking, nextFencingToken, { status: "OWNER_GATE" });
    }

    case "OWNER_GATE_CLEARED": {
      if (state === undefined || state.status !== "OWNER_GATE") {
        return noOp(state, nextFencingToken);
      }
      if (event.authorityRef === undefined) {
        throw new InvalidEngineeringRunStateError("OWNER_GATE_CLEARED event requires authorityRef");
      }
      return advance(state, appliedTracking, nextFencingToken, { status: "RESUME_AUTHORIZED" });
    }

    case "TIMEOUT": {
      if (state === undefined || TERMINAL_STATUSES.has(state.status) || state.status === "BLOCKED") {
        return noOp(state, nextFencingToken);
      }
      // E9: timeout/disappearance is always a safe explicit state, never
      // a self-authorized continuation.
      return advance(state, appliedTracking, nextFencingToken, { status: "BLOCKED" });
    }

    case "RECONCILIATION_REQUIRED": {
      if (state === undefined || !RECONCILIATION_ACCEPTING_STATUSES.has(state.status)) {
        return noOp(state, nextFencingToken);
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
        return noOp(state, nextFencingToken);
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
        return noOp(state, nextFencingToken);
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
 *
 * E7 pre-state fencing fix: `applyEvent`'s fencing floor lives on
 * `EngineeringRunState.currentFencingToken`, which does not exist before
 * the first successful CHECKPOINT. Without this, a higher fencing token
 * observed via any event durably appended BEFORE that first CHECKPOINT
 * (e.g. a premature ASK_QUESTION/TIMEOUT with no run yet to attach to)
 * would be silently lost, letting a later, lower-fenced CHECKPOINT
 * attempt still succeed and create the run - a stale/dual lease
 * "winning" the very first mutation, despite a newer fence having already
 * been observed. This replay loop tracks that pre-state floor explicitly
 * (`observedFencingFloor`, independent of `state`) and skips any event
 * whose token falls below it, so the first CHECKPOINT to actually create
 * state is provably the freshest one seen so far - not merely the
 * freshest one `applyEvent` happened to be handed a defined `state` for.
 * Once state exists, this floor and `state.currentFencingToken` track
 * identically (every accepted event advances both to the same value), so
 * this pre-filter is a genuine no-op for every event that arrives after
 * the run already exists - it only changes behavior in the pre-state
 * window.
 */
export function reconstructState(
  events: ReadonlyArray<EngineeringEventEnvelope>,
): EngineeringRunState | undefined {
  let state: EngineeringRunState | undefined;
  let observedFencingFloor = 0;
  for (const event of events) {
    if (event.fencingToken < observedFencingFloor) {
      // Stale relative to an already-observed fence, even though no
      // EngineeringRunState exists yet to reject it through the normal
      // applyEvent path - skip it entirely rather than letting it reach
      // (and possibly succeed against) an undefined state.
      continue;
    }
    state = applyEvent(state, event);
    observedFencingFloor = Math.max(observedFencingFloor, event.fencingToken);
  }
  return state;
}

/**
 * One durably-projected lifecycle phase, tied to the exact event that
 * caused it.
 */
export interface LifecyclePhaseEntry {
  readonly phase: EngineeringRunStatus;
  readonly eventId: EventId;
  readonly timestamp: string;
}

/**
 * QUESTION/ANSWER_RECEIVED representability fix: `applyEvent` deliberately
 * keeps its exactly-once WAITING/RESUME_AUTHORIZED semantics untouched (no
 * change to the pure reducer's state machine or its E5/E6 guarantees).
 * Instead, this is a second, purely-derived event-sourced projection over
 * the same durable log that makes QUESTION and ANSWER_RECEIVED durably and
 * observably representable as their own phase entries - not merely
 * declared enum values - without weakening or duplicating the underlying
 * exactly-once authorization.
 *
 * - Every ASK_QUESTION that is accepted (not a status-guard no-op) emits a
 *   QUESTION phase immediately followed by a WAITING phase for that same
 *   eventId; if a pending answer was already buffered for it, a
 *   RESUME_AUTHORIZED phase is emitted right after (mirrors the reducer's
 *   immediate reconciliation).
 * - Every ANSWER that is durably received emits an ANSWER_RECEIVED phase -
 *   whether it reconciles immediately (followed by RESUME_AUTHORIZED) or is
 *   buffered out-of-order (E6). A duplicate ANSWER to an
 *   already-answered question (E5) emits no new phase at all, preserving
 *   exactly-once observability at the projection layer too.
 * - Every other accepted, status-changing event projects its resulting
 *   status as a single phase entry.
 */
export function projectLifecyclePhases(
  events: ReadonlyArray<EngineeringEventEnvelope>,
): ReadonlyArray<LifecyclePhaseEntry> {
  const phases: LifecyclePhaseEntry[] = [];
  let state: EngineeringRunState | undefined;

  for (const event of events) {
    const before = state;
    const after = applyEvent(before, event);
    state = after;

    if (after === undefined) {
      continue;
    }

    const statusChanged = before === undefined || before.status !== after.status;

    if (event.eventType === "ASK_QUESTION") {
      if (!statusChanged) {
        continue; // status-guard no-op: no question was actually posed.
      }
      phases.push({ phase: "QUESTION", eventId: event.eventId, timestamp: event.timestamp });
      phases.push({ phase: "WAITING", eventId: event.eventId, timestamp: event.timestamp });
      if (after.status === "RESUME_AUTHORIZED") {
        phases.push({
          phase: "RESUME_AUTHORIZED",
          eventId: event.eventId,
          timestamp: event.timestamp,
        });
      }
      continue;
    }

    if (event.eventType === "ANSWER") {
      const pendingCountBefore = before?.pendingAnswers.length ?? 0;
      if (statusChanged && after.status === "RESUME_AUTHORIZED") {
        phases.push({ phase: "ANSWER_RECEIVED", eventId: event.eventId, timestamp: event.timestamp });
        phases.push({
          phase: "RESUME_AUTHORIZED",
          eventId: event.eventId,
          timestamp: event.timestamp,
        });
        continue;
      }
      if (!statusChanged && after.pendingAnswers.length > pendingCountBefore) {
        // Buffered out-of-order answer (E6): received, not yet reconciled.
        phases.push({ phase: "ANSWER_RECEIVED", eventId: event.eventId, timestamp: event.timestamp });
      }
      // Otherwise: duplicate answer to an already-answered question (E5) -
      // no new observable phase, matching exactly-once semantics.
      continue;
    }

    if (statusChanged) {
      phases.push({ phase: after.status, eventId: event.eventId, timestamp: event.timestamp });
    }
  }

  return phases;
}
