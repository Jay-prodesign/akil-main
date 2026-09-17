import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// This file lives at <repo-root>/tests/durable-outcome-job-store-creator-vs-reconciler-race.test.ts
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

// Mirrors FileDurableOutcomeJobStore's own (private) filePathFor encoding,
// so this test can independently inspect the raw physical journal - not
// through the store's own deduping API, which would mask a duplicate
// physical append.
function filePathFor(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.jsonl`);
}

// A single trial: starting from a clean store (no pre-existing lock),
// several real putIfAbsent callers (exactly one of which will win the
// creation lock and become the true creator, mid-append when the others
// fire) race alongside a larger number of pure get()/list() reconciler
// reads - all synchronized to fire in the same tight window, maximizing
// genuine OS-level contention between the true creator's own in-flight
// append and the concurrent reconciler reads racing to observe/heal the
// exact same jobId. This is a live race against the creator's own
// in-flight work, distinct from durable-outcome-job-store-reconciliation-
// race.test.ts, which races several readers against a pre-planted static
// crash artifact that never resolves on its own.
async function runTrial(trialIndex: number): Promise<void> {
  const storeDir = freshDir(`outcome-job-creator-vs-reconciler-${trialIndex}-`);
  const readyDir = freshDir(`outcome-job-creator-vs-reconciler-ready-${trialIndex}-`);
  const goFile = join(freshDir(`outcome-job-creator-vs-reconciler-go-${trialIndex}-`), "go");
  try {
    const PUT_WORKER_COUNT = 3;
    const RECONCILER_WORKER_COUNT = 12;
    const WORKERS: Array<{ label: string; mode: string }> = [];
    for (let i = 0; i < PUT_WORKER_COUNT; i += 1) {
      WORKERS.push({ label: `P${i}`, mode: "putIfAbsent" });
    }
    for (let i = 0; i < RECONCILER_WORKER_COUNT; i += 1) {
      WORKERS.push({ label: `R${i}`, mode: i % 2 === 0 ? "get" : "list" });
    }

    const workerPromises = WORKERS.map(({ label, mode }) => {
      const readyFile = join(readyDir, `${label}.ready`);
      return runWorker([storeDir, readyFile, goFile, label, mode]);
    });

    // Wait until every worker has announced readiness before releasing
    // them, so all workers attempt their operation within the same tight
    // window rather than relying on incidental spawn-timing luck.
    const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
    const readyDeadline = Date.now() + 10_000;
    for (const { label } of WORKERS) {
      const readyFile = join(readyDir, `${label}.ready`);
      while (!existsSync(readyFile)) {
        if (Date.now() > readyDeadline) {
          throw new Error(`trial ${trialIndex}: worker ${label} never announced readiness`);
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
      `trial ${trialIndex}: expected exactly one putIfAbsent caller to report CREATED, got ${createdCount} (results: ${results.join(",")})`,
    );
    assert.equal(existedCount, PUT_WORKER_COUNT - 1);

    // Inspect the RAW physical journal directly - not through the
    // store's own dedupedByJobId API, which would mask a duplicate
    // physical append. Exactly one line for this jobId must exist,
    // proving the true creator's own append and the concurrent
    // reconciler reads never produced a duplicate physical write.
    const filePath = filePathFor(storeDir, "tenant-outcome-job-race");
    const lines = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const matchingLines = lines.filter(
      (line) => (JSON.parse(line) as { jobId: string }).jobId === "job-outcome-job-race-shared",
    );
    assert.equal(
      matchingLines.length,
      1,
      `trial ${trialIndex}: expected exactly one physical jsonl line, found ${matchingLines.length}: ${JSON.stringify(matchingLines)}`,
    );
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(readyDir, { recursive: true, force: true });
    rmSync(dirname(goFile), { recursive: true, force: true });
  }
}

test(
  "Rev70 creator-vs-reconciler physical one-record witness: across 6 independent trials, real OS processes race putIfAbsent (exactly one becomes the true creator) while a larger number of pure get()/list() reconcilers race concurrently against that creator's own in-flight append - every trial produces exactly one physical jsonl line, never a duplicate",
  { timeout: 60_000 },
  async () => {
    const TRIAL_COUNT = 6;
    for (let trialIndex = 0; trialIndex < TRIAL_COUNT; trialIndex += 1) {
      await runTrial(trialIndex);
    }
  },
);
