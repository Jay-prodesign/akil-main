import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { OutcomeJob, OutcomeJobState } from "./outcome-job.js";
import type { PersistJobResult } from "./durable-outcome-job-store.js";
import type { AsyncOutcomeJobStore } from "../ports/async-outcome-job-store.js";
import type { SqlClient } from "../ports/sql-client.js";

export class CorruptedOutcomeJobRowError extends Error {
  constructor(reason: string) {
    super(`Corrupted outcome_jobs row: ${reason}`);
    this.name = "CorruptedOutcomeJobRowError";
  }
}

const RECOGNIZED_OUTCOME_JOB_STATES: ReadonlySet<OutcomeJobState> = new Set<OutcomeJobState>([
  "DRAFT",
  "QUALIFIED",
  "READY",
  "EXECUTING",
  "VERIFYING",
  "VERIFIED",
  "CLOSED",
  "BLOCKED",
  "RECOVERING",
  "ESCALATED",
  "STOPPED",
]);

/**
 * The raw shape a driver hands back for one row - deliberately typed as
 * `unknown`-ish rather than trusted as `OutcomeJob` directly, so a
 * malformed row (a hand-edited row, a partial migration, a column of the
 * wrong type from a future schema change) is caught here rather than
 * silently reinterpreted as a valid domain record.
 */
interface RawOutcomeJobRow {
  readonly tenant_id: unknown;
  readonly customer_id: unknown;
  readonly project_id: unknown;
  readonly job_id: unknown;
  readonly job_family: unknown;
  readonly business_objective: unknown;
  readonly state: unknown;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CorruptedOutcomeJobRowError(`${field} must be a non-empty string, got: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Fail-closed replay validation, matching this codebase's own established
 * convention (`validatePersistedConnectorConnection`,
 * `validatePersistedSaleBootstrapRecord`): never trust a driver-returned
 * row as `OutcomeJob` via a blind cast - revalidate every field, including
 * tenant correspondence with the caller's own expected tenant and
 * recognized-state closure, before reconstructing the branded identifiers.
 */
export function validatePersistedOutcomeJobRow(
  raw: RawOutcomeJobRow,
  expectedTenantId: TenantScope["tenantId"],
): OutcomeJob {
  const tenantId = requireNonEmptyString(raw.tenant_id, "tenant_id");
  if (tenantId !== expectedTenantId) {
    throw new CorruptedOutcomeJobRowError(
      `row tenant_id "${tenantId}" does not match the expected tenant "${expectedTenantId}"`,
    );
  }
  const customerId = requireNonEmptyString(raw.customer_id, "customer_id");
  const projectId = requireNonEmptyString(raw.project_id, "project_id");
  const jobId = requireNonEmptyString(raw.job_id, "job_id");
  const jobFamily = requireNonEmptyString(raw.job_family, "job_family");
  const businessObjective = requireNonEmptyString(raw.business_objective, "business_objective");
  const state = requireNonEmptyString(raw.state, "state");
  if (!RECOGNIZED_OUTCOME_JOB_STATES.has(state as OutcomeJobState)) {
    throw new CorruptedOutcomeJobRowError(`unrecognized state: ${state}`);
  }

  return {
    tenantId: tenantId as unknown as TenantScope["tenantId"],
    customerId: customerId as unknown as Customer["customerId"],
    projectId: projectId as unknown as Project["projectId"],
    jobId: jobId as unknown as OutcomeJob["jobId"],
    jobFamily,
    businessObjective,
    state: state as OutcomeJobState,
  };
}

/**
 * Network-backed implementation of `AsyncOutcomeJobStore` (a deliberately
 * distinct, async-native port - see that file's own doc comment for why
 * this is not, and cannot honestly be, a drop-in for the synchronous
 * `DurableOutcomeJobStore`). Takes an injected `SqlClient` - the same
 * mockable-adapter-boundary discipline `connector-execution.ts` already
 * established for its `ConnectorTransport`/`SecretResolver` - so this
 * class never imports a concrete driver package and can be adversarially
 * tested with a fake client, with no live database required.
 *
 * `putIfAbsent` relies on the migration's own
 * `UNIQUE (tenant_id, job_id)` constraint via `ON CONFLICT ... DO NOTHING`
 * (see `migrations/0001_outcome_jobs.sql`) as the actual idempotency
 * primitive - correct even under two genuinely concurrent callers, since
 * the database's own constraint (not a read-then-write race in this
 * class) is what prevents a duplicate row.
 */
export class PostgresOutcomeJobStore implements AsyncOutcomeJobStore {
  private readonly client: SqlClient;

  constructor(client: SqlClient) {
    this.client = client;
  }

  async putIfAbsent(job: OutcomeJob): Promise<PersistJobResult> {
    const insertResult = await this.client.query<RawOutcomeJobRow>(
      `INSERT INTO outcome_jobs (tenant_id, customer_id, project_id, job_id, job_family, business_objective, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, job_id) DO NOTHING
       RETURNING tenant_id, customer_id, project_id, job_id, job_family, business_objective, state`,
      [job.tenantId, job.customerId, job.projectId, job.jobId, job.jobFamily, job.businessObjective, job.state],
    );
    if (insertResult.rows.length > 0) {
      const insertedRow = insertResult.rows[0];
      if (insertedRow === undefined) {
        throw new CorruptedOutcomeJobRowError("INSERT ... RETURNING reported a row but returned no data");
      }
      return { job: validatePersistedOutcomeJobRow(insertedRow, job.tenantId), created: true };
    }

    const existing = await this.get(job.tenantId, job.jobId);
    if (existing === undefined) {
      throw new CorruptedOutcomeJobRowError(
        `putIfAbsent conflicted on tenant_id/job_id but no existing row could be read back for jobId "${job.jobId}"`,
      );
    }
    if (existing.tenantId !== job.tenantId || existing.projectId !== job.projectId) {
      throw new CorruptedOutcomeJobRowError(
        `jobId "${job.jobId}" is already persisted under a different tenant/project`,
      );
    }
    return { job: existing, created: false };
  }

  async get(
    tenantId: TenantScope["tenantId"],
    jobId: OutcomeJob["jobId"],
  ): Promise<OutcomeJob | undefined> {
    const result = await this.client.query<RawOutcomeJobRow>(
      `SELECT tenant_id, customer_id, project_id, job_id, job_family, business_objective, state
       FROM outcome_jobs
       WHERE tenant_id = $1 AND job_id = $2`,
      [tenantId, jobId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return validatePersistedOutcomeJobRow(row, tenantId);
  }

  async list(
    tenantId: TenantScope["tenantId"],
    projectId: OutcomeJob["projectId"],
  ): Promise<ReadonlyArray<OutcomeJob>> {
    const result = await this.client.query<RawOutcomeJobRow>(
      `SELECT tenant_id, customer_id, project_id, job_id, job_family, business_objective, state
       FROM outcome_jobs
       WHERE tenant_id = $1 AND project_id = $2`,
      [tenantId, projectId],
    );
    return result.rows.map((row) => validatePersistedOutcomeJobRow(row, tenantId));
  }
}
