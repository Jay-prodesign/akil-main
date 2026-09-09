import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
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
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
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
   * for the identical lost-update race this replaces). That alone is not
   * sufficient here, though: `putIfAbsent` also has a TOCTOU
   * (time-of-check-to-time-of-use) race distinct from the write mechanism -
   * the absence-check above and this call's own append are not atomic with
   * each other, so a concurrent writer can append a line for the same
   * jobId in between. `dedupedByJobId`'s "first line in the file wins" rule
   * makes on-disk append order the single source of truth for who actually
   * won, so after appending we re-derive the winner from disk and compare
   * it to what we just wrote: if another writer's line landed first, this
   * call honestly reports `created: false` and returns the true winner
   * instead of the optimistic `created: true` it would otherwise have
   * returned for a duplicate-jobId append it lost.
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
    const filePath = this.filePathFor(job.tenantId);
    const line = `${JSON.stringify(job)}\n`;
    appendFileSync(filePath, line, "utf8");
    const winner = this.get(job.tenantId, job.jobId);
    if (winner === undefined) {
      throw new InvalidDurableOutcomeJobStoreError(
        `internal error: jobId "${job.jobId}" missing immediately after append`,
      );
    }
    if (JSON.stringify(winner) !== JSON.stringify(job)) {
      if (winner.tenantId !== job.tenantId || winner.projectId !== job.projectId) {
        throw new InvalidDurableOutcomeJobStoreError(
          `jobId "${job.jobId}" is already persisted under a different tenant/project`,
        );
      }
      return { job: winner, created: false };
    }
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
