import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FileDurableOutcomeJobStore } from "../src/domain/durable-outcome-job-store.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";

// This file lives at <repo-root>/tests/durable-outcome-job-store-concurrency.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/outcome-job-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "outcome-job-race-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runWorker(args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`outcome-job-race-worker exited with code ${code}`));
      }
    });
  });
}

test(
  "Rev68 forward-port (AUD-DURABILITY-GAP): real OS-level concurrent writer processes racing putIfAbsent with an identical jobId AND identical payload produce exactly one truthful creator - creation is arbitrated by the OS-atomic linkSync lock, not by content comparison, which a comparison-based fix could not disambiguate for identical payloads",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("outcome-job-store-race-");
    const readyDir = freshDir("outcome-job-store-ready-");
    const goFile = join(freshDir("outcome-job-store-go-"), "go");
    try {
      const WORKER_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];
      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, label]);
      });

      // Wait until every worker has announced readiness (busy-polling for
      // the go file) before releasing them, so all workers attempt
      // putIfAbsent within the same tight window - maximizing genuine
      // OS-level contention on the lock rather than relying on incidental
      // spawn-timing luck.
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

      const createdCount = results.filter((line) => line === "CREATED").length;
      const existedCount = results.filter((line) => line === "EXISTED").length;
      assert.equal(
        createdCount,
        1,
        `expected exactly one worker to report CREATED, got ${createdCount} (results: ${results.join(",")})`,
      );
      assert.equal(existedCount, WORKER_LABELS.length - 1);

      // The store's own durable state must agree: exactly one persisted
      // job for this jobId, reachable after all workers have exited, with
      // no crash-consistency gap left behind by the race itself.
      const store = new FileDurableOutcomeJobStore(storeDir);
      const tenantScope = createTenantScope("tenant-outcome-job-race");
      const persisted = store.get(tenantScope.tenantId, "job-outcome-job-race-shared" as never);
      assert.notEqual(persisted, undefined);

      // Restart-safety: a fresh store instance over the same baseDir
      // reconstructs exactly the same single durable job.
      const listed = store.list(
        tenantScope.tenantId,
        "customer-outcome-job-race" as never,
        "project-outcome-job-race" as never,
      );
      assert.equal(listed.length, 1);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
