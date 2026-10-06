import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import { validatePersistedOutcomeJob, type OutcomeJob } from "./outcome-job.js";

export class InvalidDurableOutcomeJobStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableOutcomeJobStore operation: ${reason}`);
    this.name = "InvalidDurableOutcomeJobStoreError";
  }
}

export class CorruptedOutcomeJobLineError extends Error {
  constructor(filePath: string, lineNumber: number, reason: string) {
    super(`Corrupted durable outcome job line (${filePath}:${lineNumber}): ${reason}`);
    this.name = "CorruptedOutcomeJobLineError";
  }
}

export interface PersistJobResult {
  readonly job: OutcomeJob;
  readonly created: boolean;
}

/**
 * DEL-003 second bounded slice correction (F3): the durable persistence
 * boundary that makes OutcomeJob creation/replay idempotency explicit and
 * enforced, not merely assumed downstream (Brain CHANGES_REQUIRED F3,
 * DEL-003 second slice round 1). `putIfAbsent` is the sole write path -
 * there is no plain "insert" - so a duplicate admission/replay of the same
 * jobId can never overwrite or duplicate a persisted job; it only reports
 * `created: false` and returns the job exactly as first persisted.
 */
export interface DurableOutcomeJobStore {
  putIfAbsent(job: OutcomeJob): PersistJobResult;
  get(tenantId: TenantScope["tenantId"], jobId: OutcomeJob["jobId"]): OutcomeJob | undefined;
  list(tenantId: TenantScope["tenantId"], projectId: OutcomeJob["projectId"]): ReadonlyArray<OutcomeJob>;
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs` - no new runtime dependency (T10/T12). One JSON-lines file per
 * tenant under `baseDir`, keyed by jobId; every read reconstructs the
 * current job set from the full durable file, in true append order,
 * keeping only the first record for any given jobId - proving restart
 * reconstruction (a fresh store instance over the same `baseDir` sees the
 * exact same de-duplicated job set) rather than relying on a separate
 * in-memory index that could diverge from disk.
 */
export class FileDurableOutcomeJobStore implements DurableOutcomeJobStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.creationLockDir(), { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  private creationLockDir(): string {
    return join(this.baseDir, ".creation-locks");
  }

