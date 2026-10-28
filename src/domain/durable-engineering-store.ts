import { mkdirSync, readFileSync, writeFileSync, existsSync, linkSync, unlinkSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { EngineeringEventEnvelope, TaskId, RunId } from "./engineering-event-envelope.js";
import { createEngineeringEventEnvelope } from "./engineering-event-envelope.js";
import { createDec138Provenance } from "./dec-138-provenance.js";
import { reconstructState, type EngineeringRunState } from "./engineering-run-state.js";

export class InvalidDurableEngineeringStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableEngineeringStore operation: ${reason}`);
    this.name = "InvalidDurableEngineeringStoreError";
  }
}

export class EngineeringStoreLockTimeoutError extends Error {
  constructor(runKey: string) {
    super(`Timed out waiting for the durable engineering-store lock for run "${runKey}"`);
    this.name = "EngineeringStoreLockTimeoutError";
  }
}

export class CorruptedEngineeringEventLineError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable engineering-event line (${filePath}): ${reason}`);
    this.name = "CorruptedEngineeringEventLineError";
  }
}

/**
 * Bounded scan correction (same class as Brain Rev44 F1/F2, CXP-001K/L/R):
 * `projectRef`/`taskId`/`runId` are validated only as non-empty trimmed
 * strings, never as delimiter-free, so raw `::`-delimited concatenation
 * is not actually collision-safe - two distinct tuples with a component
 * containing `::` could resolve to the same key and therefore the same
 * on-disk run-state file, silently interleaving two unrelated
 * engineering runs' event logs. `JSON.stringify` of the identity tuple
 * as an array is injective for this purpose: JSON string escaping means
 * two distinct tuples can never serialize to the same string.
 */
function runKey(projectRef: string, taskId: TaskId, runId: RunId): string {
  return JSON.stringify([projectRef, taskId, runId]);
}

/**
 * ENG-ORCH-001 "First bounded vertical slice" #4: the durable persistence
 * boundary. `appendEvent` must always durably record the raw event (even
 * one that will turn out to be stale/rejected/duplicate once replayed) -
 * nothing is silently dropped at the storage layer, only at the pure
 * reducer layer (`applyEvent`). `getState` reconstructs the current
 * projection from the full durable log; it is the only way to read
 * current state, so a process restart is provably indistinguishable from
 * a fresh `getState` call against the same durable data (E4).
 */
