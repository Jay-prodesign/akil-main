import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createTenantScope, type TenantScope } from "./tenant-scope.js";
import {
  createBreakGlassAccessGrant,
  revokeBreakGlassAccessGrant,
  type BreakGlassAccessGrant,
} from "./break-glass-support-access.js";

/**
 * C7 (gap scan 2026-10-23): OS-V1-09.md's own non-scope names "a durable
 * break-glass grant/audit STORE" as a follow-on. This is the GRANT half
 * (the audit half is `durable-break-glass-support-access-audit-store.ts`).
 *
 * A structural clone of `FileDurableProtectedDecisionRecordStore`'s exact
 * technique, adapted to `BreakGlassAccessGrant`:
 * - one append-only `.grant.jsonl` log per TARGET tenant under `baseDir`
 *   (a grant is keyed by `(targetTenantId, grantId)` - the tenant whose
 *   data the grant lets a support principal view, which is also the only
 *   tenant the `/os/admin` route ever looks a grant up under);
 * - a `linkSync`-based single-winner CREATION claim per `(targetTenantId,
 *   grantId)` (`putIfAbsentGrant`) - an identical replay is an idempotent
 *   no-op, a different grant under the same key is a hard conflict;
 * - a `linkSync`-based single-winner REVISION claim per `(targetTenantId,
 *   grantId)` (`reviseGrant`) - a grant may be revised AT MOST ONCE, from
 *   `ACTIVE` to `REVOKED`, with every other field unchanged (mirroring
 *   `reviseDecisionRecord`'s own single legitimate APPROVED -> REVOKED
 *   transition); `REVOKED` is terminal;
 * - a coarser per-tenant file lock around every read and every append
 *   (the PR #167 torn-read correction, cloned verbatim);
 * - "latest wins" reads over the full append log;
 * - full structural revalidation of every persisted grant on every read.
 *
 * Revalidation never duplicates the domain's own rules: every persisted
 * grant is REBUILT through `createBreakGlassAccessGrant` (and, when
 * `REVOKED`, `revokeBreakGlassAccessGrant`) - the exact constructors the
 * frozen domain module already accepts - so a persisted grant is valid if
 * and only if the domain itself would have produced it. A persisted object
 * is never blind-cast to `BreakGlassAccessGrant`. On top of the domain's
 * rules, this boundary adds the repository's own durable-store floor:
 * unknown keys are rejected, the record's own `targetTenantId` must match
 * the tenant file it was read from (cross-tenant contamination), and
 * identifier/timestamp fields must be canonically trimmed (the
 * `PROJ-DURABLE-001` F1 invariant `FileDurableAuditLog` also applies), so
 * an identifier written here can never later fail the break-glass audit
 * store's own canonical-trim revalidation.
 *
 * `putIfAbsentGrant` runs the SAME validation on its input before anything
 * is written, so an invalid hand-built grant can never be persisted and
 * then poison every later read of its tenant's file.
 *
 * Zero new dependency: `node:fs`/`node:crypto` only.
 */

export class InvalidDurableBreakGlassAccessGrantStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableBreakGlassAccessGrantStore operation: ${reason}`);
    this.name = "InvalidDurableBreakGlassAccessGrantStoreError";
  }
}

export class CorruptedBreakGlassAccessGrantLineError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable break-glass access grant line (${filePath}): ${reason}`);
    this.name = "CorruptedBreakGlassAccessGrantLineError";
  }
}

/** A different grant is already recorded under the same `(targetTenantId, grantId)`. */
export class DuplicateBreakGlassAccessGrantError extends Error {
  constructor(grantId: string) {
    super(`A different break-glass access grant is already recorded under grantId "${grantId}"`);
    this.name = "DuplicateBreakGlassAccessGrantError";
  }
}

/** `reviseGrant` was asked to revise a `(targetTenantId, grantId)` with no durable grant. */
export class BreakGlassAccessGrantNotFoundError extends Error {
  constructor(grantId: string) {
    super(`No durable break-glass access grant exists under grantId "${grantId}"`);
    this.name = "BreakGlassAccessGrantNotFoundError";
  }
}

export interface PersistResult<T> {
  readonly value: T;
  readonly created: boolean;
}

const ALLOWED_GRANT_KEYS: ReadonlySet<string> = new Set([
  "grantId",
  "supportTenantId",
  "targetTenantId",
  "grantedToRef",
  "grantedByRef",
  "reason",
  "scope",
  "consentRequired",
  "expiresAt",
  "state",
  "revokedAt",
  "revokedReason",
]);

/** Identifier/timestamp fields that must be canonically trimmed (see this module's doc comment). */
const CANONICAL_TRIM_FIELDS: ReadonlyArray<string> = ["grantId", "grantedToRef", "grantedByRef", "expiresAt", "revokedAt"];

