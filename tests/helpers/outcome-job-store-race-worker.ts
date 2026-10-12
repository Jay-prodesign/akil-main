import { existsSync, writeFileSync } from "node:fs";
import type { OutcomeJob } from "../../src/domain/outcome-job.js";
import { FileDurableOutcomeJobStore } from "../../src/domain/durable-outcome-job-store.js";

/**
 * AUD-DURABILITY-GAP-V2: standalone worker process (not a test itself)
 * spawned by durable-outcome-job-store-concurrency.test.ts as a real,
 * separate OS process - Node's own synchronous single-threaded execution
 * cannot reproduce a true concurrent-writer race in-process, so proving the
 * `linkSync`-based lock's cross-process mutual exclusion requires genuinely
 * concurrent processes racing `putIfAbsent` with the exact same jobId.
 *
 * usage: node outcome-job-store-race-worker.js <storeDir> <readyFile>
 *   <goFile> <tenantId> <customerId> <projectId> <jobId> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, tenantId, customerId, projectId, jobId, workerLabel] = process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  tenantId === undefined ||
  customerId === undefined ||
  projectId === undefined ||
  jobId === undefined ||
  workerLabel === undefined
) {
  throw new Error(
    "usage: outcome-job-store-race-worker.js <storeDir> <readyFile> <goFile> <tenantId> <customerId> <projectId> <jobId> <workerLabel>",
  );
}

const job = {
  tenantId,
  customerId,
  projectId,
  jobId,
  jobFamily: "WEBSITE_BUILD_V1",
  businessObjective: `objective-from-${workerLabel}`,
  state: "DRAFT",
} as unknown as OutcomeJob;

// Announce readiness, then busy-wait for the parent's synchronized "go"
// signal so every racing worker attempts putIfAbsent() within the same
// tight window, maximizing genuine OS-level contention on the lock.
writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurableOutcomeJobStore(storeDir);
const result = store.putIfAbsent(job);
process.stdout.write(
  JSON.stringify({ label: workerLabel, created: result.created, businessObjective: result.job.businessObjective }),
);
process.exit(0);
