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
import { createTenantScope, type TenantScope } from "./tenant-scope.js";
import { createAuthorityContext, type AuthorityContext, type Permission } from "./authority.js";
import type { AssignmentReference, OrganizationMembership } from "./organization-membership.js";
import {
  isValidOrganizationAccessRole,
  type OrganizationAccessRole,
  type OrganizationAccessRoleContext,
} from "./organization-access-role.js";

/**
 * C2 (whole-product gap scan 2026-10-23, C-class item 2): the staff `/os`
 * surface's `requireInternalOsAccess` (`src/web/internal-os-access.ts`)
 * takes a caller-supplied `StaffAccessGrant[]`, and until now the
 * deployable runtime had no durable source for it, so it passed `[]`.
 * This store is that source's persistence half. It records, per
 * membership, the explicit evidence `resolveEffectiveOrganizationAccess`
 * needs: an `AuthorityContext`'s permissions and protected-action flag,
 * the membership's `AssignmentReference`s, and an optional curated
 * `OrganizationAccessRoleContext`.
 *
 * It stores only what a caller explicitly wrote. It never derives a
 * permission from `OrganizationMembership.role`, from
 * `OrganizationAccessRoleContext.role`, or from anything else, and it has
 * no default grant. A membership with no record here has no grant.
 *
 * Mirrors `durable-organization-membership-store.ts` and
 * `durable-organization-service-principal-store.ts`:
 *
 * - one JSON file per tenant under `baseDir`, keyed by the plain
 *   `membershipId` (the per-tenant file provides tenant isolation; the
 *   same `membershipId` in two tenants is two independent records);
 * - the Rev94 F1 `linkSync` cross-process lock, cloned verbatim, taken by
 *   readers as well as writers (the PR #167 torn-read correction);
 * - `Object.create(null)` dictionaries;
 * - ONE shared `coherenceViolation` check, run at the write boundary
 *   (before the lock is taken, so a rejected call commits nothing) and on
 *   replay, so the two paths cannot diverge;
 * - every replay failure throws `CorruptedStaffAccessGrantFileError`.
 *
 * Write paths are `create` (idempotent on an exact replay, otherwise a
 * conflict) and `update` (optimistic `expectedVersion`), named after
 * `DurableProjectStore.create`/`update`, which is the existing store whose
 * records are revised in place rather than moved through a one-way
 * lifecycle. There is no delete: narrowing a grant is an explicit `update`
 * (for example, to an empty permission set), and revoking the membership
 * itself (`DurableOrganizationMembershipStore.revoke`) already makes every
 * grant bound to it unusable through `requireInternalOsAccess`'s own
 * currentness gate.
 *
 * On disk, `authority.permissions` (a `ReadonlySet<Permission>` in memory)
 * is an array in the fixed order READ, WRITE, EXECUTE. `authority.tenantId`
 * is not stored separately: it must equal the record's own `tenantId` at
 * write time, and replay rebuilds it from that field.
 */

export class InvalidStaffAccessGrantStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableStaffAccessGrantStore operation: ${reason}`);
    this.name = "InvalidStaffAccessGrantStoreError";
  }
}

export class StaffAccessGrantConflictError extends Error {
  constructor(membershipId: string, reason: string) {
    super(`StaffAccessGrant for membership "${membershipId}" conflict: ${reason}`);
    this.name = "StaffAccessGrantConflictError";
  }
}

export class StaffAccessGrantVersionConflictError extends Error {
  constructor(membershipId: string, expectedVersion: number, actualVersion: number | undefined) {
    super(
      `StaffAccessGrant for membership "${membershipId}" version conflict: expected ${expectedVersion}, actual ${actualVersion ?? "(none - not yet created)"}`,
    );
    this.name = "StaffAccessGrantVersionConflictError";
  }
}

export class CorruptedStaffAccessGrantFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable StaffAccessGrant file (${filePath}): ${reason}`);
    this.name = "CorruptedStaffAccessGrantFileError";
  }
}

