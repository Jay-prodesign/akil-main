import { existsSync, writeFileSync } from "node:fs";
import type { TenantScope } from "../../src/domain/tenant-scope.js";
import type { CustomerOffboardingRequestId } from "../../src/domain/customer-offboarding.js";
import {
  FileDurableCustomerOffboardingRequestStore,
  CustomerOffboardingRequestVersionConflictError,
} from "../../src/domain/durable-customer-offboarding-request-store.js";

/**
 * CUS-OFFBOARD-DURABLE-001: standalone worker process (not a test itself),
 * spawned by durable-customer-offboarding-request-store-concurrency.test.ts
 * as a real, separate OS process - mirroring
 * connector-connection-race-worker.ts's own exact rationale: Node's
 * synchronous single-threaded execution cannot reproduce a true
 * concurrent-writer race in-process, so proving the `linkSync`-based lock's
 * cross-process mutual exclusion requires genuinely concurrent processes
 * racing to transition the exact same stored request at the exact same
 * expectedVersion.
 *
 * usage: node customer-offboarding-request-race-worker.js <storeDir>
 *   <readyFile> <goFile> <tenantId> <requestId> <expectedVersion>
 *   <workerLabel> <nextStatus>
 */
const [, , storeDir, readyFile, goFile, tenantId, requestId, expectedVersionArg, workerLabel, nextStatus] =
  process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  tenantId === undefined ||
  requestId === undefined ||
  expectedVersionArg === undefined ||
  workerLabel === undefined ||
  nextStatus === undefined
) {
  throw new Error(
    "usage: customer-offboarding-request-race-worker.js <storeDir> <readyFile> <goFile> <tenantId> <requestId> <expectedVersion> <workerLabel> <nextStatus>",
  );
}

const expectedVersion = Number(expectedVersionArg);

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurableCustomerOffboardingRequestStore(storeDir);
try {
  const typedTenantId = tenantId as TenantScope["tenantId"];
  const typedRequestId = requestId as CustomerOffboardingRequestId;
  const current = store.get(typedTenantId, typedRequestId);
  if (current === undefined) {
    throw new Error(`worker ${workerLabel}: no current record for ${requestId}`);
  }
  const next =
    nextStatus === "DENIED"
      ? { ...current.request, status: "DENIED" as const, decidedByRef: `membership-${workerLabel}`, decidedAt: new Date().toISOString(), denialReason: `decided by ${workerLabel}` }
      : { ...current.request, status: "COMPLETED" as const, decidedByRef: `membership-${workerLabel}`, decidedAt: new Date().toISOString() };
  const result = store.transitionToTerminal({ tenantId: typedTenantId, requestId: current.request.requestId, expectedVersion, next });
  process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success", version: result.version }));
  process.exitCode = 0;
} catch (error) {
  if (error instanceof CustomerOffboardingRequestVersionConflictError) {
    process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "conflict" }));
    process.exitCode = 0;
  } else {
    process.stderr.write(String(error));
    process.exitCode = 1;
  }
}
