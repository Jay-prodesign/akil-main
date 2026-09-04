import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, reconstructState, type EngineeringRunState } from "../src/domain/engineering-run-state.js";
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

test("E1: a mismatched branch/baseSha on a subsequent CHECKPOINT fails closed (business fields unchanged)", () => {
  const state = checkpointedState();
  // CHECKPOINT_RECEIVED is not itself a checkpoint-accepting status (a
  // fresh CHECKPOINT only re-enters from NONE/CHANGES_REQUIRED/
  // RESUME_AUTHORIZED), so this is rejected by the status guard before
  // the branch/baseSha binding is even inspected - per the E7 fencing fix,
  // the floor still advances even though nothing business-relevant does.
  const mismatched = applyEvent(
    state,
    makeEvent({
      eventType: "CHECKPOINT",
      branch: "some-other-branch",
      baseSha,
      checkpointSha: "checkpoint-sha-2",
      fencingToken: 2,
    }),
  )!;
  assert.equal(mismatched.status, state.status);
  assert.equal(mismatched.branch, state.branch);
  assert.equal(mismatched.baseSha, state.baseSha);
  assert.equal(mismatched.checkpointSha, state.checkpointSha);
  assert.equal(mismatched.currentFencingToken, 2);
});

test("E1: a mismatched branch/baseSha binding is itself rejected without mutation when the status would otherwise accept a fresh CHECKPOINT", () => {
  let state = checkpointedState();
  // Reach a checkpoint-accepting status (CHANGES_REQUIRED) so the
  // wrong-binding check is the one actually exercised, not the status
  // guard.
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  state = applyEvent(
    state,
    makeEvent({
      eventType: "RESOLVE",
      status: "CHANGES_REQUIRED",
      checkpointSha,
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/e1-binding",
      fencingToken: 3,
    }),
  )!;
  assert.equal(state.status, "CHANGES_REQUIRED");

  const mismatched = applyEvent(
    state,
    makeEvent({
      eventType: "CHECKPOINT",
      branch: "some-other-branch",
      baseSha,
      checkpointSha: "checkpoint-sha-2",
      fencingToken: 4,
    }),
  );
  // A wrong-binding CHECKPOINT is a forged/misdirected event, not a
  // legitimate out-of-order one - it must leave everything, including the
  // fencing floor, completely untouched.
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
  )!;
  // worker-b's higher fencing token alone cannot resurrect an already-
  // settled business decision: RESOLVE only applies from
  // VERIFYING/REVIEW_REQUIRED, and state is now CHANGES_REQUIRED, so the
  // business outcome (status + resolution) does not change - fencing is
  // necessary but not sufficient business authority.
  assert.equal(highFenceAttempt.status, "CHANGES_REQUIRED");
  assert.equal(highFenceAttempt.resolution?.authorityRef, "worker-a");
  // But the fencing floor DOES still advance to the higher observed token
  // (E7 fix): existence/acceptance of a newer fence revokes stale
  // mutation authority independently of whether that event changed the
  // business status.
  assert.equal(highFenceAttempt.currentFencingToken, 10);

  // Now prove the fencing floor itself: a stale (lower) fencing token
  // cannot mutate the run at all, even via an event type that would
  // otherwise be business-valid (CHECKPOINT is legitimately re-enterable
  // from CHANGES_REQUIRED - the rejection here must come from fencing,
  // not from a status-guard). Token 6 would have been accepted under the
  // pre-fix floor (still at 4); it must now fail closed against the
  // correctly-advanced floor (10).
  const staleReplay = applyEvent(
    highFenceAttempt,
    makeEvent({
      eventType: "CHECKPOINT",
      branch,
      baseSha,
      checkpointSha: "attacker-checkpoint",
      fencingToken: 6,
    }),
  );
  assert.deepEqual(staleReplay, highFenceAttempt);
});

