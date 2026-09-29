import {
  admitQuotaReservation,
  commitQuotaUsage,
  releaseQuotaReservation,
  projectQuotaReadModel,
  validatePersistedQuotaReservationEvent,
  quotaScopeKey,
  type QuotaAdmissionScope,
  type QuotaEnvelope,
  type QuotaReservationIdentity,
  type QuotaLedger,
  type QuotaReservationEvent,
  type QuotaAdmissionOutcome,
  type QuotaCommitOutcome,
  type QuotaReleaseOutcome,
  type QuotaReadModel,
  InvalidQuotaAdmissionError,
} from "./execution-quota-admission.js";
import type { AsyncQuotaReservationStore } from "../ports/async-quota-reservation-store.js";
import type { SqlClient } from "../ports/sql-client.js";

export class CorruptedQuotaReservationRowError extends Error {
  constructor(reason: string) {
    super(`Corrupted quota_reservation_events row: ${reason}`);
    this.name = "CorruptedQuotaReservationRowError";
  }
}

interface RawQuotaReservationRow {
  readonly tenant_id: unknown;
  readonly event_id: unknown;
  readonly scope_key: unknown;
  readonly customer_id: unknown;
  readonly project_id: unknown;
  readonly plan_id: unknown;
  readonly plan_version: unknown;
  readonly job_id: unknown;
  readonly run_id: unknown;
  readonly attempt_ref: unknown;
  readonly idempotency_key: unknown;
  readonly envelope_ref: unknown;
  readonly type: unknown;
  readonly occurred_at: unknown;
  readonly amount_minor_units: unknown;
  readonly amount_presence: unknown;
  readonly currency: unknown;
  readonly reason: unknown;
  readonly worker_ref: unknown;
  readonly provider_ref: unknown;
  readonly model_ref: unknown;
  readonly route_ref: unknown;
}

function rowToRecord(row: RawQuotaReservationRow, expectedScope: QuotaAdmissionScope): QuotaReservationEvent {
  const amount =
    row.amount_presence === null || row.amount_presence === undefined
      ? undefined
      : { presence: row.amount_presence, amountMinorUnits: row.amount_minor_units ?? undefined, currency: row.currency ?? undefined };
  const attribution =
    row.worker_ref === null && row.provider_ref === null && row.model_ref === null && row.route_ref === null
      ? undefined
      : {
          workerRef: row.worker_ref ?? undefined,
          providerRef: row.provider_ref ?? undefined,
          modelRef: row.model_ref ?? undefined,
          routeRef: row.route_ref ?? undefined,
        };
  const record = {
    eventId: row.event_id,
    identity: {
      scope: {
        tenantId: row.tenant_id,
        customerId: row.customer_id,
        projectId: row.project_id,
        planId: row.plan_id,
        planVersion: row.plan_version,
      },
      jobId: row.job_id,
      runId: row.run_id,
      attemptRef: row.attempt_ref,
    },
    idempotencyKey: row.idempotency_key,
    envelopeRef: row.envelope_ref,
    type: row.type,
    occurredAt: row.occurred_at,
    amount,
    reason: row.reason ?? undefined,
    attribution,
  };
  try {
    return validatePersistedQuotaReservationEvent(record, expectedScope);
  } catch (cause) {
    if (cause instanceof InvalidQuotaAdmissionError) {
      throw new CorruptedQuotaReservationRowError(cause.message);
    }
    throw cause;
  }
}

/**
 * Network-backed sibling of `FileDurableQuotaReservationStore`, mirroring
 * `PostgresOutcomeJobExecutionStore`'s own injected-`SqlClient`
 * adapter-boundary discipline - never imports a concrete driver package,
 * fully testable with a fake, no live database required.
 *
 * `admit()` is the one operation with genuine SHARED-RESOURCE contention
 * (two different idempotency keys in the same scope competing for the same
 * remaining allowance), so it is the only operation that issues a single,
 * `pg_advisory_xact_lock`-guarded atomic SQL statement deciding
 * RESERVED/REJECTED itself - the minimal `SqlClient` port has no explicit
 * transaction control, but Postgres already wraps one top-level statement
 * in its own implicit transaction for that statement's own duration, which
 * is exactly the window the advisory lock needs to hold. `commit()`/
 * `release()` have no such shared-resource contention (each only ever
 * touches the ONE reservation its own idempotencyKey names), so they reuse
 * the pure `commitQuotaUsage`/`releaseQuotaReservation` reducers directly
 * against a small SELECT, and rely on the same `UNIQUE (tenant_id,
 * event_id)` + `ON CONFLICT ... DO NOTHING` + retry-on-loss pattern
 * `PostgresOutcomeJobExecutionStore`/`outcome-job-execution-runtime.ts`'s
 * own `appendAndGetState` already establish for single-record races.
 */
