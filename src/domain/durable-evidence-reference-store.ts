import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  linkSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { EvidenceReference } from "./evidence.js";

/**
 * KNOWLEDGE-EVIDENCE-DURABLE-001 (REV216-CONTINUOUS-COMPLETION parent loop,
 * continuation after `ORG-CONFIG-POLICY-CURRENTNESS-001`): `evidence.ts`'s
 * `EvidenceReference` already has the canonical "source/reference locator"
 * domain shape (`createEvidenceReference`) but no durable registry/
 * enumeration - `OrganizationResourceBindingSource`'s own doc comment
 * (`organization-resource-binding-durable-source.ts`) has named this exact
 * gap since Rev183/`ORG-CONFIG-POLICY-CURRENTNESS-001`: `currentKnowledge
 * EvidenceRefs` remains honest empty evidence only because no durable
 * "current" registry exists anywhere in this repository yet. This store
 * supplies exactly that - the same consumer-driven pattern as memberships
 * and service principals, not speculative persistence coverage.
 *
 * `EvidenceReference` itself has no lifecycle (unlike `OrganizationMembership`
 * /`OrganizationServicePrincipal`'s `ACTIVE -> REVOKED` transition) - it is an
 * immutable captured pointer, so this store has exactly one write path
 * (`record`), idempotent on an exact content replay, and no optimistic-
 * concurrency version guard is needed because nothing ever mutates a
 * recorded entry in place.
 *
 * Mirrors `durable-organization-service-principal-store.ts`'s exact
 * established discipline: one JSON file per tenant under `baseDir`, keyed by
 * the plain `evidenceId` (the per-tenant file itself already provides exact
 * tenant isolation - this store is tenant-file SCOPED, not a claim that
 * `evidenceId` is globally unique across tenants), a real cross-process
 * `linkSync` mutual-exclusion lock (Rev94 F1's own primitive, cloned
 * verbatim), full structural revalidation of persisted JSON on every read,
 * and ONE shared `coherenceViolation` check run at BOTH the write boundary
 * (`record`, before any persistence) and on replay, so the two paths can
 * never semantically diverge.
 *
 * CI correction (same real-world hazard a multi-process race test exposed
 * in `durable-project-store.ts`): `get`/`listByTenant` acquire the same
 * per-tenant `withTenantLock` as `record` - an unlocked reader could
 * otherwise observe a torn file mid-write from a concurrent writer
 * (`writeFileSync`'s truncate-then-write is not atomic). Readers and
 * writers share one mutual exclusion, not just writer-vs-writer.
 */

export class InvalidEvidenceReferenceStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableEvidenceReferenceStore operation: ${reason}`);
    this.name = "InvalidEvidenceReferenceStoreError";
  }
}

export class EvidenceReferenceConflictError extends Error {
  constructor(evidenceId: string, reason: string) {
    super(`EvidenceReference "${evidenceId}" conflict: ${reason}`);
    this.name = "EvidenceReferenceConflictError";
  }
}

export class CorruptedEvidenceReferenceFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable EvidenceReference file (${filePath}): ${reason}`);
    this.name = "CorruptedEvidenceReferenceFileError";
  }
}

