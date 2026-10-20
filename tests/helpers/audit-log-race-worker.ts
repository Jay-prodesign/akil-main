import { existsSync, writeFileSync } from "node:fs";
import { createTenantScope } from "../../src/domain/tenant-scope.js";
import { createCustomer } from "../../src/domain/customer.js";
import { createProject } from "../../src/domain/project.js";
import { createOutcomeJob } from "../../src/domain/outcome-job.js";
import { createAuditEvent } from "../../src/domain/audit-event.js";
import { FileDurableAuditLog } from "../../src/application/durable-audit-log.js";

/**
 * AUDIT-DURABLE-001: standalone worker process (not a test itself),
 * spawned by durable-audit-log-concurrency.test.ts as a real, separate OS
 * process - mirroring `customer-repository-race-worker.ts`'s own exact
 * rationale and hazard: `AuditLog.append()` has no optimistic-concurrency
 * contract to race for a single "winner" - each worker appends a
 * DIFFERENT eventId into the SAME shared tenant file at the same time,
 * proving the per-tenant lock prevents a torn whole-file read-modify-write
 * from silently losing one worker's append entirely.
 *
 * usage: node audit-log-race-worker.js <storeDir> <readyFile> <goFile>
 *   <tenantId> <eventId> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, tenantId, eventId, workerLabel] = process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  tenantId === undefined ||
  eventId === undefined ||
  workerLabel === undefined
) {
  throw new Error("usage: audit-log-race-worker.js <storeDir> <readyFile> <goFile> <tenantId> <eventId> <workerLabel>");
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

try {
  const tenantScope = createTenantScope(tenantId);
  const customer = createCustomer({ tenantScope, customerId: "race-customer", displayName: "Race Customer" });
  const project = createProject({ tenantScope, customer, projectId: "race-project", ownerRef: "owner", state: "ACTIVE" });
  const job = createOutcomeJob({ tenantScope, customer, project, jobId: `race-job-${workerLabel}`, jobFamily: "WEBSITE_BUILD", businessObjective: "Prove concurrent audit append safety" });
  const log = new FileDurableAuditLog(storeDir);
  const event = createAuditEvent({ job, eventId, actorRef: `engineer:${workerLabel}`, eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" });
  log.append(event);
  process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success" }));
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