export class PostgresQuotaReservationStore implements AsyncQuotaReservationStore {
  private readonly client: SqlClient;

  constructor(client: SqlClient) {
    this.client = client;
  }

  async admit(input: {
    readonly envelope: QuotaEnvelope;
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
    readonly requestedAmount: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
    readonly occurredAt: unknown;
  }): Promise<QuotaAdmissionOutcome> {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
      throw new InvalidQuotaAdmissionError("idempotencyKey must be a non-empty string");
    }
    if (typeof input.occurredAt !== "string" || Number.isNaN(Date.parse(input.occurredAt))) {
      throw new InvalidQuotaAdmissionError("occurredAt must be a valid ISO timestamp");
    }
    const scope = input.envelope.scope;
    if (
      input.identity.scope.tenantId !== scope.tenantId ||
      input.identity.scope.customerId !== scope.customerId ||
      input.identity.scope.projectId !== scope.projectId ||
      input.identity.scope.planId !== scope.planId ||
      input.identity.scope.planVersion !== scope.planVersion
    ) {
      throw new InvalidQuotaAdmissionError("reservation identity's scope does not exactly match the given envelope's scope");
    }
    const presence = (input.requestedAmount as { presence?: unknown }).presence;
    if (presence !== "REPORTED" && presence !== "UNKNOWN") {
      throw new InvalidQuotaAdmissionError('requestedAmount.presence must be "REPORTED" or "UNKNOWN"');
    }
    const amountMinorUnits = presence === "REPORTED" ? (input.requestedAmount as { amountMinorUnits?: unknown }).amountMinorUnits : 0;
    const currency = presence === "REPORTED" ? (input.requestedAmount as { currency?: unknown }).currency : null;
    if (presence === "REPORTED" && currency !== input.envelope.limit.currency) {
      throw new InvalidQuotaAdmissionError(
        `requestedAmount currency "${String(currency)}" does not match envelope limit currency "${input.envelope.limit.currency}"`,
      );
    }
    const scopeKey = quotaScopeKey(scope);
    const result = await this.client.query<RawQuotaReservationRow>(
      `WITH scope_lock AS (
         SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2)) AS locked
       ),
       already_existing AS (
         SELECT e.* FROM quota_reservation_events e, scope_lock
         WHERE e.tenant_id = $1 AND e.idempotency_key = $10 AND e.type IN ('RESERVED', 'REJECTED')
       ),
       current_usage AS (
         SELECT COALESCE(SUM(e.amount_minor_units), 0) AS total
         FROM quota_reservation_events e, scope_lock
         WHERE e.tenant_id = $1 AND e.scope_key = $2 AND e.type IN ('RESERVED', 'COMMITTED', 'RECONCILIATION_REQUIRED')
       ),
       decision AS (
         SELECT
           CASE
             WHEN EXISTS (SELECT 1 FROM already_existing) THEN NULL
             WHEN $12 = 'UNKNOWN' THEN 'REJECTED'
             WHEN (SELECT total FROM current_usage) + $13::bigint <= $14::bigint THEN 'RESERVED'
             ELSE 'REJECTED'
           END AS decided_type,
           CASE
             WHEN $12 = 'UNKNOWN' THEN 'an UNKNOWN estimated cost cannot be admitted against a monetary ceiling - it is never treated as zero'
             WHEN (SELECT total FROM current_usage) + $13::bigint > $14::bigint THEN 'insufficient allowance remaining under the current envelope limit'
             ELSE NULL
           END AS decided_reason
       ),
       inserted AS (
         INSERT INTO quota_reservation_events
           (tenant_id, event_id, scope_key, customer_id, project_id, plan_id, plan_version, job_id, run_id, attempt_ref, idempotency_key, envelope_ref, type, occurred_at, amount_minor_units, amount_presence, currency, reason)
         SELECT
           $1,
           $2 || '::' || $7 || '::' || $8 || '::' || $9 || '::' || $10 || '::' || d.decided_type,
           $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, d.decided_type, $15,
           CASE WHEN $12 = 'UNKNOWN' THEN NULL ELSE $13::bigint END,
           $12,
           CASE WHEN $12 = 'UNKNOWN' THEN NULL ELSE $16 END,
           d.decided_reason
         FROM decision d
         WHERE d.decided_type IS NOT NULL
         RETURNING *
       )
       SELECT * FROM already_existing
       UNION ALL
       SELECT * FROM inserted`,
      [
        scope.tenantId,
        scopeKey,
        scope.customerId,
        scope.projectId,
        scope.planId,
        scope.planVersion,
        input.identity.jobId,
        input.identity.runId,
        input.identity.attemptRef,
        input.idempotencyKey,
        input.envelope.envelopeRef,
        presence,
        amountMinorUnits ?? 0,
        input.envelope.limit.amountMinorUnits,
        input.occurredAt,
        currency,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new InvalidQuotaAdmissionError("internal error: admit() produced no row - neither a replay nor a fresh decision");
    }
    const event = rowToRecord(row, scope);
    return event.type === "RESERVED" ? { status: "RESERVED", event } : { status: "REJECTED", event };
  }

