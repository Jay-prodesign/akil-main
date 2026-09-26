import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { OutcomeJob } from "./outcome-job.js";
import {
  isRecognizedOutcomeJobExecutionEventType,
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

function requireNonEmptyStringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new CorruptedOutcomeJobExecutionEventError(
      `${field} must be a non-empty string with no leading/trailing whitespace, got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requirePositiveIntegerField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new CorruptedOutcomeJobExecutionEventError(
      `${field} must be a positive integer, got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireOptionalNonEmptyStringField(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyStringField(value, field);
}

/**
 * Untrusted-replay-boundary validator, matching this repository's own
 * established convention (`validatePersistedPlanAdmissionEvent`,
 * `validatePersistedOutcomeJobRow`): every persisted line is revalidated
 * against the exact scope the caller asked for before it is ever handed to
 * the reducer. Structural/shape corruption is caught here
 * (`CorruptedOutcomeJobExecutionEventError`); logical corruption that is
 * shape-valid but semantically illegal (an out-of-sequence attempt, a
 * result before acceptance) is caught by `applyOutcomeJobExecutionEvent`
 * itself, which this store's `getState` always replays through - so
 * corrupted persisted logic fails exactly the same way a corrupted live
 * event stream would (Package Contract C).
 */
function validatePersistedOutcomeJobExecutionEvent(
  raw: unknown,
  expected: {
    tenantId: TenantScope["tenantId"];
    customerId: Customer["customerId"];
    projectId: Project["projectId"];
    jobId: OutcomeJob["jobId"];
    runId: string;
  },
): OutcomeJobExecutionEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CorruptedOutcomeJobExecutionEventError("persisted event must be a JSON object, not an array or primitive");
  }
  const candidate = raw as Record<string, unknown>;

  const eventId = requireNonEmptyStringField(candidate.eventId, "eventId");
  const tenantId = requireNonEmptyStringField(candidate.tenantId, "tenantId");
  const customerId = requireNonEmptyStringField(candidate.customerId, "customerId");
  const projectId = requireNonEmptyStringField(candidate.projectId, "projectId");
  const jobId = requireNonEmptyStringField(candidate.jobId, "jobId");
  const runId = requireNonEmptyStringField(candidate.runId, "runId");
  const correlationId = requireNonEmptyStringField(candidate.correlationId, "correlationId");
  const attempt = requirePositiveIntegerField(candidate.attempt, "attempt");
  const sequence = requirePositiveIntegerField(candidate.sequence, "sequence");
  requireNonEmptyStringField(candidate.occurredAt, "occurredAt");

  const scopeMismatch =
    tenantId !== expected.tenantId ||
    customerId !== expected.customerId ||
    projectId !== expected.projectId ||
    jobId !== expected.jobId ||
    runId !== expected.runId;
  if (scopeMismatch) {
    throw new CorruptedOutcomeJobExecutionEventError(
      `persisted event tenant/customer/project/job/run does not match the requested scope - cross-scope contamination`,
    );
  }

  if (!isRecognizedOutcomeJobExecutionEventType(candidate.type)) {
    throw new CorruptedOutcomeJobExecutionEventError(
      `unrecognized persisted event type: ${JSON.stringify(candidate.type)}`,
    );
  }

  const reason = requireOptionalNonEmptyStringField(candidate.reason, "reason");
  const progressRef = requireOptionalNonEmptyStringField(candidate.progressRef, "progressRef");
  const checkpointRef = requireOptionalNonEmptyStringField(candidate.checkpointRef, "checkpointRef");
  const executorRef = requireOptionalNonEmptyStringField(candidate.executorRef, "executorRef");

  return {
    eventId,
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as unknown as Customer["customerId"],
    projectId: projectId as unknown as Project["projectId"],
    jobId: jobId as unknown as OutcomeJob["jobId"],
    runId,
    correlationId,
    attempt,
    sequence,
    type: candidate.type,
    occurredAt: candidate.occurredAt as string,
    ...(reason !== undefined ? { reason } : {}),
    ...(progressRef !== undefined ? { progressRef } : {}),
    ...(checkpointRef !== undefined ? { checkpointRef } : {}),
    ...(executorRef !== undefined ? { executorRef } : {}),
  };
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
  appendEvent(event: OutcomeJobExecutionEvent): void;
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

  appendEvent(event: OutcomeJobExecutionEvent): void {
    const filePath = this.filePathFor(event.tenantId, event.customerId, event.projectId, event.jobId, event.runId);
    const line = `${JSON.stringify(event)}\n`;
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf8");
      writeFileSync(filePath, existing + line, "utf8");
    } else {
      writeFileSync(filePath, line, "utf8");
    }
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
        return validatePersistedOutcomeJobExecutionEvent(parsed, { tenantId, customerId, projectId, jobId, runId });
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
