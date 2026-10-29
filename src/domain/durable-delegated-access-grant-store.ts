import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, linkSync, unlinkSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createTenantScope, type TenantScope } from "./tenant-scope.js";
import { revokeDelegatedAccessGrant, type DelegatedAccessGrant, type DelegatedAccessGrantLifecycleState } from "./delegated-access-grant.js";
import type { Permission } from "./authority.js";

/**
 * D12 (delegated-access half; the org-switch half remains D12/genuine
 * architecture): OS-V1-02's own `DelegatedAccessGrant` lifecycle floor had
 * no durable store, and the gap-scan's original D12 entry deliberately
 * deferred building one "under C4's banner" to avoid pre-empting C7's own
 * separately-reserved break-glass grant/audit store decision. C7 (PR #191)
 * is now merged, so that sequencing concern is resolved; this is the
 * reserved follow-on. A structural clone of
 * `FileDurableBreakGlassAccessGrantStore`'s exact technique, adapted to
 * `DelegatedAccessGrant`:
 * - one append-only `.delegation.jsonl` log per tenant under `baseDir`
 *   (a grant is keyed by `(tenantId, delegationId)`);
 * - a `linkSync`-based single-winner CREATION claim per `(tenantId,
 *   delegationId)` (`putIfAbsentGrant`);
 * - a `linkSync`-based single-winner REVISION claim per `(tenantId,
 *   delegationId)` (`reviseGrant`) - `ACTIVE` -> `REVOKED` only, every other
 *   field unchanged;
 * - a coarser per-tenant file lock around every read and every append;
 * - "latest wins" reads over the full append log;
 * - full structural revalidation of every persisted grant on every read.
 *
 * One deliberate difference from the break-glass store: `createDelegatedAccessGrant`
 * (`delegated-access-grant.ts`) requires the delegator's own CURRENT, full
 * `OrganizationMembership` and `AuthorityContext` as inputs - ephemeral
 * mint-time evidence this store never persists and cannot reconstruct later,
 * so creation revalidation here cannot replay that constructor the way the
 * break-glass store replays `createBreakGlassAccessGrant`. This is safe
 * without it: `resolveEffectiveDelegatedAccess` never trusts a stored
 * grant's own `permissions` in isolation - it always re-resolves the
 * delegator's CURRENT effective access fresh and intersects the grant's
 * permissions against it at resolution time, so a stale or even
 * over-broad stored `permissions` set can never grant more than the
 * delegator currently, actually holds. This store's own revalidation is
 * therefore a structural floor only (non-empty/trimmed identifiers, valid
 * ISO timestamps with `expiresAt` strictly after `issuedAt`, `permissions`
 * drawn only from the three real `Permission` literals, a recognized
 * `state`) - not a re-proof of the subset-of-delegator-authority invariant,
 * which is mint-time-only and structurally unverifiable from storage alone.
 * The REVISION path has no such limitation: `revokeDelegatedAccessGrant`
 * needs only the grant itself plus `revokedAt`/`revokedReason`, so revision
 * replay DOES go through the real, frozen domain constructor, exactly like
 * every other durable store in this repository.
 *
 * Zero new dependency: `node:fs`/`node:crypto` only.
 */

export class InvalidDurableDelegatedAccessGrantStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableDelegatedAccessGrantStore operation: ${reason}`);
    this.name = "InvalidDurableDelegatedAccessGrantStoreError";
  }
}

export class CorruptedDelegatedAccessGrantLineError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable delegated access grant line (${filePath}): ${reason}`);
    this.name = "CorruptedDelegatedAccessGrantLineError";
  }
}

/** A different grant is already recorded under the same `(tenantId, delegationId)`. */
export class DuplicateDelegatedAccessGrantError extends Error {
  constructor(delegationId: string) {
    super(`A different delegated access grant is already recorded under delegationId "${delegationId}"`);
    this.name = "DuplicateDelegatedAccessGrantError";
  }
}

/** `reviseGrant` was asked to revise a `(tenantId, delegationId)` with no durable grant. */
export class DelegatedAccessGrantNotFoundError extends Error {
  constructor(delegationId: string) {
    super(`No durable delegated access grant exists under delegationId "${delegationId}"`);
    this.name = "DelegatedAccessGrantNotFoundError";
  }
}

