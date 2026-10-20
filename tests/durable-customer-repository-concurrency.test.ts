import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import type { Customer } from "../src/domain/customer.js";
import { FileDurableCustomerRepository } from "../src/application/durable-customer-repository.js";

// This file lives at <repo-root>/tests/durable-customer-repository-concurrency.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/customer-repository-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "customer-repository-race-worker.js");

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
  "REV216: real OS-level concurrent writer processes saving DIFFERENT customers into the same shared tenant file - every worker's write survives, none lost to a torn read-modify-write",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("customer-repo-durable-race-");
    const readyDir = freshDir("customer-repo-durable-ready-");
    const goFile = join(freshDir("customer-repo-durable-go-"), "go");
    try {
      const tenantScope = createTenantScope("tenant-customer-repo-durable-race");

      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, tenantScope.tenantId, `customer-race-${label}`, label]);
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

      const mainStore = new FileDurableCustomerRepository(storeDir);
      for (const label of WORKER_LABELS) {
        const found = mainStore.findByTenantAndId(tenantScope, `customer-race-${label}` as Customer["customerId"]);
        assert.ok(found !== undefined, `worker ${label}'s customer was lost to a torn write`);
        assert.equal(found?.displayName, `Race Customer ${label}`);
      }

      // Restart-safety: a fresh store instance over the same baseDir sees
      // every worker's write, not a blended or corrupted subset.
      const freshStoreInstance = new FileDurableCustomerRepository(storeDir);
      for (const label of WORKER_LABELS) {
        const found = freshStoreInstance.findByTenantAndId(tenantScope, `customer-race-${label}` as Customer["customerId"]);
        assert.ok(found !== undefined);
      }
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
