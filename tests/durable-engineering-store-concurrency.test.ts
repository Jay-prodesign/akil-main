import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FileDurableEngineeringStore } from "../src/domain/durable-engineering-store.js";
import type { TaskId, RunId } from "../src/domain/engineering-event-envelope.js";

/**
 * AUD-DURABILITY-GAP-V2 (re-derived against current main, replacing the
 * old #145 commit's approach rather than cherry-picking it wholesale):
 * before this correction, `FileDurableEngineeringStore.appendEvent` had no
 * lock at all around its read-check-write critical section (a lost-write
 * hazard in the same class `FileDurableOutcomeJobStore` had before the
 * #167/#168 systemic correction), and `getEvents` was fully lock-free.
 * Five real OS-level worker processes each append a DIFFERENT event to
 * the SAME shared run concurrently, each also reading the run back via
 * `getEvents` in the same window - proving both writer/writer
 * coordination (no lost events) and reader/writer coordination (no torn
 * file observed by a reader racing an in-progress writer).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "engineering-store-race-worker.js");

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
  "AUD-DURABILITY-GAP-V2: five real OS-level worker processes appending DIFFERENT events into the same shared run file concurrently - every append survives, every interleaved read stays uncorrupted",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("engineering-store-race-");
    const readyDir = freshDir("engineering-store-ready-");
    const goFile = join(freshDir("engineering-store-go-"), "go");
    try {
      const WORKER_LABELS = ["A", "B", "C", "D", "E"];

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
      for (const result of results) {
        assert.equal(result.code, 0, `worker ${result.label} failed: ${result.stderr}`);
      }

      const freshStore = new FileDurableEngineeringStore(storeDir);
      const events = freshStore.getEvents("AKILTA", "ENG-ORCH-001-RACE" as TaskId, "run-race" as RunId);
      for (const label of WORKER_LABELS) {
        assert.ok(
          events.some((event) => event.eventId === `evt-race-${label}`),
          `event "evt-race-${label}" was lost - not durably present after the race`,
        );
      }
      assert.equal(events.length, WORKER_LABELS.length, `expected ${WORKER_LABELS.length} events, got ${events.length}`);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
