import { existsSync, writeFileSync } from "node:fs";
import type { TenantScope } from "../../src/domain/tenant-scope.js";
import type { Customer } from "../../src/domain/customer.js";
import type { Project } from "../../src/domain/project.js";
import {
  FileDurableProjectStore,
  ProjectVersionConflictError,
} from "../../src/domain/durable-project-store.js";

/**
 * PROJ-DURABLE-001: standalone worker process (not a test itself), spawned
 * by durable-project-store-concurrency.test.ts as a real, separate OS
 * process - mirroring customer-offboarding-request-race-worker.ts's own
 * exact rationale: Node's synchronous single-threaded execution cannot
 * reproduce a true concurrent-writer race in-process, so proving the
 * `linkSync`-based lock's cross-process mutual exclusion requires genuinely
 * concurrent processes racing to update the exact same stored project at
 * the exact same expectedVersion.
 *
 * usage: node project-store-race-worker.js <storeDir> <readyFile> <goFile>
 *   <tenantId> <customerId> <projectId> <expectedVersion> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, tenantId, customerId, projectId, expectedVersionArg, workerLabel] =
  process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  tenantId === undefined ||
  customerId === undefined ||
  projectId === undefined ||
  expectedVersionArg === undefined ||
  workerLabel === undefined
) {
  throw new Error(
    "usage: project-store-race-worker.js <storeDir> <readyFile> <goFile> <tenantId> <customerId> <projectId> <expectedVersion> <workerLabel>",
  );
}

const expectedVersion = Number(expectedVersionArg);

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurableProjectStore(storeDir);
try {
  const typedTenantId = tenantId as TenantScope["tenantId"];
  const typedCustomerId = customerId as Customer["customerId"];
  const typedProjectId = projectId as Project["projectId"];
  const current = store.get(typedTenantId, typedCustomerId, typedProjectId);
  if (current === undefined) {
    throw new Error(`worker ${workerLabel}: no current record for ${customerId}/${projectId}`);
  }
  const next: Project = { ...current.project, state: `CLAIMED_BY_${workerLabel}` };
  const result = store.update({
    tenantId: typedTenantId,
    customerId: typedCustomerId,
    projectId: typedProjectId,
    expectedVersion,
    next,
  });
  process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success", version: result.version }));
  process.exitCode = 0;
} catch (error) {
  if (error instanceof ProjectVersionConflictError) {
    process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "conflict" }));
    process.exitCode = 0;
  } else {
    process.stderr.write(String(error));
    process.exitCode = 1;
  }
}
