import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { OutcomeJob } from "./outcome-job.js";

export class InvalidOutcomeJobExecutionEventError extends Error {
  constructor(reason: string) {
    super(`Invalid OutcomeJob execution event: ${reason}`);
    this.name = "InvalidOutcomeJobExecutionEventError";
  }
}

/**
 * OS-V0-05: the durable execution-run/event vocabulary the existing
 * OutcomeJob business lifecycle (`outcome-job.ts`) does not itself carry -
 * `EXECUTING`/`VERIFYING` are coarse business states with no room for
 * run/attempt/progress/checkpoint truth. `ACCEPTED` is run-level (recorded
 * once, before anything is in-flight - Package Contract B); `ATTEMPT_STARTED`
 * begins one attempt; `PROGRESS`/`CHECKPOINT` report ongoing truth for the
 * current attempt; every other value closes an attempt. `SUCCEEDED` here is
 * execution-runtime truth only - it never itself authorizes OutcomeJob
 * VERIFIED (Package Contract F; see `outcome-job-execution-runtime.ts`).
 */
export type OutcomeJobExecutionEventType =
  | "ACCEPTED"
  | "ATTEMPT_STARTED"
  | "PROGRESS"
  | "CHECKPOINT"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "STALLED"
  | "DEGRADED"
  | "BLOCKED"
  | "UNKNOWN"
  | "UNSUPPORTED";

export const RECOGNIZED_OUTCOME_JOB_EXECUTION_EVENT_TYPES: ReadonlySet<OutcomeJobExecutionEventType> = new Set([
  "ACCEPTED",
  "ATTEMPT_STARTED",
  "PROGRESS",
  "CHECKPOINT",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "STALLED",
  "DEGRADED",
  "BLOCKED",
  "UNKNOWN",
  "UNSUPPORTED",
]);

/**
 * Attempt-closing types that describe *why* rather than merely *that* -
 * `reason` is mandatory on these (never on ACCEPTED/ATTEMPT_STARTED/
 * PROGRESS/CHECKPOINT/SUCCEEDED, which need no explanatory text).
 */
const REASON_REQUIRED_TYPES: ReadonlySet<OutcomeJobExecutionEventType> = new Set([
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "STALLED",
  "DEGRADED",
  "BLOCKED",
  "UNKNOWN",
  "UNSUPPORTED",
]);

export function isRecognizedOutcomeJobExecutionEventType(value: unknown): value is OutcomeJobExecutionEventType {
  return (
    typeof value === "string" &&
    RECOGNIZED_OUTCOME_JOB_EXECUTION_EVENT_TYPES.has(value as OutcomeJobExecutionEventType)
  );
}

/**
 * Rev44 F2 / Rev143 F1 collision-safety discipline: `eventId` is never a
 * caller-supplied string. It is derived deterministically from the exact
 * identity tuple that must uniquely address one event slot -
 * (tenantId, customerId, projectId, jobId, runId, attempt, sequence, type) -
 * using `JSON.stringify` of the tuple as an array, which is injective
 * (JSON string escaping means two distinct tuples can never serialize to
 * the same string). `type` is included because `ACCEPTED` (run-level) and
 * an attempt's own `ATTEMPT_STARTED` deliberately share the same
 * (attempt: 1, sequence: 1) coordinate by convention - without `type` in
 * the tuple those two structurally distinct events would collide onto one
 * eventId and the second would be silently deduped away as a false
 * "duplicate" of the first. This makes retrying "record this event"
 * structurally idempotent: the same logical event always derives the same
 * eventId, with no caller-side idempotency-key bookkeeping required
 * (Minimum Adversarial Evidence #1, #3, #9).
 */
export function deriveOutcomeJobExecutionEventId(input: {
  tenantId: TenantScope["tenantId"];
  customerId: Customer["customerId"];
  projectId: Project["projectId"];
  jobId: OutcomeJob["jobId"];
  runId: string;
  attempt: number;
  sequence: number;
  type: OutcomeJobExecutionEventType;
}): string {
  return JSON.stringify([
    input.tenantId,
    input.customerId,
    input.projectId,
    input.jobId,
    input.runId,
    input.attempt,
    input.sequence,
    input.type,
  ]);
}

