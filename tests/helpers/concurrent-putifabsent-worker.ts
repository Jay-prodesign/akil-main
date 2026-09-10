import { createTenantScope } from "../../src/domain/tenant-scope.js";
import { createCustomer } from "../../src/domain/customer.js";
import { createProject } from "../../src/domain/project.js";
import { createOutcomeJob } from "../../src/domain/outcome-job.js";
import { FileDurableOutcomeJobStore } from "../../src/domain/durable-outcome-job-store.js";

/**
 * AUD-DURABILITY-GAP Rev74 F2: standalone worker process (not a test
 * itself) spawned by durable-outcome-job-store-concurrency.test.ts as a
 * real, separate OS process. Every worker constructs the exact same
 * OutcomeJob (identical jobId AND identical payload) and races to
 * `putIfAbsent` it into the same store directory - proving the Rev74 F1
 * fix (creation arbitrated by an OS-atomic lock, not by content
 * comparison) under genuine OS-level concurrency, not merely in-process
 * Promise interleaving (which cannot reproduce a true race under Node's
 * single-threaded execution - see concurrent-append-worker.ts for the
 * same reasoning applied to the engineering store).
 *
 * usage: node concurrent-putifabsent-worker.js <storeDir> <workerIndex>
 * prints exactly one line to stdout: "CREATED" or "EXISTED".
 */
const [, , storeDir, workerIndexArg] = process.argv;
if (storeDir === undefined || workerIndexArg === undefined) {
  throw new Error("usage: concurrent-putifabsent-worker.js <storeDir> <workerIndex>");
}

const tenantScope = createTenantScope("tenant-concurrency-race");
const customer = createCustomer({
  tenantScope,
  customerId: "customer-concurrency-race",
  displayName: "Concurrency Race Customer",
});
const project = createProject({
  tenantScope,
  customer,
  projectId: "project-concurrency-race",
  ownerRef: "owner-concurrency-race",
  state: "active",
});

// Every worker builds this from the exact same literal inputs - the
// resulting OutcomeJob is byte-identical (JSON.stringify-equal) across all
// workers, which is exactly the case the original TOCTOU fix could not
// arbitrate correctly.
const job = createOutcomeJob({
  tenantScope,
  customer,
  project,
  jobId: "job-concurrency-race-shared",
  jobFamily: "concurrency-race-family",
  businessObjective: "concurrency-race-objective",
});

const store = new FileDurableOutcomeJobStore(storeDir);
const result = store.putIfAbsent(job);
process.stdout.write(result.created ? "CREATED\n" : "EXISTED\n");
