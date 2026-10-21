import { existsSync, writeFileSync } from "node:fs";
import { FileDurableEngineeringStore } from "../../src/domain/durable-engineering-store.js";
import type { TaskId, RunId } from "../../src/domain/engineering-event-envelope.js";
import { createEngineeringEventEnvelope } from "../../src/domain/engineering-event-envelope.js";
import { createDec138Provenance } from "../../src/domain/dec-138-provenance.js";

/**
 * AUD-DURABILITY-GAP-V2 (re-derived against current main): standalone
 * worker process (not a test itself), spawned by
 * durable-engineering-store-concurrency.test.ts as a real, separate OS
 * process - mirroring every sibling `*-race-worker.ts`'s own exact
 * rationale: Node's synchronous single-threaded execution cannot
 * reproduce a true concurrent-writer race in-process.
 *
 * Each worker appends exactly ONE event (its own unique eventId) to the
 * SAME shared run, then immediately reads the run back via `getEvents` in
 * the same window other workers may still be appending - proving both
 * writer/writer coordination (no lost events) and reader/writer
 * coordination (no torn file observed).
 *
 * usage: node engineering-store-race-worker.js <storeDir> <readyFile> <goFile> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, workerLabel] = process.argv;

if (storeDir === undefined || readyFile === undefined || goFile === undefined || workerLabel === undefined) {
  throw new Error("usage: engineering-store-race-worker.js <storeDir> <readyFile> <goFile> <workerLabel>");
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

try {
  const store = new FileDurableEngineeringStore(storeDir);
  const event = createEngineeringEventEnvelope({
    eventId: `evt-race-${workerLabel}`,
    projectRef: "AKILTA",
    taskId: "ENG-ORCH-001-RACE" as TaskId,
    runId: "run-race" as RunId,
    correlationId: `corr-race-${workerLabel}`,
    fromRole: "WORKER",
    targetRole: "BRAIN",
    eventType: "CHECKPOINT",
    idempotencyKey: `idem-race-${workerLabel}`,
    attempt: 1,
    fencingToken: 1,
    timestamp: "2026-10-20T00:00:00.000Z",
    provenance: createDec138Provenance({
      taskId: "ENG-ORCH-001-RACE",
      repository: "Jay-prodesign/akil-main",
      branch: "claude/aud-durability-gap-v2-rederived",
      generatedAt: "2026-10-20T00:00:00.000Z",
      generatedByRole: "Claude / Primary Engineer",
      executionSurface: "test",
      sourceSurface: "test",
      transportedByPrincipal: "test",
      transportMethod: "test",
      sourceEvidenceReferences: ["internal://tests"],
      attributionBasisConfidence: "UNVERIFIED",
    }),
  });
  store.appendEvent(event);
  // Read back in the same window - proves the reader never observes a
  // torn file while other worker processes may still be mid-append.
  const events = store.getEvents("AKILTA", "ENG-ORCH-001-RACE" as TaskId, "run-race" as RunId);
  process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success", eventCount: events.length }));
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
