import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, type EngineeringRunState } from "../src/domain/engineering-run-state.js";
import { makeEvent } from "./helpers/engineering-event-helpers.js";

const branch = "claude/ENG-ORCH-001-task-packet";
const baseSha = "base-sha-1";
const checkpointSha = "checkpoint-sha-1";

function checkpointEvent(fencingToken = 1) {
  return makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken });
}

function checkpointedState(): EngineeringRunState {
  const state = applyEvent(undefined, checkpointEvent());
  assert.ok(state);
  return state as EngineeringRunState;
}

test("E1: CHECKPOINT bound to the exact branch/baseSha enters CHECKPOINT_RECEIVED", () => {
  const state = checkpointedState();
  assert.equal(state.status, "CHECKPOINT_RECEIVED");
  assert.equal(state.branch, branch);
  assert.equal(state.baseSha, baseSha);
  assert.equal(state.checkpointSha, checkpointSha);
});

test("E1: a mismatched branch/baseSha on a subsequent CHECKPOINT fails closed (state unchanged)", () => {
  const state = checkpointedState();
  const mismatched = applyEvent(
    state,
    makeEvent({
      eventType: "CHECKPOINT",
      branch: "some-other-branch",
      baseSha,
      checkpointSha: "checkpoint-sha-2",
      fencingToken: 2,
    }),
  );
  assert.deepEqual(mismatched, state);
});

test("E1: BEGIN_VERIFICATION requires the exact checkpointSha to enter VERIFYING", () => {
  const state = checkpointedState();
  const wrongSha = applyEvent(
    state,
    makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha: "wrong-sha", fencingToken: 2 }),
  );
  assert.equal(wrongSha?.status, "CHECKPOINT_RECEIVED");

  const verifying = applyEvent(
    state,
    makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }),
  );
  assert.equal(verifying?.status, "VERIFYING");
});

test("E2: duplicate delivery of the same event (same eventId) is applied once logically", () => {
  const event = checkpointEvent();
  const first = applyEvent(undefined, event);
  const second = applyEvent(first, event);
  assert.deepEqual(second, first);
});

test("E2: duplicate delivery via the same idempotencyKey (different eventId) is applied once logically", () => {
  const idempotencyKey = "shared-idem-key";
  const first = applyEvent(
    undefined,
    makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1, idempotencyKey }),
  );
  const secondDeliveryDifferentEventId = applyEvent(
    first,
    makeEvent({
      eventType: "CHECKPOINT",
      branch,
      baseSha,
      checkpointSha: "different-checkpoint-sha",
      fencingToken: 1,
      idempotencyKey,
    }),
  );
  assert.deepEqual(secondDeliveryDifferentEventId, first);
});

test("E3: authority does not regress past COMPLETED for a late-arriving event", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  state = applyEvent(
    state,
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha,
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/evidence-1",
      fencingToken: 3,
    }),
  )!;
  state = applyEvent(state, makeEvent({ eventType: "COMPLETE", fencingToken: 4 }))!;
  assert.equal(state.status, "COMPLETED");

  const lateEvent = makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 5 });
  const afterLateEvent = applyEvent(state, lateEvent);
  assert.deepEqual(afterLateEvent, state);
});

test("E7: a newer fencing token invalidates a stale lease holder's mutation attempt", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  state = applyEvent(
    state,
    makeEvent({ eventType: "ASK_QUESTION", waitReason: "need clarification", fencingToken: 3 }),
  )!;
  assert.equal(state.status, "WAITING");

  // A newer lease (fencingToken 5) answers legitimately.
  const answered = applyEvent(
    state,
    makeEvent({
      eventType: "ANSWER",
      responseTo: state.awaiting?.questionEventId,
      fencingToken: 5,
    }),
  )!;
  assert.equal(answered.status, "RESUME_AUTHORIZED");
  assert.equal(answered.currentFencingToken, 5);

  // The stale worker, still holding fencingToken 3, attempts to mutate
  // after the newer fence (5) has already been established - rejected.
  const staleAttempt = applyEvent(
    answered,
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha,
      authorityRef: "stale-worker",
      evidenceRef: "internal://tests/stale",
      fencingToken: 3,
    }),
  );
  assert.deepEqual(staleAttempt, answered);
});