export class StaffAccessGrantLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable StaffAccessGrant lock for tenant "${tenantId}"`);
    this.name = "StaffAccessGrantLockTimeoutError";
  }
}

/**
 * The domain-side grant record. It names its membership by `membershipId`
 * only: `src/domain/` cannot import the web layer's `StaffAccessGrant`
 * (which embeds the full `OrganizationMembership`), and a copy of the
 * membership's own mutable state would go stale when the membership is
 * revoked. The web adapter joins this record with the current durable
 * membership on every read.
 */
export interface StaffAccessGrantRecord {
  readonly tenantId: TenantScope["tenantId"];
  readonly membershipId: OrganizationMembership["membershipId"];
  readonly authority: AuthorityContext;
  readonly assignments: ReadonlyArray<AssignmentReference>;
  readonly roleContext?: OrganizationAccessRoleContext;
}

export interface StoredStaffAccessGrant {
  readonly grant: StaffAccessGrantRecord;
  readonly version: number;
}

/**
 * `create` is idempotent on an exact content replay (a safe no-op, never a
 * version bump); an existing record under the same `membershipId` whose
 * content differs fails closed. `update` requires the current record to
 * exist at the caller's `expectedVersion`, and `next` to keep the same
 * `tenantId`/`membershipId`.
 */
export interface DurableStaffAccessGrantStore {
  create(grant: StaffAccessGrantRecord): StoredStaffAccessGrant;
  update(input: {
    tenantId: TenantScope["tenantId"];
    membershipId: OrganizationMembership["membershipId"];
    expectedVersion: number;
    next: StaffAccessGrantRecord;
  }): StoredStaffAccessGrant;
  get(
    tenantId: TenantScope["tenantId"],
    membershipId: OrganizationMembership["membershipId"],
  ): StoredStaffAccessGrant | undefined;
  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredStaffAccessGrant>;
}

/** The exact on-disk shape of one grant. Every field is plain JSON. */
interface PersistedAssignmentReference {
  readonly assignmentId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly customerId: string;
  readonly projectId?: string;
}

interface PersistedRoleContext {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly principalRef: string;
  readonly role: string;
}

interface PersistedStaffAccessGrant {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly authority: {
    readonly permissions: ReadonlyArray<unknown>;
    readonly canPerformProtectedActions: unknown;
  };
  readonly assignments: ReadonlyArray<PersistedAssignmentReference>;
  readonly roleContext?: PersistedRoleContext;
}

interface PersistedRecord {
  readonly grant: PersistedStaffAccessGrant;
  readonly version: number;
}

interface StoredRecordsFile {
  [membershipId: string]: PersistedRecord;
}

/** Fixed serialization order for `authority.permissions`. */
const PERMISSION_ORDER: ReadonlyArray<Permission> = ["READ", "WRITE", "EXECUTE"];

function sortPermissions(permissions: ReadonlyArray<unknown>): ReadonlyArray<unknown> {
  return [...permissions].sort(
    (a, b) => PERMISSION_ORDER.indexOf(a as Permission) - PERMISSION_ORDER.indexOf(b as Permission),
  );
}

function fail(filePath: string, reason: string): never {
  throw new CorruptedStaffAccessGrantFileError(filePath, reason);
}

function isCanonicallyTrimmedNonEmpty(value: string): boolean {
  return value.length > 0 && value.trim().length > 0 && value.trim() === value;
}

/**
 * The ONE structural coherence check shared by the write boundary
 * (`create`/`update`, before the lock is taken) and replay validation.
 * It takes the on-disk shape, which is also what a write serializes to
 * first, so both paths check the same thing.
 *
 * Permissions and `canPerformProtectedActions` are validated by
 * `createAuthorityContext` itself (the one place `authority.ts`'s
 * `VALID_PERMISSIONS` is applied), not by a second copy of that list.
 * Duplicate permission entries are rejected too, because the in-memory
 * `Set` cannot hold one and a persisted duplicate can only come from
 * outside this store.
 *
 * Every `AssignmentReference` and the optional role context must be bound
 * to this record's own `tenantId` and `membershipId`. Assignment ids must
 * be unique within the record. Returns a reason, or `undefined`.
 */
function coherenceViolation(grant: PersistedStaffAccessGrant): string | undefined {
  if (!isCanonicallyTrimmedNonEmpty(grant.tenantId)) {
    return "tenantId must be a non-empty string with no leading or trailing whitespace";
  }
  if (!isCanonicallyTrimmedNonEmpty(grant.membershipId)) {
    return "membershipId must be a non-empty string with no leading or trailing whitespace";
  }
  try {
    createAuthorityContext({
      tenantScope: createTenantScope(grant.tenantId),
      permissions: grant.authority.permissions,
      canPerformProtectedActions: grant.authority.canPerformProtectedActions,
    });
  } catch (cause) {
    return `authority is invalid (${(cause as Error).message})`;
  }
  if (new Set(grant.authority.permissions).size !== grant.authority.permissions.length) {
    return "authority.permissions must not contain duplicate entries";
  }
  const seenAssignmentIds = new Set<string>();
  for (const [index, assignment] of grant.assignments.entries()) {
    const at = `assignments[${index}]`;
    if (!isCanonicallyTrimmedNonEmpty(assignment.assignmentId)) {
      return `${at}.assignmentId must be a non-empty string with no leading or trailing whitespace`;
    }
    if (!isCanonicallyTrimmedNonEmpty(assignment.customerId)) {
      return `${at}.customerId must be a non-empty string with no leading or trailing whitespace`;
    }
    if (assignment.projectId !== undefined && !isCanonicallyTrimmedNonEmpty(assignment.projectId)) {
      return `${at}.projectId, if present, must be a non-empty string with no leading or trailing whitespace`;
    }
    if (assignment.tenantId !== grant.tenantId) {
      return `${at}.tenantId does not match the grant's own tenantId - cross-tenant assignment`;
    }
    if (assignment.membershipId !== grant.membershipId) {
      return `${at}.membershipId does not match the grant's own membershipId - assignment bound to a different membership`;
    }
    if (seenAssignmentIds.has(assignment.assignmentId)) {
      return `${at}.assignmentId "${assignment.assignmentId}" is duplicated within this grant`;
    }
    seenAssignmentIds.add(assignment.assignmentId);
  }
  if (grant.roleContext !== undefined) {
    if (grant.roleContext.tenantId !== grant.tenantId) {
      return "roleContext.tenantId does not match the grant's own tenantId";
    }
    if (grant.roleContext.membershipId !== grant.membershipId) {
      return "roleContext.membershipId does not match the grant's own membershipId";
    }
    if (!isCanonicallyTrimmedNonEmpty(grant.roleContext.principalRef)) {
      return "roleContext.principalRef must be a non-empty string with no leading or trailing whitespace";
    }
    if (!isValidOrganizationAccessRole(grant.roleContext.role)) {
      return "roleContext.role is not a recognized OrganizationAccessRole";
    }
  }
  return undefined;
}

