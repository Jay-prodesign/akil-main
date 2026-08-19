import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDurableEngineeringStore } from "../src/domain/durable-engineering-store.js";
import type { TaskId, RunId } from "../src/domain/engineering-event-envelope.js";
import { invokeSafely, type WorkerInvoker } from "../src/domain/worker-invoker.js";
import { makeEvent } from "./helpers/engineering-event-helpers.js";

const branch = "claude/ENG-ORCH-001-task-packet";
const baseSha = "base-sha-1";
const checkpointSha = "checkpoint-sha-1";
const TASK_ID = "ENG-ORCH-001" as TaskId;
const RUN_1 = "run-1" as RunId;
const RUN_2 = "run-2" as RunId;

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "eng-orch-001-store-"));
}

test("E4: a persisted WAITING state survives a simulated process-restart (fresh store instance over the same durable directory)", () => {
  const dir = freshStoreDir();
  try {
    const storeA = new FileDurableEngineeringStore(dir);
    storeA.appendEvent(makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1 }));
    storeA.appendEvent(makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }));
    storeA.appendEvent(
      makeEvent({ eventType: "ASK_QUESTION", waitReason: "need clarification before proceeding", fencingToken: 3 }),
    );
    const stateBeforeRestart = storeA.getState("AKILTA", TASK_ID, RUN_1);
    assert.equal(stateBeforeRestart?.status, "WAITING");
    const questionEventId = stateBeforeRestart?.awaiting?.questionEventId;
    const waitReason = stateBeforeRestart?.awaiting?.reason;

    // Simulate process restart: a brand-new store instance, no in-memory
    // state carried over, reading the same durable directory.
    const storeB = new FileDurableEngineeringStore(dir);
    const stateAfterRestart = storeB.getState("AKILTA", TASK_ID, RUN_1);
    assert.equal(stateAfterRestart?.status, "WAITING");
    assert.equal(stateAfterRestart?.awaiting?.questionEventId, questionEventId);
    assert.equal(stateAfterRestart?.awaiting?.reason, waitReason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E6 (store-level): an ANSWER appended before its matching ASK_QUESTION event still reconciles correctly on read, regardless of append order", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEngineeringStore(dir);
    store.appendEvent(makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1 }));
    store.appendEvent(makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }));

    const questionEventId = "evt-question-appended-late";
    // ANSWER is appended to durable storage BEFORE the question it answers
    // (a pure append/persistence-order race, not a fencing/lease race -
    // fencing tokens still increase monotonically over time here, exactly
    // as a real BRAIN-issued token following a WORKER-issued one would).
    store.appendEvent(makeEvent({ eventType: "ANSWER", responseTo: questionEventId, fencingToken: 3 }));
    store.appendEvent(
      makeEvent({
        eventId: questionEventId,
        eventType: "ASK_QUESTION",
        waitReason: "need clarification",
        fencingToken: 4,
      }),
    );

    const state = store.getState("AKILTA", TASK_ID, RUN_1);
    assert.equal(state?.status, "RESUME_AUTHORIZED");
    assert.equal(state?.pendingAnswers.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E13: DEC-138 provenance fields are represented on persisted events and survive persistence/reconstruction", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEngineeringStore(dir);
    store.appendEvent(makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1 }));
    const events = store.getEvents("AKILTA", TASK_ID, RUN_1);
    assert.equal(events.length, 1);
    const provenance = events[0]?.provenance;
    assert.equal(provenance?.taskId, "ENG-ORCH-001");
    assert.equal(provenance?.repository, "Jay-prodesign/akil-main");
    assert.equal(provenance?.attributionBasisConfidence, "UNVERIFIED");
    assert.deepEqual(provenance?.sourceEvidenceReferences, ["internal://tests"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendEvent durably records every event, including ones a replay will treat as stale/rejected", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEngineeringStore(dir);
    store.appendEvent(makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1 }));
    store.appendEvent(makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }));
    // A stale-fencingToken CHECKPOINT attempt: rejected by the reducer,
    // but still durably appended for audit.
    store.appendEvent(
      makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha: "attacker-sha", fencingToken: 1 }),
    );
    const events = store.getEvents("AKILTA", TASK_ID, RUN_1);
    assert.equal(events.length, 3);
    const state = store.getState("AKILTA", TASK_ID, RUN_1);
    assert.equal(state?.status, "VERIFYING");
    assert.equal(state?.checkpointSha, checkpointSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E10: a temporary invoker/dependency failure (invokeSafely -> TIMEOUT) persists as durable BLOCKED state across a simulated restart, and retry after failure cannot duplicate continuation authorization", async () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEngineeringStore(dir);
    store.appendEvent(makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1 }));
    store.appendEvent(makeEvent({ eventType: "BEGIN_VERIFICATION", checkpointSha, fencingToken: 2 }));

    // A temporary invoker/dependency failure, translated via invokeSafely()
    // into an explicit TEMPORARY_FAILURE outcome (E10) and then durably
    // recorded through the existing TIMEOUT -> BLOCKED reducer path (E9),
    // not left as an ephemeral in-memory return value.
    const failingInvoker: WorkerInvoker = {
      role: "CLAUDE_PRIMARY_ENGINEER",
      invoke: async () => {
        throw new Error("dependency temporarily unavailable");
      },
    };
    const outcome = await invokeSafely(failingInvoker, {
      taskId: "ENG-ORCH-001",
      branch,
      checkpointSha,
    });
    assert.equal(outcome.status, "TEMPORARY_FAILURE");
    store.appendEvent(makeEvent({ eventType: "TIMEOUT", fencingToken: 3 }));

    const stateBeforeRestart = store.getState("AKILTA", TASK_ID, RUN_1);
    assert.equal(stateBeforeRestart?.status, "BLOCKED");

    // Simulate process restart: a brand-new store instance, no in-memory
    // state carried over, reading the same durable directory - the
    // retryable bounded failure state survives, it is not lost.
    const storeAfterRestart = new FileDurableEngineeringStore(dir);
    const stateAfterRestart = storeAfterRestart.getState("AKILTA", TASK_ID, RUN_1);
    assert.equal(stateAfterRestart?.status, "BLOCKED");
    assert.deepEqual(stateAfterRestart, stateBeforeRestart);

    // A retry succeeds independently...
    const retryOutcome = await invokeSafely(
      { role: "CLAUDE_PRIMARY_ENGINEER", invoke: async () => ({ accepted: true }) },
      { taskId: "ENG-ORCH-001", branch, checkpointSha },
    );
    assert.equal(retryOutcome.status, "ACCEPTED");

    // ...but ACCEPTED alone never authorizes continuation on its own - only
    // a durable RESOLVE/ANSWER applied through the reducer can. A stray
    // RESOLVE arriving while still BLOCKED is correctly rejected as a
    // business no-op, proving the retry cannot duplicate or self-authorize
    // continuation.
    storeAfterRestart.appendEvent(
      makeEvent({
        eventType: "RESOLVE",
        status: "PASS",
        checkpointSha,
        authorityRef: "Brain/ChatGPT",
        evidenceRef: "internal://tests/e10-retry-no-duplicate-authorization",
        fencingToken: 4,
      }),
    );
    const stateAfterStrayResolve = storeAfterRestart.getState("AKILTA", TASK_ID, RUN_1);
    assert.notEqual(stateAfterStrayResolve?.status, "PASS");
    assert.notEqual(stateAfterStrayResolve?.status, "RESUME_AUTHORIZED");
    assert.equal(stateAfterStrayResolve?.status, "BLOCKED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two different runs are stored independently under the same store", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEngineeringStore(dir);
    store.appendEvent(
      makeEvent({ eventType: "CHECKPOINT", branch, baseSha, checkpointSha, fencingToken: 1, runId: "run-1" }),
    );
    store.appendEvent(
      makeEvent({
        eventType: "CHECKPOINT",
        branch,
        baseSha,
        checkpointSha: "checkpoint-sha-run-2",
        fencingToken: 1,
        runId: "run-2",
      }),
    );
    const run1 = store.getState("AKILTA", TASK_ID, RUN_1);
    const run2 = store.getState("AKILTA", TASK_ID, RUN_2);
    assert.equal(run1?.checkpointSha, checkpointSha);
    assert.equal(run2?.checkpointSha, "checkpoint-sha-run-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
