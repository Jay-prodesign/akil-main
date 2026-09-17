import { existsSync, writeFileSync } from "node:fs";
import { createAnswerRecordedEvent } from "../../src/domain/plan-admission-event.js";
import { FileDurablePlanAdmissionStore } from "../../src/domain/durable-plan-admission-store.js";

/**
 * Rev71 (repo-wide Rev66 audit closure) correction: standalone worker
 * process (not a test itself) spawned by
 * durable-plan-admission-store-concurrency.test.ts as a real, separate OS
 * process, proving `appendEvent`'s atomic `appendFileSync` closes the
 * prior read-modify-write lost-update race under genuine OS-level
 * concurrency (Node's own single-threaded execution cannot reproduce a
 * true race in-process).
 *
 * usage: node plan-admission-store-append-worker.js <storeDir> <readyFile> <goFile> <workerIndex>
 */
const [, , storeDir, readyFile, goFile, workerIndexArg] = process.argv;
if (storeDir === undefined || readyFile === undefined || goFile === undefined || workerIndexArg === undefined) {
  throw new Error("usage: plan-admission-store-append-worker.js <storeDir> <readyFile> <goFile> <workerIndex>");
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurablePlanAdmissionStore(storeDir);
const event = createAnswerRecordedEvent({
  tenantId: "tenant-plan-admission-race" as never,
  customerId: "customer-plan-admission-race" as never,
  projectId: "project-plan-admission-race" as never,
  planId: "plan-plan-admission-race" as never,
  planVersion: 1 as never,
  answeredEntity: `entity-${workerIndexArg}`,
  eventId: `event-${workerIndexArg}`,
  recordedAt: "2026-09-17T00:00:00.000Z",
});
store.appendEvent(event);