test("E7 (adversarial): a higher fence observed via a business-invalid no-op event still revokes a subsequent lower stale fence's otherwise-valid mutation", () => {
  const state = applyEvent(
    checkpointedState(),
    makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }),
  )!;
  assert.equal(state.status, "VERIFYING");

  // A higher-fenced event arrives that is business-invalid for the
  // current status (OWNER_GATE_CLEARED is only valid from OWNER_GATE) -
  // a no-op for status purposes, but its fencing token must still be
  // observed/accepted as the new floor.
  const afterHighNoOp = applyEvent(
    state,
    makeEvent({ eventType: "OWNER_GATE_CLEARED", authorityRef: "owner:founder", fencingToken: 10 }),
  )!;
  assert.equal(afterHighNoOp.status, "VERIFYING");
  assert.equal(afterHighNoOp.currentFencingToken, 10);

  // A stale worker holding an older token that would otherwise be a
  // perfectly valid FLAG_REVIEW mutation from VERIFYING must now fail
  // closed - the newer fence already revoked its authority.
  const staleButOtherwiseValid = applyEvent(
    afterHighNoOp,
    makeEvent({ eventType: "FLAG_REVIEW", fencingToken: 5 }),
  );
  assert.deepEqual(staleButOtherwiseValid, afterHighNoOp);

  // Preserve no-double-win: a same-token replay of the no-op event is
  // itself a safe, idempotent no-op on the floor too.
  const sameTokenReplay = applyEvent(
    afterHighNoOp,
    makeEvent({ eventType: "OWNER_GATE_CLEARED", authorityRef: "owner:founder-2", fencingToken: 10 }),
  )!;
  assert.equal(sameTokenReplay.currentFencingToken, 10);
  assert.equal(sameTokenReplay.status, "VERIFYING");
});

test("E7 (pre-state): a higher fence observed before any run exists still revokes a subsequent lower-fenced initial CHECKPOINT", () => {
  // Nothing durable exists for this project/task/run yet, so a premature
  // ASK_QUESTION is a status-guard no-op (applyEvent(undefined, ...)
  // returns undefined, per its own semantics) - but its fencingToken must
  // still be remembered by the replay boundary (reconstructState), not
  // silently lost just because there was no EngineeringRunState to attach
  // it to yet.
  const prematureHighFence = makeEvent({
    eventType: "ASK_QUESTION",
    waitReason: "premature - no run yet",
    fencingToken: 10,
  });
  const staleInitialCheckpoint = checkpointEvent(3);

  const state = reconstructState([prematureHighFence, staleInitialCheckpoint]);
  // The stale (lower-fenced) CHECKPOINT must fail closed - no run is
  // created at all, proving a stale/dual lease holder cannot win even the
  // very FIRST mutation once a newer fence has already been observed.
  assert.equal(state, undefined);
});

test("E7 (pre-state): a fresh CHECKPOINT at or above the pre-observed floor still succeeds and carries the correct floor forward", () => {
  const prematureHighFence = makeEvent({
    eventType: "ASK_QUESTION",
    waitReason: "premature - no run yet",
    fencingToken: 10,
  });
  const validInitialCheckpoint = checkpointEvent(10);

  const state = reconstructState([prematureHighFence, validInitialCheckpoint]);
  assert.ok(state);
  assert.equal(state!.status, "CHECKPOINT_RECEIVED");
  assert.equal(state!.currentFencingToken, 10);
});

