import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { OutcomeJob, OutcomeJobState } from "./outcome-job.js";

export class InvalidDurableOutcomeJobStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableOutcomeJobStore operation: ${reason}`);
    this.name = "InvalidDurableOutcomeJobStoreError";
  }
}

export class CorruptedOutcomeJobLineError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable outcome-job line (${filePath}): ${reason}`);
    this.name = "CorruptedOutcomeJobLineError";
  }
}

const RECOGNIZED_OUTCOME_JOB_STATES: ReadonlySet<string> = new Set<OutcomeJobState>([
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

function failCorruptedLine(filePath: string, reason: string): never {
  throw new CorruptedOutcomeJobLineError(filePath, reason);
}

function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failCorruptedLine(filePath, `${field} must be a non-empty string`);
  }
  return value as string;
}

/**
 * OS-V0-03 Phase B: persisted state is an external/untrusted boundary on
 * replay, exactly like every other durable store in this repository that
 * already revalidates on read (`validatePersistedOutcomeJobRow` in
 * `postgres-outcome-job-store.ts`, `validatePersistedConnectorConnection`).
 * Before this correction, `FileDurableOutcomeJobStore.readAll` blindly
 * `JSON.parse`-cast every line as `OutcomeJob`: a corrupted or forged record
 * with a foreign embedded `tenantId` could be returned by `get()`/`list()`
 * from the requested tenant's own file, since nothing checked the record's
 * own identity fields against the tenant whose file was actually read.
 * Every failure throws `CorruptedOutcomeJobLineError` (fail-closed) rather
 * than silently dropping or coercing a bad line.
 */
function validatePersistedOutcomeJobLine(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  filePath: string,
): OutcomeJob {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    failCorruptedLine(filePath, "line must be a JSON object, not an array or primitive");
  }
  const record = raw as Record<string, unknown>;
  const tenantId = requireNonEmptyStringField(record["tenantId"], "tenantId", filePath);
  const tenantMismatch = tenantId !== expectedTenantId;
  if (tenantMismatch) {
    failCorruptedLine(
      filePath,
      `record is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant contamination`,
    );
  }
  const customerId = requireNonEmptyStringField(record["customerId"], "customerId", filePath);
  const projectId = requireNonEmptyStringField(record["projectId"], "projectId", filePath);
  const jobId = requireNonEmptyStringField(record["jobId"], "jobId", filePath);
  const jobFamily = requireNonEmptyStringField(record["jobFamily"], "jobFamily", filePath);
  const businessObjective = requireNonEmptyStringField(record["businessObjective"], "businessObjective", filePath);
  const state = requireNonEmptyStringField(record["state"], "state", filePath);
  const stateUnrecognized = !RECOGNIZED_OUTCOME_JOB_STATES.has(state);
  if (stateUnrecognized) {
    failCorruptedLine(filePath, `state "${state}" is not a recognized OutcomeJobState`);
  }

  return {
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as unknown as OutcomeJob["customerId"],
    projectId: projectId as unknown as OutcomeJob["projectId"],
    jobId: jobId as unknown as OutcomeJob["jobId"],
    jobFamily,
    businessObjective,
    state: state as OutcomeJobState,
  };
}

export interface PersistJobResult {
  readonly job: OutcomeJob;
  readonly created: boolean;
}

/**
 * DEL-003 second bounded slice correction (F3): the durable persistence
 * boundary that makes OutcomeJob creation/replay idempotency explicit and
 * enforced, not merely assumed downstream (Brain CHANGES_REQUIRED F3,
 * DEL-003 second slice round 1). `putIfAbsent` is the sole write path -
 * there is no plain "insert" - so a duplicate admission/replay of the same
 * jobId can never overwrite or duplicate a persisted job; it only reports
 * `created: false` and returns the job exactly as first persisted.
 */