test("E7: dual concurrent leases cannot both win - only the higher fencing token's effect sticks", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;

  // Two workers race to resolve the same checkpoint with different fencing tokens.
  const lowFenceResolution = applyEvent(
    state,
    makeEvent({
      eventType: "RESOLVE",
      status: "CHANGES_REQUIRED",
      checkpointSha,
      authorityRef: "worker-a",
      evidenceRef: "internal://tests/a",
      fencingToken: 4,
    }),
  )!;
  const highFenceAttempt = applyEvent(
    lowFenceResolution,
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha,
      authorityRef: "worker-b",
      evidenceRef: "internal://tests/b",
      fencingToken: 10,
    }),
  );
  // worker-b's higher fencing token alone cannot resurrect an already-
  // settled business decision: RESOLVE only applies from
  // VERIFYING/REVIEW_REQUIRED, and state is now CHANGES_REQUIRED - fencing
  // is necessary but not sufficient authority, so this is a business no-op
  // (the floor does not advance for a rejected-by-status-guard event).
  assert.deepEqual(highFenceAttempt, lowFenceResolution);

  // Now prove the fencing floor itself: a stale (lower) fencing token
  // cannot mutate the run at all, even via an event type that would
  // otherwise be business-valid (CHECKPOINT is legitimately re-enterable
  // from CHANGES_REQUIRED - the rejection here must come from fencing,
  // not from a status-guard).
  const staleReplay = applyEvent(
    lowFenceResolution,
    makeEvent({
      eventType: "CHECKPOINT",
      branch,
      baseSha,
      checkpointSha: "attacker-checkpoint",
      fencingToken: 2,
    }),
  );
  assert.deepEqual(staleReplay, lowFenceResolution);
});

test("E8: wrong project/task/runId event throws rather than silently mutating", () => {
  const state = checkpointedState();
  assert.throws(() => {
    applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", taskId: "OTHER-TASK", fencingToken: 2 }));
  });
});

test("E8: wrong checkpointSha on RESOLVE fails closed without mutation", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  const wrongShaResolve = applyEvent(
    state,
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha: "wrong-sha",
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/evidence",
      fencingToken: 3,
    }),
  );
  assert.deepEqual(wrongShaResolve, state);
});

test("E9: TIMEOUT yields an explicit BLOCKED state and never self-authorizes continuation", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  const timedOut = applyEvent(state, makeEvent({ eventType: "TIMEOUT", fencingToken: 3 }));
  assert.equal(timedOut?.status, "BLOCKED");
  assert.notEqual(timedOut?.status, "RESUME_AUTHORIZED");
  assert.notEqual(timedOut?.status, "PASS");
});

test("E10: a retried attempt (same idempotencyKey, higher attempt number) does not duplicate a continuation authorization", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  state = applyEvent(
    state,
    makeEvent({ eventType: "ASK_QUESTION", waitReason: "invoker retry scenario", fencingToken: 3 }),
  )!;
  const questionEventId = state.awaiting?.questionEventId;
  const idempotencyKey = "answer-idem-key";
  const firstAttempt = applyEvent(
    state,
    makeEvent({ eventType: "ANSWER", responseTo: questionEventId, attempt: 1, idempotencyKey, fencingToken: 4 }),
  )!;
  assert.equal(firstAttempt.status, "RESUME_AUTHORIZED");
  const retriedAttempt = applyEvent(
    firstAttempt,
    makeEvent({ eventType: "ANSWER", responseTo: questionEventId, attempt: 2, idempotencyKey, fencingToken: 4 }),
  );
  assert.deepEqual(retriedAttempt, firstAttempt);
});

test("E12: PASS requires a canonically bound BrainResolution and retains authority/evidence lineage", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  const resolved = applyEvent(
    state,
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha,
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/evidence-final",
      fencingToken: 3,
    }),
  )!;
  assert.equal(resolved.status, "PASS");
  assert.equal(resolved.resolution?.decision, "PASS");
  assert.equal(resolved.resolution?.authorityRef, "Brain/ChatGPT");
  assert.equal(resolved.resolution?.evidenceRef, "internal://tests/evidence-final");
  assert.equal(resolved.resolution?.checkpointSha, checkpointSha);
});

test("a worker cannot self-grant PASS/RESUME_AUTHORIZED without a RESOLVE/ANSWER event", () => {
  const state = checkpointedState();
  // No event type in this bounded slice can move CHECKPOINT_RECEIVED
  // directly to PASS or RESUME_AUTHORIZED without going through
  // VERIFYING + a canonically bound RESOLVE (or WAITING + ANSWER).
  const bogusComplete = applyEvent(state, makeEvent({ eventType: "COMPLETE", fencingToken: 2 }));
  assert.deepEqual(bogusComplete, state);
});
