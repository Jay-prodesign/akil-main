import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

// This file lives at <repo-root>/tests/durable-outcome-job-store-tenant-lock-reclaim-race.test.ts
// and is compiled to dist/tests/..., alongside the also-compiled
// dist/tests/helpers/outcome-job-race-worker.js and
// dist/tests/helpers/outcome-job-tenant-lock-holder-worker.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const RACE_WORKER_SCRIPT = join(HERE, "helpers", "outcome-job-race-worker.js");
const HOLDER_WORKER_SCRIPT = join(HERE, "helpers", "outcome-job-tenant-lock-holder-worker.js");

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runWorker(script: string, args: ReadonlyArray<string>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim().split("\n").filter((line) => line.length > 0));
      } else {
        reject(new Error(`${script} exited with code ${code}`));
      }
    });
  });
}

function filePathFor(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.jsonl`);
}

function tenantJournalLockPathForEpoch(dir: string, tenantId: string, epoch: number): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, ".tenant-locks", `${safeKey}.epoch-${epoch}.lock`);
}

test(
  "Rev72 concurrent multi-reclaimer adversarial witness: a genuinely live replacement owner holds the tenant journal lock (having itself just reclaimed past a pre-planted dead epoch) while several real putIfAbsent/get/list callers concurrently race to reclaim the same original dead epoch - none of them ever disturbs the live replacement's lock, all correctly wait for it, and after it releases, the raw physical jsonl file has exactly one line for the shared jobId",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("outcome-job-tenant-lock-reclaim-");
    const readyDir = freshDir("outcome-job-tenant-lock-reclaim-ready-");
    const goFile = join(freshDir("outcome-job-tenant-lock-reclaim-go-"), "go");
    try {
      const tenantId = "tenant-outcome-job-race";

      // Pre-plant the crash artifact: epoch 1's holder is dead. Both the
      // holder worker and the racing callers below must advance past it.
      const dead = spawnSync(process.execPath, ["-e", ""]);
      const deadPid = dead.pid;
      assert.ok(typeof deadPid === "number" && deadPid > 0);
      const deadEpochPath = tenantJournalLockPathForEpoch(storeDir, tenantId, 1);
      mkdirSync(dirname(deadEpochPath), { recursive: true });
      writeFileSync(deadEpochPath, JSON.stringify({ pid: deadPid }), "utf8");

      const HOLD_MS = 700;
      const holderReadyFile = join(readyDir, "holder.ready");
      const holderPromise = runWorker(HOLDER_WORKER_SCRIPT, [storeDir, holderReadyFile, goFile, String(HOLD_MS)]);

      const RACERS: ReadonlyArray<{ label: string; mode: string }> = [
        { label: "P0", mode: "putIfAbsent" },
        { label: "P1", mode: "putIfAbsent" },
        { label: "P2", mode: "putIfAbsent" },
        { label: "G0", mode: "get" },
        { label: "G1", mode: "get" },
        { label: "L0", mode: "list" },
      ];
      const racerPromises = RACERS.map(({ label, mode }) => {
        const readyFile = join(readyDir, `${label}.ready`);
        return runWorker(RACE_WORKER_SCRIPT, [storeDir, readyFile, goFile, label, mode]);
      });

      // Wait until every process (the holder AND every racer) has
      // announced readiness before releasing the shared go signal, so
      // the racers genuinely contend against the holder's live lock, not
      // against incidental spawn-timing luck.
      const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
      const readyDeadline = Date.now() + 10_000;
      const allReadyFiles = [holderReadyFile, ...RACERS.map(({ label }) => join(readyDir, `${label}.ready`))];
      for (const readyFile of allReadyFiles) {
        while (!existsSync(readyFile)) {
          if (Date.now() > readyDeadline) {
            throw new Error(`worker for ${readyFile} never announced readiness`);
          }
          Atomics.wait(sleepBuffer, 0, 0, 1);
        }
      }
      mkdirSync(dirname(goFile), { recursive: true });
      writeFileSync(goFile, "go", "utf8");

      const [holderLines, ...racerResults] = await Promise.all([holderPromise, ...racerPromises]);

      assert.deepEqual(holderLines, ["HELD", "RELEASED"]);

      // Note: the holder deliberately writes the shared job itself while
      // holding its lock (see outcome-job-tenant-lock-holder-worker.ts's
      // own doc comment for why), bypassing the normal per-jobId creation
      // lock entirely - so a putIfAbsent racer may still legitimately win
      // that separate creation lock and report CREATED from its own
      // point of view even though the physical line was already written
      // by the holder; appendJobIfAbsentLocked's idempotent presence
      // check then correctly makes its own append a no-op. The
      // meaningful, unambiguous assertion is the raw physical line count
      // below, not which caller's `created` flag came back true.

      // Inspect the RAW physical journal directly - not through the
      // store's own dedupedByJobId API, which would mask a duplicate
      // physical append. Exactly one line for this jobId must exist,
      // proving none of the concurrent reclaimers ever disturbed the
      // live holder's lock (which would have let two processes into the
      // critical section simultaneously and risked a duplicate append).
      const filePath = filePathFor(storeDir, tenantId);
      const lines = readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      const matchingLines = lines.filter(
        (line) => (JSON.parse(line) as { jobId: string }).jobId === "job-outcome-job-race-shared",
      );
      assert.equal(
        matchingLines.length,
        1,
        `expected exactly one physical jsonl line, found ${matchingLines.length}: ${JSON.stringify(matchingLines)}`,
      );

      // The original dead epoch (1) must still exist, untouched - Rev72
      // never deletes a reclaimed-past epoch.
      assert.equal(readFileSync(deadEpochPath, "utf8"), JSON.stringify({ pid: deadPid }));
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(readyDir, { recursive: true, force: true });
      rmSync(dirname(goFile), { recursive: true, force: true });
    }
  },
);
