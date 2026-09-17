import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  linkSync,
  unlinkSync,
} from "node:fs";
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

export class CorruptedOutcomeJobLockError extends Error {
  constructor(lockPath: string, reason: string) {
    super(`Corrupted durable outcome job creation lock (${lockPath}): ${reason}`);
    this.name = "CorruptedOutcomeJobLockError";
  }
}

export class OutcomeJobTenantLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable outcome-job tenant journal lock for tenant "${tenantId}"`);
    this.name = "OutcomeJobTenantLockTimeoutError";
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
  list(
    tenantId: TenantScope["tenantId"],
    customerId: OutcomeJob["customerId"],
    projectId: OutcomeJob["projectId"],
  ): ReadonlyArray<OutcomeJob>;
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
  private static readonly TENANT_LOCK_TIMEOUT_MS = 5000;
  private static readonly TENANT_LOCK_RETRY_BACKOFF_MS = 5;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.creationLockDir(), { recursive: true });
    mkdirSync(this.tenantLockDir(), { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  private creationLockDir(): string {
    return join(this.baseDir, ".creation-locks");
  }

  private tenantLockDir(): string {
    return join(this.baseDir, ".tenant-locks");
  }

  private tenantLockPathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.tenantLockDir(), `${safeKey}.lock`);
  }

  /**
   * Rev70: a `process.kill(pid, 0)` liveness probe - signal `0` sends no
   * actual signal, it only tests whether a process with this pid exists
   * and is signalable. `ESRCH` means no such process; anything else
   * (including `EPERM`, a live process owned by another user) cannot
   * safely be concluded dead, so it is treated as alive. This can be
   * fooled by PID reuse (the OS assigning a crashed holder's old pid to
   * an unrelated new process before this check runs) - the only possible
   * error direction from that is a false "still alive" result, which
   * only costs an extra wait/backoff cycle, never an unsafe reclaim.
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  /**
   * Rev69 correction: reuses the exact transient-mutex `linkSync` pattern
   * already established in `durable-connector-connection-store.ts`'s
   * `withTenantLock`, but under its own lock namespace (`.tenant-locks`,
   * distinct from `.creation-locks`) - this lock arbitrates "who may
   * physically write to this tenant's jsonl journal right now", a
   * separate concern from the per-jobId creation lock's "who created this
   * jobId first". `linkSync(tmpPath, lockPath)` either creates the
   * destination directory entry or fails with `EEXIST`, atomically, with
   * no window in which a second process could observe a half-acquired
   * lock, so exactly one process can hold it for a given tenant at a
   * time.
   *
   * Rev70 correction: Brain found the transient mutex itself could be
   * permanently abandoned if its holder process died after acquiring it
   * (between the successful `linkSync` and the `finally` block's
   * `unlinkSync(lockPath)`) - every future acquirer would only ever time
   * out, never reclaim it. The lock file's content now records its
   * holder's pid; on `EEXIST`, before backing off, this checks whether
   * the recorded holder is still alive via `isProcessAlive`. This is
   * *not* an unsafe blind deletion: reclaiming a dead holder's lock file
   * never bypasses `linkSync`'s own atomicity - it only removes a stale
   * directory entry so a *fresh* `linkSync` race can occur immediately
   * after, and that fresh race is exactly what still arbitrates "who
   * actually holds it now." If two processes both conclude the holder is
   * dead and both reclaim, at most one of their subsequent `linkSync`
   * calls can succeed; the other observes `EEXIST` again and re-evaluates
   * the (now genuinely live) new holder, never proceeding under the
   * illusion of exclusive ownership. A lock file whose content cannot be
   * parsed for a live pid is never force-deleted - only a *provably dead*
   * recorded holder triggers reclaim; anything else falls through to the
   * ordinary backoff/timeout path, which still fails closed rather than
   * deadlocking forever.
   */
  private withTenantJournalLock<T>(tenantId: TenantScope["tenantId"], criticalSection: () => T): T {
    const lockPath = this.tenantLockPathFor(tenantId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ pid: process.pid }), "utf8");
    const deadline = Date.now() + FileDurableOutcomeJobStore.TENANT_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        linkSync(tmpPath, lockPath);
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          try {
            unlinkSync(tmpPath);
          } catch {
            // best-effort cleanup only
          }
          throw cause;
        }

        let holderPid: number | undefined;
        let lockAlreadyGone = false;
        try {
          const raw = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
          if (
            typeof raw === "object" &&
            raw !== null &&
            typeof (raw as Record<string, unknown>)["pid"] === "number"
          ) {
            holderPid = (raw as { pid: number })["pid"];
          }
        } catch (readCause) {
          if ((readCause as NodeJS.ErrnoException).code === "ENOENT") {
            lockAlreadyGone = true;
          }
          // Any other read/parse failure (corrupted content, or a
          // genuinely unreadable file) cannot safely confirm the holder
          // is dead - fall through to the ordinary backoff/timeout path
          // below rather than force-deleting it.
        }

        if (lockAlreadyGone) {
          continue; // released or reclaimed by someone else - retry linkSync immediately, no backoff
        }
        if (holderPid !== undefined && !this.isProcessAlive(holderPid)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // lost the reclaim race to another process, or it was
            // released normally in the meantime - either way, safe to
            // retry linkSync fresh below.
          }
          continue;
        }

        if (Date.now() > deadline) {
          try {
            unlinkSync(tmpPath);
          } catch {
            // best-effort cleanup only
          }
          throw new OutcomeJobTenantLockTimeoutError(tenantId);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableOutcomeJobStore.TENANT_LOCK_RETRY_BACKOFF_MS,
        );
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup only - lockPath (the hard-linked copy) is what
      // actually arbitrates ownership from here on.
    }
    try {
      return criticalSection();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // best-effort: if this somehow fails, the next acquirer's own
        // liveness check (this process is still alive, so it won't
        // reclaim) bounds it via the ordinary timeout instead.
      }
    }
  }

  /**
   * Rev69 correction: the sole physical-append path for this tenant's
   * jsonl journal. Both `putIfAbsent`'s own winning-creator append and
   * `reconcileOrphanedLocks`'s healing append now go through this method
   * instead of a raw unlocked `appendFileSync` - Brain Rev69 found the
   * prior design's reconciliation append was not single-writer: a
   * creator-vs-reconciler race (the winner's own append racing a
   * concurrent reader's healing of the same not-yet-durable lock) or a
   * multi-reconciler race (several concurrent readers all healing the
   * same orphaned lock) could physically append duplicate jsonl lines for
   * the same jobId, masked only by `dedupedByJobId`'s read-time
   * first-wins behavior - the raw journal itself was not idempotent.
   *
   * Every writer now serializes through `withTenantJournalLock` and
   * re-checks presence with a *fresh* read taken *inside* the lock
   * (never a snapshot taken before acquiring it) before appending -
   * exactly one process can hold the lock for a tenant at a time, so
   * exactly one physical append can ever happen for a given jobId,
   * regardless of how many creators/reconcilers race for it. This inner
   * presence check is a lightweight jobId-only scan (not a full
   * `validatePersistedOutcomeJob` pass) - it exists purely to make the
   * write idempotent; `readAll`'s own independent, unlocked validation
   * pass remains the sole source of truth for corrupted/forged content.
   */
  private appendJobIfAbsentLocked(tenantId: TenantScope["tenantId"], job: OutcomeJob): void {
    this.withTenantJournalLock(tenantId, () => {
      const filePath = this.filePathFor(tenantId);
      if (existsSync(filePath)) {
        const lines = readFileSync(filePath, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0);
        for (const line of lines) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // a corrupted line is readAll's problem to raise, not this idempotency check's
          }
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as Record<string, unknown>)["jobId"] === job.jobId
          ) {
            return; // already durably present - idempotent no-op
          }
        }
      }
      appendFileSync(filePath, `${JSON.stringify(job)}\n`, "utf8");
    });
  }

  /**
   * AUD-DURABILITY-GAP: one lock path per (tenantId, jobId) pair - this is
   * the sole arbiter of "who actually created this jobId first",
   * independent of `filePathFor`'s per-tenant jsonl sharding. Unlike
   * `durable-connector-connection-store.ts`'s `withTenantLock`, this lock
   * is never released: it is a permanent creation claim, not a transient
   * mutex, and doubles as the durable proof of the winning payload.
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
   * Rev68 F1 (forward-port of AUD-DURABILITY-GAP's PR #30, corrected):
   * PR #30's `putIfAbsent` admitted a process-kill window after a
   * successful `linkSync(tmpPath, lockPath)` but before the following
   * `appendFileSync(jsonl)` - the creation lock becomes authoritative for
   * arbitration the instant it exists, but `get()`/`list()` only ever
   * reconstructed state from the jsonl file, so a crash in that window
   * left a permanently invisible-but-claimed jobId: a later caller would
   * see `get() === undefined`, lose its own `linkSync` with `EEXIST`, and
   * (in PR #30's version) return the lock winner as `created: false`
   * without ever repairing the jsonl file - subsequent reads could remain
   * inconsistent forever.
   *
   * Every read now reconciles first: any creation lock for this tenant
   * whose jobId is not yet reflected in the jsonl file is healed by
   * appending its own (independently validated) content, so a fresh store
   * instance over the same `baseDir` always converges to the same durable
   * set regardless of exactly where a prior process was killed. A lock
   * file that fails validation, or whose own embedded `tenantId` does not
   * match the tenant it is filed under, is corruption - not an ordinary
   * crash artifact - and fails closed rather than being silently skipped
   * or silently healed with the wrong identity.
   */
  private reconcileOrphanedLocks(
    tenantId: TenantScope["tenantId"],
    knownJobIds: ReadonlySet<OutcomeJob["jobId"]>,
  ): OutcomeJob[] {
    const lockDir = this.creationLockDir();
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const prefix = `${tenantKey}.`;
    const healed: OutcomeJob[] = [];
    for (const entry of readdirSync(lockDir)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".lock")) {
        continue; // a different tenant's lock, or leftover .tmp litter
      }
      const lockPath = join(lockDir, entry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch (cause) {
        throw new CorruptedOutcomeJobLockError(
          lockPath,
          `lock file is not valid JSON (${(cause as Error).message})`,
        );
      }
      let job: OutcomeJob;
      try {
        job = validatePersistedOutcomeJob(parsed);
      } catch (cause) {
        throw new CorruptedOutcomeJobLockError(
          lockPath,
          `lock file failed OutcomeJob validation (${(cause as Error).message})`,
        );
      }
      if (job.tenantId !== tenantId) {
        throw new CorruptedOutcomeJobLockError(
          lockPath,
          `lock file's own tenantId "${job.tenantId}" does not match the tenant it is filed under ("${tenantId}")`,
        );
      }
      if (knownJobIds.has(job.jobId)) {
        continue; // already durably reflected in jsonl - the normal case
      }
      this.appendJobIfAbsentLocked(tenantId, job);
      healed.push(job);
    }
    return healed;
  }

  /**
   * AUD-DURABILITY-GAP: replay no longer trusts `JSON.parse(line) as
   * OutcomeJob` - each line is re-run through `validatePersistedOutcomeJob`
   * and fails closed (throws) rather than silently flowing a
   * malformed/forged record into `dedupedByJobId`/callers.
   */
  private readAll(tenantId: TenantScope["tenantId"]): OutcomeJob[] {
    const filePath = this.filePathFor(tenantId);
    const fromJsonl: OutcomeJob[] = [];
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);
      for (const [index, line] of lines.entries()) {
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
          fromJsonl.push(validatePersistedOutcomeJob(parsed));
        } catch (cause) {
          throw new CorruptedOutcomeJobLineError(
            filePath,
            index + 1,
            `line failed OutcomeJob validation (${(cause as Error).message})`,
          );
        }
      }
    }
    const knownJobIds = new Set(fromJsonl.map((job) => job.jobId));
    const healed = this.reconcileOrphanedLocks(tenantId, knownJobIds);
    return [...fromJsonl, ...healed];
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
   * AUD-DURABILITY-GAP (Rev74 direction, Rev68 forward-port corrections):
   * the write itself is a single atomic `appendFileSync` call, not a
   * read-modify-write cycle. Creation is arbitrated by a single OS-atomic
   * operation rather than any content comparison: this call first writes
   * its own job to a uniquely-named temp file (private to this call - no
   * other writer can observe or race it), then attempts `linkSync` of that
   * temp file onto a jobId-scoped lock path (`creationLockPathFor`).
   * `linkSync` either creates the destination directory entry or fails
   * with `EEXIST`, atomically, with no window in which a second caller
   * could observe a half-created lock - so exactly one writer's `linkSync`
   * can ever succeed for a given jobId, regardless of whether competing
   * payloads are identical, and the outcome never depends on comparing any
   * content at all (the original TOCTOU fix this replaces could not
   * disambiguate two racing writers submitting byte-identical payloads).
   *
   * A losing writer never reads the lock file directly: it re-resolves the
   * jobId through `get()`, the exact same reconciliation path (Rev68 F1)
   * every other reader uses, so a winner that crashed between `linkSync`
   * and its own `appendFileSync` is transparently healed here too, and a
   * corrupted lock fails closed instead of this call inventing its own
   * separate (and potentially inconsistent) lock-reading logic.
   *
   * Rev68 F2 correction: the cross-writer conflict check below compares
   * the full tenantId+customerId+projectId tuple, not just tenant+project
   * - PR #30 predated this repository's later customer-isolation
   * hardening (current forward `putIfAbsent`'s own "existing" branch above
   * already required customerId; the lock-arbitration branch had not been
   * updated to match).
   */
  putIfAbsent(job: OutcomeJob): PersistJobResult {
    const existing = this.get(job.tenantId, job.jobId);
    if (existing !== undefined) {
      if (
        existing.tenantId !== job.tenantId ||
        existing.customerId !== job.customerId ||
        existing.projectId !== job.projectId
      ) {
        throw new InvalidDurableOutcomeJobStoreError(
          `jobId "${job.jobId}" is already persisted under a different tenant/customer/project`,
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
        // best-effort cleanup only - the published lock (via the hard
        // link) already carries its own independent copy of the content,
        // so a failure to remove the private temp file cannot corrupt it.
      }
    }

    if (!wonCreation) {
      const winner = this.get(job.tenantId, job.jobId);
      if (winner === undefined) {
        // The lock exists (EEXIST was just observed) but reconciliation
        // could not resolve it - unreachable via this store's own code
        // paths (a creation lock is never deleted once written), kept as
        // a fail-closed guard rather than a silent `undefined` return.
        throw new InvalidDurableOutcomeJobStoreError(
          `internal error: creation lock for jobId "${job.jobId}" exists but could not be resolved`,
        );
      }
      if (
        winner.tenantId !== job.tenantId ||
        winner.customerId !== job.customerId ||
        winner.projectId !== job.projectId
      ) {
        throw new InvalidDurableOutcomeJobStoreError(
          `jobId "${job.jobId}" is already persisted under a different tenant/customer/project`,
        );
      }
      return { job: winner, created: false };
    }

    // This call holds the creation lock - it is the true, sole creator
    // for this jobId. No other writer can create a *different* jsonl
    // entry for it, but a concurrent reader could still be mid-way
    // through healing this exact lock (Rev69) - appendJobIfAbsentLocked's
    // own tenant-journal lock and fresh-read presence check make this
    // append idempotent against that race, not merely "pure bookkeeping".
    this.appendJobIfAbsentLocked(job.tenantId, job);
    return { job, created: true };
  }

  get(tenantId: TenantScope["tenantId"], jobId: OutcomeJob["jobId"]): OutcomeJob | undefined {
    return this.dedupedByJobId(this.readAll(tenantId)).get(jobId);
  }

  list(
    tenantId: TenantScope["tenantId"],
    customerId: OutcomeJob["customerId"],
    projectId: OutcomeJob["projectId"],
  ): ReadonlyArray<OutcomeJob> {
    return [...this.dedupedByJobId(this.readAll(tenantId)).values()].filter(
      (job) => job.customerId === customerId && job.projectId === projectId,
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
