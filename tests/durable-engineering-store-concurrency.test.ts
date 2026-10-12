import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { TaskId, RunId } from "../src/domain/engineering-event-envelope.js";
import { FileDurableEngineeringStore } from "../src/domain/durable-engineering-store.js";

// This file lives at <repo-root>/tests/durable-engineering-store-concurrency.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/engineering-store-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "engineering-store-race-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface WorkerResult {
  label: string;
  eventId: string;
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
  "AUD-DURABILITY-GAP-V2 F1: real OS-level concurrent writer processes racing appendEvent on the same run - every distinct event survives (no lost-update), and restart replay reconstructs the exact same full set",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("aud-durability-gap-v2-engineering-race-");
    const readyDir = freshDir("aud-durability-gap-v2-engineering-ready-");
    const goFile = join(freshDir("aud-durability-gap-v2-engineering-go-"), "go");
    try {
      const WORKER_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];
      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, label]);
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

      const mainStore = new FileDurableEngineeringStore(storeDir);
      const events = mainStore.getEvents("AKILTA", "AUD-DURABILITY-GAP-V2" as TaskId, "run-race-1" as RunId);
      const eventIds = events.map((e) => e.eventId).sort();
      const expectedEventIds = results.map((r) => r.eventId).sort();
      // Without the lock, two concurrent read-modify-write appends could
      // both read the same prior content and one write would silently
      // discard the other's already-appended line (a lost-update race) -
      // every one of the 8 distinct events racing here must survive.
      assert.deepEqual(eventIds, expectedEventIds, `expected all ${WORKER_LABELS.length} distinct events to survive the race, got ${events.length}`);

      // Restart-safety: a fresh store instance over the same baseDir
      // reconstructs the exact same full event set.
      const freshStore = new FileDurableEngineeringStore(storeDir);
      const reloaded = freshStore.getEvents("AKILTA", "AUD-DURABILITY-GAP-V2" as TaskId, "run-race-1" as RunId);
      assert.deepEqual(reloaded.map((e) => e.eventId).sort(), eventIds);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
