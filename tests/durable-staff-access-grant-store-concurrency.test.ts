import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { FileDurableStaffAccessGrantStore } from "../src/domain/durable-staff-access-grant-store.js";

// Mirrors durable-organization-membership-store-concurrency.test.ts. The
// worker is compiled to dist/tests/helpers/staff-access-grant-race-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "staff-access-grant-race-worker.js");

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
  mode: "create" | "update",
  tenantId: string,
  labels: ReadonlyArray<string>,
  membershipIdFor: (label: string) => string,
): Promise<ReadonlyArray<WorkerOutcome>> {
  const readyDir = freshDir(`${prefix}-ready-`);
  const goFile = join(freshDir(`${prefix}-go-`), "go");
  try {
    const workerPromises = labels.map((label) => {
      const readyFile = join(readyDir, `${label}.ready`);
      return runWorkerAllowFailure([storeDir, readyFile, goFile, mode, tenantId, membershipIdFor(label), label]);
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
  "C2: real OS-level concurrent writer processes creating grants for DIFFERENT memberships in the same tenant file - every create survives, none lost to a torn write",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("staff-access-grant-race-");
    try {
      const tenantId = "tenant-staff-access-grant-race";
      const WORKER_LABELS = ["A", "B", "C", "D", "E"];

      const outcomes = await runAllWorkers(storeDir, "staff-access-grant-race", "create", tenantId, WORKER_LABELS, (label) => `mem-race-${label}`);
      for (const outcome of outcomes) {
        assert.ok(outcome.succeeded, `worker ${outcome.label} unexpectedly failed: ${outcome.stderr}`);
      }

      const listed = new FileDurableStaffAccessGrantStore(storeDir).listByTenant(createTenantScope(tenantId).tenantId);
      for (const label of WORKER_LABELS) {
        assert.ok(
          listed.some((entry) => entry.grant.membershipId === `mem-race-${label}`),
          `worker ${label}'s grant was lost to a torn write`,
        );
      }
      assert.equal(listed.length, WORKER_LABELS.length);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  },
);

test(
  "C2: real OS-level concurrent writer processes racing to update the SAME grant with the SAME expectedVersion - exactly one wins, every other fails closed with StaffAccessGrantVersionConflictError",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("staff-access-grant-update-race-");
    try {
      const tenantId = "tenant-staff-access-grant-update-race";
      const tenantScope = createTenantScope(tenantId);
      const membershipId = "mem-shared";
      new FileDurableStaffAccessGrantStore(storeDir).create({
        tenantId: tenantScope.tenantId,
        membershipId: membershipId as never,
        authority: createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false }),
        assignments: [],
      });

      const WORKER_LABELS = ["A", "B", "C", "D", "E"];
      const outcomes = await runAllWorkers(storeDir, "staff-access-grant-update-race", "update", tenantId, WORKER_LABELS, () => membershipId);

      const succeeded = outcomes.filter((outcome) => outcome.succeeded);
      const failed = outcomes.filter((outcome) => !outcome.succeeded);
      assert.equal(succeeded.length, 1, `expected exactly one worker to win the update race, got ${succeeded.length}: ${JSON.stringify(outcomes)}`);
      assert.equal(failed.length, WORKER_LABELS.length - 1);
      for (const outcome of failed) {
        assert.match(
          outcome.stderr,
          /StaffAccessGrantVersionConflictError/,
          `worker ${outcome.label} failed for a reason other than the expected version conflict: ${outcome.stderr}`,
        );
      }

      const stored = new FileDurableStaffAccessGrantStore(storeDir).get(tenantScope.tenantId, membershipId as never);
      assert.equal(stored?.version, 2);
      assert.deepEqual([...(stored?.grant.authority.permissions ?? [])], ["READ", "WRITE"]);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  },
);
