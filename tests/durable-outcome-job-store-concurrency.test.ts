import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FileDurableOutcomeJobStore } from "../src/domain/durable-outcome-job-store.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";

// This file lives at <repo-root>/tests/durable-outcome-job-store-concurrency.test.ts
// and is compiled to dist/tests/durable-outcome-job-store-concurrency.test.js,
// alongside the also-compiled dist/tests/helpers/concurrent-putifabsent-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "concurrent-putifabsent-worker.js");

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "aud-durability-gap-putifabsent-race-"));
}

function runWorker(storeDir: string, workerIndex: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const child = spawn(process.execPath, [WORKER_SCRIPT, storeDir, String(workerIndex)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`concurrent-putifabsent-worker ${workerIndex} exited with code ${code}`));
      }
    });
  });
}

test(
  "AUD-DURABILITY-GAP Rev74 F1/F2: real OS-level concurrent writer processes racing putIfAbsent with an identical jobId AND identical payload produce exactly one truthful creator - creation is arbitrated by an OS-atomic lock, not by content comparison, which the original fix could not disambiguate for identical payloads",
  { timeout: 30_000 },
  async () => {
    const dir = freshStoreDir();
    try {
      const WORKER_COUNT = 8;
      const results = await Promise.all(
        Array.from({ length: WORKER_COUNT }, (_, workerIndex) => runWorker(dir, workerIndex)),
      );

      const createdCount = results.filter((line) => line === "CREATED").length;
      const existedCount = results.filter((line) => line === "EXISTED").length;
      assert.equal(
        createdCount,
        1,
        `expected exactly one worker to report CREATED, got ${createdCount} (results: ${results.join(",")})`,
      );
      assert.equal(existedCount, WORKER_COUNT - 1);

      // The store's own durable state must agree: exactly one persisted job
      // for this jobId, reachable after all workers have exited.
      const store = new FileDurableOutcomeJobStore(dir);
      const tenantScope = createTenantScope("tenant-concurrency-race");
      const persisted = store.get(tenantScope.tenantId, "job-concurrency-race-shared" as never);
      assert.notEqual(persisted, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
