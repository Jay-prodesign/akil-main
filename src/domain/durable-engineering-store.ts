import { mkdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EngineeringEventEnvelope, TaskId, RunId } from "./engineering-event-envelope.js";
import { reconstructState, type EngineeringRunState } from "./engineering-run-state.js";

export class InvalidDurableEngineeringStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableEngineeringStore operation: ${reason}`);
    this.name = "InvalidDurableEngineeringStoreError";
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
   * Rev71 (repo-wide Rev66 audit closure) correction: the previous
   * "read whole file, concatenate, rewrite whole file" implementation was
   * not atomic across processes - two concurrent `appendEvent` calls for
   * the same run could both read the same current content, both compute
   * `existing + line`, and one's `writeFileSync` would silently discard
   * the other's event (a lost update), directly contradicting this
   * store's own documented invariant that "nothing is silently dropped at
   * the storage layer." A single `appendFileSync` call is one atomic
   * `write(2)` in append mode - Node/the OS handle file creation and the
   * append position, so no read-modify-write cycle (and therefore no lost
   * update) is possible, matching the same fix already applied to this
   * repository's other durable stores (`FileDurableOutcomeJobStore`,
   * `FileDurableExternalSaleBootstrapStore`).
   */
  appendEvent(event: EngineeringEventEnvelope): void {
    const filePath = this.filePathFor(event.projectRef, event.taskId, event.runId);
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
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
      .map((line) => JSON.parse(line) as EngineeringEventEnvelope);
  }

  getState(projectRef: string, taskId: TaskId, runId: RunId): EngineeringRunState | undefined {
    return reconstructState(this.getEvents(projectRef, taskId, runId));
  }
}