test("E7 (pre-state): once a run exists, the pre-state floor tracking is a no-op - normal in-run fencing behavior is unchanged", () => {
  // A sanity check that the reconstructState pre-filter only changes
  // behavior in the pre-state window: replaying a normal, fully in-order,
  // monotonically-increasing-token event sequence through
  // reconstructState must produce the exact same state as calling
  // applyEvent directly in sequence.
  const events = [
    checkpointEvent(1),
    makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }),
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha,
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/e7-prestate-sanity",
      fencingToken: 3,
    }),
  ];
  const viaReconstruct = reconstructState(events);
  let viaDirect: EngineeringRunState | undefined;
  for (const event of events) {
    viaDirect = applyEvent(viaDirect, event);
  }
  assert.deepEqual(viaReconstruct, viaDirect);
  assert.equal(viaReconstruct?.status, "PASS");
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
  // VERIFYING + a canonically bound RESOLVE (or WAITING + ANSWER). Same
  // fencing token as the current state, so this is a pure business no-op
  // with nothing else to prove about the fencing floor here (see the
  // dedicated E7 tests for that).
  const bogusComplete = applyEvent(state, makeEvent({ eventType: "COMPLETE", fencingToken: 1 }));
  assert.deepEqual(bogusComplete, state);
});

test("E3: an out-of-order FLAG_REVIEW with a fencing token lower than the current floor cannot regress a later RESOLVE outcome", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  const resolved = applyEvent(
    state,
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha,
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/e3-a",
      fencingToken: 4,
    }),
  )!;
  assert.equal(resolved.status, "PASS");

  // A FLAG_REVIEW event with a fencing token between the two already-
  // applied tokens (2 and 4) arrives "late" (physically after RESOLVE) -
  // its lower token means it must fail closed rather than regress PASS
  // back to REVIEW_REQUIRED, proving arrival order is evidence, not
  // authority, outside the E6 answer-before-wait special case.
  const lateOutOfOrder = applyEvent(resolved, makeEvent({ eventType: "FLAG_REVIEW", fencingToken: 3 }));
  assert.deepEqual(lateOutOfOrder, resolved);
});

function passResolvedState(): EngineeringRunState {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  return applyEvent(
    state,
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha,
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/e3-b",
      fencingToken: 4,
    }),
  )!;
}

test("E3/V5-A: a duplicate CHECKPOINT delivering the exact same reviewed commit is a safe no-op - a still-current PASS approval is not invalidated", () => {
  const resolved = passResolvedState();
  assert.equal(resolved.status, "PASS");

  const duplicateCheckpoint = applyEvent(
    resolved,
    makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 5 }),
  )!;
  assert.equal(duplicateCheckpoint.status, "PASS");
  assert.equal(duplicateCheckpoint.resolution?.checkpointSha, checkpointSha);
  assert.equal(duplicateCheckpoint.supersededResolutions.length, 0);
  assert.equal(duplicateCheckpoint.currentFencingToken, 5);
});

test("V5-A: a fresh CHECKPOINT carrying a NEW checkpointSha (a post-review push) explicitly invalidates the stale PASS approval through an authorized transition", () => {
  const resolved = passResolvedState();
  const staleResolution = resolved.resolution;
  assert.ok(staleResolution);

  const postReviewPush = applyEvent(
    resolved,
    makeEvent({
      eventType: "CHECKPOINT",
      branch,
      baseSha,
      checkpointSha: "checkpoint-sha-2",
      fencingToken: 5,
    }),
  )!;

  // The run is explicitly reopened for the new commit - not stuck in a
  // stale PASS state, and not silently ignored as a no-op.
  assert.equal(postReviewPush.status, "CHECKPOINT_RECEIVED");
  assert.equal(postReviewPush.checkpointSha, "checkpoint-sha-2");
  assert.equal(postReviewPush.currentFencingToken, 5);

  // The old approval is explicitly gone as CURRENT merge authority ...
  assert.equal(postReviewPush.resolution, undefined);
  // ... but retained as superseded history, not silently dropped.
  assert.deepEqual(postReviewPush.supersededResolutions, [staleResolution]);

  // A second genuine push chains correctly: the run can be re-verified and
  // re-resolved for the new SHA, and a third push supersedes THAT
  // resolution too, accumulating history rather than overwriting it.
  let reVerified = applyEvent(
    postReviewPush,
    makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha: "checkpoint-sha-2", fencingToken: 6 }),
  )!;
  const reResolved = applyEvent(
    reVerified,
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha: "checkpoint-sha-2",
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/v5-a-rechain",
      fencingToken: 7,
    }),
  )!;
  assert.equal(reResolved.status, "PASS");

  const secondPostReviewPush = applyEvent(
    reResolved,
    makeEvent({
      eventType: "CHECKPOINT",
      branch,
      baseSha,
      checkpointSha: "checkpoint-sha-3",
      fencingToken: 8,
    }),
  )!;
  assert.equal(secondPostReviewPush.status, "CHECKPOINT_RECEIVED");
  assert.equal(secondPostReviewPush.supersededResolutions.length, 2);
  assert.equal(secondPostReviewPush.supersededResolutions[0], staleResolution);
  assert.equal(secondPostReviewPush.supersededResolutions[1]?.checkpointSha, "checkpoint-sha-2");
});

