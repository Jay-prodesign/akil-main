import { existsSync, writeFileSync } from "node:fs";
import { createTenantScope } from "../../src/domain/tenant-scope.js";
import { createCustomer } from "../../src/domain/customer.js";
import { createProject } from "../../src/domain/project.js";
import { createOutcomeJob } from "../../src/domain/outcome-job.js";
import { FileDurableOutcomeJobStore } from "../../src/domain/durable-outcome-job-store.js";

/**
 * Rev68 forward-port (AUD-DURABILITY-GAP): standalone worker process (not a
 * test itself) spawned by durable-outcome-job-store-concurrency.test.ts as
 * a real, separate OS process. Node's own synchronous single-threaded
 * execution cannot reproduce a true concurrent-writer race in-process, so
 * proving the `linkSync`-based creation lock's cross-process mutual
 * exclusion requires genuinely concurrent processes racing to
 * `putIfAbsent` the exact same jobId with an identical payload - the case
 * a content-comparison-based fix cannot disambiguate at all.
 *
 * usage: node outcome-job-race-worker.js <storeDir> <readyFile> <goFile> <workerLabel>
 * prints exactly one line to stdout: "CREATED" or "EXISTED".
 */
const [, , storeDir, readyFile, goFile, workerLabel] = process.argv;
if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  workerLabel === undefined
) {
  throw new Error(
    "usage: outcome-job-race-worker.js <storeDir> <readyFile> <goFile> <workerLabel>",
  );
}

const tenantScope = createTenantScope("tenant-outcome-job-race");
const customer = createCustomer({
  tenantScope,
  customerId: "customer-outcome-job-race",
  displayName: "Outcome Job Race Customer",
});
const project = createProject({
  tenantScope,
  customer,
  projectId: "project-outcome-job-race",
  ownerRef: "owner-outcome-job-race",
  state: "active",
});

// Every worker builds this from the exact same literal inputs - the
// resulting OutcomeJob is byte-identical (JSON.stringify-equal) across all
// workers, exactly the case a content-comparison-based race fix cannot
// arbitrate correctly.
const job = createOutcomeJob({
  tenantScope,
  customer,
  project,
  jobId: "job-outcome-job-race-shared",
  jobFamily: "outcome-job-race-family",
  businessObjective: "outcome-job-race-objective",
});

// Announce readiness, then busy-wait for the parent's synchronized "go"
// signal so every racing worker attempts putIfAbsent within the same
// tight window, maximizing genuine OS-level contention on the lock.
writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurableOutcomeJobStore(storeDir);
const result = store.putIfAbsent(job);
process.stdout.write(result.created ? "CREATED\n" : "EXISTED\n");