export interface PersistResult<T> {
  readonly value: T;
  readonly created: boolean;
}

const ALLOWED_GRANT_KEYS: ReadonlySet<string> = new Set([
  "delegationId",
  "tenantId",
  "organizationId",
  "delegatorMembershipId",
  "delegatorPrincipalRef",
  "delegatePrincipalRef",
  "permissions",
  "canPerformProtectedActions",
  "projectId",
  "issuedAt",
  "expiresAt",
  "state",
  "revokedAt",
  "revokedReason",
]);

const CANONICAL_TRIM_FIELDS: ReadonlyArray<string> = [
  "delegationId",
  "delegatorMembershipId",
  "delegatorPrincipalRef",
  "delegatePrincipalRef",
  "projectId",
  "issuedAt",
  "expiresAt",
  "revokedAt",
];

const VALID_PERMISSIONS: ReadonlySet<string> = new Set(["READ", "WRITE", "EXECUTE"]);

function requireNonEmptyTrimmed(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty string with no leading or trailing whitespace`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyTrimmed(value, field);
  if (Number.isNaN(Date.parse(raw))) {
    throw new Error(`${field} must be a valid ISO timestamp`);
  }
  return raw;
}

/**
 * Structural-only revalidation (see this module's own doc comment for why
 * this cannot replay `createDelegatedAccessGrant` itself). Rebuilds a
 * `DelegatedAccessGrant` from an untrusted object, rejecting unknown
 * fields, untrimmed identifiers, invalid timestamps/ordering, an
 * unrecognized permission literal, or an unrecognized `state`.
 */
function rebuildGrant(raw: unknown, expectedTenantId: TenantScope["tenantId"]): DelegatedAccessGrant {
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

  const delegationId = requireNonEmptyTrimmed(record["delegationId"], "delegationId");
  const tenantScope = createTenantScope(record["tenantId"]);
  if (tenantScope.tenantId !== expectedTenantId) {
    throw new Error(
      `grant is stored under tenant "${expectedTenantId}" but its own tenantId is "${tenantScope.tenantId}" - cross-tenant contamination`,
    );
  }
  const organizationId = requireNonEmptyTrimmed(record["organizationId"], "organizationId");
  const delegatorMembershipId = requireNonEmptyTrimmed(record["delegatorMembershipId"], "delegatorMembershipId");
  const delegatorPrincipalRef = requireNonEmptyTrimmed(record["delegatorPrincipalRef"], "delegatorPrincipalRef");
  const delegatePrincipalRef = requireNonEmptyTrimmed(record["delegatePrincipalRef"], "delegatePrincipalRef");

  if (!Array.isArray(record["permissions"])) {
    throw new Error("permissions must be an array");
  }
  const permissions = new Set<Permission>();
  for (const permission of record["permissions"] as unknown[]) {
    if (typeof permission !== "string" || !VALID_PERMISSIONS.has(permission)) {
      throw new Error(`permissions must only contain "READ", "WRITE", or "EXECUTE"; got ${JSON.stringify(permission)}`);
    }
    permissions.add(permission as Permission);
  }

  if (typeof record["canPerformProtectedActions"] !== "boolean") {
    throw new Error("canPerformProtectedActions must be a boolean");
  }

  const issuedAt = requireValidTimestamp(record["issuedAt"], "issuedAt");
  const expiresAt = requireValidTimestamp(record["expiresAt"], "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new Error("expiresAt must be strictly after issuedAt");
  }

  const projectIdRaw = record["projectId"];
  const projectId = projectIdRaw === undefined ? undefined : requireNonEmptyTrimmed(projectIdRaw, "projectId");

  const state = record["state"];
  if (state !== "ACTIVE" && state !== "REVOKED") {
    throw new Error('state must be exactly "ACTIVE" or "REVOKED"');
  }

  const base: DelegatedAccessGrant = {
    delegationId: delegationId as DelegatedAccessGrant["delegationId"],
    tenantId: tenantScope.tenantId,
    organizationId: organizationId as DelegatedAccessGrant["organizationId"],
    delegatorMembershipId: delegatorMembershipId as DelegatedAccessGrant["delegatorMembershipId"],
    delegatorPrincipalRef,
    delegatePrincipalRef,
    permissions,
    canPerformProtectedActions: record["canPerformProtectedActions"] as boolean,
    ...(projectId !== undefined ? { projectId } : {}),
    issuedAt,
    expiresAt,
    state: state as DelegatedAccessGrantLifecycleState,
  };

  if (state === "ACTIVE") {
    if (record["revokedAt"] !== undefined || record["revokedReason"] !== undefined) {
      throw new Error("an ACTIVE grant must not carry revokedAt/revokedReason");
    }
    return base;
  }
  // REVOKED: replay through the real domain transition so a persisted
  // REVOKED grant is valid if and only if the frozen domain itself would
  // have produced it.
  return revokeDelegatedAccessGrant({
    grant: { ...base, state: "ACTIVE" },
    revokedAt: record["revokedAt"],
    revokedReason: record["revokedReason"],
  });
}

function isValidationError(cause: unknown): cause is Error {
  return cause instanceof Error;
}

function validatePersistedGrant(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  filePath: string,
): { delegationId: string; grant: DelegatedAccessGrant } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CorruptedDelegatedAccessGrantLineError(filePath, "line must be a JSON object, not an array or primitive");
  }
  const outer = raw as Record<string, unknown>;
  const delegationId = outer["delegationId"];
  if (typeof delegationId !== "string" || delegationId.trim().length === 0) {
    throw new CorruptedDelegatedAccessGrantLineError(filePath, "delegationId must be a non-empty string");
  }
  let grant: DelegatedAccessGrant;
  try {
    grant = rebuildGrant(outer["grant"], expectedTenantId);
  } catch (cause) {
    if (isValidationError(cause)) {
      throw new CorruptedDelegatedAccessGrantLineError(filePath, `grant "${delegationId}": ${cause.message}`);
    }
    throw cause;
  }
  if (grant.delegationId !== delegationId) {
    throw new CorruptedDelegatedAccessGrantLineError(filePath, `grant "${delegationId}".grant.delegationId does not match the line's own key`);
  }
  return { delegationId, grant };
}

