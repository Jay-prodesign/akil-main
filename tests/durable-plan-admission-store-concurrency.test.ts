import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FileDurablePlanAdmissionStore } from "../src/domain/durable-plan-admission-store.js";
import type { TenantScope } from "../src/domain/tenant-scope.js";
import type { Customer } from "../src/domain/customer.js";
import type { Project } from "../src/domain/project.js";
import type { ProjectPlanVersion } from "../src/domain/project-plan.js";

/**
 * AUD-DURABILITY-GAP-V2 (re-derived against current main, replacing the
 * old #145 commit rather than cherry-picking it wholesale): before this
 * correction, `FileDurablePlanAdmissionStore.appendEvent` had no lock at
 * all around its read-check-write critical section, and `getEvents` was
 * fully lock-free. Five real OS-level worker processes each append a
 * DIFFERENT ANSWER_RECORDED event to the SAME shared plan file
 * concurrently, each also reading the file back via `getEvents` in the
 * same window - proving both writer/writer coordination (no lost events)
 * and reader/writer coordination (no torn file observed).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "plan-admission-store-race-worker.js");

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
  "AUD-DURABILITY-GAP-V2: five real OS-level worker processes appending DIFFERENT ANSWER_RECORDED events into the same shared plan file concurrently - every append survives, every interleaved read stays uncorrupted",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("plan-admission-store-race-");
    const readyDir = freshDir("plan-admission-store-ready-");
    const goFile = join(freshDir("plan-admission-store-go-"), "go");
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

      const freshStore = new FileDurablePlanAdmissionStore(storeDir);
      const events = freshStore.getEvents(
        "tenant-plan-admission-race" as TenantScope["tenantId"],
        "customer-race" as Customer["customerId"],
        "project-race" as Project["projectId"],
        "plan-race" as ProjectPlanVersion["planId"],
      );
      for (const label of WORKER_LABELS) {
        assert.ok(
          events.some((event) => event.eventId === `answer-race-${label}`),
          `event "answer-race-${label}" was lost - not durably present after the race`,
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
