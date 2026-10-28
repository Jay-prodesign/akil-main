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
  revokeOrganizationMembership,
  type OrganizationMembership,
  type OrganizationRole,
} from "./organization-membership.js";

/**
 * ORG-MEMBERSHIP-DURABLE-001 (Brain continuation, PR #145 comment
 * `6218736597`, issued immediately after PR #162's own F1 correction
 * closed): `OrganizationResourceBindingSource`'s own doc comment
 * (`internal-os-view-state.ts`) and `resolveOrganizationResourceBindingStatus`
 * (`organization-resource-binding.ts`) both already require a
 * `currentMemberships: ReadonlyArray<OrganizationMembership>` evidence input,
 * but `organization-membership.ts` has never had any durable registry -
 * `OrganizationMembership` has only ever existed as a plain, zero-persistence
 * domain record since Phase C (Rev131). `Project` and `ConnectorConnection`
 * both now have durable stores (`PROJ-DURABLE-001`,
 * `durable-connector-connection-store.ts`), so membership is the next
 * load-bearing primitive this gap-closes, not speculative store coverage.
 *
 * Mirrors `durable-project-store.ts`'s exact established discipline: one
 * JSON file per tenant under `baseDir`, keyed by the single opaque
 * `membershipId` (a plain key, not compound - the per-tenant file itself
 * already provides exact tenant isolation, the same reasoning
 * `FileDurableCustomerRepository` already documented for its own plain
 * `customerId` key; this store is tenant-file SCOPED, not a claim that
 * `membershipId` is globally unique across tenants - the same `membershipId`
 * in two different tenants' files is two independent records, never a
 * collision), a real cross-process `linkSync` mutual-exclusion lock for the
 * read-check-write critical section (Rev94 F1's own primitive, cloned
 * verbatim - this repository's own established per-module convention), and
 * full structural revalidation of persisted JSON on every read.
 *
 * Per the Brain's own explicit instruction, this module does NOT invent an
 * invitation/suspension/role-change lifecycle - `create` and `revoke` are
 * the only two write paths, exactly mirroring `organization-membership.ts`'s
 * own `createOrganizationMembership`/`revokeOrganizationMembership` surface.
 * `revoke` does not reimplement the one-way `ACTIVE -> REVOKED` transition
 * rule itself: it reuses `revokeOrganizationMembership` verbatim (imported,
 * not redefined), so "no reactivation" and "must be a coherent ACTIVE
 * record" are enforced by the exact same domain function every in-memory
 * caller already depends on, under a real optimistic-concurrency version
 * guard that closes the one genuine concurrency hazard a bare in-memory
 * caller cannot: two processes racing to revoke the SAME membership at the
 * same time.
 *
 * ORG-MEMBERSHIP-DURABLE-001 F1 (Brain CHANGES_REQUIRED, PR #163 comment
 * `6223152039`): `create` originally persisted the caller-supplied
 * `OrganizationMembership` without revalidating it first - since the type
 * is an exported structural interface, a hand-built malformed value (stale
 * revocation metadata on an `ACTIVE` record, an unrecognized `role`, a
 * non-canonical identity string) could be written successfully and only
 * surface as `CorruptedOrganizationMembershipFileError` on a later read.
 * Fixed by extracting the shared `coherenceViolation` check - the SAME
 * structural/lifecycle invariants `validatePersistedOrganizationMembership`
 * already enforced on replay - and running it in `create` BEFORE the lock
 * is even acquired, so a rejected call commits zero bytes and zero state.
 *
 * CI/Brain correction (PR #167 batch-merge-review, systemic torn-read
 * finding): `get`/`listByTenant` now acquire the same per-tenant
 * `withTenantLock` as `create`/`revoke`. `writeAll`'s `writeFileSync` is a
 * whole-file truncate-then-write, not atomic - an unlocked reader could
 * observe a torn file mid-write from a concurrent locked writer. Readers
 * and writers now share one mutual exclusion, not just writer-vs-writer.
 */

export class InvalidOrganizationMembershipStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableOrganizationMembershipStore operation: ${reason}`);
    this.name = "InvalidOrganizationMembershipStoreError";
  }
}

export class OrganizationMembershipConflictError extends Error {
  constructor(membershipId: string, reason: string) {
    super(`OrganizationMembership "${membershipId}" conflict: ${reason}`);
    this.name = "OrganizationMembershipConflictError";
  }
}

export class OrganizationMembershipVersionConflictError extends Error {
  constructor(membershipId: string, expectedVersion: number, actualVersion: number | undefined) {
    super(
      `OrganizationMembership "${membershipId}" version conflict: expected ${expectedVersion}, actual ${actualVersion ?? "(none - not yet created)"}`,
    );
    this.name = "OrganizationMembershipVersionConflictError";
  }
}

export class CorruptedOrganizationMembershipFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable OrganizationMembership file (${filePath}): ${reason}`);
    this.name = "CorruptedOrganizationMembershipFileError";
  }
}

