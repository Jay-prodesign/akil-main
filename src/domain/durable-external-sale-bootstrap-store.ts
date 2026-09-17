import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  readdirSync,
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

export class CorruptedExternalSaleBootstrapLockError extends Error {
  constructor(lockPath: string, reason: string) {
    super(`Corrupted durable external-sale-bootstrap creation lock (${lockPath}): ${reason}`);
    this.name = "CorruptedExternalSaleBootstrapLockError";
  }
}

export class ExternalSaleBootstrapTenantLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable external-sale-bootstrap tenant journal lock for tenant "${tenantId}"`);
    this.name = "ExternalSaleBootstrapTenantLockTimeoutError";
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
  const soldScopeCustomerId = requireNonEmptyStringField(soldScopeObj["customerId"], `record "${saleId}".result.soldScope.customerId`, filePath);
  if (soldScopeCustomerId !== projectCustomerId) {
    fail(filePath, `record "${saleId}".result.soldScope.customerId does not match result.project.customerId`);
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
    customerId: soldScopeCustomerId as unknown as Project["customerId"],
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
  private static readonly TENANT_LOCK_TIMEOUT_MS = 5000;
  private static readonly TENANT_LOCK_RETRY_BACKOFF_MS = 5;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.creationLockDir(), { recursive: true });
    mkdirSync(this.tenantLockDir(), { recursive: true });
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

  private tenantLockDir(): string {
    return join(this.baseDir, ".tenant-locks");
  }

  private tenantLockPathForEpoch(tenantId: TenantScope["tenantId"], epoch: number): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.tenantLockDir(), `${safeKey}.epoch-${epoch}.lock`);
  }

  private currentTenantLockEpoch(tenantId: TenantScope["tenantId"]): number {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const prefix = `${safeKey}.epoch-`;
    const suffix = ".lock";
    let highest = 0;
    for (const entry of readdirSync(this.tenantLockDir())) {
      if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) {
        continue;
      }
      const epoch = Number(entry.slice(prefix.length, entry.length - suffix.length));
      if (Number.isInteger(epoch) && epoch > highest) {
        highest = epoch;
      }
    }
    return highest;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private tryAcquireTenantLockEpoch(tenantId: TenantScope["tenantId"], epoch: number): "acquired" | "taken" {
    const candidatePath = this.tenantLockPathForEpoch(tenantId, epoch);
    const tmpPath = `${candidatePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ pid: process.pid }), "utf8");
    try {
      linkSync(tmpPath, candidatePath);
      return "acquired";
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      return "taken";
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only
      }
    }
  }

  /**
   * AUD-DURABILITY-GAP / Rev71 forward-port (repo-wide Rev66 audit
   * closure): ports the exact `FileDurableOutcomeJobStore` tenant-journal
   * design proven correct through Rev69/Rev70/Rev72 (see that file's own
   * doc comments for the full reasoning, including the ABA-race pitfall a
   * naive "read holder pid, confirm dead, unlink, retry" reclaim would
   * introduce) - implemented correctly on the first pass here rather than
   * re-discovering the same three correction rounds. Epoch numbers only
   * ever increase; a waiter never deletes a stale holder's lock, it only
   * ever creates a new, never-before-existing epoch once the current
   * highest epoch is confirmed dead; `linkSync` remains the sole atomic
   * arbiter of any given epoch.
   */
  private withTenantJournalLock<T>(tenantId: TenantScope["tenantId"], criticalSection: () => T): T {
    const deadline = Date.now() + FileDurableExternalSaleBootstrapStore.TENANT_LOCK_TIMEOUT_MS;
    let acquiredEpoch: number | undefined;
    for (;;) {
      const highest = this.currentTenantLockEpoch(tenantId);

      if (highest === 0) {
        if (this.tryAcquireTenantLockEpoch(tenantId, 1) === "acquired") {
          acquiredEpoch = 1;
          break;
        }
        continue;
      }

      const highestPath = this.tenantLockPathForEpoch(tenantId, highest);
      let holderPid: number | undefined;
      let lockAlreadyGone = false;
      try {
        const raw = JSON.parse(readFileSync(highestPath, "utf8")) as unknown;
        if (
          typeof raw === "object" &&
          raw !== null &&
          typeof (raw as Record<string, unknown>)["pid"] === "number"
        ) {
          holderPid = (raw as { pid: number })["pid"];
        }
      } catch (readCause) {
        if ((readCause as NodeJS.ErrnoException).code === "ENOENT") {
          lockAlreadyGone = true;
        }
      }

      if (lockAlreadyGone) {
        continue;
      }
      if (holderPid !== undefined && !this.isProcessAlive(holderPid)) {
        if (this.tryAcquireTenantLockEpoch(tenantId, highest + 1) === "acquired") {
          acquiredEpoch = highest + 1;
          break;
        }
        continue;
      }

      if (Date.now() > deadline) {
        throw new ExternalSaleBootstrapTenantLockTimeoutError(tenantId);
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        FileDurableExternalSaleBootstrapStore.TENANT_LOCK_RETRY_BACKOFF_MS,
      );
    }
    try {
      return criticalSection();
    } finally {
      try {
        unlinkSync(this.tenantLockPathForEpoch(tenantId, acquiredEpoch));
      } catch {
        // best-effort
      }
    }
  }

  /**
   * The sole physical-append path for this tenant's jsonl journal -
   * mirrors `FileDurableOutcomeJobStore.appendJobIfAbsentLocked` exactly.
   * Both `putIfAbsent`'s own winning-creator append and
   * `reconcileOrphanedLocks`'s healing append go through this method, so
   * a concurrent creator-vs-reconciler or multi-reconciler race can never
   * physically duplicate a jsonl line (Rev69's finding for the sibling
   * store applies identically here).
   */
  private appendRecordIfAbsentLocked(
    tenantId: TenantScope["tenantId"],
    saleId: string,
    payload: string,
  ): void {
    this.withTenantJournalLock(tenantId, () => {
      const filePath = this.filePathFor(tenantId);
      if (existsSync(filePath)) {
        const lines = readFileSync(filePath, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0);
        for (const line of lines) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as Record<string, unknown>)["saleId"] === saleId
          ) {
            return;
          }
        }
      }
      appendFileSync(filePath, `${payload}\n`, "utf8");
    });
  }

  /**
   * AUD-DURABILITY-GAP / Rev71 forward-port F1 (repo-wide Rev66 audit
   * closure): mirrors `FileDurableOutcomeJobStore.reconcileOrphanedLocks`.
   * A process killed after `linkSync` succeeds but before its own
   * `appendFileSync` completes would otherwise leave a permanently
   * invisible-but-claimed saleId - `get()`/`putIfAbsent()`'s own
   * absence-check now transparently heals any creation lock not yet
   * reflected in the jsonl file. A lock that fails validation, or whose
   * own embedded tenantId does not match the tenant it is filed under, is
   * corruption and fails closed with `CorruptedExternalSaleBootstrapLockError`.
   */
  private reconcileOrphanedLocks(
    tenantId: TenantScope["tenantId"],
    knownSaleIds: ReadonlySet<string>,
  ): Array<{ saleId: string; result: ExternalSaleBootstrapResult }> {
    const lockDir = this.creationLockDir();
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const prefix = `${tenantKey}.`;
    const healed: Array<{ saleId: string; result: ExternalSaleBootstrapResult }> = [];
    for (const entry of readdirSync(lockDir)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".lock")) {
        continue;
      }
      const lockPath = join(lockDir, entry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch (cause) {
        throw new CorruptedExternalSaleBootstrapLockError(
          lockPath,
          `lock file is not valid JSON (${(cause as Error).message})`,
        );
      }
      let record: { saleId: string; result: ExternalSaleBootstrapResult };
      try {
        record = validatePersistedSaleBootstrapRecord(parsed, tenantId, lockPath);
      } catch (cause) {
        throw new CorruptedExternalSaleBootstrapLockError(
          lockPath,
          `lock file failed validation (${(cause as Error).message})`,
        );
      }
      if (knownSaleIds.has(record.saleId)) {
        continue;
      }
      this.appendRecordIfAbsentLocked(tenantId, record.saleId, JSON.stringify({ saleId: record.saleId, result: record.result }));
      healed.push(record);
    }
    return healed;
  }

  private readAll(
    tenantId: TenantScope["tenantId"],
  ): Array<{ saleId: string; result: ExternalSaleBootstrapResult }> {
    const filePath = this.filePathFor(tenantId);
    const fromJsonl: Array<{ saleId: string; result: ExternalSaleBootstrapResult }> = [];
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (cause) {
          throw new CorruptedExternalSaleBootstrapLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
        }
        fromJsonl.push(validatePersistedSaleBootstrapRecord(parsed, tenantId, filePath));
      }
    }
    const knownSaleIds = new Set(fromJsonl.map((record) => record.saleId));
    const healed = this.reconcileOrphanedLocks(tenantId, knownSaleIds);
    return [...fromJsonl, ...healed];
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
      // Re-resolve through get() (not a raw lock read) so a crashed
      // winner's orphaned lock is transparently healed via readAll's own
      // reconciliation before this call decides what to return - the
      // same path every other reader uses (mirrors
      // FileDurableOutcomeJobStore.putIfAbsent's identical correction).
      const winner = this.get(tenantId, saleId);
      if (winner === undefined) {
        throw new InvalidDurableExternalSaleBootstrapStoreError(
          `internal error: creation lock for saleId "${saleId}" exists but could not be resolved`,
        );
      }
      if (
        winner.job.jobId !== result.job.jobId ||
        winner.project.projectId !== result.project.projectId ||
        winner.soldScope.soldScopeId !== result.soldScope.soldScopeId
      ) {
        throw new InvalidDurableExternalSaleBootstrapStoreError(
          `saleId "${saleId}" is already persisted under a different bootstrapped result`,
        );
      }
      return { result: winner, created: false };
    }

    this.appendRecordIfAbsentLocked(tenantId, saleId, payload);
    return { result, created: true };
  }

  get(
    tenantId: TenantScope["tenantId"],
    saleId: string,
  ): ExternalSaleBootstrapResult | undefined {
    return this.dedupedBySaleId(this.readAll(tenantId)).get(saleId);
  }
}
