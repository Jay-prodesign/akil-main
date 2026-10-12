import { existsSync, writeFileSync } from "node:fs";
import { createDec138Provenance } from "../../src/domain/dec-138-provenance.js";
import { createEngineeringEventEnvelope } from "../../src/domain/engineering-event-envelope.js";
import { FileDurableEngineeringStore } from "../../src/domain/durable-engineering-store.js";

/**
 * AUD-DURABILITY-GAP-V2: standalone worker process (not a test itself)
 * spawned by durable-engineering-store-concurrency.test.ts as a real,
 * separate OS process, racing `appendEvent` on the exact same run to prove
 * the `linkSync`-based lock's cross-process mutual exclusion (Node's own
 * synchronous single-threaded execution cannot reproduce a true
 * concurrent-writer race in-process).
 *
 * usage: node engineering-store-race-worker.js <storeDir> <readyFile>
 *   <goFile> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, workerLabel] = process.argv;

if (storeDir === undefined || readyFile === undefined || goFile === undefined || workerLabel === undefined) {
  throw new Error("usage: engineering-store-race-worker.js <storeDir> <readyFile> <goFile> <workerLabel>");
}

const event = createEngineeringEventEnvelope({
  eventId: `evt-from-${workerLabel}`,
  projectRef: "AKILTA",
  taskId: "AUD-DURABILITY-GAP-V2",
  runId: "run-race-1",
  correlationId: "corr-race-1",
  fromRole: "WORKER",
  targetRole: "BRAIN",
  eventType: "CHECKPOINT",
  branch: `branch-from-${workerLabel}`,
  idempotencyKey: `idem-from-${workerLabel}`,
  attempt: 1,
  fencingToken: 1,
  timestamp: "2026-09-09T00:00:00.000Z",
  provenance: createDec138Provenance({
    taskId: "AUD-DURABILITY-GAP-V2",
    repository: "Jay-prodesign/akil-main",
    branch: `branch-from-${workerLabel}`,
    generatedAt: "2026-09-09T00:00:00.000Z",
    generatedByRole: "Claude / Primary Engineer",
    executionSurface: "test",
    sourceSurface: "test",
    transportedByPrincipal: "test",
    transportMethod: "test",
    sourceEvidenceReferences: ["internal://tests"],
    attributionBasisConfidence: "UNVERIFIED",
  }),
});

// Announce readiness, then busy-wait for the parent's synchronized "go"
// signal so every racing worker attempts appendEvent() within the same
// tight window, maximizing genuine OS-level contention on the lock.
writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurableEngineeringStore(storeDir);
store.appendEvent(event);
process.stdout.write(JSON.stringify({ label: workerLabel, eventId: event.eventId }));
process.exit(0);
