import { existsSync, writeFileSync } from "node:fs";
import type { TenantScope } from "../../src/domain/tenant-scope.js";
import type { OutcomeJob, OutcomeJobState } from "../../src/domain/outcome-job.js";
import { FileDurableOutcomeJobStore } from "../../src/domain/durable-outcome-job-store.js";

/**
 * KNOWLEDGE-EVIDENCE-DURABLE-001 CI correction (PR #167 batch-merge-review,
 * systemic torn-read/lost-write finding): standalone worker process (not a
 * test itself), spawned by durable-outcome-job-store-concurrency.test.ts as
 * a real, separate OS process. Before this correction's own fix,
 * `FileDurableOutcomeJobStore` had NO lock at all - `putIfAbsent` did an
 * unguarded read-modify-`writeFileSync` (whole-file truncate-then-rewrite),
 * so two concurrent writers for DIFFERENT jobIds racing on the SAME tenant
 * file could lose one write entirely, and an unlocked `get`/`list` could
 * observe a torn file mid-write. Each worker here both writes a DIFFERENT
 * jobId via `putIfAbsent` AND reads via `get`/`list` in the same racing
 * window, proving neither a lost write nor a corrupted read occurs under
 * genuine OS-level concurrency.
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

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

try {
  const store = new FileDurableOutcomeJobStore(storeDir);
  const job: OutcomeJob = {
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as OutcomeJob["customerId"],
    projectId: projectId as OutcomeJob["projectId"],
    jobId: jobId as OutcomeJob["jobId"],
    jobFamily: "WEBSITE_BUILD",
    businessObjective: `prove concurrent outcome-job store safety (${workerLabel})`,
    state: "DRAFT" as OutcomeJobState,
  };
  const result = store.putIfAbsent(job);
  // Interleave reads in the same racing window - any torn/unlocked read
  // would throw CorruptedOutcomeJobLineError here, not merely during the
  // write itself.
  const fetched = store.get(tenantId as TenantScope["tenantId"], jobId as OutcomeJob["jobId"]);
  const listed = store.list(
    tenantId as TenantScope["tenantId"],
    customerId as OutcomeJob["customerId"],
    projectId as OutcomeJob["projectId"],
  );
  if (fetched === undefined || fetched.jobId !== jobId) {
    throw new Error(`worker ${workerLabel}: get() did not return the just-written job`);
  }
  if (!listed.some((j) => j.jobId === jobId)) {
    throw new Error(`worker ${workerLabel}: list() did not include the just-written job`);
  }
  process.stdout.write(JSON.stringify({ label: workerLabel, created: result.created }));
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
