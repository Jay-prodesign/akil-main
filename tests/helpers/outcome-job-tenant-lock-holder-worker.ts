import { existsSync, writeFileSync, unlinkSync, readdirSync, linkSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Rev72 forward-port correction: standalone worker process (not a test
 * itself) spawned by
 * durable-outcome-job-store-tenant-lock-reclaim-race.test.ts to act as a
 * genuinely live "replacement owner" of the tenant journal lock -
 * mirroring `FileDurableOutcomeJobStore`'s own (private) epoch-based
 * `.tenant-locks` encoding directly, since the class's real acquisition
 * path has no test-only hook to hold a lock open for a controlled
 * duration.
 *
 * This worker deliberately reclaims past a pre-planted dead epoch (epoch
 * 1) exactly the way the real store would (advance, never delete), then
 * - crucially - performs a REAL conflicting write while holding it:
 * exactly the same "fresh presence check, append if absent" the real
 * `appendJobIfAbsentLocked` does, against the identical shared jobId the
 * racing `outcome-job-race-worker.js` processes target. Without this,
 * an earlier version of this test could not actually detect a mutual-
 * exclusion violation - if the holder merely slept without touching
 * jsonl, a racer that incorrectly barged into the critical section
 * concurrently (due to a since-fixed speculative-epoch bug) would simply
 * write the job uncontested, leaving no visible trace of the violation.
 * With the holder itself racing to write, a genuine violation produces a
 * real duplicate physical jsonl line, which the test can detect.
 *
 * After its write, the worker holds the epoch for `holdMs`, then
 * releases it (deletes its own epoch file) and exits - simulating a
 * real, live, eventually-completing critical section for other real
 * store-API callers (spawned concurrently by the test) to race against.
 *
 * usage: node outcome-job-tenant-lock-holder-worker.js <storeDir> <readyFile> <goFile> <holdMs>
 * prints "HELD\n" once acquired, then "RELEASED\n" after releasing.
 */
const [, , storeDir, readyFile, goFile, holdMsArg] = process.argv;
if (storeDir === undefined || readyFile === undefined || goFile === undefined || holdMsArg === undefined) {
  throw new Error("usage: outcome-job-tenant-lock-holder-worker.js <storeDir> <readyFile> <goFile> <holdMs>");
}
const holdMs = Number(holdMsArg);

const TENANT_ID = "tenant-outcome-job-race";
const safeKey = Buffer.from(TENANT_ID, "utf8").toString("base64url");
const lockDir = join(storeDir, ".tenant-locks");

function epochPath(epoch: number): string {
  return join(lockDir, `${safeKey}.epoch-${epoch}.lock`);
}

function currentEpoch(): number {
  const prefix = `${safeKey}.epoch-`;
  const suffix = ".lock";
  let highest = 0;
  for (const entry of readdirSync(lockDir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
    const epoch = Number(entry.slice(prefix.length, entry.length - suffix.length));
    if (Number.isInteger(epoch) && epoch > highest) highest = epoch;
  }
  return highest;
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

// Mirrors the real store's own acquisition loop closely enough to
// genuinely advance past the pre-planted dead epoch 1 and claim the next
// one - this worker's own pid is, by construction, alive for as long as
// this process runs, so racing store-API callers must correctly wait for
// it rather than reclaim past it.
let epoch = currentEpoch() + 1;
let acquiredPath: string | undefined;
for (;;) {
  const candidatePath = epochPath(epoch);
  const tmpPath = `${candidatePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ pid: process.pid }), "utf8");
  try {
    linkSync(tmpPath, candidatePath);
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort
    }
    acquiredPath = candidatePath;
    break;
  } catch (cause) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort
    }
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
      throw cause;
    }
    epoch += 1; // the pre-planted epoch 1 is dead by construction - advance
  }
}

process.stdout.write("HELD\n");

// The real conflicting write: mirrors appendJobIfAbsentLocked's own
// fresh-presence-check-then-append exactly, against the same shared
// jobId the racing outcome-job-race-worker.js processes target.
const JOB_ID = "job-outcome-job-race-shared";
const jsonlPath = join(storeDir, safeKey + ".jsonl");
let alreadyPresent = false;
if (existsSync(jsonlPath)) {
  const lines = readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["jobId"] === JOB_ID) {
        alreadyPresent = true;
        break;
      }
    } catch {
      // not this worker's concern - the real store's own validation owns this
    }
  }
}
if (!alreadyPresent) {
  const job = {
    tenantId: TENANT_ID,
    customerId: "customer-outcome-job-race",
    projectId: "project-outcome-job-race",
    jobId: JOB_ID,
    jobFamily: "outcome-job-race-family",
    businessObjective: "outcome-job-race-objective",
    state: "DRAFT",
  };
  appendFileSync(jsonlPath, `${JSON.stringify(job)}\n`, "utf8");
}

const holdSleepBuffer = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(holdSleepBuffer, 0, 0, holdMs);

unlinkSync(acquiredPath);
process.stdout.write("RELEASED\n");
