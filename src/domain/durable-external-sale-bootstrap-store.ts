import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { ExternalSaleBootstrapResult } from "./external-sale-bootstrap.js";
import type { Project } from "./project.js";
import type { SoldScope } from "./sold-scope.js";
import type { OutcomeJob, OutcomeJobState } from "./outcome-job.js";
import type { RequirementId } from "./offer-blueprint.js";

export class InvalidDurableExternalSaleBootstrapStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableExternalSaleBootstrapStore operation: ${reason}`);
    this.name = "InvalidDurableExternalSaleBootstrapStoreError";
  }
}

export class CorruptedExternalSaleBootstrapLineError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable external-sale-bootstrap line (${filePath}): ${reason}`);
    this.name = "CorruptedExternalSaleBootstrapLineError";
  }
}

export interface PersistExternalSaleBootstrapResult {
  readonly result: ExternalSaleBootstrapResult;
  readonly created: boolean;
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

function fail(filePath: string, reason: string): never {
  throw new CorruptedExternalSaleBootstrapLineError(filePath, reason);
}

function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  return value as string;
}

/**
 * Rev94 F3: persisted state is an external/untrusted boundary on replay -
 * this revalidates the structural invariants `bootstrapExternalSaleOutcome`
 * itself produces (via the already-validating `createProject`/
 * `createSoldScope`/`createOutcomeJob`) rather than trusting a blind
 * `JSON.parse(...) as {...}` cast. Cross-checks tenant scoping on all
 * three nested records (fail-closed on cross-tenant contamination) and
 * the referential identity between them (soldScope/job both point back
 * at the same project).
 */
