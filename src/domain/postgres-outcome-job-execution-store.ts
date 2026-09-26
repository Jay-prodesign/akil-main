import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { OutcomeJob } from "./outcome-job.js";
import {
  validatePersistedOutcomeJobExecutionEventRecord,
  InvalidOutcomeJobExecutionEventError,
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

/**
 * Rev145 F2: delegates entirely to the shared
 * `validatePersistedOutcomeJobExecutionEventRecord` (same module
 * `durable-outcome-job-execution-store.ts` uses) rather than a parallel,
 * postgres-specific field-by-field re-implementation - full canonical
 * event-contract enforcement, exact five-field requested-scope correlation
 * (tenant AND customer AND project AND job AND run, not tenant alone), and
 * eventId-forgery detection (the record's own persisted `event_id` column
 * must exactly equal the canonical derivation from its own tuple - a
 * silently-recomputed eventId can never mask a raw column mismatch) all
 * live in exactly one place. The row's snake_case columns are transformed
 * into the shared validator's camelCase record shape first; its
 * `InvalidOutcomeJobExecutionEventError` is rewrapped as this store's own
 * `CorruptedOutcomeJobExecutionRowError` for API consistency.
 */
export function validatePersistedOutcomeJobExecutionRow(
  raw: RawOutcomeJobExecutionRow,
  expected: {
    tenantId: TenantScope["tenantId"];
    customerId: Customer["customerId"];
    projectId: Project["projectId"];
    jobId: OutcomeJob["jobId"];
    runId: string;
  },
): OutcomeJobExecutionEvent {
  const record = {
    eventId: raw.event_id,
    tenantId: raw.tenant_id,
    customerId: raw.customer_id,
    projectId: raw.project_id,
    jobId: raw.job_id,
    runId: raw.run_id,
    correlationId: raw.correlation_id,
    attempt: raw.attempt,
    sequence: raw.sequence,
    type: raw.type,
    occurredAt: raw.occurred_at,
    reason: raw.reason ?? undefined,
    progressRef: raw.progress_ref ?? undefined,
    checkpointRef: raw.checkpoint_ref ?? undefined,
    executorRef: raw.executor_ref ?? undefined,
  };
  try {
    return validatePersistedOutcomeJobExecutionEventRecord(record, expected);
  } catch (cause) {
    if (cause instanceof InvalidOutcomeJobExecutionEventError) {
      throw new CorruptedOutcomeJobExecutionRowError(cause.message);
    }
    throw cause;
  }
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

  /**
   * Rev145 F1: returns `true` only when THIS call durably created the row
   * (the `RETURNING` clause reports a row precisely when the `INSERT` was
   * not suppressed by the `ON CONFLICT ... DO NOTHING` unique-constraint
   * check) - a real atomic database-level claim, correct even under two
   * genuinely concurrent writers, not a read-then-write race in this class.
   */
  async appendEvent(event: OutcomeJobExecutionEvent): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO outcome_job_execution_events
         (tenant_id, customer_id, project_id, job_id, run_id, correlation_id, attempt, sequence, event_id, type, occurred_at, reason, progress_ref, checkpoint_ref, executor_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (tenant_id, event_id) DO NOTHING
       RETURNING event_id`,
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
    return result.rows.length > 0;
  }

  async getEvents(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): Promise<ReadonlyArray<OutcomeJobExecutionEvent>> {
    // Rev147 F8: ACCEPTED and an attempt's own ATTEMPT_STARTED deliberately
    // share the same (attempt, sequence) coordinate by convention (see
    // `deriveOutcomeJobExecutionEventId`'s own doc comment), so
    // `ORDER BY attempt, sequence` alone is not a total order - it leaves
    // equal-key rows in unspecified (physical/insertion-order-dependent)
    // order. A valid persisted run replayed with ATTEMPT_STARTED sorted
    // before its own ACCEPTED would make the reducer reject a genuinely
    // valid log at restart. This adds an explicit, semantic third sort key
    // - ACCEPTED always sorts before every other type - and a final
    // `event_id` tiebreaker for full determinism, so ordering never depends
    // on physical/insertion order at all.
    const result = await this.client.query<RawOutcomeJobExecutionRow>(
      `SELECT tenant_id, customer_id, project_id, job_id, run_id, correlation_id, attempt, sequence, event_id, type, occurred_at, reason, progress_ref, checkpoint_ref, executor_ref
       FROM outcome_job_execution_events
       WHERE tenant_id = $1 AND customer_id = $2 AND project_id = $3 AND job_id = $4 AND run_id = $5
       ORDER BY attempt ASC, sequence ASC, (CASE WHEN type = 'ACCEPTED' THEN 0 ELSE 1 END) ASC, event_id ASC`,
      [tenantId, customerId, projectId, jobId, runId],
    );
    return result.rows.map((row) =>
      validatePersistedOutcomeJobExecutionRow(row, { tenantId, customerId, projectId, jobId, runId }),
    );
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
