import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createEngineeringEventEnvelope,
  type EngineeringEventEnvelope,
  type TaskId,
  type RunId,
} from "./engineering-event-envelope.js";
import { createDec138Provenance } from "./dec-138-provenance.js";
import { reconstructState, type EngineeringRunState } from "./engineering-run-state.js";

export class CorruptedEngineeringEventLineError extends Error {
  constructor(filePath: string, lineNumber: number, reason: string) {
    super(`Corrupted durable engineering event line (${filePath}:${lineNumber}): ${reason}`);
    this.name = "CorruptedEngineeringEventLineError";
  }
}

export class InvalidDurableEngineeringStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableEngineeringStore operation: ${reason}`);
    this.name = "InvalidDurableEngineeringStoreError";
  }
}

function runKey(projectRef: string, taskId: TaskId, runId: RunId): string {
  return `${projectRef}::${taskId}::${runId}`;
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

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePathFor(projectRef: string, taskId: TaskId, runId: RunId): string {
    const safeKey = Buffer.from(runKey(projectRef, taskId, runId), "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  /**
   * AUD-DURABILITY-GAP: appends via a single OS-level `appendFileSync` call
   * (`O_APPEND`), never a read-full-file-then-rewrite-full-file cycle. The
   * previous read-modify-write shape was a genuine lost-update race - a
   * second writer's read of the "current" content, taken before the first
   * writer's rewrite lands, silently drops the first writer's line when the
   * second writer's rewrite completes. An OS-level append cannot lose
   * already-written bytes: every writer's line is positioned at the current
   * end-of-file by the kernel at write time, not computed from a stale
   * in-process read.
   */
  appendEvent(event: EngineeringEventEnvelope): void {
    const filePath = this.filePathFor(event.projectRef, event.taskId, event.runId);
    const line = `${JSON.stringify(event)}\n`;
    appendFileSync(filePath, line, "utf8");
  }

  /**
   * AUD-DURABILITY-GAP: replay no longer trusts `JSON.parse(line) as
   * EngineeringEventEnvelope` - a corrupted (partial write, disk error) or
   * forged (hand-edited/injected) line is re-run through
   * `createEngineeringEventEnvelope`/`createDec138Provenance`'s own
   * ingress validation and fails closed (throws) rather than silently
   * flowing a malformed record into the reducer.
   */
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
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new CorruptedEngineeringEventLineError(
          filePath,
          index + 1,
          `line is not valid JSON (${(cause as Error).message})`,
        );
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new CorruptedEngineeringEventLineError(filePath, index + 1, "line is not a JSON object");
      }
      const record = parsed as Record<string, unknown>;
      try {
        const provenance = createDec138Provenance(
          record.provenance as Parameters<typeof createDec138Provenance>[0],
        );
        return createEngineeringEventEnvelope({
          ...(record as Parameters<typeof createEngineeringEventEnvelope>[0]),
          provenance,
        });
      } catch (cause) {
        throw new CorruptedEngineeringEventLineError(
          filePath,
          index + 1,
          `line failed envelope/provenance validation (${(cause as Error).message})`,
        );
      }
    });
  }

  getState(projectRef: string, taskId: TaskId, runId: RunId): EngineeringRunState | undefined {
    return reconstructState(this.getEvents(projectRef, taskId, runId));
  }
}
