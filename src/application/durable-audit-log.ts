import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TenantScope } from "../domain/tenant-scope.js";
import type { AuditEvent } from "../domain/audit-event.js";
import { DuplicateAuditEventError } from "./in-memory-audit-log.js";
import type { AuditLog } from "../ports/audit-log.js";

/**
 * AUDIT-DURABLE-001 (Brain continuation, PR #145 comment `6205619559`,
 * after REV216/PR #161's own F1/F2 correction round closed): the existing
 * `AuditLog` port (`src/ports/audit-log.ts`, named directly from
 * `InMemoryAuditLog`'s own pre-existing contract) has never had a
 * production-shaped implementation - `in-memory-audit-log.ts`'s own doc
 * comment discloses "production durable audit storage is deferred."
 * `buildClientProjectSnapshot`/`buildDeliveryTimeline` already have a real
 * `auditEvents` consumer with no durable source behind it, so the
 * customer-facing delivery timeline has been permanently empty by
 * construction, not by genuine absence of audit activity.
 *
 * Clones this repository's own established file-durable-store discipline
 * exactly (`FileDurableCustomerRepository`, `FileDurableProjectStore`):
 * one JSON file per tenant under `baseDir`, a real cross-process
 * `linkSync` mutual-exclusion lock (Rev94 F1's own primitive) around the
 * read-check-append-write critical section, `Object.create(null)`-free
 * plain-array storage (no caller-supplied key ever becomes an object
 * property here, so there is no prototype-pollution surface to defend -
 * unlike the dictionary-keyed stores, this one is a flat JSON array), and
 * full structural revalidation of every persisted record on every read,
 * applying `PROJ-DURABLE-001`'s own F1 canonical-trim invariant
 * (`value.trim() !== value` fails closed) from the start rather than as a
 * later fix.
 *
 * `DuplicateAuditEventError` is imported and reused verbatim from
 * `in-memory-audit-log.ts` rather than redefined here - both
 * implementations of the SAME `AuditLog` port throw the exact same error
 * type for the exact same precondition, so a caller's `instanceof` check
 * works identically regardless of which implementation is wired in.
 *
 * Append-only, never update/delete, matching the port's own contract
 * exactly: `append` is the sole write path, and it is idempotent-rejecting
 * (a duplicate `eventId` throws rather than silently overwriting or
 * silently no-op-succeeding) - proven under real concurrent-process load
 * by this checkpoint's own multi-process race test, not merely asserted.
 *
 * REV216/AUDIT-DURABLE-001 F1 correction (Brain CHANGES_REQUIRED, PR #162
 * comment `6211081375`): `InMemoryAuditLog`'s own `#seenEventIds` is a
 * SINGLE global `Set`, not one per tenant - `eventId` uniqueness is
 * global across the entire log, not scoped to a tenant. The original
 * version of this module checked duplicates only inside the current
 * tenant's own file, so the identical `eventId` could be appended once
 * per tenant without ever colliding - adapter-dependent behavior behind
 * the same `AuditLog` port, with no canonical/domain evidence that
 * tenant-scoped uniqueness was ever the intended contract. Corrected to
 * preserve the pre-existing global-uniqueness semantics exactly: a
 * second, separate global index file (`__global-event-index__.json`,
 * the full set of every `eventId` ever appended across every tenant) is
 * read-checked-written under a single GLOBAL lock (not per-tenant) that
 * serializes every `append` call system-wide, exactly mirroring how
 * `InMemoryAuditLog`'s own single-threaded, single-`Set` design already
 * serializes every append in-process. `findByTenant` is entirely
 * unaffected - reads remain lock-free, single-tenant-file reads, so
 * tenant read isolation is not weakened by this fix.
 */

export class CorruptedAuditEventRecordFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable AuditEvent record file (${filePath}): ${reason}`);
    this.name = "CorruptedAuditEventRecordFileError";
  }
}

export class AuditLogLockTimeoutError extends Error {
  constructor(reason: string) {
    super(`Timed out waiting for the durable AuditLog lock: ${reason}`);
    this.name = "AuditLogLockTimeoutError";
  }
}

function fail(filePath: string, reason: string): never {
  throw new CorruptedAuditEventRecordFileError(filePath, reason);
}

function requireNonEmptyString(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  if (value.trim() !== value) {
    fail(filePath, `${field} must not contain leading or trailing whitespace`);
  }
  return value as string;
}

/**
 * Persisted state is an external/untrusted boundary on replay, exactly
 * like every other durable store in this repository. Every structural
 * invariant `audit-event.ts`'s own `createAuditEvent` enforces at
 * construction time is re-checked here: non-empty, canonically-trimmed
 * `eventId`/`actorRef`/`eventType`/`timestamp` (and `reason` when
 * present), a `tenantId` matching the tenant file it was read from
 * (cross-tenant contamination), and a `relatedRefs` array of
 * canonically-trimmed, non-empty strings. `customerId`/`jobId`/
 * `projectId` are structurally required non-empty strings too - `audit-
 * event.ts` derives them from the source `OutcomeJob` at construction
 * time rather than validating them itself, but a replayed record has no
 * live `OutcomeJob` to derive from, so this boundary enforces the same
 * non-empty/canonical-trim floor directly.
 */
function validatePersistedAuditEvent(raw: unknown, expectedTenantId: TenantScope["tenantId"], filePath: string): AuditEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, "each record must be a JSON object, not an array or primitive");
  }
  const record = raw as Record<string, unknown>;

  const eventId = requireNonEmptyString(record["eventId"], "eventId", filePath);
  const tenantId = requireNonEmptyString(record["tenantId"], `record "${eventId}".tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${eventId}" is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant record contamination`,
    );
  }
  const customerId = requireNonEmptyString(record["customerId"], `record "${eventId}".customerId`, filePath);
  const jobId = requireNonEmptyString(record["jobId"], `record "${eventId}".jobId`, filePath);
  const projectId = requireNonEmptyString(record["projectId"], `record "${eventId}".projectId`, filePath);
  const actorRef = requireNonEmptyString(record["actorRef"], `record "${eventId}".actorRef`, filePath);
  const eventType = requireNonEmptyString(record["eventType"], `record "${eventId}".eventType`, filePath);
  const timestamp = requireNonEmptyString(record["timestamp"], `record "${eventId}".timestamp`, filePath);

  let reason: string | undefined;
  if (record["reason"] !== undefined) {
    reason = requireNonEmptyString(record["reason"], `record "${eventId}".reason`, filePath);
  }

  if (!Array.isArray(record["relatedRefs"])) {
    fail(filePath, `record "${eventId}".relatedRefs must be an array of strings`);
  }
  const relatedRefs = (record["relatedRefs"] as unknown[]).map((ref, index) =>
    requireNonEmptyString(ref, `record "${eventId}".relatedRefs[${index}]`, filePath),
  );

  return {
    eventId: eventId as AuditEvent["eventId"],
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as AuditEvent["customerId"],
    jobId: jobId as AuditEvent["jobId"],
    projectId: projectId as AuditEvent["projectId"],
    actorRef,
    eventType,
    timestamp,
    ...(reason !== undefined ? { reason } : {}),
    relatedRefs,
  };
}

/**
 * Reference/local durable implementation of the EXISTING `AuditLog` port
 * using only Node's built-in `node:fs`/`node:crypto` - no new runtime
 * dependency, matching every other durable store in this repository. One
 * JSON array file per tenant under `baseDir`. Every read reconstructs the
 * full tenant event list from disk, proving restart-safety by
 * construction.
 */
export class FileDurableAuditLog implements AuditLog {
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

  /**
   * One single, fixed lock path - deliberately NOT keyed by tenant.
   * `append`'s global `eventId`-uniqueness check/write must serialize
   * across every tenant, not just within one, to match `InMemoryAuditLog`'s
   * own global-uniqueness contract (see this module's own F1 doc comment).
   */
  private globalLockPath(): string {
    return join(this.lockDir(), "__global__.lock");
  }

  private globalIndexPath(): string {
    return join(this.baseDir, "__global-event-index__.json");
  }

  /** Rev94 F1's exact `linkSync` atomic-creation primitive, cloned verbatim. */
  private withGlobalLock<T>(criticalSection: () => T): T {
    const lockPath = this.globalLockPath();
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, String(process.pid), "utf8");
    const deadline = Date.now() + FileDurableAuditLog.LOCK_TIMEOUT_MS;
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
          throw new AuditLogLockTimeoutError("global append lock");
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FileDurableAuditLog.LOCK_RETRY_BACKOFF_MS);
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
   * The global `eventId` index: every `eventId` ever appended, across
   * every tenant - exists solely to prove uniqueness cheaply without
   * reading every tenant file on every append. It is NEVER consulted by
   * `findByTenant` (reads stay single-tenant-file, lock-free, exactly as
   * before this correction) - only `append`'s own global lock touches it.
   */
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
      throw new CorruptedAuditEventRecordFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (!Array.isArray(parsed)) {
      throw new CorruptedAuditEventRecordFileError(filePath, "file content must be a JSON array of eventId strings");
    }
    return parsed.map((raw, index) => requireNonEmptyString(raw, `globalIndex[${index}]`, filePath));
  }

  private writeGlobalIndex(eventIds: ReadonlyArray<string>): void {
    writeFileSync(this.globalIndexPath(), JSON.stringify(eventIds), "utf8");
  }

  private readAll(tenantId: TenantScope["tenantId"]): AuditEvent[] {
    const filePath = this.filePathFor(tenantId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      throw new CorruptedAuditEventRecordFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (!Array.isArray(parsed)) {
      throw new CorruptedAuditEventRecordFileError(filePath, "file content must be a JSON array of AuditEvent records");
    }
    return parsed.map((raw) => validatePersistedAuditEvent(raw, tenantId, filePath));
  }

  private writeAll(tenantId: TenantScope["tenantId"], events: ReadonlyArray<AuditEvent>): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(events), "utf8");
  }

  append(event: AuditEvent): void {
    this.withGlobalLock(() => {
      const globalIndex = this.readGlobalIndex();
      if (globalIndex.includes(event.eventId)) {
        throw new DuplicateAuditEventError(event.eventId);
      }
      const events = this.readAll(event.tenantId);
      this.writeAll(event.tenantId, [...events, event]);
      this.writeGlobalIndex([...globalIndex, event.eventId]);
    });
  }

  findByTenant(tenantScope: TenantScope): ReadonlyArray<AuditEvent> {
    return this.readAll(tenantScope.tenantId);
  }
}
