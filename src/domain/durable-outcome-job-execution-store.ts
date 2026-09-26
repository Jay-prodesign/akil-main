import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { OutcomeJob } from "./outcome-job.js";
import {
  validatePersistedOutcomeJobExecutionEventRecord,
  InvalidOutcomeJobExecutionEventError,
  type OutcomeJobExecutionEvent,
} from "./outcome-job-execution-event.js";
import {
  applyOutcomeJobExecutionEvent,
  type OutcomeJobExecutionRunState,
} from "./outcome-job-execution-run-state.js";

export class CorruptedOutcomeJobExecutionEventError extends Error {
  constructor(reason: string) {
    super(`Corrupted persisted OutcomeJob execution event: ${reason}`);
    this.name = "CorruptedOutcomeJobExecutionEventError";
  }
}

/**
 * Rev145 F2: untrusted-replay-boundary validation is delegated entirely to
 * the shared `validatePersistedOutcomeJobExecutionEventRecord` (same module
 * `postgres-outcome-job-execution-store.ts` uses) - full canonical
 * event-contract enforcement (type-scoped field rules, valid timestamp),
 * exact five-field requested-scope correlation, and eventId-forgery
 * detection all live in exactly one place, never duplicated/drifted per
 * store. Its `InvalidOutcomeJobExecutionEventError` is rewrapped as this
 * store's own `CorruptedOutcomeJobExecutionEventError` for API consistency.
 * Logical corruption that is shape-valid but semantically illegal (an
 * out-of-sequence attempt, a result before acceptance) is caught separately
 * by `applyOutcomeJobExecutionEvent` itself, which this store's `getState`
 * always replays through (Package Contract C).
 */
function validatePersistedLine(
  raw: unknown,
  expected: {
    tenantId: TenantScope["tenantId"];
    customerId: Customer["customerId"];
    projectId: Project["projectId"];
    jobId: OutcomeJob["jobId"];
    runId: string;
  },
): OutcomeJobExecutionEvent {
  try {
    return validatePersistedOutcomeJobExecutionEventRecord(raw, expected);
  } catch (cause) {
    if (cause instanceof InvalidOutcomeJobExecutionEventError) {
      throw new CorruptedOutcomeJobExecutionEventError(cause.message);
    }
    throw cause;
  }
}

/**
 * Rev44 F2 / Rev143 F1 collision-safety discipline: the durable store's own
 * per-run file key must be injective over the full identity tuple, exactly
 * like `durable-plan-admission-store.ts`'s `planKey`.
 */
function executionRunKey(
  tenantId: TenantScope["tenantId"],
  customerId: Customer["customerId"],
  projectId: Project["projectId"],
  jobId: OutcomeJob["jobId"],
  runId: string,
): string {
  return JSON.stringify([tenantId, customerId, projectId, jobId, runId]);
}

export interface DurableOutcomeJobExecutionStore {
  /**
   * Rev145 F1: returns `true` only when THIS call durably created the event
   * (first writer for this exact `eventId`); `false` when an identical event
   * already existed. Callers that must ensure single-authority side effects
   * (e.g. "invoke the worker for this attempt") gate that effect on this
   * return value, not merely on "no prior state existed" from an earlier,
   * possibly-stale read.
   */
  appendEvent(event: OutcomeJobExecutionEvent): boolean;
  getEvents(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): ReadonlyArray<OutcomeJobExecutionEvent>;
  getState(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): OutcomeJobExecutionRunState | undefined;
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs` (no new runtime dependency), one append-only JSON-lines file per
 * run under `baseDir` - mirrors `FileDurablePlanAdmissionStore` exactly.
 * `getState` always reads the full file and replays it through the pure
 * reducer, proving restart-safety by construction: a fresh store instance
 * over the same `baseDir` reconstructs the identical run state.
 */
export class FileDurableOutcomeJobExecutionStore implements DurableOutcomeJobExecutionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePathFor(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): string {
    const safeKey = Buffer.from(
      executionRunKey(tenantId, customerId, projectId, jobId, runId),
      "utf8",
    ).toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  appendEvent(event: OutcomeJobExecutionEvent): boolean {
    const existingEvents = this.getEvents(
      event.tenantId,
      event.customerId,
      event.projectId,
      event.jobId,
      event.runId,
    );
    if (existingEvents.some((existing) => existing.eventId === event.eventId)) {
      return false;
    }
    const filePath = this.filePathFor(event.tenantId, event.customerId, event.projectId, event.jobId, event.runId);
    const line = `${JSON.stringify(event)}\n`;
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf8");
      writeFileSync(filePath, existing + line, "utf8");
    } else {
      writeFileSync(filePath, line, "utf8");
    }
    return true;
  }

  getEvents(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): ReadonlyArray<OutcomeJobExecutionEvent> {
    const filePath = this.filePathFor(tenantId, customerId, projectId, jobId, runId);
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
          throw new CorruptedOutcomeJobExecutionEventError(`line is not valid JSON (${(cause as Error).message})`);
        }
        return validatePersistedLine(parsed, { tenantId, customerId, projectId, jobId, runId });
      });
  }

  getState(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): OutcomeJobExecutionRunState | undefined {
    let state: OutcomeJobExecutionRunState | undefined;
    for (const event of this.getEvents(tenantId, customerId, projectId, jobId, runId)) {
      state = applyOutcomeJobExecutionEvent(state, event);
    }
    return state;
  }
}

/**
 * Idempotent append: appending the identical event twice (same `eventId`,
 * derived from the same identity tuple) is durably safe because the
 * reducer's own replay-time dedup makes the second copy inert - this
 * helper exists only so callers do not need to special-case "did this
 * event already happen" before appending (Minimum Adversarial Evidence #3,
 * #9).
 */
export function appendOutcomeJobExecutionEventIdempotently(
  store: DurableOutcomeJobExecutionStore,
  event: OutcomeJobExecutionEvent,
): OutcomeJobExecutionRunState {
  store.appendEvent(event);
  const state = store.getState(event.tenantId, event.customerId, event.projectId, event.jobId, event.runId);
  if (state === undefined) {
    throw new CorruptedOutcomeJobExecutionEventError("internal error: state missing immediately after appendEvent");
  }
  return state;
}