/**
 * Rebuilds a grant from an untrusted object through the domain's own
 * constructors. Pure (no I/O), so every error it throws is a validation
 * failure - `InvalidBreakGlassAccessGrantError`, `InvalidTenantScopeError`,
 * or a local reason - and each caller wraps it in its own error type.
 */
function rebuildGrant(raw: unknown, expectedTargetTenantId: TenantScope["tenantId"]): BreakGlassAccessGrant {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("grant must be a JSON object, not an array or primitive");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_GRANT_KEYS.has(key)) {
      throw new Error(`grant carries an unknown field "${key}"`);
    }
  }
  for (const field of CANONICAL_TRIM_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== value) {
      throw new Error(`${field} must not contain leading or trailing whitespace`);
    }
  }
  const targetTenantScope = createTenantScope(record["targetTenantId"]);
  if (targetTenantScope.tenantId !== expectedTargetTenantId) {
    throw new Error(
      `grant is stored under tenant "${expectedTargetTenantId}" but its own targetTenantId is "${targetTenantScope.tenantId}" - cross-tenant contamination`,
    );
  }
  const supportTenantScope = createTenantScope(record["supportTenantId"]);
  if (!Array.isArray(record["scope"])) {
    throw new Error("scope must be an array");
  }
  const created = createBreakGlassAccessGrant({
    grantId: record["grantId"],
    supportTenantScope,
    targetTenantScope,
    grantedToRef: record["grantedToRef"],
    grantedByRef: record["grantedByRef"],
    reason: record["reason"],
    scope: [...(record["scope"] as unknown[])],
    consentRequired: record["consentRequired"],
    expiresAt: record["expiresAt"],
  });
  const state = record["state"];
  if (state === "ACTIVE") {
    if (record["revokedAt"] !== undefined || record["revokedReason"] !== undefined) {
      throw new Error("an ACTIVE grant must not carry revokedAt/revokedReason");
    }
    return created;
  }
  if (state === "REVOKED") {
    return revokeBreakGlassAccessGrant({ grant: created, revokedAt: record["revokedAt"], revokedReason: record["revokedReason"] });
  }
  throw new Error('state must be exactly "ACTIVE" or "REVOKED"');
}

function isValidationError(cause: unknown): cause is Error {
  return cause instanceof Error;
}

function validatePersistedGrant(
  raw: unknown,
  expectedTargetTenantId: TenantScope["tenantId"],
  filePath: string,
): { grantId: string; grant: BreakGlassAccessGrant } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CorruptedBreakGlassAccessGrantLineError(filePath, "line must be a JSON object, not an array or primitive");
  }
  const outer = raw as Record<string, unknown>;
  const grantId = outer["grantId"];
  if (typeof grantId !== "string" || grantId.trim().length === 0) {
    throw new CorruptedBreakGlassAccessGrantLineError(filePath, "grantId must be a non-empty string");
  }
  let grant: BreakGlassAccessGrant;
  try {
    grant = rebuildGrant(outer["grant"], expectedTargetTenantId);
  } catch (cause) {
    if (isValidationError(cause)) {
      throw new CorruptedBreakGlassAccessGrantLineError(filePath, `grant "${grantId}": ${cause.message}`);
    }
    throw cause;
  }
  if (grant.grantId !== grantId) {
    throw new CorruptedBreakGlassAccessGrantLineError(filePath, `grant "${grantId}".grant.grantId does not match the line's own key`);
  }
  return { grantId, grant };
}

function grantIdentityEquals(a: BreakGlassAccessGrant, b: BreakGlassAccessGrant): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every field a revocation must leave untouched. */
function grantImmutableFieldsEqual(a: BreakGlassAccessGrant, b: BreakGlassAccessGrant): boolean {
  return (
    a.grantId === b.grantId &&
    a.supportTenantId === b.supportTenantId &&
    a.targetTenantId === b.targetTenantId &&
    a.grantedToRef === b.grantedToRef &&
    a.grantedByRef === b.grantedByRef &&
    a.reason === b.reason &&
    JSON.stringify(a.scope) === JSON.stringify(b.scope) &&
    a.consentRequired === b.consentRequired &&
    a.expiresAt === b.expiresAt
  );
}

/**
 * The durable break-glass grant store's contract. Mirrors
 * `DurableProtectedDecisionRecordStore`'s method shape: one creation
 * method, one revision method, one read.
 */
