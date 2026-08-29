import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, projectLifecyclePhases, type EngineeringRunState } from "../src/domain/engineering-run-state.js";
import { makeEvent } from "./helpers/engineering-event-helpers.js";

const branch = "claude/ENG-ORCH-001-task-packet";
const baseSha = "base-sha-1";
const checkpointSha = "checkpoint-sha-1";

test("QUESTION and WAITING are both durably projectable from a single ASK_QUESTION event", () => {
  const checkpointEvt = makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1 });
  const beginEvt = makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 });
  const askEvt = makeEvent({ eventType: "ASK_QUESTION", waitReason: "need clarification", fencingToken: 3 });

  const phases = projectLifecyclePhases([checkpointEvt, beginEvt, askEvt]);
  const questionPhases = phases.filter((p) => p.eventId === askEvt.eventId);
  assert.deepEqual(
    questionPhases.map((p) => p.phase),
    ["QUESTION", "WAITING"],
  );
});

test("ANSWER_RECEIVED and RESUME_AUTHORIZED are both durably projectable from a direct ANSWER reconciliation", () => {
  const checkpointEvt = makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1 });
  const beginEvt = makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 });
  const askEvt = makeEvent({ eventType: "ASK_QUESTION", waitReason: "need clarification", fencingToken: 3 });

  let state: EngineeringRunState | undefined;
  for (const e of [checkpointEvt, beginEvt, askEvt]) {
    state = applyEvent(state, e);
  }
  const answerEvt = makeEvent({
    eventType: "ANSWER",
    responseTo: state!.awaiting?.questionEventId,
    fencingToken: 4,
  });

  const phases = projectLifecyclePhases([checkpointEvt, beginEvt, askEvt, answerEvt]);
  const answerPhases = phases.filter((p) => p.eventId === answerEvt.eventId);
  assert.deepEqual(
    answerPhases.map((p) => p.phase),
    ["ANSWER_RECEIVED", "RESUME_AUTHORIZED"],
  );
});

test("ANSWER_RECEIVED projects even when the answer is buffered out-of-order (E6); QUESTION/WAITING/RESUME_AUTHORIZED all project once the question is later applied", () => {
  const checkpointEvt = makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1 });
  const beginEvt = makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 });
  const notYetAskedQuestionId = "evt-not-yet-durable-question";
  const answerEvt = makeEvent({
    eventType: "ANSWER",
    responseTo: notYetAskedQuestionId,
    fencingToken: 3,
  });
  const askEvt = makeEvent({
    eventId: notYetAskedQuestionId,
    eventType: "ASK_QUESTION",
    waitReason: "need clarification",
    fencingToken: 4,
  });

  const phases = projectLifecyclePhases([checkpointEvt, beginEvt, answerEvt, askEvt]);

  const answerPhases = phases.filter((p) => p.eventId === answerEvt.eventId);
  assert.deepEqual(
    answerPhases.map((p) => p.phase),
    ["ANSWER_RECEIVED"],
  );

  const askPhases = phases.filter((p) => p.eventId === askEvt.eventId);
  assert.deepEqual(
    askPhases.map((p) => p.phase),
    ["QUESTION", "WAITING", "RESUME_AUTHORIZED"],
  );
});

test("a duplicate ANSWER to an already-answered question produces no additional ANSWER_RECEIVED/RESUME_AUTHORIZED phase (E5 exactly-once)", () => {
  const checkpointEvt = makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1 });
  const beginEvt = makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 });
  const askEvt = makeEvent({ eventType: "ASK_QUESTION", waitReason: "need clarification", fencingToken: 3 });

  let state: EngineeringRunState | undefined;
  for (const e of [checkpointEvt, beginEvt, askEvt]) {
    state = applyEvent(state, e);
  }
  const questionEventId = state!.awaiting?.questionEventId;
  const firstAnswer = makeEvent({ eventType: "ANSWER", responseTo: questionEventId, fencingToken: 4 });
  const duplicateAnswer = makeEvent({ eventType: "ANSWER", responseTo: questionEventId, fencingToken: 4 });

  const phases = projectLifecyclePhases([checkpointEvt, beginEvt, askEvt, firstAnswer, duplicateAnswer]);
  const duplicatePhases = phases.filter((p) => p.eventId === duplicateAnswer.eventId);
  assert.deepEqual(duplicatePhases, []);

  const firstAnswerPhases = phases.filter((p) => p.eventId === firstAnswer.eventId);
  assert.deepEqual(
    firstAnswerPhases.map((p) => p.phase),
    ["ANSWER_RECEIVED", "RESUME_AUTHORIZED"],
  );
});

test("a status-guard no-op ASK_QUESTION (wrong current status) projects no QUESTION/WAITING phase at all", () => {
  // ASK_QUESTION is only valid from CHECKPOINT_RECEIVED/VERIFYING/
  // REVIEW_REQUIRED/PASS - not from a fresh run with no CHECKPOINT yet.
  const askEvt = makeEvent({ eventType: "ASK_QUESTION", waitReason: "premature question", fencingToken: 1 });
  const phases = projectLifecyclePhases([askEvt]);
  assert.deepEqual(phases, []);
});
