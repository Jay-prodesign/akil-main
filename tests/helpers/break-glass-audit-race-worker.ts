import { existsSync, writeFileSync } from "node:fs";
import { FileDurableBreakGlassSupportAccessAuditStore } from "../../src/domain/durable-break-glass-support-access-audit-store.js";
import type { BreakGlassSupportAccessAudit } from "../../src/domain/break-glass-support-access.js";

/**
 * C7: standalone worker process (not a test itself), spawned by
 * durable-break-glass-support-access-audit-store.test.ts as a real,
 * separate OS process - mirrors `audit-log-race-worker.ts` exactly. Each
 * worker waits for a shared "go" file, then appends one audit record.
 *
 * usage: node break-glass-audit-race-worker.js <storeDir> <readyFile> <goFile>
 *   <targetTenantId> <auditRef> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, targetTenantId, auditRef, workerLabel] = process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  targetTenantId === undefined ||
  auditRef === undefined ||
  workerLabel === undefined
) {
  throw new Error("usage: break-glass-audit-race-worker.js <storeDir> <readyFile> <goFile> <targetTenantId> <auditRef> <workerLabel>");
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

try {
  const audit = {
    auditRef,
    grantId: `bg-grant-race-${workerLabel}`,
    supportTenantId: "tenant-bg-audit-race-support",
    targetTenantId,
    requestedView: "TASK",
    decidedByPrincipalRef: `staff-support-${workerLabel}`,
    decidedAt: "2026-10-27T00:00:00.000Z",
  } as BreakGlassSupportAccessAudit;
  new FileDurableBreakGlassSupportAccessAuditStore(storeDir).append(audit);
  process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success" }));
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
