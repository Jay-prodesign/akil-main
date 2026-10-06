import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FileDurableEngineeringStore } from "../src/domain/durable-engineering-store.js";
import type { TaskId, RunId, EventId } from "../src/domain/engineering-event-envelope.js";

// This file lives at <repo-root>/tests/durable-engineering-store-concurrency.test.ts
// and is compiled to dist/tests/durable-engineering-store-concurrency.test.js,
// alongside the also-compiled dist/tests/helpers/concurrent-append-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "concurrent-append-worker.js");

const TASK_ID = "ENG-ORCH-001" as TaskId;
const RUN_1 = "run-1" as RunId;

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "eng-orch-001-concurrency-"));
}

function runWorker(storeDir: string, workerIndex: number, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT, storeDir, String(workerIndex), String(count)], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`concurrent-append-worker ${workerIndex} exited with code ${code}`));
      }
    });
  });
}

test(
  "AUD-DURABILITY-GAP: real OS-level concurrent writer processes appending to the same durable engineering store file lose zero events (proves appendFileSync's O_APPEND atomicity claim, not merely in-process Promise interleaving)",
  { timeout: 30_000 },
  async () => {
    const dir = freshStoreDir();
    try {
      const WORKER_COUNT = 8;
      const EVENTS_PER_WORKER = 25;
      await Promise.all(
        Array.from({ length: WORKER_COUNT }, (_, workerIndex) =>
          runWorker(dir, workerIndex, EVENTS_PER_WORKER),
        ),
      );

      const store = new FileDurableEngineeringStore(dir);
      const events = store.getEvents("AKILTA", TASK_ID, RUN_1);
      const expectedTotal = WORKER_COUNT * EVENTS_PER_WORKER;
      assert.equal(events.length, expectedTotal);

      const uniqueEventIds = new Set(events.map((event) => event.eventId));
      assert.equal(uniqueEventIds.size, expectedTotal);

      // Every worker's own full sequence of events must be entirely present -
      // a lost-update race would silently drop some subset of exactly one
      // worker's lines (the one whose read-then-rewrite got clobbered).
      for (let workerIndex = 0; workerIndex < WORKER_COUNT; workerIndex += 1) {
        for (let i = 0; i < EVENTS_PER_WORKER; i += 1) {
          assert.ok(
            uniqueEventIds.has(`concurrency-worker-${workerIndex}-event-${i}` as EventId),
            `missing event from worker ${workerIndex}, index ${i} - a lost-update race dropped a concurrent writer's line`,
          );
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
