-- RUNTIME-001: provider-neutral persistence foundation.
--
-- Mirrors the field set of src/domain/outcome-job.ts's OutcomeJob exactly
-- (tenantId, customerId, projectId, jobId, jobFamily, businessObjective,
-- state) - no column this schema does not already have a domain-level
-- counterpart for. The UNIQUE constraint on (tenant_id, job_id) is the
-- actual idempotency primitive PostgresOutcomeJobStore.putIfAbsent
-- depends on (src/domain/postgres-outcome-job-store.ts) via
-- `ON CONFLICT (tenant_id, job_id) DO NOTHING` - correct even under two
-- genuinely concurrent writers, since Postgres itself enforces it.
--
-- This migration is additive scaffolding only: it is not applied against
-- any live database by this checkpoint (no DATABASE_URL is configured or
-- connected to in this repository), matching the corridor's "no live
-- account mutation" hard stop.

CREATE TABLE IF NOT EXISTS outcome_jobs (
    tenant_id           TEXT NOT NULL,
    customer_id         TEXT NOT NULL,
    project_id          TEXT NOT NULL,
    job_id              TEXT NOT NULL,
    job_family          TEXT NOT NULL,
    business_objective  TEXT NOT NULL,
    state               TEXT NOT NULL,
    CONSTRAINT outcome_jobs_tenant_job_unique UNIQUE (tenant_id, job_id),
    CONSTRAINT outcome_jobs_state_recognized CHECK (
        state IN (
            'DRAFT', 'QUALIFIED', 'READY', 'EXECUTING', 'VERIFYING',
            'VERIFIED', 'CLOSED', 'BLOCKED', 'RECOVERING', 'ESCALATED', 'STOPPED'
        )
    )
);

CREATE INDEX IF NOT EXISTS outcome_jobs_tenant_project_idx
    ON outcome_jobs (tenant_id, project_id);
