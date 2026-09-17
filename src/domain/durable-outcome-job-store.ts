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

  private tenantLockPathForEpoch(tenantId: TenantScope["tenantId"], epoch: number): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.tenantLockDir(), `${safeKey}.epoch-${epoch}.lock`);
  }

  /**
   * Rev72: the highest tenant-lock epoch number currently present on disk
   * for this tenant, or `0` if none exist yet - used only as a starting
   * point for a fresh acquisition attempt (see `withTenantJournalLock`),
   * never as a basis for deleting anything.
   */
  private currentTenantLockEpoch(tenantId: TenantScope["tenantId"]): number {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const prefix = `${safeKey}.epoch-`;
    const suffix = ".lock";
    let highest = 0;
    for (const entry of readdirSync(this.tenantLockDir())) {
      if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) {
        continue; // a different tenant's lock, or leftover .tmp litter
      }
      const epoch = Number(entry.slice(prefix.length, entry.length - suffix.length));
      if (Number.isInteger(epoch) && epoch > highest) {
        highest = epoch;
      }
    }
    return highest;
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
   * jobId first".
   *
   * Rev70 attempted a crash-recoverable reclaim by having a stuck waiter
   * read the current lock file's recorded holder pid, confirm it dead via
   * `isProcessAlive`, then `unlinkSync` it before retrying `linkSync`.
   * Rev72 found this unsafe: between that read and that `unlinkSync`,
   * another process could have *already* reclaimed the same dead lock and
   * installed its own live replacement at the identical path - the first
   * process's `unlinkSync(lockPath)` would then delete that *replacement*
   * owner's live lock (an ABA race: same path, different underlying
   * lock), letting a third process acquire it too, so two processes could
   * end up inside the critical section simultaneously. No "read, confirm,
   * then delete-by-path" sequence can ever be made safe against this
   * without a true compare-and-delete primitive, which Node's `fs` API
   * does not provide.
   *
   * Rev72 correction: reclaim now never deletes anything. Instead of one
   * mutable lock file per tenant, each acquisition attempt targets a
   * strictly increasing per-tenant *epoch* number
   * (`tenantLockPathForEpoch`). `linkSync` for a given epoch is still the
   * sole, atomic arbiter of who holds *that exact epoch* - unchanged from
   * before. What changes is how a waiter responds to a dead holder: it
   * never touches the dead epoch's file at all. It simply advances to the
   * *next* epoch number and attempts `linkSync` there instead - a path
   * that has never existed before, so creating it is always unconditionally
   * safe. Because epoch numbers only ever increase and a given epoch
   * number's file is (a) created by at most one process, ever (`linkSync`
   * atomicity), and (b) only ever deleted by that same process releasing
   * its own lock, there is no path on which two processes can ever both
   * believe they hold the same epoch, and no path on which reclaiming a
   * dead epoch can disturb a live one - a live epoch is simply never a
   * candidate for reclaim, only for advancing past.
   *
   * Critically, a fresh acquirer never attempts to create a new epoch
   * number *speculatively* - doing so would let it skip straight past a
   * currently-live epoch (a higher, never-before-tried number is always
   * free to `linkSync` regardless of whether some lower epoch is still
   * actively held), silently destroying mutual exclusion. Every attempt
   * therefore first determines the CURRENT highest epoch's own status: if
   * it is alive, this call waits/backs off exactly as it would for the
   * original single-lock-file design; only once the current highest
   * epoch is confirmed dead (or found already released) does this call
   * ever attempt to create a new, higher one.
   *
   * A dead process's abandoned epoch file is therefore never removed by
   * anyone; it is a small, bounded, disclosed accumulation (this store
   * already accepts the identical characteristic for
   * `creationLockPathFor`'s per-jobId locks, which are also never
   * released) rather than a correctness risk.
   */
  private tryAcquireTenantLockEpoch(
    tenantId: TenantScope["tenantId"],
    epoch: number,
  ): "acquired" | "taken" {
    const candidatePath = this.tenantLockPathForEpoch(tenantId, epoch);
    const tmpPath = `${candidatePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ pid: process.pid }), "utf8");
    try {
      linkSync(tmpPath, candidatePath);
      return "acquired";
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      return "taken";
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only - a successful linkSync's hard-linked
        // copy already carries its own independent content, so a failure
        // to remove the private temp file cannot corrupt it.
      }
    }
  }

  private withTenantJournalLock<T>(tenantId: TenantScope["tenantId"], criticalSection: () => T): T {
    const deadline = Date.now() + FileDurableOutcomeJobStore.TENANT_LOCK_TIMEOUT_MS;
    let acquiredEpoch: number | undefined;
    for (;;) {
      const highest = this.currentTenantLockEpoch(tenantId);

      if (highest === 0) {
        // No lock has ever existed for this tenant (or every prior epoch
        // was cleanly released back down to none) - straightforward
        // first acquisition at epoch 1.
        if (this.tryAcquireTenantLockEpoch(tenantId, 1) === "acquired") {
          acquiredEpoch = 1;
          break;
        }
        continue; // someone else just claimed epoch 1 first - rescan
      }

      const highestPath = this.tenantLockPathForEpoch(tenantId, highest);
      let holderPid: number | undefined;
      let lockAlreadyGone = false;
      try {
        const raw = JSON.parse(readFileSync(highestPath, "utf8")) as unknown;
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
        // genuinely unreadable file) cannot safely confirm the holder is
        // dead - treated as still-contended below, never force-advanced
        // past.
      }

      if (lockAlreadyGone) {
        continue; // released between our scan and this read - rescan immediately, no backoff
      }
      if (holderPid !== undefined && !this.isProcessAlive(holderPid)) {
        // The current highest epoch's holder is provably dead - safe to
        // advance past it. This never touches epoch `highest`'s own
        // file; it only ever creates a brand-new one at `highest + 1`.
        if (this.tryAcquireTenantLockEpoch(tenantId, highest + 1) === "acquired") {
          acquiredEpoch = highest + 1;
          break;
        }
        continue; // someone else already advanced past it first - rescan
      }

      // The current highest epoch is genuinely alive (or its status
      // could not be confirmed dead) - this is real contention, not a
      // crash artifact. Wait and re-evaluate, exactly as a normal mutex
      // would; never attempt a higher epoch while this one might still
      // be a live critical section.
      if (Date.now() > deadline) {
        throw new OutcomeJobTenantLockTimeoutError(tenantId);
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        FileDurableOutcomeJobStore.TENANT_LOCK_RETRY_BACKOFF_MS,
      );
    }
    try {
      return criticalSection();
    } finally {
      try {
        unlinkSync(this.tenantLockPathForEpoch(tenantId, acquiredEpoch));
      } catch {
        // best-effort: if this somehow fails, the next acquirer's own
        // liveness check (this process is still alive while running this
        // very `finally` block) bounds it via the ordinary wait/timeout
        // path above rather than an unsafe reclaim.
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
