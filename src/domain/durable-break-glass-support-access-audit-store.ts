import { mkdirSync, readFileSync, writeFileSync, existsSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createTenantScope, type TenantScope } from "./tenant-scope.js";
import type { BreakGlassSupportAccessAudit, BreakGlassSupportViewKind } from "./break-glass-support-access.js";

/**
 * C7 (gap scan 2026-10-23): OS-V1-09.md's own non-scope names "a durable
 * break-glass grant/audit STORE" as a follow-on. This is the AUDIT half
 * (the grant half is `durable-break-glass-access-grant-store.ts`).
 *
 * A dedicated store for `BreakGlassSupportAccessAudit` - the mandatory
 * evidence `authorizeBreakGlassSupportAccess` attaches to every `GRANTED`
 * decision. It deliberately does NOT reuse `FileDurableAuditLog`: that
 * store persists `AuditEvent` (an OutcomeJob-shaped record with
 * customerId/jobId/projectId/eventType/relatedRefs), which has no place
 * for auditRef/grantId/supportTenantId/requestedView/decidedByPrincipalRef.
 * What it DOES reuse, verbatim, is `FileDurableAuditLog`'s technique:
 * - one JSON array file per TARGET tenant (`targetTenantId` - the tenant
 *   whose data was viewed) under `baseDir`;
 * - a single GLOBAL `linkSync` lock (never per-tenant) serializing every
 *   `append`;
 * - a SEPARATE global uniqueness index file
 *   (`__global-audit-ref-index__.json`) holding every `auditRef` ever
 *   appended across every tenant, so `auditRef` uniqueness is global, not
 *   per-tenant - the REV216/AUDIT-DURABLE-001 F1 correction, applied here
 *   from the start rather than as a later fix (checking only the current
 *   tenant's own file would let the same `auditRef` be appended once per
 *   tenant);
 * - reads (`findByTargetTenant`) take the same global lock, because a
 *   whole-file `writeFileSync` is not atomic (the PR #167 torn-read
 *   correction);
 * - full structural revalidation of every persisted record on every read,
 *   with the canonical-trim invariant (`value.trim() !== value` fails
 *   closed).
 *
 * `append` runs the SAME validation on its input before anything is
 * written, so a record this store accepts is always one it can read back -
 * an invalid record can never be persisted and then poison every later
 * read of its tenant's file.
 *
 * Append-only: there is no update and no delete.
 *
 * Zero new dependency: `node:fs`/`node:crypto` only.
 */