export interface DurableOutcomeJobStore {
  putIfAbsent(job: OutcomeJob): PersistJobResult;
  get(tenantId: TenantScope["tenantId"], jobId: OutcomeJob["jobId"]): OutcomeJob | undefined;
  list(
    tenantId: TenantScope["tenantId"],
    customerId: OutcomeJob["customerId"],
    projectId: OutcomeJob["projectId"],
  ): ReadonlyArray<OutcomeJob>;
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs` - no new runtime dependency (T10/T12). One JSON-lines file per
 * tenant under `baseDir`, keyed by jobId; every read reconstructs the
 * current job set from the full durable file, in true append order,
 * keeping only the first record for any given jobId - proving restart
 * reconstruction (a fresh store instance over the same `baseDir` sees the
 * exact same de-duplicated job set) rather than relying on a separate
 * in-memory index that could diverge from disk.
 */
export class FileDurableOutcomeJobStore implements DurableOutcomeJobStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  private readAll(tenantId: TenantScope["tenantId"]): OutcomeJob[] {
    const filePath = this.filePathFor(tenantId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (cause) {
          throw new CorruptedOutcomeJobLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
        }
        return validatePersistedOutcomeJobLine(parsed, tenantId, filePath);
      });
  }

  private dedupedByJobId(jobs: ReadonlyArray<OutcomeJob>): Map<OutcomeJob["jobId"], OutcomeJob> {
    const byJobId = new Map<OutcomeJob["jobId"], OutcomeJob>();
    for (const job of jobs) {
      if (!byJobId.has(job.jobId)) {
        // First record for this jobId wins - later duplicate appends
        // (a replayed wiring pass) are inert on reconstruction.
        byJobId.set(job.jobId, job);
      }
    }
    return byJobId;
  }

  putIfAbsent(job: OutcomeJob): PersistJobResult {
    const existing = this.get(job.tenantId, job.jobId);
    if (existing !== undefined) {
      if (
        existing.tenantId !== job.tenantId ||
        existing.customerId !== job.customerId ||
        existing.projectId !== job.projectId
      ) {
        throw new InvalidDurableOutcomeJobStoreError(
          `jobId "${job.jobId}" is already persisted under a different tenant/customer/project`,
        );
      }
      return { job: existing, created: false };
    }
    const filePath = this.filePathFor(job.tenantId);
    const line = `${JSON.stringify(job)}\n`;
    if (existsSync(filePath)) {
      const existingContent = readFileSync(filePath, "utf8");
      writeFileSync(filePath, existingContent + line, "utf8");
    } else {
      writeFileSync(filePath, line, "utf8");
    }
    return { job, created: true };
  }

  get(tenantId: TenantScope["tenantId"], jobId: OutcomeJob["jobId"]): OutcomeJob | undefined {
    return this.dedupedByJobId(this.readAll(tenantId)).get(jobId);
  }

  list(
    tenantId: TenantScope["tenantId"],
    customerId: OutcomeJob["customerId"],
    projectId: OutcomeJob["projectId"],
  ): ReadonlyArray<OutcomeJob> {
    return [...this.dedupedByJobId(this.readAll(tenantId)).values()].filter(
      (job) => job.customerId === customerId && job.projectId === projectId,
    );
  }
}

/**
 * F3: persists a batch of already-wired `OutcomeJob`s through the store's
 * `putIfAbsent` idempotency, reporting which were newly created versus
 * already-durably-present. Calling this twice with the same wired jobs (a
 * replayed resume, or a restart re-running `wireAdmittedOutcomeJobs` over
 * the same admitted specs) durably persists exactly one job per jobId -
 * the second call's `created` list is always empty, proving persisted job
 * creation happens once.
 */
export function persistWiredOutcomeJobs(
  store: DurableOutcomeJobStore,
  jobs: ReadonlyArray<OutcomeJob>,
): { readonly created: ReadonlyArray<OutcomeJob>; readonly alreadyPersisted: ReadonlyArray<OutcomeJob> } {
  const created: OutcomeJob[] = [];
  const alreadyPersisted: OutcomeJob[] = [];
  for (const job of jobs) {
    const result = store.putIfAbsent(job);
    if (result.created) {
      created.push(result.job);
    } else {
      alreadyPersisted.push(result.job);
    }
  }
  return { created, alreadyPersisted };
}
