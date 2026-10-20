import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FileDurableConfigurationPolicyDecisionStore } from "../src/domain/durable-configuration-policy-decision-store.js";
import { encodeConfigurationPolicyDecisionKey } from "../src/domain/configuration-policy-decision-projection.js";

/**
 * KNOWLEDGE-EVIDENCE-DURABLE-001 CI correction (PR #167 batch-merge-review,
 * systemic torn-read finding, Brain's own special-attention item): proves
 * the per-decisionId creation lock plus the NEW per-`(tenantId,
 * decisionKey)` file lock together coordinate real multi-process access to
 * the SHARED decision-log file - five workers each append a DIFFERENT
 * decisionId into the SAME `(tenantId, decisionKey)` file concurrently,
 * each also reading via `getDecisionProjectionHistory` in the same window.
 * Before this correction, the only lock was keyed by `(tenantId,
 * decisionKey, decisionId)` - it never coordinated two DIFFERENT
 * decisionIds' writers racing on the same file, nor any reader against any
 * writer.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "configuration-policy-decision-store-race-worker.js");

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
  "KNOWLEDGE-EVIDENCE-DURABLE-001: real OS-level concurrent writer processes appending DIFFERENT decisionIds into the same shared (tenantId, decisionKey) decision-log file - every append survives, every interleaved read stays uncorrupted",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("config-policy-decision-race-");
    const readyDir = freshDir("config-policy-decision-ready-");
    const goFile = join(freshDir("config-policy-decision-go-"), "go");
    try {
      const tenantId = "tenant-config-policy-decision-race";
      const customerId = "customer-race";
      const projectId = "project-race";
      const WORKER_LABELS = ["A", "B", "C", "D", "E"];

      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([storeDir, readyFile, goFile, tenantId, customerId, projectId, label]);
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

      const decisionKey = encodeConfigurationPolicyDecisionKey({ tenantId: tenantId as never, customerId: customerId as never, projectId: projectId as never });
      const freshStore = new FileDurableConfigurationPolicyDecisionStore(storeDir);
      const history = freshStore.getDecisionProjectionHistory(tenantId as never, decisionKey);
      for (const label of WORKER_LABELS) {
        assert.ok(
          history.some((entry) => entry.decisionId === `decision-race-${label}`),
          `decision "decision-race-${label}" was lost - not durably present after the race`,
        );
      }
      assert.equal(history.length, WORKER_LABELS.length, `expected ${WORKER_LABELS.length} entries, got ${history.length}`);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
