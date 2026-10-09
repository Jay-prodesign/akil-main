import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement } from "../src/domain/connection-authority.js";
import { createConnectorDescriptor, requestConnectorConnection } from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";

// This file lives at <repo-root>/tests/durable-connector-connection-store-concurrency.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/connector-connection-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "connector-connection-race-worker.js");

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
  "Rev94 F1: real OS-level concurrent writer processes racing to update the same connector connection at the same expectedVersion - at most one wins, the loser fails closed, and restart replay reconstructs exactly the winner's state",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("conn-001-connector-store-race-");
    const readyDir = freshDir("conn-001-connector-store-ready-");
    const goFile = join(freshDir("conn-001-connector-store-go-"), "go");
    try {
      const tenantId = "akilta-tenant-race";
      const connectionBindingId = "bind-race-1";
      const connectionRequirementId = `req-race-${tenantId}`;

      const ownership = createProjectOwnershipRef({
        tenantId,
        customerId: `customer-${tenantId}`,
        projectId: `project-${tenantId}`,
      });
      const descriptor = createConnectorDescriptor({
        connectorKind: "GITHUB",
        displayName: "GitHub",
        supportedAuthModes: ["OAUTH2"],
        capabilityRefs: ["cap:repo-access"],
        isAiModelProvider: false,
        requiresOAuthRedirect: true,
      });
      const requirement = createConnectionRequirement({
        connectionRequirementId,
        ownership,
        requiredCapabilityRef: "cap:repo-access",
        purpose: "race test purpose",
        accountOwner: "AKILTA_MANAGED",
        minimumProviderScope: [],
        connectionMethod: "api",
        validationRequirement: "must respond 200",
      });
      const initialInstance = requestConnectorConnection({
        requirement,
        connectorDescriptor: descriptor,
        connectionBindingId,
        workspaceRef: "workspace-initial",
        integrationInstanceRef: "instance-initial",
        delegatedScope: [],
        authMode: "OAUTH2",
      });

      const mainStore = new FileDurableConnectorConnectionStore(storeDir);
      const initial = mainStore.save(initialInstance);
      assert.equal(initial.version, 1);

      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const workerPromises = WORKER_LABELS.map((label) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker([
          storeDir,
          readyFile,
          goFile,
          tenantId,
          connectionBindingId,
          connectionRequirementId,
          label,
          "1", // every worker races from the exact same expectedVersion: 1
        ]);
      });

      // Wait until every worker has announced readiness (busy-polling for
      // the go file) before releasing them, so all five attempt save()
      // within the same tight window - maximizing genuine contention on
      // the lock rather than relying on incidental spawn-timing luck.
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

      const winnerLabel = successes[0]?.label;
      const finalState = mainStore.get(requirement.ownership.tenantId, initialInstance.binding.connectionBindingId);
      assert.equal(finalState?.version, 2);
      assert.equal(finalState?.instance.binding.workspaceRef, `workspace-${winnerLabel}`);

      // Restart-safety: a fresh store instance over the same baseDir
      // reconstructs exactly the same accepted winner, not some blended or
      // corrupted state from the losing writers' discarded attempts.
      const freshStore = new FileDurableConnectorConnectionStore(storeDir);
      const reloaded = freshStore.get(requirement.ownership.tenantId, initialInstance.binding.connectionBindingId);
      assert.deepEqual(reloaded, finalState);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