export class OrganizationMembershipLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable OrganizationMembership lock for tenant "${tenantId}"`);
    this.name = "OrganizationMembershipLockTimeoutError";
  }
}

export interface StoredOrganizationMembership {
  readonly membership: OrganizationMembership;
  readonly version: number;
}

/**
 * `create` is the sole creation path and is idempotent on an EXACT content
 * replay (a retried submission of the identical membership is a safe no-op,
 * never an error and never a version bump) - but any existing record under
 * the same `membershipId` whose content differs even in one field fails
 * closed rather than silently coexisting with or overwriting it, mirroring
 * `DurableProjectStore.create`'s exact discipline. `revoke` is the sole
 * transition path: it requires the CURRENT durable record to exist and be at
 * the caller's own `expectedVersion` (no conflicting overwrite of a
 * transition the caller never observed), and delegates the transition
 * itself to `revokeOrganizationMembership` - a stale/incoherent/already-
 * `REVOKED` record is rejected by that function's own pre-existing
 * "coherent ACTIVE record" precondition, not reimplemented here.
 */
export interface DurableOrganizationMembershipStore {
  create(membership: OrganizationMembership): StoredOrganizationMembership;
  revoke(input: {
    tenantId: TenantScope["tenantId"];
    membershipId: OrganizationMembership["membershipId"];
    expectedVersion: number;
    revokedAt: unknown;
    revokedReason: unknown;
  }): StoredOrganizationMembership;
  get(
    tenantId: TenantScope["tenantId"],
    membershipId: OrganizationMembership["membershipId"],
  ): StoredOrganizationMembership | undefined;
  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredOrganizationMembership>;
}

interface StoredRecordsFile {
  [membershipId: string]: StoredOrganizationMembership;
}

function fail(filePath: string, reason: string): never {
  throw new CorruptedOrganizationMembershipFileError(filePath, reason);
}

/**
 * `organization-membership.ts` declares `OrganizationRole` as a type-level
 * union only - there is no exported runtime set to reuse, exactly the
 * situation `FileDurableCustomerRepository` already documented for
 * `LearningEligibility`. This duplicates the identical four literal values
 * `createOrganizationMembership`'s own private `ORGANIZATION_ROLE_VALUES`
 * enforces, so a replayed record can never resurrect a role no construction
 * call could ever legitimately produce.
 */
const RECOGNIZED_ORGANIZATION_ROLES: ReadonlySet<string> = new Set<OrganizationRole>([
  "STAFF",
  "JUNIOR",
  "STUDENT",
  "CLIENT_ASSOCIATE",
]);

function membershipsIdentical(a: OrganizationMembership, b: OrganizationMembership): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isCanonicallyTrimmedNonEmpty(value: string): boolean {
  return value.length > 0 && value.trim().length > 0 && value.trim() === value;
}

/**
 * ORG-MEMBERSHIP-DURABLE-001 F1 (Brain CHANGES_REQUIRED, PR #163 comment
 * `6223152039`): the ONE structural+lifecycle coherence check shared by
 * BOTH the write boundary (`create`, before any persistence is attempted)
 * and replay validation (`validatePersistedOrganizationMembership`) - so a
 * malformed value can never be accepted at either boundary, and the two
 * paths can never semantically diverge into a second rule set.
 * `OrganizationMembership` is an exported structural interface
 * (`organization-membership.ts`'s own documented factory-bypass concern),
 * so a caller can hand `create` an object that never went through
 * `createOrganizationMembership`/`revokeOrganizationMembership` at all -
 * this re-derives every invariant those two functions themselves enforce:
 * non-empty canonically-trimmed `membershipId`/`tenantId`/`principalRef`, a
 * `role` among the four values construction can legitimately produce, and
 * `ACTIVE`/`REVOKED` lifecycle coherence (an `ACTIVE` record carrying stale
 * `revokedAt`/`revokedReason`, or a `REVOKED` record missing either, is
 * incoherent). Returns a human-readable violation reason, or `undefined`
 * when the given shape is exactly what construction could have produced.
 */
function coherenceViolation(membership: {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly principalRef: string;
  readonly role: string;
  readonly state: string;
  readonly revokedAt?: string | undefined;
  readonly revokedReason?: string | undefined;
}): string | undefined {
  if (!isCanonicallyTrimmedNonEmpty(membership.membershipId)) {
    return "membershipId must be a non-empty string with no leading or trailing whitespace";
  }
  if (!isCanonicallyTrimmedNonEmpty(membership.tenantId)) {
    return "tenantId must be a non-empty string with no leading or trailing whitespace";
  }
  if (!isCanonicallyTrimmedNonEmpty(membership.principalRef)) {
    return "principalRef must be a non-empty string with no leading or trailing whitespace";
  }
  if (!RECOGNIZED_ORGANIZATION_ROLES.has(membership.role)) {
    return "role is not a value createOrganizationMembership can legitimately produce";
  }
  if (membership.state !== "ACTIVE" && membership.state !== "REVOKED") {
    return 'state must be "ACTIVE" or "REVOKED"';
  }
  if (membership.state === "ACTIVE") {
    if (membership.revokedAt !== undefined || membership.revokedReason !== undefined) {
      return "is ACTIVE but carries revocation metadata - incoherent lifecycle state";
    }
    return undefined;
  }
  if (membership.revokedAt === undefined || !isCanonicallyTrimmedNonEmpty(membership.revokedAt)) {
    return "revokedAt must be a non-empty, canonically-trimmed string when REVOKED";
  }
  if (Number.isNaN(Date.parse(membership.revokedAt))) {
    return "revokedAt must be a valid ISO timestamp";
  }
  if (membership.revokedReason === undefined || !isCanonicallyTrimmedNonEmpty(membership.revokedReason)) {
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

/**
 * Persisted state is an external/untrusted boundary on replay, exactly like
 * every other durable store in this repository. Field TYPE shape is
 * checked here directly (JSON can hand back anything); every structural
 * and lifecycle INVARIANT - non-empty canonical trim, recognized `role`,
 * `ACTIVE`/`REVOKED` coherence - is delegated to the single shared
 * `coherenceViolation` check above, so replay validation can never silently
 * drift from what the write boundary enforces. Cross-tenant contamination
 * (stored tenant file vs. embedded `tenantId`) and key-to-identity
 * consistency (stored key vs. embedded `membershipId`) remain checked here,
 * since `coherenceViolation` has no access to the expected tenant/key
 * context. Every failure throws `CorruptedOrganizationMembershipFileError`
 * (fail-closed) rather than silently dropping or guessing a bad field.
 */
function validatePersistedOrganizationMembership(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  expectedKey: string,
  filePath: string,
): StoredOrganizationMembership {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, `record "${expectedKey}" must be a JSON object, not an array or primitive`);
  }
  const outer = raw as Record<string, unknown>;

  if (!Number.isInteger(outer["version"]) || (outer["version"] as number) < 1) {
    fail(filePath, `record "${expectedKey}".version must be a positive integer`);
  }
  const version = outer["version"] as number;

  const rawMembership = outer["membership"];
  if (typeof rawMembership !== "object" || rawMembership === null || Array.isArray(rawMembership)) {
    fail(filePath, `record "${expectedKey}".membership must be a JSON object`);
  }
  const record = rawMembership as Record<string, unknown>;

  const membershipId = requireStringTypeField(record["membershipId"], `record "${expectedKey}".membership.membershipId`, filePath);
  if (membershipId !== expectedKey) {
    fail(
      filePath,
      `stored key "${expectedKey}" does not match embedded membershipId "${membershipId}" - key-identity substitution`,
    );
  }
  const tenantId = requireStringTypeField(record["tenantId"], `record "${expectedKey}".membership.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${expectedKey}" is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant record contamination`,
    );
  }
  const principalRef = requireStringTypeField(record["principalRef"], `record "${expectedKey}".membership.principalRef`, filePath);
  const role = requireStringTypeField(record["role"], `record "${expectedKey}".membership.role`, filePath);
  const state = requireStringTypeField(record["state"], `record "${expectedKey}".membership.state`, filePath);
  const revokedAt = optionalStringTypeField(record["revokedAt"], `record "${expectedKey}".membership.revokedAt`, filePath);
  const revokedReason = optionalStringTypeField(record["revokedReason"], `record "${expectedKey}".membership.revokedReason`, filePath);

  const violation = coherenceViolation({ membershipId, tenantId, principalRef, role, state, revokedAt, revokedReason });
  if (violation !== undefined) {
    fail(filePath, `record "${expectedKey}".membership ${violation}`);
  }

  if (state === "ACTIVE") {
    return {
      version,
      membership: {
        membershipId: membershipId as OrganizationMembership["membershipId"],
        tenantId: tenantId as TenantScope["tenantId"],
        principalRef,
        role: role as OrganizationRole,
        state: "ACTIVE",
      },
    };
  }

  return {
    version,
    membership: {
      membershipId: membershipId as OrganizationMembership["membershipId"],
      tenantId: tenantId as TenantScope["tenantId"],
      principalRef,
      role: role as OrganizationRole,
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
 * `baseDir`, keyed by the plain `membershipId`; every read reconstructs the
 * full tenant record set from disk, proving restart-safety by construction
 * exactly like `FileDurableProjectStore` does.
 */
export class FileDurableOrganizationMembershipStore implements DurableOrganizationMembershipStore {
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
    const deadline = Date.now() + FileDurableOrganizationMembershipStore.LOCK_TIMEOUT_MS;
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
          if (Date.now() - statSync(lockPath).mtimeMs > FileDurableOrganizationMembershipStore.STALE_LOCK_THRESHOLD_MS) {
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
          throw new OrganizationMembershipLockTimeoutError(tenantId);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableOrganizationMembershipStore.LOCK_RETRY_BACKOFF_MS,
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
      throw new CorruptedOrganizationMembershipFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CorruptedOrganizationMembershipFileError(
        filePath,
        "file content must be a JSON object keyed by membershipId, not an array or primitive",
      );
    }
    const result: StoredRecordsFile = Object.create(null) as StoredRecordsFile;
    for (const [key, rawRecord] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = validatePersistedOrganizationMembership(rawRecord, tenantId, key, filePath);
    }
    return result;
  }

  private writeAll(tenantId: TenantScope["tenantId"], records: StoredRecordsFile): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(records), "utf8");
  }

  create(membership: OrganizationMembership): StoredOrganizationMembership {
    // ORG-MEMBERSHIP-DURABLE-001 F1 (Brain CHANGES_REQUIRED, PR #163 comment
    // `6223152039`): `OrganizationMembership` is an exported structural
    // interface, so a caller can hand this a hand-built value that never
    // went through `createOrganizationMembership`/`revokeOrganizationMembership`
    // at all. Validate BEFORE acquiring the lock or touching disk - a
    // rejected call commits zero bytes and zero state, never a corrupted
    // record that only surfaces as `CorruptedOrganizationMembershipFileError`
    // on the next read/restart.
    const violation = coherenceViolation(membership);
    if (violation !== undefined) {
      throw new InvalidOrganizationMembershipStoreError(
        `cannot create membership "${membership.membershipId}": ${violation}`,
      );
    }
    return this.withTenantLock(membership.tenantId, () => {
      const records = this.readAll(membership.tenantId);
      const existing = records[membership.membershipId];

      if (existing === undefined) {
        const created: StoredOrganizationMembership = { membership, version: 1 };
        records[membership.membershipId] = created;
        this.writeAll(membership.tenantId, records);
        return created;
      }

      if (membershipsIdentical(existing.membership, membership)) {
        // Idempotent identical replay - a safe no-op, never a version bump.
        return existing;
      }

      throw new OrganizationMembershipConflictError(
        membership.membershipId,
        "an existing record under this membershipId already differs from the given membership - a create can never silently overwrite or coexist with a non-identical record",
      );
    });
  }

  revoke(input: {
    tenantId: TenantScope["tenantId"];
    membershipId: OrganizationMembership["membershipId"];
    expectedVersion: number;
    revokedAt: unknown;
    revokedReason: unknown;
  }): StoredOrganizationMembership {
    return this.withTenantLock(input.tenantId, () => {
      const records = this.readAll(input.tenantId);
      const existing = records[input.membershipId];

      if (existing === undefined) {
        throw new OrganizationMembershipVersionConflictError(input.membershipId, input.expectedVersion, undefined);
      }
      if (existing.version !== input.expectedVersion) {
        throw new OrganizationMembershipVersionConflictError(input.membershipId, input.expectedVersion, existing.version);
      }

      // Delegates the transition rule itself to the pre-existing domain
      // function - a stale/incoherent/already-REVOKED record is rejected by
      // its own precondition (InvalidOrganizationMembershipTransitionError),
      // not reimplemented here. This is what closes "no reactivation" even
      // under a correct expectedVersion: a REVOKED record's version can
      // still be read and matched, but revokeOrganizationMembership itself
      // refuses to transition it again.
      const revoked = revokeOrganizationMembership({
        membership: existing.membership,
        revokedAt: input.revokedAt,
        revokedReason: input.revokedReason,
      });

      const updated: StoredOrganizationMembership = { membership: revoked, version: existing.version + 1 };
      records[input.membershipId] = updated;
      this.writeAll(input.tenantId, records);
      return updated;
    });
  }

  get(
    tenantId: TenantScope["tenantId"],
    membershipId: OrganizationMembership["membershipId"],
  ): StoredOrganizationMembership | undefined {
    return this.withTenantLock(tenantId, () => this.readAll(tenantId)[membershipId]);
  }

  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredOrganizationMembership> {
    return this.withTenantLock(tenantId, () => Object.values(this.readAll(tenantId)));
  }
}
