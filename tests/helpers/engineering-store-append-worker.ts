import { existsSync, writeFileSync } from "node:fs";
import { FileDurableEngineeringStore } from "../../src/domain/durable-engineering-store.js";

/**
 * Rev71 (repo-wide Rev66 audit closure) correction: standalone worker
 * process (not a test itself) spawned by
 * durable-engineering-store-concurrency.test.ts as a real, separate OS
 * process. Node's own synchronous single-threaded execution cannot
 * reproduce a true concurrent-writer race in-process, so proving
 * `appendEvent`'s atomic `appendFileSync` closes the prior
 * read-modify-write lost-update race requires genuinely concurrent
 * processes appending to the same run's durable log at once.
 *
 * usage: node engineering-store-append-worker.js <storeDir> <readyFile> <goFile> <workerIndex>
 */
const [, , storeDir, readyFile, goFile, workerIndexArg] = process.argv;
if (storeDir === undefined || readyFile === undefined || goFile === undefined || workerIndexArg === undefined) {
  throw new Error("usage: engineering-store-append-worker.js <storeDir> <readyFile> <goFile> <workerIndex>");
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurableEngineeringStore(storeDir);
store.appendEvent({
  eventId: `event-${workerIndexArg}`,
  projectRef: "project-engineering-store-race",
  taskId: "task-engineering-store-race",
  runId: "run-engineering-store-race",
  correlationId: "correlation-engineering-store-race",
  fromRole: "WORKER",
  targetRole: "BRAIN",
  eventType: "CHECKPOINT",
  idempotencyKey: `idempotency-${workerIndexArg}`,
  attempt: 1,
  fencingToken: 1,
  timestamp: "2026-09-17T00:00:00.000Z",
  provenance: {
    taskId: "task-engineering-store-race",
    repository: "engineering-store-append-worker",
    branch: "n/a",
    generatedAt: "2026-09-17T00:00:00.000Z",
    generatedByRole: "WORKER",
  },
} as never);