export interface DurableBreakGlassAccessGrantStore {
  /**
   * Creates the grant under `(grant.targetTenantId, grant.grantId)` exactly
   * once. An identical replay returns `{ created: false }`; a DIFFERENT
   * grant under the same key throws `DuplicateBreakGlassAccessGrantError`.
   */
  putIfAbsentGrant(grant: BreakGlassAccessGrant): PersistResult<BreakGlassAccessGrant>;
  /**
   * Fetches the CURRENT grant fresh, applies `revise` to it, and records the
   * result - single-use per key, exactly like `reviseDecisionRecord`. The
   * revision must be `REVOKED` with every other field identical to the
   * current `ACTIVE` grant (the real caller is `revokeBreakGlassAccessGrant`).
   * Throws `BreakGlassAccessGrantNotFoundError` when no grant exists, and
   * propagates any error `revise` itself throws (for example
   * `InvalidBreakGlassAccessGrantError` when revoking an already-revoked
   * grant).
   */
  reviseGrant(input: {
    readonly targetTenantScope: TenantScope;
    readonly grantId: string;
    readonly revise: (current: BreakGlassAccessGrant) => BreakGlassAccessGrant;
  }): PersistResult<BreakGlassAccessGrant>;
  getGrant(targetTenantScope: TenantScope, grantId: string): BreakGlassAccessGrant | undefined;
}