/**
 * Write-boundary serialization. `StaffAccessGrantRecord` is an exported
 * structural interface, so a caller can hand `create`/`update` a value
 * whose runtime shape does not match its type. Field types are checked
 * here, then the shared `coherenceViolation` runs on the serialized form.
 * `authority.tenantId` is checked here because the on-disk shape does not
 * carry it.
 */
function serializeForWrite(
  grant: StaffAccessGrantRecord,
): { readonly persisted: PersistedStaffAccessGrant } | { readonly violation: string } {
  const raw = grant as unknown as Record<string, unknown>;
  if (typeof raw["tenantId"] !== "string" || typeof raw["membershipId"] !== "string") {
    return { violation: "tenantId and membershipId must be strings" };
  }
  const authority = raw["authority"] as Record<string, unknown> | undefined;
  if (typeof authority !== "object" || authority === null) {
    return { violation: "authority must be an AuthorityContext" };
  }
  if (authority["tenantId"] !== grant.tenantId) {
    return { violation: "authority.tenantId does not match the grant's own tenantId" };
  }
  if (!(authority["permissions"] instanceof Set)) {
    return { violation: "authority.permissions must be a Set" };
  }
  const permissions = Array.from(authority["permissions"] as Set<unknown>);
  if (!Array.isArray(raw["assignments"])) {
    return { violation: "assignments must be an array" };
  }
  const assignments: PersistedAssignmentReference[] = [];
  for (const [index, entry] of (raw["assignments"] as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { violation: `assignments[${index}] must be an AssignmentReference` };
    }
    const assignment = entry as Record<string, unknown>;
    const projectId = assignment["projectId"];
    if (
      typeof assignment["assignmentId"] !== "string" ||
      typeof assignment["tenantId"] !== "string" ||
      typeof assignment["membershipId"] !== "string" ||
      typeof assignment["customerId"] !== "string" ||
      (projectId !== undefined && typeof projectId !== "string")
    ) {
      return { violation: `assignments[${index}] has a field of the wrong type` };
    }
    assignments.push({
      assignmentId: assignment["assignmentId"],
      tenantId: assignment["tenantId"],
      membershipId: assignment["membershipId"],
      customerId: assignment["customerId"],
      ...(projectId !== undefined ? { projectId: projectId as string } : {}),
    });
  }
  let roleContext: PersistedRoleContext | undefined;
  const rawRoleContext = raw["roleContext"];
  if (rawRoleContext !== undefined) {
    if (typeof rawRoleContext !== "object" || rawRoleContext === null) {
      return { violation: "roleContext, if present, must be an OrganizationAccessRoleContext" };
    }
    const context = rawRoleContext as Record<string, unknown>;
    if (
      typeof context["tenantId"] !== "string" ||
      typeof context["membershipId"] !== "string" ||
      typeof context["principalRef"] !== "string" ||
      typeof context["role"] !== "string"
    ) {
      return { violation: "roleContext has a field of the wrong type" };
    }
    roleContext = {
      tenantId: context["tenantId"],
      membershipId: context["membershipId"],
      principalRef: context["principalRef"],
      role: context["role"],
    };
  }
  const persisted: PersistedStaffAccessGrant = {
    tenantId: grant.tenantId,
    membershipId: grant.membershipId,
    authority: {
      permissions: sortPermissions(permissions),
      canPerformProtectedActions: authority["canPerformProtectedActions"],
    },
    assignments,
    ...(roleContext !== undefined ? { roleContext } : {}),
  };
  const violation = coherenceViolation(persisted);
  return violation !== undefined ? { violation } : { persisted };
}

