import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FileDurableEngineeringStore } from "../src/domain/durable-engineering-store.js";

// This file lives at <repo-root>/tests/durable-engineering-store-concurrency.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/engineering-store-append-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "engineering-store-append-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runWorker(args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`engineering-store-append-worker exited with code ${code}`));
      }
    });
  });
}

test(
  "Rev71 (repo-wide Rev66 audit closure): real OS-level concurrent processes appending distinct events to the same run's durable log never lose an update - the prior read-modify-write implementation could silently drop a concurrent writer's event; appendFileSync's atomicity means every one of N concurrent appends is durably present",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("engineering-store-race-");
    const readyDir = freshDir("engineering-store-race-ready-");
    const goFile = join(freshDir("engineering-store-race-go-"), "go");
    try {
      const WORKER_COUNT = 10;
      const workerPromises = Array.from({ length: WORKER_COUNT }, (_, index) => {
        const readyFile = join(readyDir, `${index}.ready`);
        return runWorker([storeDir, readyFile, goFile, String(index)]);
      });

      const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
      const readyDeadline = Date.now() + 10_000;
      for (let index = 0; index < WORKER_COUNT; index += 1) {
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

      const store = new FileDurableEngineeringStore(storeDir);
      const events = store.getEvents(
        "project-engineering-store-race" as never,
        "task-engineering-store-race" as never,
        "run-engineering-store-race" as never,
      );
      assert.equal(
        events.length,
        WORKER_COUNT,
        `expected all ${WORKER_COUNT} concurrently-appended events to survive, found ${events.length}`,
      );
      const eventIds = new Set(events.map((event) => (event as { eventId: string }).eventId));
      assert.equal(eventIds.size, WORKER_COUNT, "expected every worker's distinct eventId to be present, none lost");
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
