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
-- protection"). event_id (derived from the full identity tuple INCLUDING
-- type - see deriveOutcomeJobExecutionEventId) is the uniqueness key
-- rather than the bare (attempt, sequence) pair, because the run-level
-- ACCEPTED event and its first attempt's ATTEMPT_STARTED event
-- deliberately share the same (attempt: 1, sequence: 1) coordinate by
-- convention - a bare (attempt, sequence) constraint would incorrectly
-- collide those two structurally distinct events into one row.
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
            'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'STALLED',
            'DEGRADED', 'BLOCKED', 'UNKNOWN', 'UNSUPPORTED'
        )
    )
);

CREATE INDEX IF NOT EXISTS outcome_job_execution_events_run_idx
    ON outcome_job_execution_events (tenant_id, job_id, run_id, attempt, sequence);