function serializeGrant(grant: DelegatedAccessGrant): Record<string, unknown> {
  return { ...grant, permissions: [...grant.permissions].sort() };
}

function grantIdentityEquals(a: DelegatedAccessGrant, b: DelegatedAccessGrant): boolean {
  return JSON.stringify(serializeGrant(a)) === JSON.stringify(serializeGrant(b));
}

/** Every field a revocation must leave untouched. */
function grantImmutableFieldsEqual(a: DelegatedAccessGrant, b: DelegatedAccessGrant): boolean {
  return (
    a.delegationId === b.delegationId &&
    a.tenantId === b.tenantId &&
    a.organizationId === b.organizationId &&
    a.delegatorMembershipId === b.delegatorMembershipId &&
    a.delegatorPrincipalRef === b.delegatorPrincipalRef &&
    a.delegatePrincipalRef === b.delegatePrincipalRef &&
    JSON.stringify([...a.permissions].sort()) === JSON.stringify([...b.permissions].sort()) &&
    a.canPerformProtectedActions === b.canPerformProtectedActions &&
    a.projectId === b.projectId &&
    a.issuedAt === b.issuedAt &&
    a.expiresAt === b.expiresAt
  );
}

/** Mirrors `DurableBreakGlassAccessGrantStore`'s method shape exactly. */
export interface DurableDelegatedAccessGrantStore {
  /**
   * Creates the grant under `(grant.tenantId, grant.delegationId)` exactly
   * once. An identical replay returns `{ created: false }`; a DIFFERENT
   * grant under the same key throws `DuplicateDelegatedAccessGrantError`.
   */
  putIfAbsentGrant(grant: DelegatedAccessGrant): PersistResult<DelegatedAccessGrant>;
  /**
   * Fetches the CURRENT grant fresh, applies `revise` to it, and records the
   * result - single-use per key. The revision must be `REVOKED` with every
   * other field identical to the current `ACTIVE` grant (the real caller is
   * `revokeDelegatedAccessGrant`). Throws `DelegatedAccessGrantNotFoundError`
   * when no grant exists.
   */
  reviseGrant(input: {
    readonly tenantScope: TenantScope;
    readonly delegationId: string;
    readonly revise: (current: DelegatedAccessGrant) => DelegatedAccessGrant;
  }): PersistResult<DelegatedAccessGrant>;
  getGrant(tenantScope: TenantScope, delegationId: string): DelegatedAccessGrant | undefined;
}

