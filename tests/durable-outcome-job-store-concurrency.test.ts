import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FileDurableOutcomeJobStore } from "../src/domain/durable-outcome-job-store.js";

/**
 * KNOWLEDGE-EVIDENCE-DURABLE-001 CI correction (PR #167 batch-merge-review,
 * systemic torn-read/lost-write finding): `FileDurableOutcomeJobStore` had
 * no lock at all before this correction - proves the "whole-file read-
 * modify-rewrite, no lock whatsoever" hazard class is closed by a real
 * five-process OS-level race: five workers each `putIfAbsent` a DIFFERENT
 * jobId into the SAME tenant file concurrently, each also reading via
 * `get`/`list` in the same window - every write must survive (none lost to
 * an unguarded concurrent rewrite) and no reader may ever observe a torn
 * file.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "outcome-job-store-race-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runWorker(args: ReadonlyArray<string>): Promise<{ label: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ label: args[args.length - 1] ?? "?", stderr, code });
    });
  });
}

test(
  "KNOWLEDGE-EVIDENCE-DURABLE-001: real OS-level concurrent writer processes putIfAbsent-ing DIFFERENT jobIds into the same shared tenant file - every write survives, every interleaved read stays uncorrupted",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("outcome-job-race-");
    const readyDir = freshDir("outcome-job-ready-");
    const goFile = join(freshDir("outcome-job-go-"), "go");
    try {
      const tenantId = "tenant-outcome-job-race";
      const customerId = "customer-race";
      const projectId = "project-race";
      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const jobIds = WORKER_LABELS.map((label) => `job-race-${label}`);

      const workerPromises = WORKER_LABELS.map((label, index) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, tenantId, customerId, projectId, jobIds[index] as string, label]);
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

      for (const result of results) {
        assert.equal(result.code, 0, `worker ${result.label} failed: ${result.stderr}`);
      }

      const freshStore = new FileDurableOutcomeJobStore(storeDir);
      for (const jobId of jobIds) {
        const stored = freshStore.get(
          tenantId as never,
          jobId as never,
        );
        assert.ok(stored !== undefined, `jobId "${jobId}" was lost - not durably present after the race`);
      }
      const listed = freshStore.list(tenantId as never, customerId as never, projectId as never);
      assert.equal(listed.length, WORKER_LABELS.length, `expected all ${WORKER_LABELS.length} jobs, got ${listed.length}: ${JSON.stringify(listed.map((j) => j.jobId))}`);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