export class CorruptedBreakGlassSupportAccessAuditFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable break-glass support-access audit file (${filePath}): ${reason}`);
    this.name = "CorruptedBreakGlassSupportAccessAuditFileError";
  }
}

export class InvalidBreakGlassSupportAccessAuditError extends Error {
  constructor(reason: string) {
    super(`Invalid break-glass support-access audit record: ${reason}`);
    this.name = "InvalidBreakGlassSupportAccessAuditError";
  }
}

/** Its own class, never `DuplicateAuditEventError` - that error's identity belongs to the unrelated `AuditLog` port. */
export class DuplicateBreakGlassSupportAccessAuditError extends Error {
  constructor(auditRef: string) {
    super(`Break-glass support-access audit "${auditRef}" has already been appended - the audit log is append-only`);
    this.name = "DuplicateBreakGlassSupportAccessAuditError";
  }
}

export class BreakGlassSupportAccessAuditLockTimeoutError extends Error {
  constructor(reason: string) {
    super(`Timed out waiting for the durable break-glass support-access audit lock: ${reason}`);
    this.name = "BreakGlassSupportAccessAuditLockTimeoutError";
  }
}

/**
 * The recognized view kinds, pinned to the frozen domain union at compile
 * time: `satisfies Record<BreakGlassSupportViewKind, true>` fails to
 * compile if a kind is missing here or a kind not in the union is added,
 * so this can never drift from `break-glass-support-access.ts`.
 */
const RECOGNIZED_VIEW_KINDS = {
  TASK: true,
  CONNECTION: true,
  QUOTA: true,
  APPROVALS: true,
  AUDIT_EVIDENCE: true,
} as const satisfies Record<BreakGlassSupportViewKind, true>;

function isRecognizedViewKind(value: unknown): value is BreakGlassSupportViewKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RECOGNIZED_VIEW_KINDS, value);
}

const ALLOWED_AUDIT_KEYS: ReadonlySet<string> = new Set([
  "auditRef",
  "grantId",
  "supportTenantId",
  "targetTenantId",
  "requestedView",
  "decidedByPrincipalRef",
  "decidedAt",
]);

function requireCanonicalString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.trim() !== value) {
    throw new Error(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

/** Pure (no I/O): every error it throws is a validation failure, wrapped by each caller in its own error type. */
function rebuildAudit(raw: unknown, expectedTargetTenantId: TenantScope["tenantId"] | undefined): BreakGlassSupportAccessAudit {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("each record must be a JSON object, not an array or primitive");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_AUDIT_KEYS.has(key)) {
      throw new Error(`record carries an unknown field "${key}"`);
    }
  }
  const auditRef = requireCanonicalString(record["auditRef"], "auditRef");
  const grantId = requireCanonicalString(record["grantId"], `record "${auditRef}".grantId`);
  const supportTenantId = createTenantScope(record["supportTenantId"]).tenantId;
  const targetTenantId = createTenantScope(record["targetTenantId"]).tenantId;
  if (expectedTargetTenantId !== undefined && targetTenantId !== expectedTargetTenantId) {
    throw new Error(
      `record "${auditRef}" is stored under tenant file "${expectedTargetTenantId}" but its own targetTenantId is "${targetTenantId}" - cross-tenant record contamination`,
    );
  }
  const requestedView = record["requestedView"];
  if (!isRecognizedViewKind(requestedView)) {
    throw new Error(`record "${auditRef}".requestedView must be one of ${Object.keys(RECOGNIZED_VIEW_KINDS).join(", ")}`);
  }
  const decidedByPrincipalRef = requireCanonicalString(record["decidedByPrincipalRef"], `record "${auditRef}".decidedByPrincipalRef`);
  const decidedAt = requireCanonicalString(record["decidedAt"], `record "${auditRef}".decidedAt`);
  if (Number.isNaN(Date.parse(decidedAt))) {
    throw new Error(`record "${auditRef}".decidedAt must be a valid ISO timestamp`);
  }
  return { auditRef, grantId, supportTenantId, targetTenantId, requestedView, decidedByPrincipalRef, decidedAt };
}

function validatePersistedAudit(raw: unknown, expectedTargetTenantId: TenantScope["tenantId"], filePath: string): BreakGlassSupportAccessAudit {
  try {
    return rebuildAudit(raw, expectedTargetTenantId);
  } catch (cause) {
    throw new CorruptedBreakGlassSupportAccessAuditFileError(filePath, (cause as Error).message);
  }
}

/** The durable break-glass audit store's contract: append-only, plus a per-target-tenant read. */
export interface DurableBreakGlassSupportAccessAuditStore {
  append(audit: BreakGlassSupportAccessAudit): void;
  findByTargetTenant(targetTenantScope: TenantScope): ReadonlyArray<BreakGlassSupportAccessAudit>;
}

export class FileDurableBreakGlassSupportAccessAuditStore implements DurableBreakGlassSupportAccessAuditStore {
  private readonly baseDir: string;
  private static readonly LOCK_TIMEOUT_MS = 5000;
  private static readonly LOCK_RETRY_BACKOFF_MS = 5;

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

  /** One fixed lock path - deliberately NOT keyed by tenant, so `auditRef` uniqueness serializes across every tenant. */
  private globalLockPath(): string {
    return join(this.lockDir(), "__global__.lock");
  }

  private globalIndexPath(): string {
    return join(this.baseDir, "__global-audit-ref-index__.json");
  }

  /** `FileDurableAuditLog.withGlobalLock`, cloned verbatim (Rev94 F1's `linkSync` primitive). */
  private withGlobalLock<T>(criticalSection: () => T): T {
    const lockPath = this.globalLockPath();
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, String(process.pid), "utf8");
    const deadline = Date.now() + FileDurableBreakGlassSupportAccessAuditStore.LOCK_TIMEOUT_MS;
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
        if (Date.now() > deadline) {
          try {
            unlinkSync(tmpPath);
          } catch {
            // best-effort cleanup only
          }
          throw new BreakGlassSupportAccessAuditLockTimeoutError("global audit lock");
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FileDurableBreakGlassSupportAccessAuditStore.LOCK_RETRY_BACKOFF_MS);
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

  private readGlobalIndex(): string[] {
    const filePath = this.globalIndexPath();
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      throw new CorruptedBreakGlassSupportAccessAuditFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (!Array.isArray(parsed)) {
      throw new CorruptedBreakGlassSupportAccessAuditFileError(filePath, "file content must be a JSON array of auditRef strings");
    }
    return parsed.map((raw, index) => {
      try {
        return requireCanonicalString(raw, `globalIndex[${index}]`);
      } catch (cause) {
        throw new CorruptedBreakGlassSupportAccessAuditFileError(filePath, (cause as Error).message);
      }
    });
  }

  private writeGlobalIndex(auditRefs: ReadonlyArray<string>): void {
    writeFileSync(this.globalIndexPath(), JSON.stringify(auditRefs), "utf8");
  }

  private readAll(tenantId: TenantScope["tenantId"]): BreakGlassSupportAccessAudit[] {
    const filePath = this.filePathFor(tenantId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      throw new CorruptedBreakGlassSupportAccessAuditFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (!Array.isArray(parsed)) {
      throw new CorruptedBreakGlassSupportAccessAuditFileError(filePath, "file content must be a JSON array of audit records");
    }
    return parsed.map((raw) => validatePersistedAudit(raw, tenantId, filePath));
  }

  private writeAll(tenantId: TenantScope["tenantId"], audits: ReadonlyArray<BreakGlassSupportAccessAudit>): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(audits), "utf8");
  }

  append(audit: BreakGlassSupportAccessAudit): void {
    let validated: BreakGlassSupportAccessAudit;
    try {
      validated = rebuildAudit(audit, undefined);
    } catch (cause) {
      throw new InvalidBreakGlassSupportAccessAuditError((cause as Error).message);
    }
    this.withGlobalLock(() => {
      const globalIndex = this.readGlobalIndex();
      if (globalIndex.includes(validated.auditRef)) {
        throw new DuplicateBreakGlassSupportAccessAuditError(validated.auditRef);
      }
      const audits = this.readAll(validated.targetTenantId);
      this.writeAll(validated.targetTenantId, [...audits, validated]);
      this.writeGlobalIndex([...globalIndex, validated.auditRef]);
    });
  }

  findByTargetTenant(targetTenantScope: TenantScope): ReadonlyArray<BreakGlassSupportAccessAudit> {
    return this.withGlobalLock(() => this.readAll(targetTenantScope.tenantId));
  }
}
