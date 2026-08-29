import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, type EngineeringRunState } from "../src/domain/engineering-run-state.js";
import { makeEvent } from "./helpers/engineering-event-helpers.js";

const branch = "claude/ENG-ORCH-001-task-packet";
const baseSha = "base-sha-1";
const checkpointSha = "checkpoint-sha-1";

function checkpointedState(): EngineeringRunState {
  const state = applyEvent(
    undefined,
    makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1 }),
  );
  assert.ok(state);
  return state as EngineeringRunState;
}

function verifyingState(): EngineeringRunState {
  const state = applyEvent(
    checkpointedState(),
    makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }),
  );
  assert.ok(state);
  return state as EngineeringRunState;
}

test("E5: an ANSWER bound by exact response_to produces at most one RESUME_AUTHORIZED even when delivered twice with different eventIds", () => {
  const waiting = applyEvent(
    verifyingState(),
    makeEvent({ eventType: "ASK_QUESTION", waitReason: "need clarification", fencingToken: 3 }),
  )!;
  const questionEventId = waiting.awaiting?.questionEventId;

  const firstDelivery = applyEvent(
    waiting,
    makeEvent({ eventType: "ANSWER", responseTo: questionEventId, fencingToken: 4 }),
  )!;
  assert.equal(firstDelivery.status, "RESUME_AUTHORIZED");

  // Second, independently-eventId'd delivery of the "same" answer.
  const secondDelivery = applyEvent(
    firstDelivery,
    makeEvent({ eventType: "ANSWER", responseTo: questionEventId, fencingToken: 4 }),
  )!;
  assert.equal(secondDelivery.status, "RESUME_AUTHORIZED");
  assert.equal(secondDelivery.answeredQuestionEventIds.length, 1);
});

test("E6: an ANSWER arriving before its WAITING projection is durable reconciles safely once both exist, replayed in true append order", () => {
  const verifying = verifyingState();

  // Simulate an ANSWER event referencing a question that has not yet been
  // applied to this run's state (the callback-before-persistence race).
  const notYetAskedQuestionId = "evt-not-yet-durable-question";
  const withOrphanAnswer = applyEvent(
    verifying,
    makeEvent({
      eventType: "ANSWER",
      responseTo: notYetAskedQuestionId,
      fencingToken: 3,
    }),
  )!;
  // The answer is safely buffered, not lost, and does not itself resume.
  assert.equal(withOrphanAnswer.status, "VERIFYING");
  assert.equal(withOrphanAnswer.pendingAnswers.length, 1);
  assert.equal(withOrphanAnswer.pendingAnswers[0]?.responseTo, notYetAskedQuestionId);

  // The matching ASK_QUESTION now becomes durable, using the SAME eventId
  // the (already-buffered) answer referenced.
  const askEvent = makeEvent({
    eventId: notYetAskedQuestionId,
    eventType: "ASK_QUESTION",
    waitReason: "need clarification",
    fencingToken: 4,
  });
  const reconciled = applyEvent(withOrphanAnswer, askEvent)!;

  // No lost answer, no double resume: reconciled directly to RESUME_AUTHORIZED.
  assert.equal(reconciled.status, "RESUME_AUTHORIZED");
  assert.equal(reconciled.pendingAnswers.length, 0);
  assert.deepEqual(reconciled.answeredQuestionEventIds, [notYetAskedQuestionId]);
});

test("E11: ambiguous prior external-effect evidence yields RECONCILIATION_REQUIRED and blocks blind replay", () => {
  const waiting = applyEvent(
    verifyingState(),
    makeEvent({ eventType: "ASK_QUESTION", waitReason: "confirm effect", fencingToken: 3 }),
  )!;
  const flagged = applyEvent(
    waiting,
    makeEvent({
      eventType: "RECONCILIATION_REQUIRED",
      waitReason: "ambiguous prior external effect: unclear whether the last attempt already executed",
      fencingToken: 4,
    }),
  )!;
  assert.equal(flagged.status, "RECONCILIATION_REQUIRED");
  assert.equal(flagged.reconciliation?.reason.includes("ambiguous"), true);

  // A subsequent ANSWER (that would otherwise auto-resume from WAITING)
  // must NOT blindly replay/resume once RECONCILIATION_REQUIRED.
  const blindReplayAttempt = applyEvent(
    flagged,
    makeEvent({ eventType: "ANSWER", responseTo: waiting.awaiting?.questionEventId, fencingToken: 5 }),
  );
  assert.notEqual(blindReplayAttempt?.status, "RESUME_AUTHORIZED");

  // Only an explicit RECONCILED event (with evidence) can move it forward,
  // and it lands in BLOCKED - never directly back into an auto-resuming state.
  const reconciledOut = applyEvent(
    flagged,
    makeEvent({ eventType: "RECONCILED", evidenceRef: "internal://tests/reconciliation-evidence", fencingToken: 6 }),
  )!;
  assert.equal(reconciledOut.status, "BLOCKED");
});

test("OWNER_GATE: a genuine owner-approval pause is distinct from WAITING and requires explicit clearance", () => {
  const gated = applyEvent(verifyingState(), makeEvent({ eventType: "OWNER_GATE", fencingToken: 3 }))!;
  assert.equal(gated.status, "OWNER_GATE");

  const cleared = applyEvent(
    gated,
    makeEvent({ eventType: "OWNER_GATE_CLEARED", authorityRef: "owner:founder", fencingToken: 4 }),
  )!;
  assert.equal(cleared.status, "RESUME_AUTHORIZED");
});
