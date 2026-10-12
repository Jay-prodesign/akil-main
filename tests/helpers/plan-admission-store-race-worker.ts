import { existsSync, writeFileSync } from "node:fs";
import { createAnswerRecordedEvent } from "../../src/domain/plan-admission-event.js";
import { FileDurablePlanAdmissionStore } from "../../src/domain/durable-plan-admission-store.js";

/**
 * AUD-DURABILITY-GAP-V2: standalone worker process (not a test itself)
 * spawned by durable-plan-admission-store-concurrency.test.ts as a real,
 * separate OS process, racing `appendEvent` on the exact same plan to prove
 * the `linkSync`-based lock's cross-process mutual exclusion (Node's own
 * synchronous single-threaded execution cannot reproduce a true
 * concurrent-writer race in-process).
 *
 * usage: node plan-admission-store-race-worker.js <storeDir> <readyFile>
 *   <goFile> <tenantId> <customerId> <projectId> <planId> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, tenantId, customerId, projectId, planId, workerLabel] = process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  tenantId === undefined ||
  customerId === undefined ||
  projectId === undefined ||
  planId === undefined ||
  workerLabel === undefined
) {
  throw new Error(
    "usage: plan-admission-store-race-worker.js <storeDir> <readyFile> <goFile> <tenantId> <customerId> <projectId> <planId> <workerLabel>",
  );
}

const event = createAnswerRecordedEvent({
  tenantId: tenantId as never,
  customerId: customerId as never,
  projectId: projectId as never,
  planId: planId as never,
  planVersion: 1,
  answeredEntity: `entity-from-${workerLabel}`,
  eventId: `evt-from-${workerLabel}`,
  recordedAt: "2026-09-10T00:00:00.000Z",
});

// Announce readiness, then busy-wait for the parent's synchronized "go"
// signal so every racing worker attempts appendEvent() within the same
// tight window, maximizing genuine OS-level contention on the lock.
writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurablePlanAdmissionStore(storeDir);
store.appendEvent(event);
process.stdout.write(JSON.stringify({ label: workerLabel, eventId: event.eventId }));
process.exit(0);
