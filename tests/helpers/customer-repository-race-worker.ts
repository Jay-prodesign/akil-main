import { existsSync, writeFileSync } from "node:fs";
import { createTenantScope } from "../../src/domain/tenant-scope.js";
import { createCustomer } from "../../src/domain/customer.js";
import { FileDurableCustomerRepository } from "../../src/application/durable-customer-repository.js";

/**
 * REV216: standalone worker process (not a test itself), spawned by
 * durable-customer-repository-concurrency.test.ts as a real, separate OS
 * process - mirroring every other race-worker in this repository's own
 * exact rationale: Node's synchronous single-threaded execution cannot
 * reproduce a true concurrent-writer race in-process. Unlike the other
 * race workers, `CustomerRepository.save()` has no optimistic-concurrency
 * contract to race for a single "winner" - the hazard this proves instead
 * is a TORN whole-file read-modify-write: each worker saves a DIFFERENT
 * customerId into the SAME shared tenant file at the same time, and
 * without the per-tenant lock, two overlapping read-all/write-all cycles
 * could silently lose one worker's write entirely (not merely clobber a
 * value - make it vanish).
 *
 * CI correction: every outcome path now sets `process.exitCode` instead of
 * calling `process.exit()`. `process.stdout.write()` to a piped stdout
 * (`stdio: ["ignore", "pipe", "pipe"]` in the parent test) can be
 * asynchronous; `process.exit()` terminates immediately and can truncate a
 * write still in flight - exactly what a busy CI runner exposed here
 * (`worker stdout was not valid JSON: (Unexpected end of JSON input)`).
 * Setting `exitCode` and letting the process end naturally once the event
 * loop drains lets Node flush pending output first. The identical fix was
 * applied to every other race-worker script in this repository, all of
 * which shared the same pattern.
 *
 * usage: node customer-repository-race-worker.js <storeDir> <readyFile>
 *   <goFile> <tenantId> <customerId> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, tenantId, customerId, workerLabel] = process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  tenantId === undefined ||
  customerId === undefined ||
  workerLabel === undefined
) {
  throw new Error("usage: customer-repository-race-worker.js <storeDir> <readyFile> <goFile> <tenantId> <customerId> <workerLabel>");
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

try {
  const tenantScope = createTenantScope(tenantId);
  const repo = new FileDurableCustomerRepository(storeDir);
  const customer = createCustomer({ tenantScope, customerId, displayName: `Race Customer ${workerLabel}` });
  repo.save(customer);
  process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success" }));
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