  /**
   * AUD-DURABILITY-GAP Rev74 F1: one lock path per (tenantId, jobId) pair -
   * this is the sole arbiter of "who actually created this jobId first",
   * independent of `filePathFor`'s per-tenant jsonl sharding.
   */
  private creationLockPathFor(
    tenantId: TenantScope["tenantId"],
    jobId: OutcomeJob["jobId"],
  ): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const jobKey = Buffer.from(jobId, "utf8").toString("base64url");
    return join(this.creationLockDir(), `${tenantKey}.${jobKey}.lock`);
  }

  /**
   * AUD-DURABILITY-GAP: replay no longer trusts `JSON.parse(line) as
   * OutcomeJob` - each line is re-run through `validatePersistedOutcomeJob`
   * and fails closed (throws) rather than silently flowing a
   * malformed/forged record into `dedupedByJobId`/callers.
   */
  private readAll(tenantId: TenantScope["tenantId"]): OutcomeJob[] {
    const filePath = this.filePathFor(tenantId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new CorruptedOutcomeJobLineError(
          filePath,
          index + 1,
          `line is not valid JSON (${(cause as Error).message})`,
        );
      }
      try {
        return validatePersistedOutcomeJob(parsed);
      } catch (cause) {
        throw new CorruptedOutcomeJobLineError(
          filePath,
          index + 1,
          `line failed OutcomeJob validation (${(cause as Error).message})`,
        );
      }
    });
  }

  private dedupedByJobId(jobs: ReadonlyArray<OutcomeJob>): Map<OutcomeJob["jobId"], OutcomeJob> {
    const byJobId = new Map<OutcomeJob["jobId"], OutcomeJob>();
    for (const job of jobs) {
      if (!byJobId.has(job.jobId)) {
        // First record for this jobId wins - later duplicate appends
        // (a replayed wiring pass) are inert on reconstruction.
        byJobId.set(job.jobId, job);
      }
    }
    return byJobId;
  }

  /**
   * AUD-DURABILITY-GAP: the write itself is a single atomic `appendFileSync`
   * call, not a read-modify-write cycle (see `FileDurableEngineeringStore`
   * for the identical lost-update race this replaces).
   *
   * Rev74 F1 correction: the original TOCTOU fix re-derived the winner from
   * disk after appending and compared it (via `JSON.stringify`) to what
   * this call submitted - but two writers racing with an *identical*
   * payload for the same jobId cannot be disambiguated by content
   * comparison at all: both observe the same first-on-disk winner, and
   * both see it match their own submitted content byte-for-byte, so both
   * concluded `created: true`. Creation is now arbitrated by a single
   * OS-atomic operation instead of any content comparison: each writer
   * first writes its own job to a uniquely-named temp file (private to
   * this call - no other writer can observe or race it), then attempts
   * `linkSync` of that temp file onto a jobId-scoped lock path
   * (`creationLockPathFor`). `linkSync` either creates the destination
   * directory entry or fails with `EEXIST`, atomically, with no window in
   * which a second caller could observe a half-created lock - so exactly
   * one writer's `linkSync` can ever succeed for a given jobId, regardless
   * of whether the competing payloads are identical, and the outcome does
   * not depend on comparing any content at all.
   *
   * Residual bounded risk (disclosed, not claimed closed): if this process
   * is killed after `linkSync` succeeds but before the following
   * `appendFileSync` completes, the lock exists but the jsonl file (read by
   * `get`/`list`) does not yet reflect the job - a narrow crash window
   * inherent to any single local synchronous write, same class of residual
   * risk this store's "bounded local restart/replay" scope already
   * accepted before this correction (not a new gap; a pre-existing one
   * still bounded by "local" persistence, not distributed consensus).
   */
  putIfAbsent(job: OutcomeJob): PersistJobResult {
    const existing = this.get(job.tenantId, job.jobId);
    if (existing !== undefined) {
      if (existing.tenantId !== job.tenantId || existing.projectId !== job.projectId) {
        throw new InvalidDurableOutcomeJobStoreError(
          `jobId "${job.jobId}" is already persisted under a different tenant/project`,
        );
      }
      return { job: existing, created: false };
    }

    const lockPath = this.creationLockPathFor(job.tenantId, job.jobId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(job), "utf8");
    let wonCreation: boolean;
    try {
      linkSync(tmpPath, lockPath);
      wonCreation = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      wonCreation = false;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only - the published lock (via the hard link)
        // already carries its own independent copy of the content, so a
        // failure to remove the private temp file cannot corrupt it.
      }
    }

    if (!wonCreation) {
      // Another writer's linkSync already claimed creation for this jobId -
      // its content is authoritative, independent of what this call
      // submitted (even if the payloads are byte-identical).
      const winnerRaw = readFileSync(lockPath, "utf8");
      let winner: OutcomeJob;
      try {
        winner = validatePersistedOutcomeJob(JSON.parse(winnerRaw));
      } catch (cause) {
        throw new InvalidDurableOutcomeJobStoreError(
          `internal error: creation-lock content for jobId "${job.jobId}" is not a valid persisted OutcomeJob (${(cause as Error).message})`,
        );
      }
      if (winner.tenantId !== job.tenantId || winner.projectId !== job.projectId) {
        throw new InvalidDurableOutcomeJobStoreError(
          `jobId "${job.jobId}" is already persisted under a different tenant/project`,
        );
      }
      return { job: winner, created: false };
    }

    // This call holds the creation lock - it is the true, sole creator for
    // this jobId. No other writer can reach this point for the same jobId,
    // so the append below is pure durability bookkeeping, not part of the
    // race arbitration.
    const filePath = this.filePathFor(job.tenantId);
    appendFileSync(filePath, `${JSON.stringify(job)}\n`, "utf8");
    return { job, created: true };
  }

  get(tenantId: TenantScope["tenantId"], jobId: OutcomeJob["jobId"]): OutcomeJob | undefined {
    return this.dedupedByJobId(this.readAll(tenantId)).get(jobId);
  }

  list(
    tenantId: TenantScope["tenantId"],
    projectId: OutcomeJob["projectId"],
  ): ReadonlyArray<OutcomeJob> {
    return [...this.dedupedByJobId(this.readAll(tenantId)).values()].filter(
      (job) => job.projectId === projectId,
    );
  }
}

/**
 * F3: persists a batch of already-wired `OutcomeJob`s through the store's
 * `putIfAbsent` idempotency, reporting which were newly created versus
 * already-durably-present. Calling this twice with the same wired jobs (a
 * replayed resume, or a restart re-running `wireAdmittedOutcomeJobs` over
 * the same admitted specs) durably persists exactly one job per jobId -
 * the second call's `created` list is always empty, proving persisted job
 * creation happens once.
 */
export function persistWiredOutcomeJobs(
  store: DurableOutcomeJobStore,
  jobs: ReadonlyArray<OutcomeJob>,
): { readonly created: ReadonlyArray<OutcomeJob>; readonly alreadyPersisted: ReadonlyArray<OutcomeJob> } {
  const created: OutcomeJob[] = [];
  const alreadyPersisted: OutcomeJob[] = [];
  for (const job of jobs) {
    const result = store.putIfAbsent(job);
    if (result.created) {
      created.push(result.job);
    } else {
      alreadyPersisted.push(result.job);
    }
  }
  return { created, alreadyPersisted };
}
