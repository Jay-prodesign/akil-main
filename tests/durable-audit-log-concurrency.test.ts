import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { FileDurableAuditLog } from "../src/application/durable-audit-log.js";

// This file lives at <repo-root>/tests/durable-audit-log-concurrency.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/audit-log-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "audit-log-race-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface WorkerResult {
  label: string;
  outcome: "success";
}

function runWorker(args: ReadonlyArray<string>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as WorkerResult);
      } catch (cause) {
        reject(new Error(`worker stdout was not valid JSON: ${stdout} (${(cause as Error).message})`));
      }
    });
  });
}

test(
  "AUDIT-DURABLE-001: real OS-level concurrent writer processes appending DIFFERENT AuditEvents into the same shared tenant file - every worker's append survives, none lost to a torn read-modify-write",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("audit-log-durable-race-");
    const readyDir = freshDir("audit-log-durable-ready-");
    const goFile = join(freshDir("audit-log-durable-go-"), "go");
    try {
      const tenantScope = createTenantScope("tenant-audit-log-durable-race");

      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, tenantScope.tenantId, `evt-race-${label}`, label]);
      });

      const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
      const readyDeadline = Date.now() + 10_000;
      for (const label of WORKER_LABELS) {
        const readyFile = join(readyDir, `${label}.ready`);
        while (!existsSync(readyFile)) {
          if (Date.now() > readyDeadline) {
            throw new Error(`worker ${label} never announced readiness`);
          }
          Atomics.wait(sleepBuffer, 0, 0, 1);
        }
      }
      mkdirSync(dirname(goFile), { recursive: true });
      writeFileSync(goFile, "go", "utf8");

      const results = await Promise.all(workerPromises);
      assert.equal(results.length, WORKER_LABELS.length);

      const mainLog = new FileDurableAuditLog(storeDir);
      const events = mainLog.findByTenant(tenantScope);
      for (const label of WORKER_LABELS) {
        const found = events.find((event) => event.eventId === `evt-race-${label}`);
        assert.ok(found !== undefined, `worker ${label}'s audit event was lost to a torn write`);
      }
      assert.equal(events.length, WORKER_LABELS.length);

      // Restart-safety: a fresh store instance over the same baseDir sees
      // every worker's append, not a blended or corrupted subset.
      const freshLogInstance = new FileDurableAuditLog(storeDir);
      assert.equal(freshLogInstance.findByTenant(tenantScope).length, WORKER_LABELS.length);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
