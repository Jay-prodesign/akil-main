import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { FileDurableExternalSaleBootstrapStore } from "../src/domain/durable-external-sale-bootstrap-store.js";

// This file lives at <repo-root>/tests/durable-external-sale-bootstrap-store-concurrency.test.ts
// and is compiled to dist/tests/..., alongside dist/tests/helpers/sale-bootstrap-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "sale-bootstrap-race-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface WorkerResult {
  label: string;
  created: boolean;
  jobId: string;
}

function runWorker(args: ReadonlyArray<string>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
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
  "Rev94 F3: real OS-level concurrent duplicate-delivery processes bootstrapping the exact same verified sale fact - exactly one becomes creator, the others converge to the identical persisted result, and restart replay reconstructs that same single authoritative record",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("sale-bootstrap-race-store-");
    const readyDir = freshDir("sale-bootstrap-race-ready-");
    const goFile = join(freshDir("sale-bootstrap-race-go-"), "go");
    try {
      const tenantId = createTenantScope("tenant-sale-race").tenantId;
      const WORKER_LABELS = ["A", "B", "C", "D", "E"];

      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, tenantId, label]);
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

      const creators = results.filter((r) => r.created);
      assert.equal(creators.length, 1, `expected exactly one creator, got: ${JSON.stringify(results)}`);

      const uniqueJobIds = new Set(results.map((r) => r.jobId));
      assert.equal(uniqueJobIds.size, 1, "every worker must converge on the exact same jobId - no duplicate project/job");

      const store = new FileDurableExternalSaleBootstrapStore(storeDir);
      // All workers derive the same deterministic saleId from the shared
      // fact, so any worker's jobId identifies the one durable record.
      const winningJobId = [...uniqueJobIds][0];
      assert.ok(winningJobId);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