  async commit(input: {
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
    readonly actualAmount: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
    readonly occurredAt: unknown;
    readonly attribution?: {
      workerRef?: unknown;
      providerRef?: unknown;
      modelRef?: unknown;
      routeRef?: unknown;
    };
    readonly allowedOverage?: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
  }): Promise<QuotaCommitOutcome> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ledger = await this.readReservationLedger(input.identity, input.idempotencyKey);
      const { ledger: nextLedger, outcome } = commitQuotaUsage({ ledger, ...input });
      if (nextLedger === ledger) {
        return outcome;
      }
      const newEvent = nextLedger.events[nextLedger.events.length - 1] as QuotaReservationEvent;
      const inserted = await this.insertEventIfAbsent(newEvent);
      if (inserted) {
        return outcome;
      }
      // Lost the race to a concurrent identical-idempotencyKey commit - loop
      // once more to re-read now-current durable state and reconcile
      // (replays safely if content matches, fails closed via
      // `QuotaReservationConflictError` if it does not).
    }
    throw new InvalidQuotaAdmissionError("internal error: commit() could not converge after retrying a lost concurrent-insert race");
  }

  async release(input: {
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
    readonly occurredAt: unknown;
    readonly reason?: unknown;
  }): Promise<QuotaReleaseOutcome> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ledger = await this.readReservationLedger(input.identity, input.idempotencyKey);
      const { ledger: nextLedger, outcome } = releaseQuotaReservation({ ledger, ...input });
      if (nextLedger === ledger) {
        return outcome;
      }
      const newEvent = nextLedger.events[nextLedger.events.length - 1] as QuotaReservationEvent;
      const inserted = await this.insertEventIfAbsent(newEvent);
      if (inserted) {
        return outcome;
      }
    }
    throw new InvalidQuotaAdmissionError("internal error: release() could not converge after retrying a lost concurrent-insert race");
  }

  async getReadModel(envelope: QuotaEnvelope): Promise<QuotaReadModel> {
    const result = await this.client.query<RawQuotaReservationRow>(
      `SELECT * FROM quota_reservation_events WHERE tenant_id = $1 AND scope_key = $2`,
      [envelope.scope.tenantId, quotaScopeKey(envelope.scope)],
    );
    const events = result.rows.map((row) => rowToRecord(row, envelope.scope));
    return projectQuotaReadModel({ events }, envelope);
  }

  private async readReservationLedger(identity: QuotaReservationIdentity, idempotencyKey: unknown): Promise<QuotaLedger> {
    const result = await this.client.query<RawQuotaReservationRow>(
      `SELECT * FROM quota_reservation_events
       WHERE tenant_id = $1 AND scope_key = $2 AND job_id = $3 AND run_id = $4 AND attempt_ref = $5 AND idempotency_key = $6`,
      [identity.scope.tenantId, quotaScopeKey(identity.scope), identity.jobId, identity.runId, identity.attemptRef, idempotencyKey],
    );
    const events = result.rows.map((row) => rowToRecord(row, identity.scope));
    return { events };
  }

  private async insertEventIfAbsent(event: QuotaReservationEvent): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO quota_reservation_events
         (tenant_id, event_id, scope_key, customer_id, project_id, plan_id, plan_version, job_id, run_id, attempt_ref, idempotency_key, envelope_ref, type, occurred_at, amount_minor_units, amount_presence, currency, reason, worker_ref, provider_ref, model_ref, route_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
       ON CONFLICT (tenant_id, event_id) DO NOTHING
       RETURNING event_id`,
      [
        event.identity.scope.tenantId,
        event.eventId,
        quotaScopeKey(event.identity.scope),
        event.identity.scope.customerId,
        event.identity.scope.projectId,
        event.identity.scope.planId,
        event.identity.scope.planVersion,
        event.identity.jobId,
        event.identity.runId,
        event.identity.attemptRef,
        event.idempotencyKey,
        event.envelopeRef,
        event.type,
        event.occurredAt,
        event.amount?.amountMinorUnits ?? null,
        event.amount?.presence ?? null,
        event.amount?.currency ?? null,
        event.reason ?? null,
        event.attribution?.workerRef ?? null,
        event.attribution?.providerRef ?? null,
        event.attribution?.modelRef ?? null,
        event.attribution?.routeRef ?? null,
      ],
    );
    return result.rows.length > 0;
  }
}