/**
 * Rebuilds the in-memory record from an already-validated on-disk shape.
 * `createAuthorityContext` cannot throw here: `coherenceViolation` already
 * ran the same call on the same input.
 */
function toRecord(persisted: PersistedStaffAccessGrant): StaffAccessGrantRecord {
  const tenantScope = createTenantScope(persisted.tenantId);
  return {
    tenantId: tenantScope.tenantId,
    membershipId: persisted.membershipId as OrganizationMembership["membershipId"],
    authority: createAuthorityContext({
      tenantScope,
      permissions: persisted.authority.permissions,
      canPerformProtectedActions: persisted.authority.canPerformProtectedActions,
    }),
    assignments: persisted.assignments.map(
      (assignment) =>
        ({
          assignmentId: assignment.assignmentId,
          tenantId: assignment.tenantId,
          membershipId: assignment.membershipId,
          customerId: assignment.customerId,
          ...(assignment.projectId !== undefined ? { projectId: assignment.projectId } : {}),
        }) as AssignmentReference,
    ),
    ...(persisted.roleContext !== undefined
      ? {
          roleContext: {
            tenantId: tenantScope.tenantId,
            membershipId: persisted.roleContext.membershipId as OrganizationMembership["membershipId"],
            principalRef: persisted.roleContext.principalRef,
            role: persisted.roleContext.role as OrganizationAccessRole,
          },
        }
      : {}),
  };
}

function toStored(record: PersistedRecord): StoredStaffAccessGrant {
  return { grant: toRecord(record.grant), version: record.version };
}

/**
 * Compares two grants in their canonical on-disk form. Comparing the
 * in-memory records with `JSON.stringify` would be wrong: a `Set`
 * serializes as `{}`, so two grants with different permissions would
 * compare equal.
 */
function persistedGrantsIdentical(a: PersistedStaffAccessGrant, b: PersistedStaffAccessGrant): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(grant: PersistedStaffAccessGrant): PersistedStaffAccessGrant {
  return {
    tenantId: grant.tenantId,
    membershipId: grant.membershipId,
    authority: {
      permissions: sortPermissions(grant.authority.permissions),
      canPerformProtectedActions: grant.authority.canPerformProtectedActions,
    },
    assignments: grant.assignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      tenantId: assignment.tenantId,
      membershipId: assignment.membershipId,
      customerId: assignment.customerId,
      ...(assignment.projectId !== undefined ? { projectId: assignment.projectId } : {}),
    })),
    ...(grant.roleContext !== undefined
      ? {
          roleContext: {
            tenantId: grant.roleContext.tenantId,
            membershipId: grant.roleContext.membershipId,
            principalRef: grant.roleContext.principalRef,
            role: grant.roleContext.role,
          },
        }
      : {}),
  };
}