function validatePersistedSaleBootstrapRecord(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  filePath: string,
): { saleId: string; result: ExternalSaleBootstrapResult } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, "line must be a JSON object, not an array or primitive");
  }
  const record = raw as Record<string, unknown>;
  const saleId = requireNonEmptyStringField(record["saleId"], "saleId", filePath);

  const rawResult = record["result"];
  if (typeof rawResult !== "object" || rawResult === null || Array.isArray(rawResult)) {
    fail(filePath, `record "${saleId}".result must be a JSON object`);
  }
  const resultObj = rawResult as Record<string, unknown>;

  const rawProject = resultObj["project"];
  if (typeof rawProject !== "object" || rawProject === null || Array.isArray(rawProject)) {
    fail(filePath, `record "${saleId}".result.project must be a JSON object`);
  }
  const projectObj = rawProject as Record<string, unknown>;
  const projectTenantId = requireNonEmptyStringField(projectObj["tenantId"], `record "${saleId}".result.project.tenantId`, filePath);
  if (projectTenantId !== expectedTenantId) {
    fail(filePath, `record "${saleId}" is stored under tenant file "${expectedTenantId}" but result.project.tenantId is "${projectTenantId}" - cross-tenant contamination`);
  }
  const projectCustomerId = requireNonEmptyStringField(projectObj["customerId"], `record "${saleId}".result.project.customerId`, filePath);
  const projectId = requireNonEmptyStringField(projectObj["projectId"], `record "${saleId}".result.project.projectId`, filePath);
  const projectOwnerRef = requireNonEmptyStringField(projectObj["ownerRef"], `record "${saleId}".result.project.ownerRef`, filePath);
  const projectState = requireNonEmptyStringField(projectObj["state"], `record "${saleId}".result.project.state`, filePath);

  const rawSoldScope = resultObj["soldScope"];
  if (typeof rawSoldScope !== "object" || rawSoldScope === null || Array.isArray(rawSoldScope)) {
    fail(filePath, `record "${saleId}".result.soldScope must be a JSON object`);
  }
  const soldScopeObj = rawSoldScope as Record<string, unknown>;
  const soldScopeTenantId = requireNonEmptyStringField(soldScopeObj["tenantId"], `record "${saleId}".result.soldScope.tenantId`, filePath);
  if (soldScopeTenantId !== expectedTenantId) {
    fail(filePath, `record "${saleId}" is stored under tenant file "${expectedTenantId}" but result.soldScope.tenantId is "${soldScopeTenantId}" - cross-tenant contamination`);
  }
  const soldScopeProjectId = requireNonEmptyStringField(soldScopeObj["projectId"], `record "${saleId}".result.soldScope.projectId`, filePath);
  if (soldScopeProjectId !== projectId) {
    fail(filePath, `record "${saleId}".result.soldScope.projectId does not match result.project.projectId`);
  }
  const soldScopeId = requireNonEmptyStringField(soldScopeObj["soldScopeId"], `record "${saleId}".result.soldScope.soldScopeId`, filePath);
  const outcomeContractRef = requireNonEmptyStringField(soldScopeObj["outcomeContractRef"], `record "${saleId}".result.soldScope.outcomeContractRef`, filePath);
  if (!Array.isArray(soldScopeObj["includedRequirementIds"]) || !Array.isArray(soldScopeObj["excludedRequirementIds"])) {
    fail(filePath, `record "${saleId}".result.soldScope.includedRequirementIds/excludedRequirementIds must be arrays`);
  }

  const rawJob = resultObj["job"];
  if (typeof rawJob !== "object" || rawJob === null || Array.isArray(rawJob)) {
    fail(filePath, `record "${saleId}".result.job must be a JSON object`);
  }
  const jobObj = rawJob as Record<string, unknown>;
  const jobTenantId = requireNonEmptyStringField(jobObj["tenantId"], `record "${saleId}".result.job.tenantId`, filePath);
  if (jobTenantId !== expectedTenantId) {
    fail(filePath, `record "${saleId}" is stored under tenant file "${expectedTenantId}" but result.job.tenantId is "${jobTenantId}" - cross-tenant contamination`);
  }
  const jobCustomerId = requireNonEmptyStringField(jobObj["customerId"], `record "${saleId}".result.job.customerId`, filePath);
  if (jobCustomerId !== projectCustomerId) {
    fail(filePath, `record "${saleId}".result.job.customerId does not match result.project.customerId`);
  }
  const jobProjectId = requireNonEmptyStringField(jobObj["projectId"], `record "${saleId}".result.job.projectId`, filePath);
  if (jobProjectId !== projectId) {
    fail(filePath, `record "${saleId}".result.job.projectId does not match result.project.projectId`);
  }
  const jobId = requireNonEmptyStringField(jobObj["jobId"], `record "${saleId}".result.job.jobId`, filePath);
  const jobFamily = requireNonEmptyStringField(jobObj["jobFamily"], `record "${saleId}".result.job.jobFamily`, filePath);
  const businessObjective = requireNonEmptyStringField(jobObj["businessObjective"], `record "${saleId}".result.job.businessObjective`, filePath);
  if (typeof jobObj["state"] !== "string" || !RECOGNIZED_OUTCOME_JOB_STATES.has(jobObj["state"])) {
    fail(filePath, `record "${saleId}".result.job.state is not a recognized OutcomeJobState`);
  }

  const includedRequirementIds = soldScopeObj["includedRequirementIds"] as unknown as ReadonlyArray<RequirementId>;
  const excludedRequirementIds = soldScopeObj["excludedRequirementIds"] as unknown as ReadonlyArray<RequirementId>;

  const project: Project = {
    tenantId: projectTenantId as TenantScope["tenantId"],
    customerId: projectCustomerId as unknown as Project["customerId"],
    projectId: projectId as unknown as Project["projectId"],
    ownerRef: projectOwnerRef,
    state: projectState,
  };
  const soldScope: SoldScope = {
    tenantId: soldScopeTenantId as TenantScope["tenantId"],
    projectId: soldScopeProjectId as unknown as Project["projectId"],
    soldScopeId: soldScopeId as unknown as SoldScope["soldScopeId"],
    outcomeContractRef,
    includedRequirementIds,
    excludedRequirementIds,
  };
  const job: OutcomeJob = {
    tenantId: jobTenantId as TenantScope["tenantId"],
    customerId: jobCustomerId as unknown as OutcomeJob["customerId"],
    projectId: jobProjectId as unknown as Project["projectId"],
    jobId: jobId as unknown as OutcomeJob["jobId"],
    jobFamily,
    businessObjective,
    state: jobObj["state"] as OutcomeJobState,
  };

  return { saleId, result: { project, soldScope, job } };
}

/**
 * Mirrors `durable-outcome-job-store.ts`'s own already-established
 * `putIfAbsent`-only idempotency pattern rather than inventing a new one:
 * this is the durable layer that lets `bootstrapExternalSaleOutcome`
 * (a pure, side-effect-free function) be safely replayed on duplicate
 * delivery or crash-recovery of the same canonical sale id
 * (`deriveCanonicalSaleId`, `external-sale-bootstrap.ts`) without ever
 * producing a second Project/SoldScope/OutcomeJob. `putIfAbsent` is the
 * sole write path - there is no plain "insert."
 */
