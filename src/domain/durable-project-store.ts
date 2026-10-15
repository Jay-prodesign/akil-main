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
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";

/**
 * PROJ-DURABLE-001 (Founder authorization, 2026-10-15, direct conversation
 * instruction - "Project store" was the first of three persistence
 * candidates `OBS-ADMIN-SOURCE-001`/`V2-ADMIN-SURFACE-001` both flagged for
 * explicit Founder authorization only, never self-built). `project.ts`'s
 * `Project` has been a pure, zero-persistence domain record since
 * `AKI-BE-001` - `WorkProjectSource`'s own doc comment already states no
 * `ProjectStore`/`ProjectPort` exists anywhere in this repository, and that
 * single missing primitive bottlenecks `WorkProjectSource` (always
 * `NOT_ACTIVE`), `WorkJobSource` composition (needs a real `Project` to call
 * `listJobs(project)` with), and `OrganizationResourceBindingSource`'s own
 * `currentProject` gate. This module closes exactly that gap, mirroring
 * `durable-customer-offboarding-request-store.ts`'s exact established
 * discipline: optimistic-concurrency versioned updates, a real cross-process
 * `linkSync`-based mutual-exclusion lock for the read-check-write critical
 * section (Rev94 F1's own primitive, cloned verbatim rather than imported -
 * this repository's own established per-module convention), and full
 * structural revalidation of persisted JSON on every read.
 *
 * Per the Founder's own explicit instruction, this module does NOT invent a
 * new `Project` lifecycle enum or widen `Project` semantics - `state`
 * remains the exact free-form non-empty string `project.ts` already
 * declares, carried through verbatim.
 *
 * "Collision-safe Project identity": unlike `CustomerOffboardingRequest`
 * (keyed by a single opaque `requestId`), `Project` only has a composite
 * identity - `(tenantId, customerId, projectId)` - and a bare `projectId`
 * is never asserted globally unique across customers within a tenant
 * (`project.ts` itself permits `projectId`s that collide across different
 * `customerId`s). Rather than joining `customerId`/`projectId` with a
 * separator (which could itself collide - e.g. `customerId: "a::b"`,
 * `projectId: "c"` vs `customerId: "a"`, `projectId: "b::c"`), the compound
 * key here is `base64url(JSON.stringify([customerId, projectId]))`: JSON's
 * own string-escaping makes `JSON.stringify` of a two-element string array
 * injective - no two distinct `(customerId, projectId)` pairs can ever
 * produce the same encoded array, so two different projects can never
 * collide onto the same storage key regardless of what characters either
 * field contains.
 */

export class InvalidProjectStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableProjectStore operation: ${reason}`);
    this.name = "InvalidProjectStoreError";
  }
}

export class ProjectConflictError extends Error {
  constructor(customerId: string, projectId: string, reason: string) {
    super(`Project "${customerId}/${projectId}" conflict: ${reason}`);
    this.name = "ProjectConflictError";
  }
}

export class ProjectVersionConflictError extends Error {
  constructor(
    customerId: string,
    projectId: string,
    expectedVersion: number | undefined,
    actualVersion: number | undefined,
  ) {
    super(
      `Project "${customerId}/${projectId}" version conflict: expected ${expectedVersion ?? "(none)"}, actual ${actualVersion ?? "(none - not yet created)"}`,
    );
    this.name = "ProjectVersionConflictError";
  }
}

export class CorruptedProjectFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable Project file (${filePath}): ${reason}`);
    this.name = "CorruptedProjectFileError";
  }
}