export class FileDurableBreakGlassAccessGrantStore implements DurableBreakGlassAccessGrantStore {
  private readonly baseDir: string;
  private static readonly LOCK_RETRY_BACKOFF_MS = 5;
  private static readonly MAX_LOCK_ATTEMPTS = 1000;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.creationLockDir(), { recursive: true });
    mkdirSync(this.revisionLockDir(), { recursive: true });
    mkdirSync(this.fileLockDir(), { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.grant.jsonl`);
  }

  private creationLockDir(): string {
    return join(this.baseDir, ".grant-creation-locks");
  }

  private creationLockPathFor(tenantId: TenantScope["tenantId"], grantId: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const grantKey = Buffer.from(grantId, "utf8").toString("base64url");
    return join(this.creationLockDir(), `${tenantKey}.${grantKey}.lock`);
  }

  private revisionLockDir(): string {
    return join(this.baseDir, ".grant-revision-locks");
  }

  private revisionLockPathFor(tenantId: TenantScope["tenantId"], grantId: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const grantKey = Buffer.from(grantId, "utf8").toString("base64url");
    return join(this.revisionLockDir(), `${tenantKey}.${grantKey}.lock`);
  }

  private fileLockDir(): string {
    return join(this.baseDir, ".grant-file-locks");
  }

  private fileLockPathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.fileLockDir(), `${safeKey}.lock`);
  }

  /** `FileDurableProtectedDecisionRecordStore.withTenantFileLock`, cloned verbatim (Rev94 F1's primitive). */
  private withTenantFileLock<T>(tenantId: TenantScope["tenantId"], criticalSection: () => T): T {
    const lockPath = this.fileLockPathFor(tenantId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, String(process.pid), "utf8");
    let attempts = 0;
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
        attempts += 1;
        if (attempts >= FileDurableBreakGlassAccessGrantStore.MAX_LOCK_ATTEMPTS) {
          try {
            unlinkSync(tmpPath);
          } catch {
            // best-effort cleanup only
          }
          throw new InvalidDurableBreakGlassAccessGrantStoreError(
            `timed out waiting for the durable break-glass grant file lock for tenant "${tenantId}"`,
          );
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FileDurableBreakGlassAccessGrantStore.LOCK_RETRY_BACKOFF_MS);
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

  private readAll(tenantId: TenantScope["tenantId"]): Array<{ grantId: string; grant: BreakGlassAccessGrant }> {
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
        throw new CorruptedBreakGlassAccessGrantLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
      }
      return validatePersistedGrant(parsed, tenantId, filePath);
    });
  }

  /** "Latest wins" over the full append log - a later REVOKED revision always supersedes the ACTIVE creation. */
  private latestByGrantId(records: ReadonlyArray<{ grantId: string; grant: BreakGlassAccessGrant }>): Map<string, BreakGlassAccessGrant> {
    const byId = new Map<string, BreakGlassAccessGrant>();
    for (const entry of records) {
      byId.set(entry.grantId, entry.grant);
    }
    return byId;
  }

  /** Validates a caller-supplied grant with the same rules as replay, before anything is written. */
  private requireValidInputGrant(grant: BreakGlassAccessGrant, label: string): BreakGlassAccessGrant {
    try {
      return rebuildGrant(grant, createTenantScope(grant.targetTenantId).tenantId);
    } catch (cause) {
      if (isValidationError(cause)) {
        throw new InvalidDurableBreakGlassAccessGrantStoreError(`${label} is not a valid BreakGlassAccessGrant: ${cause.message}`);
      }
      throw cause;
    }
  }

  putIfAbsentGrant(grant: BreakGlassAccessGrant): PersistResult<BreakGlassAccessGrant> {
    const validated = this.requireValidInputGrant(grant, "grant");
    const tenantId = validated.targetTenantId;
    const grantId = validated.grantId;
    if (validated.state !== "ACTIVE") {
      throw new InvalidDurableBreakGlassAccessGrantStoreError("a grant is created ACTIVE - a REVOKED grant is only ever recorded through reviseGrant");
    }

    const existing = this.getGrant(createTenantScope(tenantId), grantId);
    if (existing !== undefined) {
      if (!grantIdentityEquals(existing, validated)) {
        throw new DuplicateBreakGlassAccessGrantError(grantId);
      }
      return { value: existing, created: false };
    }

    const lockPath = this.creationLockPathFor(tenantId, grantId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ grantId, grant: validated });
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
        // best-effort cleanup only.
      }
    }

    if (!wonCreation) {
      const winnerRaw = readFileSync(lockPath, "utf8");
      const winner = validatePersistedGrant(JSON.parse(winnerRaw), tenantId, lockPath);
      if (!grantIdentityEquals(winner.grant, validated)) {
        throw new DuplicateBreakGlassAccessGrantError(grantId);
      }
      if (this.getGrant(createTenantScope(tenantId), grantId) === undefined) {
        this.withTenantFileLock(tenantId, () => appendFileSync(this.filePathFor(tenantId), `${winnerRaw}\n`, "utf8"));
      }
      return { value: winner.grant, created: false };
    }

    this.withTenantFileLock(tenantId, () => appendFileSync(this.filePathFor(tenantId), `${payload}\n`, "utf8"));
    return { value: validated, created: true };
  }

  reviseGrant(input: {
    readonly targetTenantScope: TenantScope;
    readonly grantId: string;
    readonly revise: (current: BreakGlassAccessGrant) => BreakGlassAccessGrant;
  }): PersistResult<BreakGlassAccessGrant> {
    const tenantId = input.targetTenantScope.tenantId;
    const grantId = input.grantId;
    if (typeof grantId !== "string" || grantId.trim().length === 0) {
      throw new InvalidDurableBreakGlassAccessGrantStoreError("grantId must be a non-empty string");
    }

    const current = this.getGrant(input.targetTenantScope, grantId);
    if (current === undefined) {
      throw new BreakGlassAccessGrantNotFoundError(grantId);
    }
    const revision = this.requireValidInputGrant(input.revise(current), "revision");
    if (revision.targetTenantId !== tenantId || revision.grantId !== grantId) {
      throw new InvalidDurableBreakGlassAccessGrantStoreError("revision.targetTenantId/grantId must exactly match the grant being revised");
    }
    if (current.state !== "ACTIVE") {
      // REVOKED is terminal. A repeat of the SAME already-applied revision
      // is still a safe idempotent no-op; anything else is rejected.
      if (grantIdentityEquals(current, revision)) {
        return { value: current, created: false };
      }
      throw new InvalidDurableBreakGlassAccessGrantStoreError(`grantId "${grantId}" is already REVOKED and cannot be revised again`);
    }
    if (revision.state !== "REVOKED" || !grantImmutableFieldsEqual(current, revision)) {
      throw new InvalidDurableBreakGlassAccessGrantStoreError(
        `grantId "${grantId}"'s only legitimate revision is ACTIVE -> REVOKED with every other field unchanged`,
      );
    }

    const lockPath = this.revisionLockPathFor(tenantId, grantId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ grantId, grant: revision });
    writeFileSync(tmpPath, payload, "utf8");
    let wonRevision: boolean;
    try {
      linkSync(tmpPath, lockPath);
      wonRevision = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      wonRevision = false;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only.
      }
    }

    if (!wonRevision) {
      const winnerRaw = readFileSync(lockPath, "utf8");
      const winner = validatePersistedGrant(JSON.parse(winnerRaw), tenantId, lockPath);
      if (!grantIdentityEquals(winner.grant, revision)) {
        throw new InvalidDurableBreakGlassAccessGrantStoreError(
          `grantId "${grantId}" was already revised with different content by a concurrent caller`,
        );
      }
      const latestNow = this.getGrant(input.targetTenantScope, grantId);
      if (latestNow === undefined || latestNow.state !== "REVOKED") {
        this.withTenantFileLock(tenantId, () => appendFileSync(this.filePathFor(tenantId), `${winnerRaw}\n`, "utf8"));
      }
      return { value: winner.grant, created: false };
    }

    this.withTenantFileLock(tenantId, () => appendFileSync(this.filePathFor(tenantId), `${payload}\n`, "utf8"));
    return { value: revision, created: true };
  }

  getGrant(targetTenantScope: TenantScope, grantId: string): BreakGlassAccessGrant | undefined {
    const tenantId = targetTenantScope.tenantId;
    return this.withTenantFileLock(tenantId, () => this.latestByGrantId(this.readAll(tenantId)).get(grantId));
  }
}
