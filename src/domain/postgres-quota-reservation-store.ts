import {
  admitQuotaReservation,
  commitQuotaUsage,
  releaseQuotaReservation,
  projectQuotaReadModel,
  validatePersistedQuotaReservationEvent,
  assertReplayMatchesOriginalRequest,
  deriveQuotaReservationEventId,
  findCanonicalLatestForIdempotencyKey,
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
  QuotaReservationAlreadySettledError,
} from "./execution-quota-admission.js";
// Rev177 F4 note: `QuotaReservationConflictError` is never caught or
// constructed here directly - `claimFirstTerminalDisposition`'s callers
// reconcile a lost race by re-invoking the SAME pure `commitQuotaUsage`/
// `releaseQuotaReservation` reducers against the real winning ledger state,
// which already throw/return the correct outcome (Rev177 F7).
// Rev179 F12: `admit()` itself DOES construct `QuotaReservationAlreadySettledError`
// directly, once its own atomic SQL confirms the canonical latest event for
// this idempotencyKey has already reached a genuine terminal disposition -
// see the `already_settled_terminal` branch below.
import { createCostAmount } from "./execution-economics-attribution.js";
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
  readonly source_fingerprint: unknown;
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
    sourceFingerprint: row.source_fingerprint,
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
    if (input.envelope.monetaryLimit !== undefined && presence === "REPORTED" && currency !== input.envelope.monetaryLimit.currency) {
      throw new InvalidQuotaAdmissionError(
        `requestedAmount currency "${String(currency)}" does not match envelope monetaryLimit currency "${input.envelope.monetaryLimit.currency}"`,
      );
    }
    const scopeKey = quotaScopeKey(scope);
    // Rev177 F1: candidate eventIds are computed HERE in TypeScript (the one
    // canonical `deriveQuotaReservationEventId` derivation) and passed to SQL
    // as plain parameters - the SQL below never reconstructs an eventId
    // itself (it previously did, via ad-hoc `||` string concatenation of a
    // `::`-delimited convention that was never collision-safe to begin
    // with). This exactly mirrors `PostgresOutcomeJobExecutionStore`'s own
    // established convention: a store receives `event.eventId`, it never
    // recomputes one.
    const candidateReservedEventId = deriveQuotaReservationEventId(input.identity, input.idempotencyKey, "RESERVED");
    const candidateRejectedEventId = deriveQuotaReservationEventId(input.identity, input.idempotencyKey, "REJECTED");
    const result = await this.client.query<RawQuotaReservationRow>(
      `WITH scope_lock AS (
         SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2)) AS locked
       ),
       canonical_latest AS (
         -- Rev179 F12: the ONE canonical latest event for this exact
         -- idempotencyKey (across ALL types, ordered by the database-assigned
         -- id - never caller-supplied occurred_at), mirroring the pure
         -- findCanonicalLatestForIdempotencyKey reducer this store must stay
         -- in parity with. This store is strictly append-only: a reservation's
         -- ORIGINAL RESERVED row is never deleted once it later transitions to
         -- COMMITTED/RELEASED/RECONCILIATION_REQUIRED, so a query for "any row
         -- with type = RESERVED" (this CTE's prior shape) would keep matching
         -- that stale row forever, resurrecting an already-settled reservation
         -- as if it were still current. Selecting only the single latest row
         -- closes that gap structurally.
         SELECT e.* FROM quota_reservation_events e, scope_lock
         WHERE e.tenant_id = $1 AND e.idempotency_key = $10
         ORDER BY e.id DESC
         LIMIT 1
       ),
       already_reserved AS (
         -- Rev176 "rejected-then-later-admissible recovery": only an existing
         -- RESERVED decision is permanent and blocks re-evaluation - it
         -- already durably consumed real allowance. A REJECTED-only history
         -- consumed nothing, so it must not permanently block this
         -- idempotencyKey from ever being re-evaluated once circumstances
         -- change. Rev179 F12: this is the canonical latest row, not merely
         -- any historical RESERVED row - see canonical_latest above.
         SELECT * FROM canonical_latest WHERE type = 'RESERVED'
       ),
       already_settled_terminal AS (
         -- Rev179 F12: the canonical latest event has already moved on to a
         -- genuine terminal disposition - this idempotencyKey can never be
         -- re-admitted, resurrected, or transitioned to a different terminal
         -- state (mirrors the pure QuotaReservationAlreadySettledError
         -- contract exactly).
         SELECT * FROM canonical_latest WHERE type IN ('COMMITTED', 'RELEASED', 'RECONCILIATION_REQUIRED')
       ),
       existing_rejected AS (
         SELECT * FROM canonical_latest WHERE type = 'REJECTED'
       ),
       latest_per_reservation AS (
         -- Rev176: this store is strictly append-only - a COMMITTED or
         -- RELEASED transition never deletes or updates its reservation's
         -- earlier RESERVED row. Summing every matching row directly would
         -- therefore double-count a reservation's original RESERVED amount
         -- alongside its own later COMMITTED/RELEASED row. DISTINCT ON
         -- ordered by the database-assigned id column (never caller-supplied
         -- occurred_at) picks exactly the true latest row per
         -- idempotency_key, mirroring the pure projectQuotaScopeUsage
         -- reducer's own "latest event per reservation" fold.
         SELECT DISTINCT ON (e.idempotency_key) e.idempotency_key, e.type, e.amount_minor_units, e.amount_presence
         FROM quota_reservation_events e, scope_lock
         WHERE e.tenant_id = $1 AND e.scope_key = $2
         ORDER BY e.idempotency_key, e.id DESC
       ),
       current_usage AS (
         -- Rev177 F10: unit_count (a finite, always-known count of
         -- outstanding-or-settled reservations) is the ALWAYS-enforced hard
         -- floor. monetary_total/has_unknown_committed only ever matter
         -- when the envelope configured a real monetaryLimit ($14 non-NULL)
         -- to protect - mirroring the pure admitQuotaReservation reducer's
         -- own unit-floor-first, monetary-only-if-configured decision order.
         SELECT
           COUNT(*) FILTER (WHERE l.type IN ('RESERVED', 'COMMITTED', 'RECONCILIATION_REQUIRED')) AS unit_count,
           COALESCE(SUM(l.amount_minor_units) FILTER (WHERE l.type IN ('RESERVED', 'COMMITTED', 'RECONCILIATION_REQUIRED')), 0) AS monetary_total,
           EXISTS (
             SELECT 1 FROM latest_per_reservation l2
             WHERE l2.type IN ('COMMITTED', 'RECONCILIATION_REQUIRED') AND l2.amount_presence = 'UNKNOWN'
           ) AS has_unknown_committed
         FROM latest_per_reservation l
       ),
       decision AS (
         SELECT
           CASE
             WHEN EXISTS (SELECT 1 FROM already_reserved) THEN NULL
             WHEN EXISTS (SELECT 1 FROM already_settled_terminal) THEN NULL
             WHEN (SELECT unit_count FROM current_usage) + 1 > $20::bigint THEN 'REJECTED'
             WHEN $14::bigint IS NULL THEN 'RESERVED'
             WHEN (SELECT has_unknown_committed FROM current_usage) THEN 'REJECTED'
             WHEN $12 = 'UNKNOWN' THEN 'REJECTED'
             WHEN (SELECT monetary_total FROM current_usage) + $13::bigint <= $14::bigint THEN 'RESERVED'
             ELSE 'REJECTED'
           END AS decided_type,
           CASE
             WHEN (SELECT unit_count FROM current_usage) + 1 > $20::bigint THEN 'insufficient unit allowance remaining under the current envelope''s unit floor'
             WHEN $14::bigint IS NULL THEN NULL
             WHEN (SELECT has_unknown_committed FROM current_usage) THEN 'an UNKNOWN committed monetary usage already exists in this scope - further monetary-ceiling-dependent admission cannot trust the remaining monetary allowance'
             WHEN $12 = 'UNKNOWN' THEN 'an UNKNOWN estimated cost cannot be admitted against a monetary ceiling - it is never treated as zero'
             WHEN (SELECT monetary_total FROM current_usage) + $13::bigint > $14::bigint THEN 'insufficient monetary allowance remaining under the current envelope''s monetaryLimit'
             ELSE NULL
           END AS decided_reason
       ),
       inserted AS (
         INSERT INTO quota_reservation_events
           (tenant_id, event_id, scope_key, customer_id, project_id, plan_id, plan_version, job_id, run_id, attempt_ref, idempotency_key, envelope_ref, source_fingerprint, type, occurred_at, amount_minor_units, amount_presence, currency, reason)
         SELECT
           $1,
           -- Rev177 F1: select the precomputed candidate eventId for the
           -- decided type - never reconstruct one from parts here.
           CASE WHEN d.decided_type = 'RESERVED' THEN $17 ELSE $18 END,
           $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $19, d.decided_type, $15,
           CASE WHEN $12 = 'UNKNOWN' THEN NULL ELSE $13::bigint END,
           $12,
           CASE WHEN $12 = 'UNKNOWN' THEN NULL ELSE $16 END,
           d.decided_reason
         FROM decision d
         WHERE d.decided_type IS NOT NULL
           -- Still REJECTED and a REJECTED row already exists for this exact
           -- idempotencyKey: this would derive the IDENTICAL event_id as
           -- that existing row (event_id depends only on identity/
           -- idempotencyKey/type, never on content/time) - never attempt
           -- that insert; the final SELECT below replays the original
           -- cached rejection instead. Only a genuine upgrade to RESERVED
           -- (a distinct event_id) may append a new row once REJECTED
           -- already exists.
           AND NOT (d.decided_type = 'REJECTED' AND EXISTS (SELECT 1 FROM existing_rejected))
         ON CONFLICT (tenant_id, event_id) DO NOTHING
         RETURNING *
       )
       SELECT * FROM already_reserved
       UNION ALL
       SELECT * FROM already_settled_terminal
       UNION ALL
       SELECT * FROM inserted
       UNION ALL
       SELECT * FROM existing_rejected
         WHERE NOT EXISTS (SELECT 1 FROM already_reserved) AND NOT EXISTS (SELECT 1 FROM already_settled_terminal) AND NOT EXISTS (SELECT 1 FROM inserted)`,
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
        input.envelope.monetaryLimit?.amountMinorUnits ?? null,
        input.occurredAt,
        currency,
        candidateReservedEventId,
        candidateRejectedEventId,
        input.envelope.sourceFingerprint,
        input.envelope.unitLimit,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new InvalidQuotaAdmissionError("internal error: admit() produced no row - neither a replay nor a fresh decision");
    }
    const event = rowToRecord(row, scope);
    // Rev179 F12: the canonical latest event for this idempotencyKey has
    // already reached a genuine terminal disposition - fail closed BEFORE
    // any replay-match content comparison (a resurrected terminal row could
    // otherwise legitimately match the original request's own content and
    // slip through `assertReplayMatchesOriginalRequest` unnoticed).
    if (event.type === "COMMITTED" || event.type === "RELEASED" || event.type === "RECONCILIATION_REQUIRED") {
      throw new QuotaReservationAlreadySettledError(event.idempotencyKey, event.type);
    }
    // Rev177 F2: whatever row this query returned - fresh insert OR a
    // replayed already_reserved/existing_rejected row - must match the
    // CURRENT caller's own identity/envelopeRef/sourceFingerprint/amount
    // exactly like the pure `admitQuotaReservation` ledger fold already
    // requires. For a fresh insert this is a tautology (the row IS what was
    // just inserted from these same inputs); for a replay, this is the
    // actual enforcement point - the prior SQL silently returned ANY row
    // matching only (tenant_id, idempotency_key, type), with no check that
    // this caller's request content still agrees with it.
    assertReplayMatchesOriginalRequest(
      event,
      {
        identity: input.identity,
        envelopeRef: input.envelope.envelopeRef,
        sourceFingerprint: input.envelope.sourceFingerprint,
        requestedAmount: createCostAmount(input.requestedAmount),
      },
      input.idempotencyKey,
    );
    return event.type === "RESERVED" ? { status: "RESERVED", event } : { status: "REJECTED", event };
  }

  /**
   * Rev177 F4: `commit()` and `release()` each independently read-then-append
   * in separate queries. Because COMMITTED, RELEASED and RECONCILIATION_REQUIRED
   * all have DIFFERENT `event_id`s, two concurrent terminal transitions on the
   * SAME RESERVED reservation (one calling commit, the other release) could
   * both durably insert - the `UNIQUE (tenant_id, event_id)` constraint alone
   * cannot serialize "the first terminal disposition wins" across different
   * event types. `claimFirstTerminalDisposition` closes this: reading the
   * RESERVED row's own fields OUTSIDE the lock is safe (a RESERVED row is
   * immutable once created), but "does a terminal disposition already exist
   * for this exact reservation, and if not, insert this one" is one atomic
   * SQL statement, `pg_advisory_xact_lock`-guarded on `(tenant, idempotencyKey)`
   * - a different, narrower lock key than `admit()`'s own per-scope lock, so
   * the two never contend with each other.
   */
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
    const ledger = await this.readReservationLedger(input.identity, input.idempotencyKey);
    const { ledger: nextLedger, outcome } = commitQuotaUsage({ ledger, ...input });
    if (nextLedger === ledger) {
      // Already-terminal identical-content safe replay, decided purely from
      // what was just read - no new event is being appended, so no atomicity
      // is needed here.
      return outcome;
    }
    const candidateEvent = nextLedger.events[nextLedger.events.length - 1] as QuotaReservationEvent;
    const winningEvent = await this.claimFirstTerminalDisposition(candidateEvent);
    if (winningEvent.eventId === candidateEvent.eventId) {
      return outcome;
    }
    // Lost the first-terminal-disposition claim to a DIFFERENT concurrent
    // transition (e.g. this commit raced a release that won instead).
    // Reconcile by re-invoking the SAME pure reducer against the ACTUAL
    // winning ledger state - it already knows how to safely replay
    // identical content, report a graceful outcome, or fail closed
    // (Rev177 F7's monotonic-terminal fix), so no decision logic is
    // duplicated here.
    const { outcome: reconciledOutcome } = commitQuotaUsage({ ledger: { events: [...ledger.events, winningEvent] }, ...input });
    return reconciledOutcome;
  }

  async release(input: {
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
    readonly occurredAt: unknown;
    readonly reason?: unknown;
  }): Promise<QuotaReleaseOutcome> {
    const ledger = await this.readReservationLedger(input.identity, input.idempotencyKey);
    const { ledger: nextLedger, outcome } = releaseQuotaReservation({ ledger, ...input });
    if (nextLedger === ledger) {
      return outcome;
    }
    const candidateEvent = nextLedger.events[nextLedger.events.length - 1] as QuotaReservationEvent;
    const winningEvent = await this.claimFirstTerminalDisposition(candidateEvent);
    if (winningEvent.eventId === candidateEvent.eventId) {
      return outcome;
    }
    const { outcome: reconciledOutcome } = releaseQuotaReservation({ ledger: { events: [...ledger.events, winningEvent] }, ...input });
    return reconciledOutcome;
  }

  /**
   * Rev177 F8: Postgres gives NO ordering guarantee for a plain `SELECT *`
   * without an `ORDER BY` - rows can physically return in any order the
   * planner chooses. Every pure fold this module feeds these events into
   * (`findLatestEvent`, `projectQuotaScopeUsage`, `projectQuotaReadModel`,
   * etc.) determines "latest" by iterating the array and keeping the LAST
   * match - which is only correct if the array is already in true
   * chronological (insertion) order. `ORDER BY id ASC` makes that explicit
   * and DB-enforced, exactly mirroring `admit()`'s own `latest_per_reservation`
   * CTE, which already orders by `id` rather than trusting return order or
   * the caller-supplied `occurred_at`.
   */
  async getReadModel(envelope: QuotaEnvelope): Promise<QuotaReadModel> {
    const result = await this.client.query<RawQuotaReservationRow>(
      `SELECT * FROM quota_reservation_events WHERE tenant_id = $1 AND scope_key = $2 ORDER BY id ASC`,
      [envelope.scope.tenantId, quotaScopeKey(envelope.scope)],
    );
    const events = result.rows.map((row) => rowToRecord(row, envelope.scope));
    return projectQuotaReadModel({ events }, envelope);
  }

  /**
   * Rev179 F14: a pure, non-mutating read - reuses the exact same
   * `readReservationLedger()` query `commit()`/`release()` already use, then
   * the SAME canonical-latest lookup the pure domain reducers rely on. Never
   * appends, never fabricates a commit that did not really happen.
   */
  async peekSettlement(input: {
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
  }): Promise<{ readonly settled: true; readonly event: QuotaReservationEvent } | { readonly settled: false }> {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
      throw new InvalidQuotaAdmissionError("idempotencyKey must be a non-empty string");
    }
    const ledger = await this.readReservationLedger(input.identity, input.idempotencyKey);
    const latest = findCanonicalLatestForIdempotencyKey(ledger, input.identity.scope.tenantId, input.idempotencyKey);
    if (latest !== undefined && (latest.type === "COMMITTED" || latest.type === "RECONCILIATION_REQUIRED")) {
      return { settled: true, event: latest };
    }
    return { settled: false };
  }

  private async readReservationLedger(identity: QuotaReservationIdentity, idempotencyKey: unknown): Promise<QuotaLedger> {
    const result = await this.client.query<RawQuotaReservationRow>(
      `SELECT * FROM quota_reservation_events
       WHERE tenant_id = $1 AND scope_key = $2 AND job_id = $3 AND run_id = $4 AND attempt_ref = $5 AND idempotency_key = $6
       ORDER BY id ASC`,
      [identity.scope.tenantId, quotaScopeKey(identity.scope), identity.jobId, identity.runId, identity.attemptRef, idempotencyKey],
    );
    const events = result.rows.map((row) => rowToRecord(row, identity.scope));
    return { events };
  }

  /**
   * Rev177 F4: the one atomic "claim the first terminal disposition for this
   * exact reservation" statement shared by `commit()`/`release()`. Locked on
   * `(tenant, idempotencyKey)` - narrower than, and independent of, `admit()`'s
   * own per-scope lock. If a terminal event (COMMITTED/RELEASED/
   * RECONCILIATION_REQUIRED) already exists for this idempotencyKey, that row
   * is returned unchanged and the candidate is never inserted; otherwise the
   * candidate is inserted and returned. The caller compares the returned
   * row's `eventId` against its own candidate's to know whether it won.
   */
  private async claimFirstTerminalDisposition(event: QuotaReservationEvent): Promise<QuotaReservationEvent> {
    const result = await this.client.query<RawQuotaReservationRow>(
      `WITH lock_slot AS (
         SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $11)) AS locked
       ),
       existing_terminal AS (
         SELECT e.* FROM quota_reservation_events e, lock_slot
         WHERE e.tenant_id = $1 AND e.idempotency_key = $11
           AND e.type IN ('COMMITTED', 'RELEASED', 'RECONCILIATION_REQUIRED')
       ),
       inserted AS (
         INSERT INTO quota_reservation_events
           (tenant_id, event_id, scope_key, customer_id, project_id, plan_id, plan_version, job_id, run_id, attempt_ref, idempotency_key, envelope_ref, source_fingerprint, type, occurred_at, amount_minor_units, amount_presence, currency, reason, worker_ref, provider_ref, model_ref, route_ref)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
         WHERE NOT EXISTS (SELECT 1 FROM existing_terminal)
         ON CONFLICT (tenant_id, event_id) DO NOTHING
         RETURNING *
       )
       SELECT * FROM existing_terminal
       UNION ALL
       SELECT * FROM inserted`,
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
        event.sourceFingerprint,
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
    const row = result.rows[0];
    if (row === undefined) {
      throw new InvalidQuotaAdmissionError("internal error: claimFirstTerminalDisposition produced no row - neither an existing terminal nor a fresh insert");
    }
    return rowToRecord(row, event.identity.scope);
  }
}
