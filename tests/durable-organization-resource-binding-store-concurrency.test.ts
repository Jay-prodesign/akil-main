import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FileDurableOrganizationResourceBindingStore } from "../src/domain/durable-organization-resource-binding-store.js";

/**
 * KNOWLEDGE-EVIDENCE-DURABLE-001 CI correction (PR #167 batch-merge-review,
 * systemic torn-read finding): proves the "append-log" persistence pattern
 * class (per-record `linkSync` creation lock + shared per-tenant
 * `appendFileSync` file + the new `withTenantFileLock`) is safe under real
 * multi-process concurrency - five workers each `putIfAbsent` a DIFFERENT
 * organizationId into the SAME shared tenant `.jsonl` file concurrently,
 * each also reading via `get` in the same window. This same primitive
 * backs `FileDurableProtectedDecisionRecordStore`, so this one witness
 * stands for both per Brain's own instruction not to duplicate a test per
 * class when several components share exactly the same primitive.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "organization-resource-binding-store-race-worker.js");

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
  "KNOWLEDGE-EVIDENCE-DURABLE-001: real OS-level concurrent writer processes putIfAbsent-ing DIFFERENT organizationIds into the same shared per-tenant append-log file - every write survives, every interleaved read stays uncorrupted",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("org-binding-race-");
    const readyDir = freshDir("org-binding-ready-");
    const goFile = join(freshDir("org-binding-go-"), "go");
    try {
      const tenantId = "tenant-org-binding-race";
      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const organizationIds = WORKER_LABELS.map((label) => `org-race-${label}`);

      const workerPromises = WORKER_LABELS.map((label, index) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, tenantId, organizationIds[index] as string, label]);
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

      const freshStore = new FileDurableOrganizationResourceBindingStore(storeDir);
      for (const organizationId of organizationIds) {
        const stored = freshStore.get(tenantId as never, organizationId);
        assert.ok(stored !== undefined, `organizationId "${organizationId}" was lost - not durably present after the race`);
      }
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
