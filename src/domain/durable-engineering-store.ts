import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EngineeringEventEnvelope, TaskId, RunId } from "./engineering-event-envelope.js";
import { reconstructState, type EngineeringRunState } from "./engineering-run-state.js";

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

  appendEvent(event: EngineeringEventEnvelope): void {
    const filePath = this.filePathFor(event.projectRef, event.taskId, event.runId);
    const line = `${JSON.stringify(event)}\n`;
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf8");
      writeFileSync(filePath, existing + line, "utf8");
    } else {
      writeFileSync(filePath, line, "utf8");
    }
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
