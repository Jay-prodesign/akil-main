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
 * `membershipId` (a plain key, not compound - `membershipId` is already
 * globally-unique-by-contract identity, the same reasoning
 * `FileDurableCustomerRepository` already documented for its own plain
 * `customerId` key), a real cross-process `linkSync` mutual-exclusion lock
 * for the read-check-write critical section (Rev94 F1's own primitive,
 * cloned verbatim - this repository's own established per-module
 * convention), and full structural revalidation of persisted JSON on every
 * read.
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

function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  if (value.trim() !== value) {
    fail(filePath, `${field} must not contain leading or trailing whitespace`);
  }
  return value as string;
}

function membershipsIdentical(a: OrganizationMembership, b: OrganizationMembership): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Persisted state is an external/untrusted boundary on replay, exactly like
 * every other durable store in this repository. Every structural invariant
 * `organization-membership.ts`'s own `createOrganizationMembership`/
 * `revokeOrganizationMembership`/`isOrganizationMembershipActive` already
 * enforce is re-checked here: non-empty canonically-trimmed `membershipId`/
 * `tenantId`/`principalRef`, a `role` among the four values construction can
 * legitimately produce, cross-tenant contamination (stored tenant file vs.
 * embedded `tenantId`), key-to-identity consistency (stored key vs. embedded
 * `membershipId`), and `ACTIVE`/`REVOKED` lifecycle coherence - an `ACTIVE`
 * record carrying stale `revokedAt`/`revokedReason`, or a `REVOKED` record
 * missing either, is corruption, never silently coerced. Every failure
 * throws `CorruptedOrganizationMembershipFileError` (fail-closed) rather
 * than silently dropping or guessing a bad field.
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

  const membershipId = requireNonEmptyStringField(
    record["membershipId"],
    `record "${expectedKey}".membership.membershipId`,
    filePath,
  );
  if (membershipId !== expectedKey) {
    fail(
      filePath,
      `stored key "${expectedKey}" does not match embedded membershipId "${membershipId}" - key-identity substitution`,
    );
  }
  const tenantId = requireNonEmptyStringField(record["tenantId"], `record "${expectedKey}".membership.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${expectedKey}" is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant record contamination`,
    );
  }
  const principalRef = requireNonEmptyStringField(
    record["principalRef"],
    `record "${expectedKey}".membership.principalRef`,
    filePath,
  );
  if (typeof record["role"] !== "string" || !RECOGNIZED_ORGANIZATION_ROLES.has(record["role"])) {
    fail(
      filePath,
      `record "${expectedKey}".membership.role is not a value createOrganizationMembership can legitimately produce`,
    );
  }
  const role = record["role"] as OrganizationRole;

  const state = record["state"];
  if (state !== "ACTIVE" && state !== "REVOKED") {
    fail(filePath, `record "${expectedKey}".membership.state must be "ACTIVE" or "REVOKED"`);
  }

  if (state === "ACTIVE") {
    if (record["revokedAt"] !== undefined || record["revokedReason"] !== undefined) {
      fail(
        filePath,
        `record "${expectedKey}".membership is ACTIVE but carries revocation metadata - incoherent persisted lifecycle state`,
      );
    }
    return {
      version,
      membership: {
        membershipId: membershipId as OrganizationMembership["membershipId"],
        tenantId: tenantId as TenantScope["tenantId"],
        principalRef,
        role,
        state: "ACTIVE",
      },
    };
  }

  const revokedAt = requireNonEmptyStringField(record["revokedAt"], `record "${expectedKey}".membership.revokedAt`, filePath);
  if (Number.isNaN(Date.parse(revokedAt))) {
    fail(filePath, `record "${expectedKey}".membership.revokedAt must be a valid ISO timestamp`);
  }
  const revokedReason = requireNonEmptyStringField(
    record["revokedReason"],
    `record "${expectedKey}".membership.revokedReason`,
    filePath,
  );

  return {
    version,
    membership: {
      membershipId: membershipId as OrganizationMembership["membershipId"],
      tenantId: tenantId as TenantScope["tenantId"],
      principalRef,
      role,
      state: "REVOKED",
      revokedAt,
      revokedReason,
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
    return this.readAll(tenantId)[membershipId];
  }

  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredOrganizationMembership> {
    return Object.values(this.readAll(tenantId));
  }
}