export interface DurableEngineeringStore {
  appendEvent(event: EngineeringEventEnvelope): void;
  getState(projectRef: string, taskId: TaskId, runId: RunId): EngineeringRunState | undefined;
  getEvents(projectRef: string, taskId: TaskId, runId: RunId): ReadonlyArray<EngineeringEventEnvelope>;
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs`/`node:crypto` - no new runtime dependency, no Google Drive, no
 * queue/broker (E15). One append-only JSON-lines file per run under
 * `baseDir`, keyed by project/task/runId; `getState` reads the full file
 * and replays it through the pure reducer in true on-disk append order
 * every time, proving restart-safety by construction (there is no
 * separate in-memory cache that could diverge from disk).
 *
 * AUD-DURABILITY-GAP-V2 correction (re-derived against current `main`
 * after the #167/#168 systemic torn-read/lost-write correction - see that
 * correction's own epistemic note in
 * `KNOWLEDGE-EVIDENCE-DURABLE-001-SYSTEMIC-TORN-READ-CORRECTION.md`):
 * this store previously had no lock at all around `appendEvent`'s
 * read-check-write critical section (a lost-write hazard identical in
 * class to `FileDurableOutcomeJobStore`'s pre-correction defect) and
 * `getEvents` did a blind `JSON.parse` cast with zero structural
 * revalidation (so a torn/corrupted/tampered line would either throw an
 * opaque `SyntaxError` or, worse, silently flow through as a
 * well-typed-but-garbage `EngineeringEventEnvelope`). Fixed with the
 * standard two-part pattern this corridor has now established
 * repository-wide: a `linkSync`-based per-run mutual-exclusion lock
 * shared by the writer AND every reader (applying the #167 lesson that a
 * writer-only lock does not prevent a reader from observing a torn file
 * mid-write), plus fail-closed replay validation that re-runs
 * `createEngineeringEventEnvelope`/`createDec138Provenance` against every
 * parsed line (Rev183 F4's "reapply constructor invariants on replay"
 * precedent) plus a cross-run-contamination identity check.
 */
export class FileDurableEngineeringStore implements DurableEngineeringStore {
  private readonly baseDir: string;
  private static readonly LOCK_TIMEOUT_MS = 5000;
  private static readonly LOCK_RETRY_BACKOFF_MS = 5;
  private static readonly STALE_LOCK_THRESHOLD_MS = 30_000;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.lockDir(), { recursive: true });
  }

  private filePathFor(projectRef: string, taskId: TaskId, runId: RunId): string {
    const safeKey = Buffer.from(runKey(projectRef, taskId, runId), "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  private lockDir(): string {
    return join(this.baseDir, ".locks");
  }

  private lockPathFor(projectRef: string, taskId: TaskId, runId: RunId): string {
    const safeKey = Buffer.from(runKey(projectRef, taskId, runId), "utf8").toString("base64url");
    return join(this.lockDir(), `${safeKey}.lock`);
  }

  /**
   * Real cross-process mutual exclusion for the shared per-run file,
   * reusing the exact `linkSync` atomic-creation primitive already
   * accepted for `FileDurableConnectorConnectionStore`/every other
   * `FileDurable*Store` in this repository. `linkSync(tmpPath, lockPath)`
   * either creates the `lockPath` directory entry or fails with `EEXIST` -
   * atomically, with no window in which a second process could observe a
   * half-acquired lock - so exactly one process can hold the lock for a
   * given run at a time, whether it is appending or reading. A bounded
   * timeout throws `EngineeringStoreLockTimeoutError` rather than
   * deadlocking forever against a lock abandoned by a crashed process.
   */
  private withRunLock<T>(projectRef: string, taskId: TaskId, runId: RunId, criticalSection: () => T): T {
    const key = runKey(projectRef, taskId, runId);
    const lockPath = this.lockPathFor(projectRef, taskId, runId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, String(process.pid), "utf8");
    const deadline = Date.now() + FileDurableEngineeringStore.LOCK_TIMEOUT_MS;
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
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > FileDurableEngineeringStore.STALE_LOCK_THRESHOLD_MS) {
            unlinkSync(lockPath);
          }
        } catch {
          // the lock may have just been released, or reclaimed by another
          // waiter, between the EEXIST above and this check - either way,
          // just fall through and retry
        }
        if (Date.now() > deadline) {
          try {
            unlinkSync(tmpPath);
          } catch {
            // best-effort cleanup only
          }
          throw new EngineeringStoreLockTimeoutError(key);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableEngineeringStore.LOCK_RETRY_BACKOFF_MS,
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
        // best-effort: if this somehow fails, the lock would be abandoned
        // and only cleared by another holder's own timeout/replacement.
      }
    }
  }

  appendEvent(event: EngineeringEventEnvelope): void {
    this.withRunLock(event.projectRef, event.taskId, event.runId, () => {
      const filePath = this.filePathFor(event.projectRef, event.taskId, event.runId);
      const line = `${JSON.stringify(event)}\n`;
      if (existsSync(filePath)) {
        const existing = readFileSync(filePath, "utf8");
        writeFileSync(filePath, existing + line, "utf8");
      } else {
        writeFileSync(filePath, line, "utf8");
      }
    });
  }

  /**
   * Re-validates every persisted line by reapplying
   * `createEngineeringEventEnvelope`/`createDec138Provenance`'s own
   * constructor invariants, rather than trusting a blind `JSON.parse`
   * cast - a torn write, disk corruption, or hand-edited file can never
   * silently flow through as a well-typed event. Also re-confirms the
   * parsed event's own `(projectRef, taskId, runId)` matches the exact
   * identity this file is keyed by, failing closed on cross-run
   * contamination even though `filePathFor`'s own injective encoding
   * should make that structurally impossible.
   */
  getEvents(
    projectRef: string,
    taskId: TaskId,
    runId: RunId,
  ): ReadonlyArray<EngineeringEventEnvelope> {
    return this.withRunLock(projectRef, taskId, runId, () => {
      const filePath = this.filePathFor(projectRef, taskId, runId);
      if (!existsSync(filePath)) {
        return [];
      }
      const content = readFileSync(filePath, "utf8");
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch (cause) {
            throw new CorruptedEngineeringEventLineError(
              filePath,
              `line is not valid JSON (${(cause as Error).message})`,
            );
          }
          if (typeof parsed !== "object" || parsed === null) {
            throw new CorruptedEngineeringEventLineError(filePath, "line did not parse to an object");
          }
          const raw = parsed as Record<string, unknown>;
          if (typeof raw.provenance !== "object" || raw.provenance === null) {
            throw new CorruptedEngineeringEventLineError(filePath, "line's provenance is not an object");
          }
          let event: EngineeringEventEnvelope;
          try {
            const provenance = createDec138Provenance(
              raw.provenance as unknown as Parameters<typeof createDec138Provenance>[0],
            );
            event = createEngineeringEventEnvelope({
              ...raw,
              provenance,
            } as Parameters<typeof createEngineeringEventEnvelope>[0]);
          } catch (cause) {
            throw new CorruptedEngineeringEventLineError(
              filePath,
              `line failed envelope/provenance revalidation (${(cause as Error).message})`,
            );
          }
          if (event.projectRef !== projectRef || event.taskId !== taskId || event.runId !== runId) {
            throw new CorruptedEngineeringEventLineError(
              filePath,
              `line's own (projectRef, taskId, runId) does not match this file's identity - cross-run contamination`,
            );
          }
          return event;
        });
    });
  }

  getState(projectRef: string, taskId: TaskId, runId: RunId): EngineeringRunState | undefined {
    return reconstructState(this.getEvents(projectRef, taskId, runId));
  }
}