export class FileDurableDelegatedAccessGrantStore implements DurableDelegatedAccessGrantStore {
  private readonly baseDir: string;
  private static readonly LOCK_RETRY_BACKOFF_MS = 5;
  private static readonly MAX_LOCK_ATTEMPTS = 1000;
  private static readonly STALE_LOCK_THRESHOLD_MS = 30_000;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.creationLockDir(), { recursive: true });
    mkdirSync(this.revisionLockDir(), { recursive: true });
    mkdirSync(this.fileLockDir(), { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.delegation.jsonl`);
  }

  private creationLockDir(): string {
    return join(this.baseDir, ".delegation-creation-locks");
  }

  private creationLockPathFor(tenantId: TenantScope["tenantId"], delegationId: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const delegationKey = Buffer.from(delegationId, "utf8").toString("base64url");
    return join(this.creationLockDir(), `${tenantKey}.${delegationKey}.lock`);
  }

  private revisionLockDir(): string {
    return join(this.baseDir, ".delegation-revision-locks");
  }

  private revisionLockPathFor(tenantId: TenantScope["tenantId"], delegationId: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const delegationKey = Buffer.from(delegationId, "utf8").toString("base64url");
    return join(this.revisionLockDir(), `${tenantKey}.${delegationKey}.lock`);
  }

  private fileLockDir(): string {
    return join(this.baseDir, ".delegation-file-locks");
  }

  private fileLockPathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.fileLockDir(), `${safeKey}.lock`);
  }

  /** `FileDurableBreakGlassAccessGrantStore.withTenantFileLock`, cloned verbatim. */
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
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > FileDurableDelegatedAccessGrantStore.STALE_LOCK_THRESHOLD_MS) {
            unlinkSync(lockPath);
          }
        } catch {
          // the lock may have just been released, or reclaimed by another
          // waiter, between the EEXIST above and this check - either way,
          // just fall through and retry
        }
        attempts += 1;
        if (attempts >= FileDurableDelegatedAccessGrantStore.MAX_LOCK_ATTEMPTS) {
          try {
            unlinkSync(tmpPath);
          } catch {
            // best-effort cleanup only
          }
          throw new InvalidDurableDelegatedAccessGrantStoreError(
            `timed out waiting for the durable delegated access grant file lock for tenant "${tenantId}"`,
          );
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FileDurableDelegatedAccessGrantStore.LOCK_RETRY_BACKOFF_MS);
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

  private readAll(tenantId: TenantScope["tenantId"]): Array<{ delegationId: string; grant: DelegatedAccessGrant }> {
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
        throw new CorruptedDelegatedAccessGrantLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
      }
      return validatePersistedGrant(parsed, tenantId, filePath);
    });
  }

  /** "Latest wins" over the full append log - a later REVOKED revision always supersedes the ACTIVE creation. */
  private latestByDelegationId(
    records: ReadonlyArray<{ delegationId: string; grant: DelegatedAccessGrant }>,
  ): Map<string, DelegatedAccessGrant> {
    const byId = new Map<string, DelegatedAccessGrant>();
    for (const entry of records) {
      byId.set(entry.delegationId, entry.grant);
    }
    return byId;
  }

  /** Validates a caller-supplied grant with the same rules as replay, before anything is written. */
  private requireValidInputGrant(grant: DelegatedAccessGrant, label: string): DelegatedAccessGrant {
    try {
      return rebuildGrant(serializeGrant(grant), createTenantScope(grant.tenantId).tenantId);
    } catch (cause) {
      if (isValidationError(cause)) {
        throw new InvalidDurableDelegatedAccessGrantStoreError(`${label} is not a valid DelegatedAccessGrant: ${cause.message}`);
      }
      throw cause;
    }
  }

  putIfAbsentGrant(grant: DelegatedAccessGrant): PersistResult<DelegatedAccessGrant> {
    const validated = this.requireValidInputGrant(grant, "grant");
    const tenantId = validated.tenantId;
    const delegationId = validated.delegationId;
    if (validated.state !== "ACTIVE") {
      throw new InvalidDurableDelegatedAccessGrantStoreError(
        "a grant is created ACTIVE - a REVOKED grant is only ever recorded through reviseGrant",
      );
    }

    const existing = this.getGrant(createTenantScope(tenantId), delegationId);
    if (existing !== undefined) {
      if (!grantIdentityEquals(existing, validated)) {
        throw new DuplicateDelegatedAccessGrantError(delegationId);
      }
      return { value: existing, created: false };
    }

    const lockPath = this.creationLockPathFor(tenantId, delegationId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ delegationId, grant: serializeGrant(validated) });
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
        throw new DuplicateDelegatedAccessGrantError(delegationId);
      }
      if (this.getGrant(createTenantScope(tenantId), delegationId) === undefined) {
        this.withTenantFileLock(tenantId, () => appendFileSync(this.filePathFor(tenantId), `${winnerRaw}\n`, "utf8"));
      }
      return { value: winner.grant, created: false };
    }

    this.withTenantFileLock(tenantId, () => appendFileSync(this.filePathFor(tenantId), `${payload}\n`, "utf8"));
    return { value: validated, created: true };
  }

  reviseGrant(input: {
    readonly tenantScope: TenantScope;
    readonly delegationId: string;
    readonly revise: (current: DelegatedAccessGrant) => DelegatedAccessGrant;
  }): PersistResult<DelegatedAccessGrant> {
    const tenantId = input.tenantScope.tenantId;
    const delegationId = input.delegationId;
    if (typeof delegationId !== "string" || delegationId.trim().length === 0) {
      throw new InvalidDurableDelegatedAccessGrantStoreError("delegationId must be a non-empty string");
    }

    const current = this.getGrant(input.tenantScope, delegationId);
    if (current === undefined) {
      throw new DelegatedAccessGrantNotFoundError(delegationId);
    }
    const revision = this.requireValidInputGrant(input.revise(current), "revision");
    if (revision.tenantId !== tenantId || revision.delegationId !== delegationId) {
      throw new InvalidDurableDelegatedAccessGrantStoreError("revision.tenantId/delegationId must exactly match the grant being revised");
    }
    if (current.state !== "ACTIVE") {
      if (grantIdentityEquals(current, revision)) {
        return { value: current, created: false };
      }
      throw new InvalidDurableDelegatedAccessGrantStoreError(`delegationId "${delegationId}" is already REVOKED and cannot be revised again`);
    }
    if (revision.state !== "REVOKED" || !grantImmutableFieldsEqual(current, revision)) {
      throw new InvalidDurableDelegatedAccessGrantStoreError(
        `delegationId "${delegationId}"'s only legitimate revision is ACTIVE -> REVOKED with every other field unchanged`,
      );
    }

    const lockPath = this.revisionLockPathFor(tenantId, delegationId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ delegationId, grant: serializeGrant(revision) });
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
        throw new InvalidDurableDelegatedAccessGrantStoreError(
          `delegationId "${delegationId}" was already revised with different content by a concurrent caller`,
        );
      }
      const latestNow = this.getGrant(input.tenantScope, delegationId);
      if (latestNow === undefined || latestNow.state !== "REVOKED") {
        this.withTenantFileLock(tenantId, () => appendFileSync(this.filePathFor(tenantId), `${winnerRaw}\n`, "utf8"));
      }
      return { value: winner.grant, created: false };
    }

    this.withTenantFileLock(tenantId, () => appendFileSync(this.filePathFor(tenantId), `${payload}\n`, "utf8"));
    return { value: revision, created: true };
  }

  getGrant(tenantScope: TenantScope, delegationId: string): DelegatedAccessGrant | undefined {
    const tenantId = tenantScope.tenantId;
    return this.withTenantFileLock(tenantId, () => this.latestByDelegationId(this.readAll(tenantId)).get(delegationId));
  }
}
