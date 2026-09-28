-- OS-V0-05: durable OutcomeJob execution run/event truth.
--
-- Additive only - does not alter or drop anything from
-- 0001_outcome_jobs.sql. Mirrors the field set of
-- src/domain/outcome-job-execution-event.ts's OutcomeJobExecutionEvent
-- exactly. The UNIQUE (tenant_id, event_id) constraint is the actual
-- idempotency primitive PostgresOutcomeJobExecutionStore.appendEvent
-- depends on via `ON CONFLICT ... DO NOTHING` - correct even under two
-- genuinely concurrent writers, since Postgres itself enforces it
-- (Persistence Contract: "must rely on database uniqueness/ordering
-- constraints rather than read-then-write races for duplicate
-- protection").
--
-- Rev158 F16: event_id (see deriveOutcomeJobExecutionEventId) is derived
-- from the full identity tuple, but its final slot-tag component is NOT
-- the raw `type` string - it is a single shared tag for every type except
-- ACCEPTED. This single UNIQUE (tenant_id, event_id) constraint is
-- therefore ALSO the cross-type slot-exclusivity guarantee: two DIFFERENT
-- non-ACCEPTED event types racing for the same (attempt, sequence)
-- coordinate (e.g. a concurrent CANCEL_REQUESTED and CHECKPOINT_REQUESTED,
-- or PROGRESS racing a terminal result) derive the identical event_id and
-- so cannot both durably win an INSERT - no second constraint is needed.
-- event_id is the uniqueness key rather than the bare (attempt, sequence)
-- pair only because of the one deliberate exception: the run-level
-- ACCEPTED event and its first attempt's ATTEMPT_STARTED event share the
-- same (attempt: 1, sequence: 1) coordinate by convention - a bare
-- (attempt, sequence) constraint would incorrectly collide those two
-- structurally distinct events into one row, which is why ACCEPTED alone
-- keeps its own distinct slot-tag in event_id's derivation.
--
-- This migration is additive scaffolding only: it is not applied against
-- any live database by this checkpoint (no DATABASE_URL is configured or
-- connected to in this repository).

CREATE TABLE IF NOT EXISTS outcome_job_execution_events (
    tenant_id           TEXT NOT NULL,
    customer_id         TEXT NOT NULL,
    project_id          TEXT NOT NULL,
    job_id              TEXT NOT NULL,
    run_id              TEXT NOT NULL,
    correlation_id      TEXT NOT NULL,
    attempt             INTEGER NOT NULL,
    sequence            INTEGER NOT NULL,
    event_id            TEXT NOT NULL,
    type                TEXT NOT NULL,
    occurred_at         TEXT NOT NULL,
    reason              TEXT,
    progress_ref        TEXT,
    checkpoint_ref      TEXT,
    executor_ref        TEXT,
    CONSTRAINT outcome_job_execution_events_event_id_unique
        UNIQUE (tenant_id, event_id),
    CONSTRAINT outcome_job_execution_events_attempt_positive CHECK (attempt > 0),
    CONSTRAINT outcome_job_execution_events_sequence_positive CHECK (sequence > 0),
    CONSTRAINT outcome_job_execution_events_type_recognized CHECK (
        type IN (
            'ACCEPTED', 'ATTEMPT_STARTED', 'PROGRESS', 'CHECKPOINT',
            'CANCEL_REQUESTED', 'CHECKPOINT_REQUESTED',
            'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'STALLED',
            'DEGRADED', 'BLOCKED', 'UNKNOWN', 'UNSUPPORTED'
        )
    )
);

CREATE INDEX IF NOT EXISTS outcome_job_execution_events_run_idx
    ON outcome_job_execution_events (tenant_id, job_id, run_id, attempt, sequence);