function requireStringTypeField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string") {
    fail(filePath, `${field} must be a string`);
  }
  return value as string;
}

function requireObjectField(value: unknown, field: string, filePath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(filePath, `${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Persisted state is an untrusted boundary on replay. Field types are
 * checked here (JSON can hand back anything). Every structural invariant
 * goes through the shared `coherenceViolation`. Key-to-identity and
 * file-to-tenant consistency are checked here, because
 * `coherenceViolation` does not know which file or key it came from.
 * Every failure throws `CorruptedStaffAccessGrantFileError`; nothing is
 * dropped or guessed, so a damaged record can never read as "no grant".
 */
function validatePersistedStaffAccessGrant(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  expectedKey: string,
  filePath: string,
): PersistedRecord {
  const outer = requireObjectField(raw, `record "${expectedKey}"`, filePath);

  if (!Number.isInteger(outer["version"]) || (outer["version"] as number) < 1) {
    fail(filePath, `record "${expectedKey}".version must be a positive integer`);
  }
  const version = outer["version"] as number;

  const record = requireObjectField(outer["grant"], `record "${expectedKey}".grant`, filePath);
  const at = `record "${expectedKey}".grant`;

  const membershipId = requireStringTypeField(record["membershipId"], `${at}.membershipId`, filePath);
  if (membershipId !== expectedKey) {
    fail(filePath, `stored key "${expectedKey}" does not match embedded membershipId "${membershipId}" - key-identity substitution`);
  }
  const tenantId = requireStringTypeField(record["tenantId"], `${at}.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${expectedKey}" is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant record contamination`,
    );
  }

  const authority = requireObjectField(record["authority"], `${at}.authority`, filePath);
  const permissions = authority["permissions"];
  if (!Array.isArray(permissions)) {
    fail(filePath, `${at}.authority.permissions must be an array`);
  }

  const rawAssignments = record["assignments"];
  if (!Array.isArray(rawAssignments)) {
    fail(filePath, `${at}.assignments must be an array`);
  }
  const assignments: PersistedAssignmentReference[] = rawAssignments.map((entry, index) => {
    const field = `${at}.assignments[${index}]`;
    const assignment = requireObjectField(entry, field, filePath);
    const projectId = assignment["projectId"];
    return {
      assignmentId: requireStringTypeField(assignment["assignmentId"], `${field}.assignmentId`, filePath),
      tenantId: requireStringTypeField(assignment["tenantId"], `${field}.tenantId`, filePath),
      membershipId: requireStringTypeField(assignment["membershipId"], `${field}.membershipId`, filePath),
      customerId: requireStringTypeField(assignment["customerId"], `${field}.customerId`, filePath),
      ...(projectId !== undefined ? { projectId: requireStringTypeField(projectId, `${field}.projectId`, filePath) } : {}),
    };
  });

  let roleContext: PersistedRoleContext | undefined;
  if (record["roleContext"] !== undefined) {
    const context = requireObjectField(record["roleContext"], `${at}.roleContext`, filePath);
    roleContext = {
      tenantId: requireStringTypeField(context["tenantId"], `${at}.roleContext.tenantId`, filePath),
      membershipId: requireStringTypeField(context["membershipId"], `${at}.roleContext.membershipId`, filePath),
      principalRef: requireStringTypeField(context["principalRef"], `${at}.roleContext.principalRef`, filePath),
      role: requireStringTypeField(context["role"], `${at}.roleContext.role`, filePath),
    };
  }

  const grant: PersistedStaffAccessGrant = {
    tenantId,
    membershipId,
    authority: {
      permissions: permissions as unknown[],
      canPerformProtectedActions: authority["canPerformProtectedActions"],
    },
    assignments,
    ...(roleContext !== undefined ? { roleContext } : {}),
  };
  const violation = coherenceViolation(grant);
  if (violation !== undefined) {
    fail(filePath, `${at} ${violation}`);
  }
  return { grant, version };
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs`/`node:crypto` (no new runtime dependency). Every read rebuilds
 * the tenant's records from disk, so there is no cache to go stale.
 */
export class FileDurableStaffAccessGrantStore implements DurableStaffAccessGrantStore {
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
    const deadline = Date.now() + FileDurableStaffAccessGrantStore.LOCK_TIMEOUT_MS;
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
          if (Date.now() - statSync(lockPath).mtimeMs > FileDurableStaffAccessGrantStore.STALE_LOCK_THRESHOLD_MS) {
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
          throw new StaffAccessGrantLockTimeoutError(tenantId);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableStaffAccessGrantStore.LOCK_RETRY_BACKOFF_MS,
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
   * `Object.create(null)` dictionary - the same prototype-pollution defense
   * every other durable store in this repository applies.
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
      throw new CorruptedStaffAccessGrantFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CorruptedStaffAccessGrantFileError(
        filePath,
        "file content must be a JSON object keyed by membershipId, not an array or primitive",
      );
    }
    const result: StoredRecordsFile = Object.create(null) as StoredRecordsFile;
    for (const [key, rawRecord] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = validatePersistedStaffAccessGrant(rawRecord, tenantId, key, filePath);
    }
    return result;
  }

  private writeAll(tenantId: TenantScope["tenantId"], records: StoredRecordsFile): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(records), "utf8");
  }

  create(grant: StaffAccessGrantRecord): StoredStaffAccessGrant {
    // Validate BEFORE acquiring the lock or touching disk - a rejected call
    // commits zero bytes and zero state.
    const serialized = serializeForWrite(grant);
    if ("violation" in serialized) {
      throw new InvalidStaffAccessGrantStoreError(
        `cannot create a grant for membership "${String(grant.membershipId)}": ${serialized.violation}`,
      );
    }
    const persisted = serialized.persisted;
    return this.withTenantLock(grant.tenantId, () => {
      const records = this.readAll(grant.tenantId);
      const existing = records[grant.membershipId];

      if (existing === undefined) {
        const created: PersistedRecord = { grant: persisted, version: 1 };
        records[grant.membershipId] = created;
        this.writeAll(grant.tenantId, records);
        return toStored(created);
      }

      if (persistedGrantsIdentical(existing.grant, persisted)) {
        // Idempotent identical replay - a safe no-op, never a version bump.
        return toStored(existing);
      }

      throw new StaffAccessGrantConflictError(
        grant.membershipId,
        "an existing grant for this membershipId already differs from the given grant - a create can never silently overwrite or coexist with a non-identical record; use update with the current version",
      );
    });
  }

  update(input: {
    tenantId: TenantScope["tenantId"];
    membershipId: OrganizationMembership["membershipId"];
    expectedVersion: number;
    next: StaffAccessGrantRecord;
  }): StoredStaffAccessGrant {
    if (input.next.tenantId !== input.tenantId || input.next.membershipId !== input.membershipId) {
      throw new StaffAccessGrantConflictError(
        input.membershipId,
        "next's own tenantId/membershipId does not exactly match the record being updated - an update can never move a grant to a different membership",
      );
    }
    const serialized = serializeForWrite(input.next);
    if ("violation" in serialized) {
      throw new InvalidStaffAccessGrantStoreError(
        `cannot update the grant for membership "${String(input.membershipId)}": ${serialized.violation}`,
      );
    }
    const persisted = serialized.persisted;
    return this.withTenantLock(input.tenantId, () => {
      const records = this.readAll(input.tenantId);
      const existing = records[input.membershipId];

      if (existing === undefined) {
        throw new StaffAccessGrantVersionConflictError(input.membershipId, input.expectedVersion, undefined);
      }
      if (existing.version !== input.expectedVersion) {
        throw new StaffAccessGrantVersionConflictError(input.membershipId, input.expectedVersion, existing.version);
      }

      const updated: PersistedRecord = { grant: persisted, version: existing.version + 1 };
      records[input.membershipId] = updated;
      this.writeAll(input.tenantId, records);
      return toStored(updated);
    });
  }

  get(
    tenantId: TenantScope["tenantId"],
    membershipId: OrganizationMembership["membershipId"],
  ): StoredStaffAccessGrant | undefined {
    return this.withTenantLock(tenantId, () => {
      const record = this.readAll(tenantId)[membershipId];
      return record === undefined ? undefined : toStored(record);
    });
  }

  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredStaffAccessGrant> {
    return this.withTenantLock(tenantId, () => Object.values(this.readAll(tenantId)).map(toStored));
  }
}
