import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { OutcomeJob } from "./outcome-job.js";
import {
  isRecognizedOutcomeJobExecutionEventType,
  type OutcomeJobExecutionEvent,
} from "./outcome-job-execution-event.js";
import { applyOutcomeJobExecutionEvent, type OutcomeJobExecutionRunState } from "./outcome-job-execution-run-state.js";
import type { AsyncOutcomeJobExecutionStore } from "../ports/async-outcome-job-execution-store.js";
import type { SqlClient } from "../ports/sql-client.js";

export class CorruptedOutcomeJobExecutionRowError extends Error {
  constructor(reason: string) {
    super(`Corrupted outcome_job_execution_events row: ${reason}`);
    this.name = "CorruptedOutcomeJobExecutionRowError";
  }
}

interface RawOutcomeJobExecutionRow {
  readonly tenant_id: unknown;
  readonly customer_id: unknown;
  readonly project_id: unknown;
  readonly job_id: unknown;
  readonly run_id: unknown;
  readonly correlation_id: unknown;
  readonly attempt: unknown;
  readonly sequence: unknown;
  readonly event_id: unknown;
  readonly type: unknown;
  readonly occurred_at: unknown;
  readonly reason: unknown;
  readonly progress_ref: unknown;
  readonly checkpoint_ref: unknown;
  readonly executor_ref: unknown;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CorruptedOutcomeJobExecutionRowError(`${field} must be a non-empty string, got: ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new CorruptedOutcomeJobExecutionRowError(`${field} must be a positive integer, got: ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, field);
}

/**
 * Fail-closed replay validation, matching this codebase's own established
 * convention (`validatePersistedOutcomeJobRow`,
 * `validatePersistedOutcomeJobExecutionEvent`): a driver-returned row is
 * never blindly cast as `OutcomeJobExecutionEvent` - every field is
 * revalidated, including tenant correspondence with the caller's own
 * expected tenant, before reconstructing the record.
 */
export function validatePersistedOutcomeJobExecutionRow(
  raw: RawOutcomeJobExecutionRow,
  expectedTenantId: TenantScope["tenantId"],
): OutcomeJobExecutionEvent {
  const tenantId = requireNonEmptyString(raw.tenant_id, "tenant_id");
  if (tenantId !== expectedTenantId) {
    throw new CorruptedOutcomeJobExecutionRowError(
      `row tenant_id "${tenantId}" does not match the expected tenant "${expectedTenantId}"`,
    );
  }
  const customerId = requireNonEmptyString(raw.customer_id, "customer_id");
  const projectId = requireNonEmptyString(raw.project_id, "project_id");
  const jobId = requireNonEmptyString(raw.job_id, "job_id");
  const runId = requireNonEmptyString(raw.run_id, "run_id");
  const correlationId = requireNonEmptyString(raw.correlation_id, "correlation_id");
  const attempt = requirePositiveInteger(raw.attempt, "attempt");
  const sequence = requirePositiveInteger(raw.sequence, "sequence");
  requireNonEmptyString(raw.event_id, "event_id");
  if (!isRecognizedOutcomeJobExecutionEventType(raw.type)) {
    throw new CorruptedOutcomeJobExecutionRowError(`unrecognized type: ${JSON.stringify(raw.type)}`);
  }
  const occurredAt = requireNonEmptyString(raw.occurred_at, "occurred_at");
  const reason = optionalNonEmptyString(raw.reason, "reason");
  const progressRef = optionalNonEmptyString(raw.progress_ref, "progress_ref");
  const checkpointRef = optionalNonEmptyString(raw.checkpoint_ref, "checkpoint_ref");
  const executorRef = optionalNonEmptyString(raw.executor_ref, "executor_ref");

  return {
    eventId: JSON.stringify([tenantId, customerId, projectId, jobId, runId, attempt, sequence, raw.type]),
    tenantId: tenantId as unknown as TenantScope["tenantId"],
    customerId: customerId as unknown as Customer["customerId"],
    projectId: projectId as unknown as Project["projectId"],
    jobId: jobId as unknown as OutcomeJob["jobId"],
    runId,
    correlationId,
    attempt,
    sequence,
    type: raw.type,
    occurredAt,
    ...(reason !== undefined ? { reason } : {}),
    ...(progressRef !== undefined ? { progressRef } : {}),
    ...(checkpointRef !== undefined ? { checkpointRef } : {}),
    ...(executorRef !== undefined ? { executorRef } : {}),
  };
}

/**
 * Network-backed implementation of `AsyncOutcomeJobExecutionStore`, mirroring
 * `PostgresOutcomeJobStore`'s own injected-`SqlClient` adapter-boundary
 * discipline - never imports a concrete driver package, fully testable with
 * a fake client, no live database required. `appendEvent` relies entirely on
 * the migration's own `UNIQUE (tenant_id, event_id)` constraint via
 * `ON CONFLICT ... DO NOTHING` as the actual duplicate-protection primitive -
 * correct even under two genuinely concurrent writers, since the database's
 * own constraint (not a read-then-write race in this class) is what prevents
 * two rows for the same event (Persistence Contract, Minimum Adversarial
 * Evidence #14). Keyed on `event_id` rather than the bare
 * (attempt, sequence) pair because ACCEPTED and an attempt's own
 * ATTEMPT_STARTED deliberately share the same (1, 1) coordinate by
 * convention - `event_id` (derived from the tuple INCLUDING `type`) is what
 * actually distinguishes them.
 */
export class PostgresOutcomeJobExecutionStore implements AsyncOutcomeJobExecutionStore {
  private readonly client: SqlClient;

  constructor(client: SqlClient) {
    this.client = client;
  }

  async appendEvent(event: OutcomeJobExecutionEvent): Promise<void> {
    await this.client.query(
      `INSERT INTO outcome_job_execution_events
         (tenant_id, customer_id, project_id, job_id, run_id, correlation_id, attempt, sequence, event_id, type, occurred_at, reason, progress_ref, checkpoint_ref, executor_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [
        event.tenantId,
        event.customerId,
        event.projectId,
        event.jobId,
        event.runId,
        event.correlationId,
        event.attempt,
        event.sequence,
        event.eventId,
        event.type,
        event.occurredAt,
        event.reason ?? null,
        event.progressRef ?? null,
        event.checkpointRef ?? null,
        event.executorRef ?? null,
      ],
    );
  }

  async getEvents(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): Promise<ReadonlyArray<OutcomeJobExecutionEvent>> {
    const result = await this.client.query<RawOutcomeJobExecutionRow>(
      `SELECT tenant_id, customer_id, project_id, job_id, run_id, correlation_id, attempt, sequence, event_id, type, occurred_at, reason, progress_ref, checkpoint_ref, executor_ref
       FROM outcome_job_execution_events
       WHERE tenant_id = $1 AND customer_id = $2 AND project_id = $3 AND job_id = $4 AND run_id = $5
       ORDER BY attempt ASC, sequence ASC`,
      [tenantId, customerId, projectId, jobId, runId],
    );
    return result.rows.map((row) => validatePersistedOutcomeJobExecutionRow(row, tenantId));
  }

  async getState(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): Promise<OutcomeJobExecutionRunState | undefined> {
    const events = await this.getEvents(tenantId, customerId, projectId, jobId, runId);
    let state: OutcomeJobExecutionRunState | undefined;
    for (const event of events) {
      state = applyOutcomeJobExecutionEvent(state, event);
    }
    return state;
  }
}
