import { mkdirSync, readFileSync, writeFileSync, existsSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createEngineeringEventEnvelope, type EngineeringEventEnvelope, type TaskId, type RunId } from "./engineering-event-envelope.js";
import { createDec138Provenance } from "./dec-138-provenance.js";
import { reconstructState, type EngineeringRunState } from "./engineering-run-state.js";

export class InvalidDurableEngineeringStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableEngineeringStore operation: ${reason}`);
    this.name = "InvalidDurableEngineeringStoreError";
  }
}

export class CorruptedEngineeringEventLineError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable engineering-event line (${filePath}): ${reason}`);
    this.name = "CorruptedEngineeringEventLineError";
  }
}

export class EngineeringStoreLockTimeoutError extends Error {
  constructor(runKeyDescription: string) {
    super(`Timed out waiting for the durable engineering-store lock for run ${runKeyDescription}`);
    this.name = "EngineeringStoreLockTimeoutError";
  }
}

/**
 * AUD-DURABILITY-GAP-V2 F2: persisted state is an external/untrusted
 * boundary on replay, exactly like every other durable store in this
 * repository that already revalidates on read
 * (`validatePersistedConnectorConnection`, `validatePersistedOutcomeJobLine`,
 * `validatePersistedPlanAdmissionEvent`). Before this correction,
 * `FileDurableEngineeringStore.getEvents` blindly `JSON.parse`-cast every
 * line as `EngineeringEventEnvelope` - a corrupted or forged line (wrong
 * identity tuple, invalid role/eventType, missing provenance) would flow
 * straight into the reducer. This re-runs the exact same constructor
 * invariants `createEngineeringEventEnvelope`/`createDec138Provenance`
 * already enforce at creation time (the "reapply constructor invariants on
 * replay" pattern - Rev183 F4), plus an identity-scope check that the
 * persisted event's own projectRef/taskId/runId exactly match the tuple
 * `getEvents` was actually asked for. Every failure throws
 * `CorruptedEngineeringEventLineError` (fail-closed) rather than silently
 * dropping or coercing a bad line.
 */
function validatePersistedEngineeringEvent(
  raw: unknown,
  expected: { projectRef: string; taskId: TaskId; runId: RunId },
  filePath: string,
): EngineeringEventEnvelope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CorruptedEngineeringEventLineError(filePath, "line must be a JSON object, not an array or primitive");
  }
  const record = raw as Record<string, unknown>;
  const rawProvenance = record["provenance"];
  if (typeof rawProvenance !== "object" || rawProvenance === null || Array.isArray(rawProvenance)) {
    throw new CorruptedEngineeringEventLineError(filePath, "provenance must be a JSON object");
  }
  let envelope: EngineeringEventEnvelope;
  try {
    const provenance = createDec138Provenance(rawProvenance as never);
    envelope = createEngineeringEventEnvelope({ ...record, provenance } as never);
  } catch (cause) {
    throw new CorruptedEngineeringEventLineError(filePath, (cause as Error).message);
  }
  if (
    envelope.projectRef !== expected.projectRef ||
    envelope.taskId !== expected.taskId ||
    envelope.runId !== expected.runId
  ) {
    throw new CorruptedEngineeringEventLineError(
      filePath,
      `record's own projectRef/taskId/runId ("${envelope.projectRef}"/"${envelope.taskId}"/"${envelope.runId}") does not match the requested run ("${expected.projectRef}"/"${expected.taskId}"/"${expected.runId}") - cross-run contamination`,
    );
  }
  return envelope;
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
 * `node:fs` - no new runtime dependency, no Google Drive, no queue/broker
 * (E15). One append-only JSON-lines file per run under `baseDir`, keyed
 * by project/task/runId; `getState` reads the full file and replays it
 * through the pure reducer in true on-disk append order every time,
 * proving restart-safety by construction (there is no separate in-memory
 * cache that could diverge from disk).
 */
export class FileDurableEngineeringStore implements DurableEngineeringStore {
  private readonly baseDir: string;
  private static readonly LOCK_TIMEOUT_MS = 5000;
  private static readonly LOCK_RETRY_BACKOFF_MS = 5;

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
   * AUD-DURABILITY-GAP-V2 F1: real cross-process mutual exclusion for
   * `appendEvent`'s read-modify-write critical section, reusing the exact
   * `linkSync` atomic-creation primitive already accepted for
   * `FileDurableConnectorConnectionStore.save` and
   * `FileDurableOutcomeJobStore.putIfAbsent`. Before this correction, two
   * concurrent writers (e.g. a WORKER and a BRAIN process appending to the
   * same run) could both read the same prior file content and one could
   * silently clobber the other's appended event - the exact
   * `AUD-DURABILITY-GAP` finding class for this store.
   */
  private withRunLock<T>(projectRef: string, taskId: TaskId, runId: RunId, criticalSection: () => T): T {
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
        if (Date.now() > deadline) {
          try {
            unlinkSync(tmpPath);
          } catch {
            // best-effort cleanup only
          }
          throw new EngineeringStoreLockTimeoutError(`"${projectRef}"/"${taskId}"/"${runId}"`);
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
        // best-effort: a stuck lock is bounded for the next acquirer by
        // the caller-visible timeout above, rather than deadlocking forever.
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

  getEvents(
    projectRef: string,
    taskId: TaskId,
    runId: RunId,
  ): ReadonlyArray<EngineeringEventEnvelope> {
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
          throw new CorruptedEngineeringEventLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
        }
        return validatePersistedEngineeringEvent(parsed, { projectRef, taskId, runId }, filePath);
      });
  }

  getState(projectRef: string, taskId: TaskId, runId: RunId): EngineeringRunState | undefined {
    return reconstructState(this.getEvents(projectRef, taskId, runId));
  }
}