export class EvidenceReferenceLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable EvidenceReference lock for tenant "${tenantId}"`);
    this.name = "EvidenceReferenceLockTimeoutError";
  }
}

export interface StoredEvidenceReference {
  readonly evidence: EvidenceReference;
}

/**
 * `record` is the sole write path and is idempotent on an EXACT content
 * replay (safe no-op) - but any existing record under the same `evidenceId`
 * whose content differs even in one field fails closed rather than silently
 * coexisting with or overwriting it.
 */
export interface DurableEvidenceReferenceStore {
  record(evidence: EvidenceReference): StoredEvidenceReference;
  get(
    tenantId: TenantScope["tenantId"],
    evidenceId: EvidenceReference["evidenceId"],
  ): StoredEvidenceReference | undefined;
  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredEvidenceReference>;
}

interface StoredRecordsFile {
  [evidenceId: string]: StoredEvidenceReference;
}

function fail(filePath: string, reason: string): never {
  throw new CorruptedEvidenceReferenceFileError(filePath, reason);
}

function isCanonicallyTrimmedNonEmpty(value: string): boolean {
  return value.length > 0 && value.trim().length > 0 && value.trim() === value;
}

/**
 * The ONE structural coherence check shared by BOTH the write boundary
 * (`record`, before any persistence is attempted) and replay validation -
 * applying `ORG-MEMBERSHIP-DURABLE-001` F1's own lesson from the start.
 * `EvidenceReference` is an exported structural interface, so a caller can
 * hand `record` an object that never went through `createEvidenceReference`
 * at all - this re-derives every invariant that function itself enforces:
 * non-empty, canonically-trimmed `evidenceId`/`tenantId`/`customerId`/
 * `projectId`/`jobId`/`evidenceType`/`sourceLocator`/`capturedAt`. Returns a
 * human-readable violation reason, or `undefined` when the given shape is
 * exactly what construction could have produced.
 */
function coherenceViolation(evidence: {
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly evidenceType: string;
  readonly sourceLocator: string;
  readonly capturedAt: string;
}): string | undefined {
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["evidenceId", evidence.evidenceId],
    ["tenantId", evidence.tenantId],
    ["customerId", evidence.customerId],
    ["projectId", evidence.projectId],
    ["jobId", evidence.jobId],
    ["evidenceType", evidence.evidenceType],
    ["sourceLocator", evidence.sourceLocator],
    ["capturedAt", evidence.capturedAt],
  ];
  for (const [field, value] of fields) {
    if (typeof value !== "string" || !isCanonicallyTrimmedNonEmpty(value)) {
      return `${field} must be a non-empty string with no leading or trailing whitespace`;
    }
  }
  return undefined;
}

function requireStringTypeField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string") {
    fail(filePath, `${field} must be a string`);
  }
  return value as string;
}

function evidenceIdentical(a: EvidenceReference, b: EvidenceReference): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Persisted state is an external/untrusted boundary on replay, exactly like
 * every other durable store in this repository. Field TYPE shape is checked
 * here directly (JSON can hand back anything); every structural invariant is
 * delegated to the single shared `coherenceViolation` check above, so replay
 * validation can never silently drift from what the write boundary enforces.
 * Cross-tenant contamination and key-to-identity consistency remain checked
 * here, since `coherenceViolation` has no access to the expected tenant/key
 * context. Every failure throws `CorruptedEvidenceReferenceFileError`
 * (fail-closed) rather than silently dropping or guessing a bad field.
 */
function validatePersistedEvidenceReference(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  expectedKey: string,
  filePath: string,
): StoredEvidenceReference {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, `record "${expectedKey}" must be a JSON object, not an array or primitive`);
  }
  const outer = raw as Record<string, unknown>;

  const rawEvidence = outer["evidence"];
  if (typeof rawEvidence !== "object" || rawEvidence === null || Array.isArray(rawEvidence)) {
    fail(filePath, `record "${expectedKey}".evidence must be a JSON object`);
  }
  const record = rawEvidence as Record<string, unknown>;

  const evidenceId = requireStringTypeField(record["evidenceId"], `record "${expectedKey}".evidence.evidenceId`, filePath);
  if (evidenceId !== expectedKey) {
    fail(
      filePath,
      `stored key "${expectedKey}" does not match embedded evidenceId "${evidenceId}" - key-identity substitution`,
    );
  }
  const tenantId = requireStringTypeField(record["tenantId"], `record "${expectedKey}".evidence.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${expectedKey}" is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant record contamination`,
    );
  }
  const customerId = requireStringTypeField(record["customerId"], `record "${expectedKey}".evidence.customerId`, filePath);
  const projectId = requireStringTypeField(record["projectId"], `record "${expectedKey}".evidence.projectId`, filePath);
  const jobId = requireStringTypeField(record["jobId"], `record "${expectedKey}".evidence.jobId`, filePath);
  const evidenceType = requireStringTypeField(record["evidenceType"], `record "${expectedKey}".evidence.evidenceType`, filePath);
  const sourceLocator = requireStringTypeField(record["sourceLocator"], `record "${expectedKey}".evidence.sourceLocator`, filePath);
  const capturedAt = requireStringTypeField(record["capturedAt"], `record "${expectedKey}".evidence.capturedAt`, filePath);

  const violation = coherenceViolation({
    evidenceId,
    tenantId,
    customerId,
    projectId,
    jobId,
    evidenceType,
    sourceLocator,
    capturedAt,
  });
  if (violation !== undefined) {
    fail(filePath, `record "${expectedKey}".evidence ${violation}`);
  }

  return {
    evidence: {
      evidenceId: evidenceId as EvidenceReference["evidenceId"],
      tenantId: tenantId as EvidenceReference["tenantId"],
      customerId: customerId as EvidenceReference["customerId"],
      projectId: projectId as EvidenceReference["projectId"],
      jobId: jobId as EvidenceReference["jobId"],
      evidenceType,
      sourceLocator,
      capturedAt,
    },
  };
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs`/`node:crypto` - no new runtime dependency, matching every other
 * durable store in this repository. One JSON file per tenant under
 * `baseDir`, keyed by the plain `evidenceId`; every read reconstructs the
 * full tenant record set from disk, proving restart-safety by construction.
 */
export class FileDurableEvidenceReferenceStore implements DurableEvidenceReferenceStore {
  private readonly baseDir: string;
  private static readonly LOCK_TIMEOUT_MS = 5000;
  private static readonly LOCK_RETRY_BACKOFF_MS = 5;
  private static readonly STALE_LOCK_THRESHOLD_MS = 30_000;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.lockDir(), { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.json`);
  }

  private lockDir(): string {
    return join(this.baseDir, ".locks");
  }

  private lockPathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.lockDir(), `${safeKey}.lock`);
  }

  /**
   * Rev94 F1's exact `linkSync` atomic-creation primitive, cloned verbatim.
   */
  private withTenantLock<T>(tenantId: TenantScope["tenantId"], criticalSection: () => T): T {
    const lockPath = this.lockPathFor(tenantId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, String(process.pid), "utf8");
    const deadline = Date.now() + FileDurableEvidenceReferenceStore.LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        linkSync(tmpPath, lockPath);
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          try {
            unlinkSync(tmpPath);
          } catch {
            // best-effort cleanup only
          }
          throw cause;
        }
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > FileDurableEvidenceReferenceStore.STALE_LOCK_THRESHOLD_MS) {
            unlinkSync(lockPath);
          }
        } catch {
          // the lock may have just been released, or reclaimed by another
          // waiter, between the EEXIST above and this check - either way,
          // just fall through and retry
        }
        if (Date.now() > deadline) {
          try {
            unlinkSync(tmpPath);
          } catch {
            // best-effort cleanup only
          }
          throw new EvidenceReferenceLockTimeoutError(tenantId);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableEvidenceReferenceStore.LOCK_RETRY_BACKOFF_MS,
        );
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup only - lockPath (the hard-linked copy) is what
      // actually arbitrates ownership from here on.
    }
    try {
      return criticalSection();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // best-effort: a stuck lock is bounded for the next acquirer by
        // the caller-visible timeout above, not a permanent deadlock.
      }
    }
  }

  /**
   * `Object.create(null)` dictionary - the exact same prototype-pollution
   * defense every other durable store in this repository already applies.
   */
  private readAll(tenantId: TenantScope["tenantId"]): StoredRecordsFile {
    const filePath = this.filePathFor(tenantId);
    if (!existsSync(filePath)) {
      return Object.create(null) as StoredRecordsFile;
    }
    const content = readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      throw new CorruptedEvidenceReferenceFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CorruptedEvidenceReferenceFileError(
        filePath,
        "file content must be a JSON object keyed by evidenceId, not an array or primitive",
      );
    }
    const result: StoredRecordsFile = Object.create(null) as StoredRecordsFile;
    for (const [key, rawRecord] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = validatePersistedEvidenceReference(rawRecord, tenantId, key, filePath);
    }
    return result;
  }

  private writeAll(tenantId: TenantScope["tenantId"], records: StoredRecordsFile): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(records), "utf8");
  }

  record(evidence: EvidenceReference): StoredEvidenceReference {
    // Validate BEFORE acquiring the lock or touching disk - a rejected call
    // commits zero bytes and zero state.
    const violation = coherenceViolation(evidence);
    if (violation !== undefined) {
      throw new InvalidEvidenceReferenceStoreError(`cannot record evidence "${evidence.evidenceId}": ${violation}`);
    }
    return this.withTenantLock(evidence.tenantId, () => {
      const records = this.readAll(evidence.tenantId);
      const existing = records[evidence.evidenceId];

      if (existing === undefined) {
        const created: StoredEvidenceReference = { evidence };
        records[evidence.evidenceId] = created;
        this.writeAll(evidence.tenantId, records);
        return created;
      }

      if (evidenceIdentical(existing.evidence, evidence)) {
        // Idempotent identical replay - a safe no-op.
        return existing;
      }

      throw new EvidenceReferenceConflictError(
        evidence.evidenceId,
        "an existing record under this evidenceId already differs from the given evidence reference - record can never silently overwrite or coexist with a non-identical record",
      );
    });
  }

  get(
    tenantId: TenantScope["tenantId"],
    evidenceId: EvidenceReference["evidenceId"],
  ): StoredEvidenceReference | undefined {
    return this.withTenantLock(tenantId, () => this.readAll(tenantId)[evidenceId]);
  }

  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredEvidenceReference> {
    return this.withTenantLock(tenantId, () => Object.values(this.readAll(tenantId)));
  }
}
