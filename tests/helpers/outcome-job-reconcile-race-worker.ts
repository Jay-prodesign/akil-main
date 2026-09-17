import { existsSync, writeFileSync } from "node:fs";
import { FileDurableOutcomeJobStore } from "../../src/domain/durable-outcome-job-store.js";

/**
 * Rev69 forward-port correction: standalone worker process (not a test
 * itself) spawned by durable-outcome-job-store-reconciliation-race.test.ts
 * as a real, separate OS process. Every worker opens a store over the
 * SAME baseDir (which already has a pre-created orphaned creation lock -
 * the exact crash artifact Rev68 F1's self-healing targets) and either
 * reads through it (triggering reconciliation) or re-submits the same
 * putIfAbsent call (which, since the lock already exists, takes the
 * losing-writer path and re-resolves through the identical reconciling
 * `get()`). Brain Rev69 found that racing several of these healers
 * against each other (or against the original crashed "creator") could
 * physically append duplicate jsonl lines, masked only by read-time
 * dedupe - proving the fix requires genuinely concurrent OS processes,
 * not in-process `Promise.all`, which cannot reproduce this race under
 * Node's single-threaded execution.
 *
 * usage: node outcome-job-reconcile-race-worker.js <storeDir> <readyFile> <goFile> <mode>
 *   <mode> is "get", "list", or "putIfAbsent".
 * prints nothing on success; a non-zero exit code signals a thrown error.
 */
const [, , storeDir, readyFile, goFile, mode] = process.argv;
if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  mode === undefined
) {
  throw new Error(
    "usage: outcome-job-reconcile-race-worker.js <storeDir> <readyFile> <goFile> <mode>",
  );
}

const TENANT_ID = "tenant-outcome-job-reconcile-race";
const CUSTOMER_ID = "customer-outcome-job-reconcile-race";
const PROJECT_ID = "project-outcome-job-reconcile-race";
const JOB_ID = "job-outcome-job-reconcile-race";

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurableOutcomeJobStore(storeDir);

if (mode === "get") {
  store.get(TENANT_ID as never, JOB_ID as never);
} else if (mode === "list") {
  store.list(TENANT_ID as never, CUSTOMER_ID as never, PROJECT_ID as never);
} else if (mode === "putIfAbsent") {
  store.putIfAbsent({
    tenantId: TENANT_ID as never,
    customerId: CUSTOMER_ID as never,
    projectId: PROJECT_ID as never,
    jobId: JOB_ID as never,
    jobFamily: "outcome-job-reconcile-race-family",
    businessObjective: "outcome-job-reconcile-race-objective",
    state: "DRAFT",
  });
} else {
  throw new Error(`unknown mode "${mode}"`);
}
