import { existsSync, writeFileSync } from "node:fs";
import { FileDurablePlanAdmissionStore } from "../../src/domain/durable-plan-admission-store.js";
import { createAnswerRecordedEvent } from "../../src/domain/plan-admission-event.js";
import type { TenantScope } from "../../src/domain/tenant-scope.js";
import type { Customer } from "../../src/domain/customer.js";
import type { Project } from "../../src/domain/project.js";
import type { ProjectPlanVersion } from "../../src/domain/project-plan.js";

/**
 * AUD-DURABILITY-GAP-V2 (re-derived against current main): standalone
 * worker process (not a test itself), spawned by
 * durable-plan-admission-store-concurrency.test.ts as a real, separate OS
 * process. Each worker appends one distinct ANSWER_RECORDED event (its
 * own unique eventId) to the SAME shared plan file, then immediately
 * reads the full event log back via `getEvents` in the same window other
 * workers may still be appending - proving both writer/writer
 * coordination (no lost events) and reader/writer coordination (no torn
 * file observed).
 *
 * usage: node plan-admission-store-race-worker.js <storeDir> <readyFile> <goFile> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, workerLabel] = process.argv;

if (storeDir === undefined || readyFile === undefined || goFile === undefined || workerLabel === undefined) {
  throw new Error("usage: plan-admission-store-race-worker.js <storeDir> <readyFile> <goFile> <workerLabel>");
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const tenantId = "tenant-plan-admission-race" as TenantScope["tenantId"];
const customerId = "customer-race" as Customer["customerId"];
const projectId = "project-race" as Project["projectId"];
const planId = "plan-race" as ProjectPlanVersion["planId"];

try {
  const store = new FileDurablePlanAdmissionStore(storeDir);
  const event = createAnswerRecordedEvent({
    tenantId,
    customerId,
    projectId,
    planId,
    planVersion: 1,
    answeredEntity: `entity-${workerLabel}`,
    eventId: `answer-race-${workerLabel}`,
    recordedAt: "2026-10-20T00:00:00.000Z",
  });
  store.appendEvent(event);
  // Read back in the same window - proves the reader never observes a
  // torn file while other worker processes may still be mid-append.
  const events = store.getEvents(tenantId, customerId, projectId, planId);
  process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success", eventCount: events.length }));
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
