import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FileDurableOutcomeJobStore } from "../src/domain/durable-outcome-job-store.js";

// This file lives at <repo-root>/tests/durable-outcome-job-store-concurrency.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/outcome-job-store-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "outcome-job-store-race-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface WorkerResult {
  label: string;
  created: boolean;
  businessObjective: string;
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
  "AUD-DURABILITY-GAP-V2 F1: real OS-level concurrent writer processes racing putIfAbsent on the same jobId - at most one reports created:true, and restart replay reconstructs exactly the winner's record",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("aud-durability-gap-v2-outcome-job-race-");
    const readyDir = freshDir("aud-durability-gap-v2-outcome-job-ready-");
    const goFile = join(freshDir("aud-durability-gap-v2-outcome-job-go-"), "go");
    try {
      const tenantId = "akilta-tenant-race";
      const customerId = `customer-${tenantId}`;
      const projectId = `project-${tenantId}`;
      const jobId = "job-race-1";

      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, tenantId, customerId, projectId, jobId, label]);
      });

      // Wait until every worker has announced readiness before releasing
      // them, so all five attempt putIfAbsent() within the same tight
      // window - maximizing genuine contention on the lock rather than
      // relying on incidental spawn-timing luck.
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

      const creators = results.filter((r) => r.created === true);
      const nonCreators = results.filter((r) => r.created === false);
      assert.equal(creators.length, 1, `expected exactly one creator, got: ${JSON.stringify(results)}`);
      assert.equal(nonCreators.length, WORKER_LABELS.length - 1);

      const winnerObjective = creators[0]?.businessObjective;
      // Every non-creator must have observed the exact same winning record
      // (not its own payload) - proving the race was arbitrated, not just
      // "nobody crashed".
      for (const nonCreator of nonCreators) {
        assert.equal(nonCreator.businessObjective, winnerObjective);
      }

      const mainStore = new FileDurableOutcomeJobStore(storeDir);
      const finalState = mainStore.get(tenantId as never, jobId as never);
      assert.equal(finalState?.businessObjective, winnerObjective);

      // Restart-safety: a fresh store instance over the same baseDir
      // reconstructs exactly the same accepted winner.
      const freshStore = new FileDurableOutcomeJobStore(storeDir);
      const reloaded = freshStore.get(tenantId as never, jobId as never);
      assert.deepEqual(reloaded, finalState);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
