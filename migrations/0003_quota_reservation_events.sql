-- OS-V0-07: durable usage/cost/quota reservation-lifecycle truth.
--
-- Additive only - does not alter or drop anything from 0001_outcome_jobs.sql
-- or 0002_outcome_job_execution_events.sql. Mirrors the field set of
-- src/domain/execution-quota-admission.ts's QuotaReservationEvent exactly.
--
-- The UNIQUE (tenant_id, event_id) constraint is the actual duplicate-
-- protection primitive PostgresQuotaReservationStore's commit()/release()
-- rely on via `ON CONFLICT ... DO NOTHING` (same Persistence Contract
-- discipline as outcome_job_execution_events: "rely on database
-- uniqueness/ordering constraints rather than read-then-write races for
-- duplicate protection").
--
-- admit()'s own atomic "does this fit under the current envelope limit"
-- decision is a genuinely different, SHARED-RESOURCE contention problem (two
-- DIFFERENT idempotency keys in the SAME scope competing for the same
-- remaining allowance) that a per-row unique constraint alone cannot
-- arbitrate - PostgresQuotaReservationStore's admit() instead issues ONE
-- single atomic SQL statement per call (a `pg_advisory_xact_lock`-guarded
-- CTE reading current scope usage and deciding RESERVED/REJECTED before
-- inserting), matching this repository's "no read-then-write allowance
-- race" requirement without needing explicit multi-statement transactions
-- (the minimal `SqlClient` port exposes only single parameterized
-- statements, never `BEGIN`/`COMMIT`).
--
-- This migration is additive scaffolding only: it is not applied against
-- any live database by this checkpoint (no DATABASE_URL is configured or
-- connected to in this repository - "No concrete DB driver/live DB
-- activation," matching every other Postgres store in this repository).
--
-- Rev176: `id` provides a reliable, monotonic insertion-order column so
-- `PostgresQuotaReservationStore`'s current-usage query can select the
-- LATEST row per `idempotency_key` (via `DISTINCT ON (idempotency_key)
-- ... ORDER BY idempotency_key, id DESC`) before summing - a naive
-- `SUM(amount_minor_units) WHERE type IN (...)` over every row would
-- double-count a reservation's original RESERVED amount alongside its
-- later COMMITTED/RELEASED row for the same idempotency_key, since neither
-- transition deletes or updates the earlier row (this store is strictly
-- append-only, mirroring every other event-sourced store in this
-- repository). `occurred_at` (caller-supplied, TEXT) is not trustworthy
-- for this - only a database-assigned sequence is.
--
-- Rev177 F2: `source_fingerprint` (refined into this same additive
-- migration lineage, not a new migration file - this migration is not
-- live-applied anywhere) records the EXACT envelope/policy version a
-- reservation was admitted against, alongside its `envelope_ref`. A
-- conflicting replay whose `source_fingerprint` differs from what this exact
-- `idempotency_key` already recorded fails closed exactly like a differing
-- `envelope_ref`/identity/amount already does - see
-- `assertReplayMatchesOriginalRequest` in `execution-quota-admission.ts`.

CREATE TABLE IF NOT EXISTS quota_reservation_events (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           TEXT NOT NULL,
    event_id            TEXT NOT NULL,
    scope_key           TEXT NOT NULL,
    customer_id         TEXT NOT NULL,
    project_id          TEXT NOT NULL,
    plan_id             TEXT NOT NULL,
    plan_version        INTEGER NOT NULL,
    job_id              TEXT NOT NULL,
    run_id              TEXT NOT NULL,
    attempt_ref         TEXT NOT NULL,
    idempotency_key     TEXT NOT NULL,
    envelope_ref        TEXT NOT NULL,
    source_fingerprint  TEXT NOT NULL,
    type                TEXT NOT NULL,
    occurred_at         TEXT NOT NULL,
    amount_minor_units  BIGINT,
    amount_presence     TEXT,
    currency            TEXT,
    reason              TEXT,
    worker_ref          TEXT,
    provider_ref        TEXT,
    model_ref           TEXT,
    route_ref           TEXT,
    CONSTRAINT quota_reservation_events_event_id_unique
        UNIQUE (tenant_id, event_id),
    CONSTRAINT quota_reservation_events_plan_version_positive CHECK (plan_version > 0),
    CONSTRAINT quota_reservation_events_type_recognized CHECK (
        type IN ('RESERVED', 'REJECTED', 'COMMITTED', 'RELEASED', 'RECONCILIATION_REQUIRED')
    ),
    CONSTRAINT quota_reservation_events_amount_presence_recognized CHECK (
        amount_presence IS NULL OR amount_presence IN ('REPORTED', 'UNKNOWN')
    )
);

CREATE INDEX IF NOT EXISTS quota_reservation_events_scope_idx
    ON quota_reservation_events (tenant_id, scope_key);

CREATE INDEX IF NOT EXISTS quota_reservation_events_idempotency_idx
    ON quota_reservation_events (tenant_id, idempotency_key);