test("V5-A: a stale-fenced CHECKPOINT still cannot invalidate a PASS approval - the global fencing floor is checked before the CHECKPOINT-accepting-status guard", () => {
  const resolved = passResolvedState();
  assert.equal(resolved.currentFencingToken, 4);

  const staleCheckpoint = applyEvent(
    resolved,
    makeEvent({
      eventType: "CHECKPOINT",
      branch,
      baseSha,
      checkpointSha: "checkpoint-sha-2",
      fencingToken: 3,
    }),
  )!;
  assert.deepEqual(staleCheckpoint, resolved);
});

test("V5-A: COMPLETED remains terminal - a post-completion CHECKPOINT still cannot reopen the run (E3 invariant preserved)", () => {
  const resolved = passResolvedState();
  const completed = applyEvent(resolved, makeEvent({ eventType: "COMPLETE", fencingToken: 5 }))!;
  assert.equal(completed.status, "COMPLETED");

  const afterComplete = applyEvent(
    completed,
    makeEvent({
      eventType: "CHECKPOINT",
      branch,
      baseSha,
      checkpointSha: "checkpoint-sha-2",
      fencingToken: 6,
    }),
  )!;
  assert.equal(afterComplete.status, "COMPLETED");
  assert.equal(afterComplete.checkpointSha, checkpointSha);
});

test("E12: RESOLVE CHANGES_REQUIRED produces a BrainResolution with full authority/evidence lineage", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  const resolved = applyEvent(
    state,
    makeEvent({
      eventType: "RESOLVE",
      status: "CHANGES_REQUIRED",
      checkpointSha,
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/e12-changes-required",
      fencingToken: 3,
    }),
  )!;
  assert.equal(resolved.status, "CHANGES_REQUIRED");
  assert.equal(resolved.resolution?.decision, "CHANGES_REQUIRED");
  assert.equal(resolved.resolution?.authorityRef, "Brain/ChatGPT");
  assert.equal(resolved.resolution?.evidenceRef, "internal://tests/e12-changes-required");
  assert.equal(resolved.resolution?.checkpointSha, checkpointSha);
});

test("E12: RESOLVE PASS with an authorizedNextTaskRef carries the authorized next-worker/continuation reference on the BrainResolution", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  const resolved = applyEvent(
    state,
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha,
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/e12-next-worker",
      authorizedNextTaskRef: "ENG-ORCH-002",
      fencingToken: 3,
    }),
  )!;
  assert.equal(resolved.resolution?.authorizedNextTaskRef, "ENG-ORCH-002");
});

test("E12: RESOLVE PASS without an authorizedNextTaskRef leaves it absent (no continuation silently invented)", () => {
  let state = checkpointedState();
  state = applyEvent(state, makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }))!;
  const resolved = applyEvent(
    state,
    makeEvent({
      eventType: "RESOLVE",
      status: "PASS",
      checkpointSha,
      authorityRef: "Brain/ChatGPT",
      evidenceRef: "internal://tests/e12-no-next-worker",
      fencingToken: 3,
    }),
  )!;
  assert.equal(resolved.resolution?.authorizedNextTaskRef, undefined);
});