export interface OutcomeJobExecutionEvent {
  readonly eventId: string;
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly runId: string;
  readonly correlationId: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly type: OutcomeJobExecutionEventType;
  readonly occurredAt: string;
  readonly reason?: string;
  readonly progressRef?: string;
  readonly checkpointRef?: string;
  readonly executorRef?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidOutcomeJobExecutionEventError(`${field} must be a string`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new InvalidOutcomeJobExecutionEventError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidOutcomeJobExecutionEventError(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

function requireOptionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, field);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InvalidOutcomeJobExecutionEventError(`${field} must be a positive integer`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(raw))) {
    throw new InvalidOutcomeJobExecutionEventError(`${field} must be a valid ISO timestamp`);
  }
  return raw;
}

/**
 * Constructs and fully validates one execution event. `job` must belong to
 * the given `tenantScope`/`customer`/`project` (same structural check
 * `createOutcomeJob` itself already applies) - this function never trusts a
 * caller-asserted tenant/customer/project/job tuple independent of a real
 * `OutcomeJob` record.
 */
export function createOutcomeJobExecutionEvent(input: {
  tenantScope: TenantScope;
  customer: Customer;
  project: Project;
  job: OutcomeJob;
  runId: unknown;
  correlationId: unknown;
  attempt: unknown;
  sequence: unknown;
  type: unknown;
  occurredAt: unknown;
  reason?: unknown;
  progressRef?: unknown;
  checkpointRef?: unknown;
  executorRef?: unknown;
}): OutcomeJobExecutionEvent {
  if (input.customer.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidOutcomeJobExecutionEventError("customer does not belong to the given tenantScope");
  }
  if (input.project.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidOutcomeJobExecutionEventError("project does not belong to the given tenantScope");
  }
  if (input.project.customerId !== input.customer.customerId) {
    throw new InvalidOutcomeJobExecutionEventError("project does not belong to the given customer");
  }
  if (
    input.job.tenantId !== input.tenantScope.tenantId ||
    input.job.customerId !== input.customer.customerId ||
    input.job.projectId !== input.project.projectId
  ) {
    throw new InvalidOutcomeJobExecutionEventError("job does not belong to the given tenantScope/customer/project");
  }

  const runId = requireNonEmptyString(input.runId, "runId");
  const correlationId = requireNonEmptyString(input.correlationId, "correlationId");
  const attempt = requirePositiveInteger(input.attempt, "attempt");
  const sequence = requirePositiveInteger(input.sequence, "sequence");
  if (!isRecognizedOutcomeJobExecutionEventType(input.type)) {
    throw new InvalidOutcomeJobExecutionEventError(
      `type must be one of ${Array.from(RECOGNIZED_OUTCOME_JOB_EXECUTION_EVENT_TYPES).join(", ")}`,
    );
  }
  const type = input.type;
  const occurredAt = requireValidTimestamp(input.occurredAt, "occurredAt");

  let reason: string | undefined;
  if (REASON_REQUIRED_TYPES.has(type)) {
    reason = requireNonEmptyString(input.reason, "reason");
  } else if (input.reason !== undefined) {
    throw new InvalidOutcomeJobExecutionEventError(`reason must not be supplied for event type ${type}`);
  }

  let progressRef: string | undefined;
  if (type === "PROGRESS") {
    progressRef = requireOptionalNonEmptyString(input.progressRef, "progressRef");
  } else if (input.progressRef !== undefined) {
    throw new InvalidOutcomeJobExecutionEventError(`progressRef must not be supplied for event type ${type}`);
  }

  let checkpointRef: string | undefined;
  if (type === "CHECKPOINT") {
    checkpointRef = requireNonEmptyString(input.checkpointRef, "checkpointRef");
  } else if (input.checkpointRef !== undefined) {
    throw new InvalidOutcomeJobExecutionEventError(`checkpointRef must not be supplied for event type ${type}`);
  }

  const executorRef = requireOptionalNonEmptyString(input.executorRef, "executorRef");

  const eventId = deriveOutcomeJobExecutionEventId({
    tenantId: input.tenantScope.tenantId,
    customerId: input.customer.customerId,
    projectId: input.project.projectId,
    jobId: input.job.jobId,
    runId,
    attempt,
    sequence,
    type,
  });

  return {
    eventId,
    tenantId: input.tenantScope.tenantId,
    customerId: input.customer.customerId,
    projectId: input.project.projectId,
    jobId: input.job.jobId,
    runId,
    correlationId,
    attempt,
    sequence,
    type,
    occurredAt,
    ...(reason !== undefined ? { reason } : {}),
    ...(progressRef !== undefined ? { progressRef } : {}),
    ...(checkpointRef !== undefined ? { checkpointRef } : {}),
    ...(executorRef !== undefined ? { executorRef } : {}),
  };
}