export class ProjectLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable Project lock for tenant "${tenantId}"`);
    this.name = "ProjectLockTimeoutError";
  }
}

export interface StoredProject {
  readonly project: Project;
  readonly version: number;
}

/**
 * `create` is the sole creation path and is idempotent on an EXACT content
 * replay (a retried submission of the identical project is a safe no-op,
 * never an error and never a version bump) - but any existing record under
 * the same `(tenantId, customerId, projectId)` whose content differs even in
 * one field fails closed rather than silently coexisting with or
 * overwriting it. `update` is the sole revision path: it requires the
 * CURRENT durable record to exist and be at the caller's own
 * `expectedVersion` (no conflicting overwrite of an update the caller never
 * observed), and requires `next`'s own tenant/customer/project identity to
 * exactly match the existing record's (never silently reassigning a project
 * to a different tenant/customer, and never renaming its own `projectId`
 * out from under its storage key).
 */
export interface DurableProjectStore {
  create(project: Project): StoredProject;
  update(input: {
    tenantId: TenantScope["tenantId"];
    customerId: Customer["customerId"];
    projectId: Project["projectId"];
    expectedVersion: number;
    next: Project;
  }): StoredProject;
  get(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
  ): StoredProject | undefined;
  listByCustomer(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
  ): ReadonlyArray<StoredProject>;
  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredProject>;
}

interface StoredRecordsFile {
  [compoundKey: string]: StoredProject;
}

function fail(filePath: string, reason: string): never {
  throw new CorruptedProjectFileError(filePath, reason);
}

/**
 * Brain CHANGES_REQUIRED (PR #158, exact head `f8391ccd8dad7459983eb2c14cfa7e504a60aa22`,
 * F1): the original version of this function rejected only empty/
 * whitespace-only strings, not leading/trailing whitespace - weaker than
 * `project.ts`'s own `createProject` constructor invariant (its
 * `requireNonEmptyString` explicitly rejects `value.trim() !== value`),
 * so a corrupted/hand-forged record such as `projectId: " proj "` could
 * be replayed even though the live constructor would reject it. Every
 * field validated through this function (`tenantId`/`customerId`/
 * `projectId`/`ownerRef`/`state`) now preserves that exact canonical-trim
 * invariant on replay too.
 */
function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  if (value.trim() !== value) {
    fail(filePath, `${field} must not contain leading or trailing whitespace`);
  }
  return value as string;
}

function compoundKeyFor(customerId: string, projectId: string): string {
  return Buffer.from(JSON.stringify([customerId, projectId]), "utf8").toString("base64url");
}

function projectsIdentical(a: Project, b: Project): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.customerId === b.customerId &&
    a.projectId === b.projectId &&
    a.ownerRef === b.ownerRef &&
    a.state === b.state
  );
}

/**
 * Persisted state is an external/untrusted boundary on replay, exactly like
 * every other durable store in this repository that already revalidates on
 * read. Every structural invariant `project.ts`'s own `createProject`
 * already enforces at creation time is re-checked here, plus the
 * key-to-identity consistency a corrupted or hand-forged file could violate.
 * Every failure throws `CorruptedProjectFileError` (fail-closed) rather than
 * silently coercing or dropping a bad field.
 */
function validatePersistedProject(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  expectedKey: string,
  filePath: string,
): StoredProject {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, `record "${expectedKey}" must be a JSON object, not an array or primitive`);
  }
  const outer = raw as Record<string, unknown>;

  if (!Number.isInteger(outer["version"]) || (outer["version"] as number) < 1) {
    fail(filePath, `record "${expectedKey}".version must be a positive integer`);
  }
  const version = outer["version"] as number;

  const rawProject = outer["project"];
  if (typeof rawProject !== "object" || rawProject === null || Array.isArray(rawProject)) {
    fail(filePath, `record "${expectedKey}".project must be a JSON object`);
  }
  const record = rawProject as Record<string, unknown>;

  const tenantId = requireNonEmptyStringField(record["tenantId"], `record "${expectedKey}".project.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${expectedKey}" is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant record contamination`,
    );
  }
  const customerId = requireNonEmptyStringField(record["customerId"], `record "${expectedKey}".project.customerId`, filePath);
  const projectId = requireNonEmptyStringField(record["projectId"], `record "${expectedKey}".project.projectId`, filePath);
  const ownerRef = requireNonEmptyStringField(record["ownerRef"], `record "${expectedKey}".project.ownerRef`, filePath);
  const state = requireNonEmptyStringField(record["state"], `record "${expectedKey}".project.state`, filePath);

  const expectedKeyForIdentity = compoundKeyFor(customerId, projectId);
  if (expectedKeyForIdentity !== expectedKey) {
    fail(
      filePath,
      `stored key "${expectedKey}" does not match the compound key derived from embedded customerId/projectId ("${customerId}"/"${projectId}") - cross-customer/cross-project record substitution`,
    );
  }

  const project: Project = {
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as Customer["customerId"],
    projectId: projectId as Project["projectId"],
    ownerRef,
    state,
  };

  return { project, version };
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs`/`node:crypto` - no new runtime dependency, matching every other
 * durable store in this repository. One JSON file per tenant under
 * `baseDir`, keyed by the compound `(customerId, projectId)` key; every read
 * reconstructs the full tenant record set from disk (no separate in-memory
 * index that could diverge), proving restart-safety by construction exactly
 * like `FileDurableCustomerOffboardingRequestStore` does.
 */
export class FileDurableProjectStore implements DurableProjectStore {
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
   * Rev94 F1's exact `linkSync` atomic-creation primitive, cloned verbatim
   * (this repository's own established per-module duplication convention):
   * `linkSync(tmpPath, lockPath)` either creates the `lockPath` directory
   * entry or fails with `EEXIST`, atomically, with no window in which a
   * second process could observe a half-acquired lock, so exactly one
   * process can hold the lock for a given tenant at a time.
   */
  private withTenantLock<T>(tenantId: TenantScope["tenantId"], criticalSection: () => T): T {
    const lockPath = this.lockPathFor(tenantId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, String(process.pid), "utf8");
    const deadline = Date.now() + FileDurableProjectStore.LOCK_TIMEOUT_MS;
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
          throw new ProjectLockTimeoutError(tenantId);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableProjectStore.LOCK_RETRY_BACKOFF_MS,
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
   * defense `durable-connector-connection-store.ts`/
   * `durable-customer-offboarding-request-store.ts` already apply: a
   * base64url-encoded compound key can never collide with an inherited
   * `Object.prototype` member name, but this guards the general dictionary
   * discipline regardless.
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
      throw new CorruptedProjectFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CorruptedProjectFileError(
        filePath,
        "file content must be a JSON object keyed by the compound (customerId, projectId) key, not an array or primitive",
      );
    }
    const result: StoredRecordsFile = Object.create(null) as StoredRecordsFile;
    for (const [key, rawRecord] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = validatePersistedProject(rawRecord, tenantId, key, filePath);
    }
    return result;
  }

  private writeAll(tenantId: TenantScope["tenantId"], records: StoredRecordsFile): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(records), "utf8");
  }

  create(project: Project): StoredProject {
    const key = compoundKeyFor(project.customerId, project.projectId);
    return this.withTenantLock(project.tenantId, () => {
      const records = this.readAll(project.tenantId);
      const existing = records[key];

      if (existing === undefined) {
        const created: StoredProject = { project, version: 1 };
        records[key] = created;
        this.writeAll(project.tenantId, records);
        return created;
      }

      if (projectsIdentical(existing.project, project)) {
        // Idempotent identical replay - a safe no-op, never a version bump.
        return existing;
      }

      throw new ProjectConflictError(
        project.customerId,
        project.projectId,
        "an existing record under this (customerId, projectId) already differs from the given project - a create can never silently overwrite or coexist with a non-identical record (collision-safe keying)",
      );
    });
  }

  update(input: {
    tenantId: TenantScope["tenantId"];
    customerId: Customer["customerId"];
    projectId: Project["projectId"];
    expectedVersion: number;
    next: Project;
  }): StoredProject {
    const key = compoundKeyFor(input.customerId, input.projectId);
    return this.withTenantLock(input.tenantId, () => {
      const records = this.readAll(input.tenantId);
      const existing = records[key];

      if (existing === undefined) {
        throw new ProjectVersionConflictError(input.customerId, input.projectId, input.expectedVersion, undefined);
      }
      if (existing.version !== input.expectedVersion) {
        throw new ProjectVersionConflictError(input.customerId, input.projectId, input.expectedVersion, existing.version);
      }
      if (
        existing.project.tenantId !== input.next.tenantId ||
        existing.project.customerId !== input.next.customerId ||
        existing.project.projectId !== input.next.projectId
      ) {
        throw new ProjectConflictError(
          input.customerId,
          input.projectId,
          "next's own tenant/customer/projectId does not exactly match the existing record's - an update can never reassign a project to a different identity",
        );
      }

      const updated: StoredProject = { project: input.next, version: existing.version + 1 };
      records[key] = updated;
      this.writeAll(input.tenantId, records);
      return updated;
    });
  }

  get(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
  ): StoredProject | undefined {
    return this.readAll(tenantId)[compoundKeyFor(customerId, projectId)];
  }

  listByCustomer(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
  ): ReadonlyArray<StoredProject> {
    return Object.values(this.readAll(tenantId)).filter((stored) => stored.project.customerId === customerId);
  }

  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredProject> {
    return Object.values(this.readAll(tenantId));
  }
}
