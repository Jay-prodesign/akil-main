import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// This file lives at <repo-root>/tests/durable-outcome-job-store-reconciliation-race.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/outcome-job-reconcile-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "outcome-job-reconcile-race-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runWorker(args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`outcome-job-reconcile-race-worker exited with code ${code}`));
      }
    });
  });
}

// Mirrors FileDurableOutcomeJobStore's own (private) filePathFor and
// creationLockPathFor encoding, so this test can pre-inject the exact
// crash artifact (a creation lock with no jsonl record) and independently
// inspect the raw physical journal afterward - not through the store's
// own deduping API, which would mask a duplicate-append defect.
function filePathFor(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.jsonl`);
}

function creationLockPathFor(dir: string, tenantId: string, jobId: string): string {
  const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
  const jobKey = Buffer.from(jobId, "utf8").toString("base64url");
  return join(dir, ".creation-locks", `${tenantKey}.${jobKey}.lock`);
}

test(
  "Rev69 physical one-record proof: real OS-level concurrent readers/writers all racing to reconcile the SAME orphaned creation lock (the Rev68 F1 crash artifact) produce exactly one physical jsonl line for that jobId, not merely one after read-time dedupe",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("outcome-job-reconcile-race-");
    const readyDir = freshDir("outcome-job-reconcile-race-ready-");
    const goFile = join(freshDir("outcome-job-reconcile-race-go-"), "go");
    try {
      const tenantId = "tenant-outcome-job-reconcile-race";
      const jobId = "job-outcome-job-reconcile-race";

      // Pre-create the exact crash artifact Rev68 F1 targets: a creation
      // lock exists, but the jsonl file for this tenant does not - as if
      // the true creator's linkSync succeeded and then the process was
      // killed before its own appendFileSync ran.
      const job = {
        tenantId,
        customerId: "customer-outcome-job-reconcile-race",
        projectId: "project-outcome-job-reconcile-race",
        jobId,
        jobFamily: "outcome-job-reconcile-race-family",
        businessObjective: "outcome-job-reconcile-race-objective",
        state: "DRAFT",
      };
      const lockPath = creationLockPathFor(storeDir, tenantId, jobId);
      mkdirSync(join(storeDir, ".creation-locks"), { recursive: true });
      writeFileSync(lockPath, JSON.stringify(job), "utf8");

      // A mix of pure readers (get/list, which reconcile transparently)
      // and a losing putIfAbsent caller (which, since the lock already
      // exists, falls into the exact same reconciling get() path) - all
      // racing to be the one that physically heals this orphaned lock.
      const MODES = [
        "get",
        "get",
        "list",
        "list",
        "putIfAbsent",
        "putIfAbsent",
        "get",
        "list",
      ];
      const workerPromises = MODES.map((mode, index) => {
        const readyFile = join(readyDir, `${index}.ready`);
        return runWorker([storeDir, readyFile, goFile, mode]);
      });

      // Wait until every worker has announced readiness before releasing
      // them, so all workers attempt reconciliation within the same
      // tight window - maximizing genuine OS-level contention rather
      // than relying on incidental spawn-timing luck.
      const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
      const readyDeadline = Date.now() + 10_000;
      for (let index = 0; index < MODES.length; index += 1) {
        const readyFile = join(readyDir, `${index}.ready`);
        while (!existsSync(readyFile)) {
          if (Date.now() > readyDeadline) {
            throw new Error(`worker ${index} never announced readiness`);
          }
          Atomics.wait(sleepBuffer, 0, 0, 1);
        }
      }
      mkdirSync(dirname(goFile), { recursive: true });
      writeFileSync(goFile, "go", "utf8");

      await Promise.all(workerPromises);

      // Inspect the RAW physical journal directly - not through the
      // store's own dedupedByJobId API, which would mask a duplicate
      // physical append. Exactly one line for this jobId must exist.
      const filePath = filePathFor(storeDir, tenantId);
      const lines = readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      const matchingLines = lines.filter((line) => (JSON.parse(line) as { jobId: string }).jobId === jobId);
      assert.equal(
        matchingLines.length,
        1,
        `expected exactly one physical jsonl line for jobId "${jobId}", found ${matchingLines.length}: ${JSON.stringify(matchingLines)}`,
      );
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