export interface DurableExternalSaleBootstrapStore {
  putIfAbsent(
    tenantId: TenantScope["tenantId"],
    saleId: string,
    result: ExternalSaleBootstrapResult,
  ): PersistExternalSaleBootstrapResult;
  get(
    tenantId: TenantScope["tenantId"],
    saleId: string,
  ): ExternalSaleBootstrapResult | undefined;
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs` - no new runtime dependency. Rev94 F3 correction: the prior
 * "check via get(), then read-current-content + rewrite-with-appended-
 * line" was not race-honest - concurrent duplicate deliveries could both
 * observe absence and both report `created: true`. `putIfAbsent` now
 * arbitrates creation via the exact same `linkSync`-based atomic-creation
 * primitive already accepted for `FileDurableOutcomeJobStore.putIfAbsent`
 * (AUD-DURABILITY-GAP): each writer first writes its own record to a
 * uniquely-named temp file, then attempts `linkSync` onto a
 * saleId-scoped lock path. `linkSync` either creates the destination
 * directory entry or fails `EEXIST`, atomically, with no window for a
 * second writer to observe a half-created lock - so exactly one writer's
 * `linkSync` can ever succeed for a given saleId, regardless of whether
 * competing payloads are identical. The durable per-tenant `.jsonl` file
 * (read by `get`) is appended to only by the winning writer, as pure
 * durability bookkeeping - never part of the race arbitration itself.
 * Replay also now revalidates every persisted line (`validatePersisted-
 * SaleBootstrapRecord`) instead of blind-casting JSON.
 */
export class FileDurableExternalSaleBootstrapStore
  implements DurableExternalSaleBootstrapStore
{
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.creationLockDir(), { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  private creationLockDir(): string {
    return join(this.baseDir, ".creation-locks");
  }

  private creationLockPathFor(tenantId: TenantScope["tenantId"], saleId: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const saleKey = Buffer.from(saleId, "utf8").toString("base64url");
    return join(this.creationLockDir(), `${tenantKey}.${saleKey}.lock`);
  }

  private readAll(
    tenantId: TenantScope["tenantId"],
  ): Array<{ saleId: string; result: ExternalSaleBootstrapResult }> {
    const filePath = this.filePathFor(tenantId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new CorruptedExternalSaleBootstrapLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
      }
      return validatePersistedSaleBootstrapRecord(parsed, tenantId, filePath);
    });
  }

  private dedupedBySaleId(
    records: ReadonlyArray<{ saleId: string; result: ExternalSaleBootstrapResult }>,
  ): Map<string, ExternalSaleBootstrapResult> {
    const byId = new Map<string, ExternalSaleBootstrapResult>();
    for (const record of records) {
      if (!byId.has(record.saleId)) {
        byId.set(record.saleId, record.result);
      }
    }
    return byId;
  }

  putIfAbsent(
    tenantId: TenantScope["tenantId"],
    saleId: string,
    result: ExternalSaleBootstrapResult,
  ): PersistExternalSaleBootstrapResult {
    if (saleId.trim().length === 0) {
      throw new InvalidDurableExternalSaleBootstrapStoreError("saleId must be a non-empty string");
    }
    const existing = this.get(tenantId, saleId);
    if (existing !== undefined) {
      if (
        existing.job.jobId !== result.job.jobId ||
        existing.project.projectId !== result.project.projectId ||
        existing.soldScope.soldScopeId !== result.soldScope.soldScopeId
      ) {
        throw new InvalidDurableExternalSaleBootstrapStoreError(
          `saleId "${saleId}" is already persisted with a different bootstrapped result`,
        );
      }
      return { result: existing, created: false };
    }

    const lockPath = this.creationLockPathFor(tenantId, saleId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ saleId, result });
    writeFileSync(tmpPath, payload, "utf8");
    let wonCreation: boolean;
    try {
      linkSync(tmpPath, lockPath);
      wonCreation = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      wonCreation = false;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only - the published lock (hard link)
        // already carries its own independent copy of the content.
      }
    }

    if (!wonCreation) {
      const winnerRaw = readFileSync(lockPath, "utf8");
      let winner: { saleId: string; result: ExternalSaleBootstrapResult };
      try {
        winner = validatePersistedSaleBootstrapRecord(JSON.parse(winnerRaw), tenantId, lockPath);
      } catch (cause) {
        throw new InvalidDurableExternalSaleBootstrapStoreError(
          `internal error: creation-lock content for saleId "${saleId}" is not a valid persisted record (${(cause as Error).message})`,
        );
      }
      if (
        winner.result.job.jobId !== result.job.jobId ||
        winner.result.project.projectId !== result.project.projectId ||
        winner.result.soldScope.soldScopeId !== result.soldScope.soldScopeId
      ) {
        throw new InvalidDurableExternalSaleBootstrapStoreError(
          `saleId "${saleId}" is already persisted under a different bootstrapped result`,
        );
      }
      return { result: winner.result, created: false };
    }

    const filePath = this.filePathFor(tenantId);
    appendFileSync(filePath, `${payload}\n`, "utf8");
    return { result, created: true };
  }

  get(
    tenantId: TenantScope["tenantId"],
    saleId: string,
  ): ExternalSaleBootstrapResult | undefined {
    return this.dedupedBySaleId(this.readAll(tenantId)).get(saleId);
  }
}
