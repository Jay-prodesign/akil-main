import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileDurableEngineeringStore,
  CorruptedEngineeringEventLineError,
} from "../src/domain/durable-engineering-store.js";
import type { TaskId, RunId } from "../src/domain/engineering-event-envelope.js";
import { makeEvent } from "./helpers/engineering-event-helpers.js";

const TASK_ID = "AUD-DURABILITY-GAP-V2" as TaskId;
const RUN_1 = "run-replay-1" as RunId;

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "aud-durability-gap-v2-engineering-replay-"));
}

function singleFilePathIn(dir: string): string {
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1, `expected exactly one durable file in ${dir}, found ${files.length}`);
  return join(dir, files[0]!);
}

function overwriteFileWithSingleLine(filePath: string, record: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * AUD-DURABILITY-GAP-V2 F2: before this correction,
 * `FileDurableEngineeringStore.getEvents` blindly `JSON.parse`-cast every
 * line as `EngineeringEventEnvelope` with zero revalidation - this proves
 * the store's replay boundary is now fail-closed, exactly like every other
 * durable store in this repository (`durable-outcome-job-store.ts`,
 * `durable-plan-admission-store.ts`, `durable-connector-connection-store.ts`).
 */
test("AUD-DURABILITY-GAP-V2 F2: a corrupted or forged persisted engineering-event line is rejected fail-closed on replay, not silently cast", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEngineeringStore(dir);
    store.appendEvent(makeEvent({ projectRef: "AKILTA", taskId: TASK_ID, runId: RUN_1, eventType: "CHECKPOINT", branch: "b", baseSha: "base", checkpointSha: "cp", fencingToken: 1 }));
    const filePath = singleFilePathIn(dir);
    const legitEvent = JSON.parse(readFileSync(filePath, "utf8").trim());
    const getEvents = () => store.getEvents("AKILTA", TASK_ID, RUN_1);

    overwriteFileWithSingleLine(filePath, { ...legitEvent, eventType: "UNKNOWN_EVENT_TYPE" });
    assert.throws(getEvents, CorruptedEngineeringEventLineError, "unknown eventType must be rejected");

    overwriteFileWithSingleLine(filePath, { ...legitEvent, eventId: "" });
    assert.throws(getEvents, CorruptedEngineeringEventLineError, "empty eventId must be rejected");

    overwriteFileWithSingleLine(filePath, { ...legitEvent, fencingToken: 0 });
    assert.throws(getEvents, CorruptedEngineeringEventLineError, "non-positive fencingToken must be rejected");

    const { provenance: _omitted, ...withoutProvenance } = legitEvent;
    overwriteFileWithSingleLine(filePath, withoutProvenance);
    assert.throws(getEvents, CorruptedEngineeringEventLineError, "missing provenance must be rejected");

    overwriteFileWithSingleLine(filePath, { ...legitEvent, provenance: { ...legitEvent.provenance, taskId: "" } });
    assert.throws(getEvents, CorruptedEngineeringEventLineError, "malformed nested provenance must be rejected");

    overwriteFileWithSingleLine(filePath, "not even an object");
    assert.throws(getEvents, CorruptedEngineeringEventLineError, "a non-object line must be rejected");

    overwriteFileWithSingleLine(filePath, { ...legitEvent, projectRef: "FOREIGN-PROJECT" });
    assert.throws(getEvents, CorruptedEngineeringEventLineError, "a line claiming a foreign projectRef must be rejected (cross-run contamination)");

    overwriteFileWithSingleLine(filePath, { ...legitEvent, taskId: "FOREIGN-TASK" });
    assert.throws(getEvents, CorruptedEngineeringEventLineError, "a line claiming a foreign taskId must be rejected (cross-run contamination)");

    overwriteFileWithSingleLine(filePath, { ...legitEvent, runId: "FOREIGN-RUN" });
    assert.throws(getEvents, CorruptedEngineeringEventLineError, "a line claiming a foreign runId must be rejected (cross-run contamination)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AUD-DURABILITY-GAP-V2 F2: a legitimate multi-event run still replays and reconstructs state correctly through the new validator (no false rejection)", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEngineeringStore(dir);
    store.appendEvent(makeEvent({ projectRef: "AKILTA", taskId: TASK_ID, runId: RUN_1, eventType: "CHECKPOINT", branch: "b", baseSha: "base", checkpointSha: "cp1", fencingToken: 1 }));
    store.appendEvent(makeEvent({ projectRef: "AKILTA", taskId: TASK_ID, runId: RUN_1, eventType: "BEGIN_VERIFICATION", checkpointSha: "cp1", fencingToken: 2 }));
    const state = store.getState("AKILTA", TASK_ID, RUN_1);
    assert.equal(state?.status, "VERIFYING");

    const freshStore = new FileDurableEngineeringStore(dir);
    const reloaded = freshStore.getState("AKILTA", TASK_ID, RUN_1);
    assert.deepEqual(reloaded, state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
