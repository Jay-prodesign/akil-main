import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { FileDurableAuditLog } from "../src/application/durable-audit-log.js";

// This file lives at <repo-root>/tests/durable-audit-log-concurrency.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/audit-log-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "audit-log-race-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface WorkerResult {
  label: string;
  outcome: "success";
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

interface WorkerOutcome {
  label: string;
  succeeded: boolean;
  stderr: string;
}

/**
 * Unlike `runWorker`, a nonzero exit is an expected OUTCOME here, not a
 * test-infrastructure failure - the cross-tenant duplicate-eventId race
 * test below expects exactly one worker to succeed and every other
 * worker to fail closed with `DuplicateAuditEventError` (surfaced on
 * stderr by the worker script itself).
 */
function runWorkerAllowFailure(args: ReadonlyArray<string>): Promise<WorkerOutcome> {
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
      const label = args[args.length - 1] ?? "?";
      resolve({ label, succeeded: code === 0, stderr });
    });
  });
}

test(
  "AUDIT-DURABLE-001: real OS-level concurrent writer processes appending DIFFERENT AuditEvents into the same shared tenant file - every worker's append survives, none lost to a torn read-modify-write",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("audit-log-durable-race-");
    const readyDir = freshDir("audit-log-durable-ready-");
    const goFile = join(freshDir("audit-log-durable-go-"), "go");
    try {
      const tenantScope = createTenantScope("tenant-audit-log-durable-race");

      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, tenantScope.tenantId, `evt-race-${label}`, label]);
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

      const mainLog = new FileDurableAuditLog(storeDir);
      const events = mainLog.findByTenant(tenantScope);
      for (const label of WORKER_LABELS) {
        const found = events.find((event) => event.eventId === `evt-race-${label}`);
        assert.ok(found !== undefined, `worker ${label}'s audit event was lost to a torn write`);
      }
      assert.equal(events.length, WORKER_LABELS.length);

      // Restart-safety: a fresh store instance over the same baseDir sees
      // every worker's append, not a blended or corrupted subset.
      const freshLogInstance = new FileDurableAuditLog(storeDir);
      assert.equal(freshLogInstance.findByTenant(tenantScope).length, WORKER_LABELS.length);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);

test(
  "KNOWLEDGE-EVIDENCE-DURABLE-001 CI correction: findByTenant() reads interleaved WHILE real OS-level writer processes are still mid-append never observe a torn file (the 'global-index+tenant-file' pattern, per Brain's own named class)",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("audit-log-durable-readrace-");
    const readyDir = freshDir("audit-log-durable-readrace-ready-");
    const goFile = join(freshDir("audit-log-durable-readrace-go-"), "go");
    try {
      const tenantScope = createTenantScope("tenant-audit-log-readrace");
      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, tenantScope.tenantId, `evt-readrace-${label}`, label]);
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

      // Race a real reader (this process) against the five real writer
      // processes - reads here happen WHILE appends may be mid-flight in
      // another OS process, not only after they all complete.
      const readerLog = new FileDurableAuditLog(storeDir);
      let readCount = 0;
      const readerDeadline = Date.now() + 5_000;
      while (Date.now() < readerDeadline) {
        readerLog.findByTenant(tenantScope);
        readCount += 1;
        Atomics.wait(sleepBuffer, 0, 0, 1);
      }
      assert.ok(readCount > 0, "the reader loop never actually ran");

      const results = await Promise.all(workerPromises);
      assert.equal(results.length, WORKER_LABELS.length);

      const finalEvents = readerLog.findByTenant(tenantScope);
      for (const label of WORKER_LABELS) {
        assert.ok(
          finalEvents.some((event) => event.eventId === `evt-readrace-${label}`),
          `worker ${label}'s audit event was lost`,
        );
      }
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);

test(
  "REV216/AUDIT-DURABLE-001 F1: real OS-level concurrent writer processes in DIFFERENT tenants appending the SAME eventId - exactly one succeeds, every other fails closed with DuplicateAuditEventError, proving the global cross-tenant lock closes the race Brain named",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("audit-log-durable-crosstenant-race-");
    const readyDir = freshDir("audit-log-durable-crosstenant-ready-");
    const goFile = join(freshDir("audit-log-durable-crosstenant-go-"), "go");
    try {
      const SHARED_EVENT_ID = "evt-crosstenant-race-shared";
      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        // Each worker uses a DIFFERENT tenant but the SAME eventId.
        return runWorkerAllowFailure([storeDir, readyFile, goFile, `tenant-audit-crosstenant-race-${label}`, SHARED_EVENT_ID, label]);
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

      const outcomes = await Promise.all(workerPromises);
      const succeeded = outcomes.filter((outcome) => outcome.succeeded);
      const failed = outcomes.filter((outcome) => !outcome.succeeded);
      assert.equal(succeeded.length, 1, `expected exactly one worker to win the race, got ${succeeded.length}: ${JSON.stringify(outcomes)}`);
      assert.equal(failed.length, WORKER_LABELS.length - 1);
      for (const outcome of failed) {
        assert.match(outcome.stderr, /DuplicateAuditEventError/, `worker ${outcome.label} failed for a reason other than the expected duplicate rejection: ${outcome.stderr}`);
      }

      // Exactly one tenant's file holds the shared eventId - no tenant
      // sees a duplicate, and no tenant lost it to a torn write either.
      const mainLog = new FileDurableAuditLog(storeDir);
      let tenantsHoldingEvent = 0;
      for (const label of WORKER_LABELS) {
        const tenantScope = createTenantScope(`tenant-audit-crosstenant-race-${label}`);
        const events = mainLog.findByTenant(tenantScope);
        if (events.some((event) => event.eventId === SHARED_EVENT_ID)) {
          tenantsHoldingEvent += 1;
        }
      }
      assert.equal(tenantsHoldingEvent, 1);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
