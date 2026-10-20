import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { FileDurableProjectStore } from "../src/domain/durable-project-store.js";

// This file lives at <repo-root>/tests/durable-project-store-concurrency.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/project-store-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "project-store-race-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface WorkerResult {
  label: string;
  outcome: "success" | "conflict";
  version?: number;
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
  "PROJ-DURABLE-001: real OS-level concurrent writer processes racing to update the same Project at the same expectedVersion - at most one wins, every loser fails closed, and restart replay reconstructs exactly the winner's state",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("proj-durable-001-race-");
    const readyDir = freshDir("proj-durable-001-ready-");
    const goFile = join(freshDir("proj-durable-001-go-"), "go");
    try {
      const tenantScope = createTenantScope("tenant-proj-durable-race");
      const customer = createCustomer({ tenantScope, customerId: "customer-race", displayName: "Race Customer" });
      const project = createProject({
        tenantScope,
        customer,
        projectId: "proj-race-1",
        ownerRef: "membership-owner-race",
        state: "ACTIVE",
      });

      const mainStore = new FileDurableProjectStore(storeDir);
      const created = mainStore.create(project);
      assert.equal(created.version, 1);

      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([
          storeDir,
          readyFile,
          goFile,
          tenantScope.tenantId,
          customer.customerId,
          project.projectId,
          "1", // every worker races from the exact same expectedVersion: 1
          label,
        ]);
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

      const successes = results.filter((r) => r.outcome === "success");
      const conflicts = results.filter((r) => r.outcome === "conflict");
      assert.equal(successes.length, 1, `expected exactly one winner, got: ${JSON.stringify(results)}`);
      assert.equal(conflicts.length, WORKER_LABELS.length - 1);
      assert.equal(successes[0]?.version, 2);

      const finalState = mainStore.get(tenantScope.tenantId, customer.customerId, project.projectId);
      assert.equal(finalState?.version, 2);
      assert.equal(finalState?.project.state.startsWith("CLAIMED_BY_"), true);

      // Restart-safety: a fresh store instance over the same baseDir
      // reconstructs exactly the same accepted winner, not some blended or
      // corrupted state from the losing writers' discarded attempts.
      const freshStoreInstance = new FileDurableProjectStore(storeDir);
      const reloaded = freshStoreInstance.get(tenantScope.tenantId, customer.customerId, project.projectId);
      assert.deepEqual(reloaded, finalState);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
