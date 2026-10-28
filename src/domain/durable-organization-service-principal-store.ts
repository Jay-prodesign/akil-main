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
import {
  revokeOrganizationServicePrincipal,
  type OrganizationServicePrincipal,
} from "./organization-service-principal.js";

/**
 * ORG-SERVICE-PRINCIPAL-DURABLE-001 (Brain continuation, PR #145 comment
 * `6223155547`, issued immediately after `ORG-MEMBERSHIP-DURABLE-001`'s own
 * F1 correction closed): `OrganizationResourceBindingSource` now has real
 * current memberships, Project, and ConnectorConnection truth
 * (`ORG-MEMBERSHIP-DURABLE-001`); its next unresolved real currentness gate
 * is `currentServicePrincipals`, and `organization-service-principal.ts`
 * already has the canonical `ACTIVE -> REVOKED` domain lifecycle but no
 * durable registry/enumeration - the same consumer-driven pattern as
 * memberships, not speculative persistence coverage.
 *
 * Mirrors `durable-organization-membership-store.ts`'s exact established
 * discipline (including its own Brain F1 correction, applied here from the
 * start rather than as a later fix): one JSON file per tenant under
 * `baseDir`, keyed by the plain `servicePrincipalId` (the per-tenant file
 * itself already provides exact tenant isolation - this store is
 * tenant-file SCOPED, not a claim that `servicePrincipalId` is globally
 * unique across tenants), a real cross-process `linkSync` mutual-exclusion
 * lock (Rev94 F1's own primitive, cloned verbatim), full structural
 * revalidation of persisted JSON on every read, and ONE shared
 * `coherenceViolation` check run at BOTH the write boundary (`create`,
 * before any persistence) and on replay, so the two paths can never
 * semantically diverge. `create` and `revoke` are the only two write
 * paths - no expiry/suspension/reactivation/new worker registry is
 * invented. `revoke` does not reimplement the one-way `ACTIVE -> REVOKED`
 * transition rule itself: it reuses `revokeOrganizationServicePrincipal`
 * verbatim (imported, not redefined), under a real optimistic-concurrency
 * version guard that closes the one genuine concurrency hazard a bare
 * in-memory caller cannot - two processes racing to revoke the SAME
 * service principal at the same time.
 *
 * CI/Brain correction (PR #167 batch-merge-review, systemic torn-read
 * finding): `get`/`listByTenant` now acquire the same per-tenant
 * `withTenantLock` as `create`/`revoke`. `writeAll`'s `writeFileSync` is a
 * whole-file truncate-then-write, not atomic - an unlocked reader could
 * observe a torn file mid-write from a concurrent locked writer. Readers
 * and writers now share one mutual exclusion, not just writer-vs-writer.
 */

export class InvalidOrganizationServicePrincipalStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableOrganizationServicePrincipalStore operation: ${reason}`);
    this.name = "InvalidOrganizationServicePrincipalStoreError";
  }
}

export class OrganizationServicePrincipalConflictError extends Error {
  constructor(servicePrincipalId: string, reason: string) {
    super(`OrganizationServicePrincipal "${servicePrincipalId}" conflict: ${reason}`);
    this.name = "OrganizationServicePrincipalConflictError";
  }
}

export class OrganizationServicePrincipalVersionConflictError extends Error {
  constructor(servicePrincipalId: string, expectedVersion: number, actualVersion: number | undefined) {
    super(
      `OrganizationServicePrincipal "${servicePrincipalId}" version conflict: expected ${expectedVersion}, actual ${actualVersion ?? "(none - not yet created)"}`,
    );
    this.name = "OrganizationServicePrincipalVersionConflictError";
  }
}

export class CorruptedOrganizationServicePrincipalFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable OrganizationServicePrincipal file (${filePath}): ${reason}`);
    this.name = "CorruptedOrganizationServicePrincipalFileError";
  }
}

export class OrganizationServicePrincipalLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable OrganizationServicePrincipal lock for tenant "${tenantId}"`);
    this.name = "OrganizationServicePrincipalLockTimeoutError";
  }
}

export interface StoredOrganizationServicePrincipal {
  readonly servicePrincipal: OrganizationServicePrincipal;
  readonly version: number;
}

/**
 * `create` is the sole creation path and is idempotent on an EXACT content
 * replay (safe no-op, never a version bump) - but any existing record under
 * the same `servicePrincipalId` whose content differs even in one field
 * fails closed rather than silently coexisting with or overwriting it.
 * `revoke` is the sole transition path: optimistic-concurrency
 * `expectedVersion` guard, then delegates the transition itself to
 * `revokeOrganizationServicePrincipal` - a stale/incoherent/already-
 * `REVOKED` record is rejected by that function's own pre-existing
 * precondition, not reimplemented here.
 */
export interface DurableOrganizationServicePrincipalStore {
  create(servicePrincipal: OrganizationServicePrincipal): StoredOrganizationServicePrincipal;
  revoke(input: {
    tenantId: TenantScope["tenantId"];
    servicePrincipalId: OrganizationServicePrincipal["servicePrincipalId"];
    expectedVersion: number;
    revokedAt: unknown;
    revokedReason: unknown;
  }): StoredOrganizationServicePrincipal;
  get(
    tenantId: TenantScope["tenantId"],
    servicePrincipalId: OrganizationServicePrincipal["servicePrincipalId"],
  ): StoredOrganizationServicePrincipal | undefined;
  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredOrganizationServicePrincipal>;
}

interface StoredRecordsFile {
  [servicePrincipalId: string]: StoredOrganizationServicePrincipal;
}

function fail(filePath: string, reason: string): never {
  throw new CorruptedOrganizationServicePrincipalFileError(filePath, reason);
}

function isCanonicallyTrimmedNonEmpty(value: string): boolean {
  return value.length > 0 && value.trim().length > 0 && value.trim() === value;
}

/**
 * The ONE structural+lifecycle coherence check shared by BOTH the write
 * boundary (`create`, before any persistence is attempted) and replay
 * validation - applying `ORG-MEMBERSHIP-DURABLE-001` F1's own lesson from
 * the start. `OrganizationServicePrincipal` is an exported structural
 * interface, so a caller can hand `create` an object that never went
 * through `createOrganizationServicePrincipal`/
 * `revokeOrganizationServicePrincipal` at all - this re-derives every
 * invariant those two functions themselves enforce: non-empty
 * canonically-trimmed `servicePrincipalId`/`tenantId`/`workerRef`, and
 * `ACTIVE`/`REVOKED` lifecycle coherence. Returns a human-readable
 * violation reason, or `undefined` when the given shape is exactly what
 * construction could have produced.
 */
function coherenceViolation(servicePrincipal: {
  readonly servicePrincipalId: string;
  readonly tenantId: string;
  readonly workerRef: string;
  readonly state: string;
  readonly revokedAt?: string | undefined;
  readonly revokedReason?: string | undefined;
}): string | undefined {
  if (!isCanonicallyTrimmedNonEmpty(servicePrincipal.servicePrincipalId)) {
    return "servicePrincipalId must be a non-empty string with no leading or trailing whitespace";
  }
  if (!isCanonicallyTrimmedNonEmpty(servicePrincipal.tenantId)) {
    return "tenantId must be a non-empty string with no leading or trailing whitespace";
  }
  if (!isCanonicallyTrimmedNonEmpty(servicePrincipal.workerRef)) {
    return "workerRef must be a non-empty string with no leading or trailing whitespace";
  }
  if (servicePrincipal.state !== "ACTIVE" && servicePrincipal.state !== "REVOKED") {
    return 'state must be "ACTIVE" or "REVOKED"';
  }
  if (servicePrincipal.state === "ACTIVE") {
    if (servicePrincipal.revokedAt !== undefined || servicePrincipal.revokedReason !== undefined) {
      return "is ACTIVE but carries revocation metadata - incoherent lifecycle state";
    }
    return undefined;
  }
  if (servicePrincipal.revokedAt === undefined || !isCanonicallyTrimmedNonEmpty(servicePrincipal.revokedAt)) {
    return "revokedAt must be a non-empty, canonically-trimmed string when REVOKED";
  }
  if (Number.isNaN(Date.parse(servicePrincipal.revokedAt))) {
    return "revokedAt must be a valid ISO timestamp";
  }
  if (servicePrincipal.revokedReason === undefined || !isCanonicallyTrimmedNonEmpty(servicePrincipal.revokedReason)) {
    return "revokedReason must be a non-empty, canonically-trimmed string when REVOKED";
  }
  return undefined;
}

function requireStringTypeField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string") {
    fail(filePath, `${field} must be a string`);
  }
  return value as string;
}

function optionalStringTypeField(value: unknown, field: string, filePath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireStringTypeField(value, field, filePath);
}

function servicePrincipalsIdentical(a: OrganizationServicePrincipal, b: OrganizationServicePrincipal): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Persisted state is an external/untrusted boundary on replay, exactly like
 * every other durable store in this repository. Field TYPE shape is
 * checked here directly (JSON can hand back anything); every structural
 * and lifecycle INVARIANT is delegated to the single shared
 * `coherenceViolation` check above, so replay validation can never
 * silently drift from what the write boundary enforces. Cross-tenant
 * contamination and key-to-identity consistency remain checked here, since
 * `coherenceViolation` has no access to the expected tenant/key context.
 * Every failure throws `CorruptedOrganizationServicePrincipalFileError`
 * (fail-closed) rather than silently dropping or guessing a bad field.
 */
function validatePersistedOrganizationServicePrincipal(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  expectedKey: string,
  filePath: string,
): StoredOrganizationServicePrincipal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, `record "${expectedKey}" must be a JSON object, not an array or primitive`);
  }
  const outer = raw as Record<string, unknown>;

  if (!Number.isInteger(outer["version"]) || (outer["version"] as number) < 1) {
    fail(filePath, `record "${expectedKey}".version must be a positive integer`);
  }
  const version = outer["version"] as number;

  const rawServicePrincipal = outer["servicePrincipal"];
  if (typeof rawServicePrincipal !== "object" || rawServicePrincipal === null || Array.isArray(rawServicePrincipal)) {
    fail(filePath, `record "${expectedKey}".servicePrincipal must be a JSON object`);
  }
  const record = rawServicePrincipal as Record<string, unknown>;

  const servicePrincipalId = requireStringTypeField(
    record["servicePrincipalId"],
    `record "${expectedKey}".servicePrincipal.servicePrincipalId`,
    filePath,
  );
  if (servicePrincipalId !== expectedKey) {
    fail(
      filePath,
      `stored key "${expectedKey}" does not match embedded servicePrincipalId "${servicePrincipalId}" - key-identity substitution`,
    );
  }
  const tenantId = requireStringTypeField(record["tenantId"], `record "${expectedKey}".servicePrincipal.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${expectedKey}" is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant record contamination`,
    );
  }
  const workerRef = requireStringTypeField(record["workerRef"], `record "${expectedKey}".servicePrincipal.workerRef`, filePath);
  const state = requireStringTypeField(record["state"], `record "${expectedKey}".servicePrincipal.state`, filePath);
  const revokedAt = optionalStringTypeField(record["revokedAt"], `record "${expectedKey}".servicePrincipal.revokedAt`, filePath);
  const revokedReason = optionalStringTypeField(record["revokedReason"], `record "${expectedKey}".servicePrincipal.revokedReason`, filePath);

  const violation = coherenceViolation({ servicePrincipalId, tenantId, workerRef, state, revokedAt, revokedReason });
  if (violation !== undefined) {
    fail(filePath, `record "${expectedKey}".servicePrincipal ${violation}`);
  }

  if (state === "ACTIVE") {
    return {
      version,
      servicePrincipal: {
        servicePrincipalId: servicePrincipalId as OrganizationServicePrincipal["servicePrincipalId"],
        tenantId: tenantId as TenantScope["tenantId"],
        workerRef,
        state: "ACTIVE",
      },
    };
  }

  return {
    version,
    servicePrincipal: {
      servicePrincipalId: servicePrincipalId as OrganizationServicePrincipal["servicePrincipalId"],
      tenantId: tenantId as TenantScope["tenantId"],
      workerRef,
      state: "REVOKED",
      revokedAt: revokedAt as string,
      revokedReason: revokedReason as string,
    },
  };
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs`/`node:crypto` - no new runtime dependency, matching every other
 * durable store in this repository. One JSON file per tenant under
 * `baseDir`, keyed by the plain `servicePrincipalId`; every read
 * reconstructs the full tenant record set from disk, proving restart-
 * safety by construction.
 */
export class FileDurableOrganizationServicePrincipalStore implements DurableOrganizationServicePrincipalStore {
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
    const deadline = Date.now() + FileDurableOrganizationServicePrincipalStore.LOCK_TIMEOUT_MS;
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
          if (Date.now() - statSync(lockPath).mtimeMs > FileDurableOrganizationServicePrincipalStore.STALE_LOCK_THRESHOLD_MS) {
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
          throw new OrganizationServicePrincipalLockTimeoutError(tenantId);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableOrganizationServicePrincipalStore.LOCK_RETRY_BACKOFF_MS,
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
      throw new CorruptedOrganizationServicePrincipalFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CorruptedOrganizationServicePrincipalFileError(
        filePath,
        "file content must be a JSON object keyed by servicePrincipalId, not an array or primitive",
      );
    }
    const result: StoredRecordsFile = Object.create(null) as StoredRecordsFile;
    for (const [key, rawRecord] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = validatePersistedOrganizationServicePrincipal(rawRecord, tenantId, key, filePath);
    }
    return result;
  }

  private writeAll(tenantId: TenantScope["tenantId"], records: StoredRecordsFile): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(records), "utf8");
  }

  create(servicePrincipal: OrganizationServicePrincipal): StoredOrganizationServicePrincipal {
    // ORG-SERVICE-PRINCIPAL-DURABLE-001: `OrganizationServicePrincipal` is an
    // exported structural interface, so a caller can hand this a hand-built
    // value that never went through `createOrganizationServicePrincipal`/
    // `revokeOrganizationServicePrincipal` at all (the exact
    // `ORG-MEMBERSHIP-DURABLE-001` F1 gap, closed here from the start).
    // Validate BEFORE acquiring the lock or touching disk - a rejected call
    // commits zero bytes and zero state.
    const violation = coherenceViolation(servicePrincipal);
    if (violation !== undefined) {
      throw new InvalidOrganizationServicePrincipalStoreError(
        `cannot create service principal "${servicePrincipal.servicePrincipalId}": ${violation}`,
      );
    }
    return this.withTenantLock(servicePrincipal.tenantId, () => {
      const records = this.readAll(servicePrincipal.tenantId);
      const existing = records[servicePrincipal.servicePrincipalId];

      if (existing === undefined) {
        const created: StoredOrganizationServicePrincipal = { servicePrincipal, version: 1 };
        records[servicePrincipal.servicePrincipalId] = created;
        this.writeAll(servicePrincipal.tenantId, records);
        return created;
      }

      if (servicePrincipalsIdentical(existing.servicePrincipal, servicePrincipal)) {
        // Idempotent identical replay - a safe no-op, never a version bump.
        return existing;
      }

      throw new OrganizationServicePrincipalConflictError(
        servicePrincipal.servicePrincipalId,
        "an existing record under this servicePrincipalId already differs from the given service principal - a create can never silently overwrite or coexist with a non-identical record",
      );
    });
  }

  revoke(input: {
    tenantId: TenantScope["tenantId"];
    servicePrincipalId: OrganizationServicePrincipal["servicePrincipalId"];
    expectedVersion: number;
    revokedAt: unknown;
    revokedReason: unknown;
  }): StoredOrganizationServicePrincipal {
    return this.withTenantLock(input.tenantId, () => {
      const records = this.readAll(input.tenantId);
      const existing = records[input.servicePrincipalId];

      if (existing === undefined) {
        throw new OrganizationServicePrincipalVersionConflictError(input.servicePrincipalId, input.expectedVersion, undefined);
      }
      if (existing.version !== input.expectedVersion) {
        throw new OrganizationServicePrincipalVersionConflictError(input.servicePrincipalId, input.expectedVersion, existing.version);
      }

      // Delegates the transition rule itself to the pre-existing domain
      // function - a stale/incoherent/already-REVOKED record is rejected by
      // its own precondition, not reimplemented here.
      const revoked = revokeOrganizationServicePrincipal({
        servicePrincipal: existing.servicePrincipal,
        revokedAt: input.revokedAt,
        revokedReason: input.revokedReason,
      });

      const updated: StoredOrganizationServicePrincipal = { servicePrincipal: revoked, version: existing.version + 1 };
      records[input.servicePrincipalId] = updated;
      this.writeAll(input.tenantId, records);
      return updated;
    });
  }

  get(
    tenantId: TenantScope["tenantId"],
    servicePrincipalId: OrganizationServicePrincipal["servicePrincipalId"],
  ): StoredOrganizationServicePrincipal | undefined {
    return this.withTenantLock(tenantId, () => this.readAll(tenantId)[servicePrincipalId]);
  }

  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredOrganizationServicePrincipal> {
    return this.withTenantLock(tenantId, () => Object.values(this.readAll(tenantId)));
  }
}
