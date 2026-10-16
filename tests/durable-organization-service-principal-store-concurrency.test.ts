import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganizationServicePrincipal } from "../src/domain/organization-service-principal.js";
import {
  FileDurableOrganizationServicePrincipalStore,
  OrganizationServicePrincipalVersionConflictError,
} from "../src/domain/durable-organization-service-principal-store.js";

// This file lives at <repo-root>/tests/durable-organization-service-principal-store-concurrency.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/org-service-principal-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "org-service-principal-race-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface WorkerOutcome {
  label: string;
  succeeded: boolean;
  stderr: string;
}

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

async function runAllWorkers(
  storeDir: string,
  prefix: string,
  mode: "create" | "revoke",
  tenantId: string,
  labels: ReadonlyArray<string>,
  servicePrincipalIdFor: (label: string) => string,
): Promise<ReadonlyArray<WorkerOutcome>> {
  const readyDir = freshDir(`${prefix}-ready-`);
  const goFile = join(freshDir(`${prefix}-go-`), "go");
  try {
    const workerPromises = labels.map((label) => {
      const readyFile = join(readyDir, `${label}.ready`);
      return runWorkerAllowFailure([storeDir, readyFile, goFile, mode, tenantId, servicePrincipalIdFor(label), label]);
    });

    const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
    const readyDeadline = Date.now() + 10_000;
    for (const label of labels) {
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

    return await Promise.all(workerPromises);
  } finally {
    rmSync(readyDir, { recursive: true, force: true });
    rmSync(dirname(goFile), { recursive: true, force: true });
  }
}

test(
  "ORG-SERVICE-PRINCIPAL-DURABLE-001: real OS-level concurrent writer processes creating DIFFERENT service principals in the same shared tenant file - every worker's create survives, none lost to a torn write",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("org-sp-durable-race-");
    try {
      const tenantId = "tenant-org-sp-durable-race";
      const WORKER_LABELS = ["A", "B", "C", "D", "E"];

      const outcomes = await runAllWorkers(
        storeDir,
        "org-sp-durable-race",
        "create",
        tenantId,
        WORKER_LABELS,
        (label) => `sp-race-${label}`,
      );
      for (const outcome of outcomes) {
        assert.ok(outcome.succeeded, `worker ${outcome.label} unexpectedly failed: ${outcome.stderr}`);
      }

      const mainStore = new FileDurableOrganizationServicePrincipalStore(storeDir);
      const listed = mainStore.listByTenant(createTenantScope(tenantId).tenantId);
      for (const label of WORKER_LABELS) {
        const found = listed.find((entry) => entry.servicePrincipal.servicePrincipalId === `sp-race-${label}`);
        assert.ok(found !== undefined, `worker ${label}'s service principal was lost to a torn write`);
      }
      assert.equal(listed.length, WORKER_LABELS.length);

      const freshInstance = new FileDurableOrganizationServicePrincipalStore(storeDir);
      assert.equal(freshInstance.listByTenant(createTenantScope(tenantId).tenantId).length, WORKER_LABELS.length);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  },
);

test(
  "ORG-SERVICE-PRINCIPAL-DURABLE-001: real OS-level concurrent writer processes racing to revoke the SAME service principal with the SAME expectedVersion - exactly one wins, every other fails closed with OrganizationServicePrincipalVersionConflictError",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("org-sp-durable-revoke-race-");
    try {
      const tenantId = "tenant-org-sp-durable-revoke-race";
      const tenantScope = createTenantScope(tenantId);
      const servicePrincipalId = "sp-shared";
      const seedStore = new FileDurableOrganizationServicePrincipalStore(storeDir);
      seedStore.create(
        createOrganizationServicePrincipal({ servicePrincipalId, tenantScope, workerRef: "worker-shared" }),
      );

      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const outcomes = await runAllWorkers(
        storeDir,
        "org-sp-durable-revoke-race",
        "revoke",
        tenantId,
        WORKER_LABELS,
        () => servicePrincipalId,
      );

      const succeeded = outcomes.filter((outcome) => outcome.succeeded);
      const failed = outcomes.filter((outcome) => !outcome.succeeded);
      assert.equal(succeeded.length, 1, `expected exactly one worker to win the revoke race, got ${succeeded.length}: ${JSON.stringify(outcomes)}`);
      assert.equal(failed.length, WORKER_LABELS.length - 1);
      for (const outcome of failed) {
        assert.match(
          outcome.stderr,
          /OrganizationServicePrincipalVersionConflictError/,
          `worker ${outcome.label} failed for a reason other than the expected version conflict: ${outcome.stderr}`,
        );
      }

      const mainStore = new FileDurableOrganizationServicePrincipalStore(storeDir);
      const stored = mainStore.get(tenantScope.tenantId, servicePrincipalId as never);
      assert.equal(stored?.servicePrincipal.state, "REVOKED");
      assert.equal(stored?.version, 2);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  },
);
