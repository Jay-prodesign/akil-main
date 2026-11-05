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
import type { WorkArtifact } from "./work-artifact.js";

/**
 * Durable registry for `WorkArtifact` - the real generated-content record a
 * job's `EXECUTING` step produces (see `work-artifact.ts`'s own doc comment
 * for why this is a genuinely new store, not a duplicate of
 * `durable-evidence-reference-store.ts`). Mirrors that store's exact
 * established discipline verbatim: one JSON file per tenant under
 * `baseDir`, keyed by the plain `artifactId`, a real cross-process
 * `linkSync` mutual-exclusion lock, full structural revalidation of
 * persisted JSON on every read, and ONE shared `coherenceViolation` check
 * run at both the write boundary (`record`, before any persistence) and on
 * replay, so the two paths can never semantically diverge.
 *
 * `WorkArtifact` has no lifecycle (like `EvidenceReference`, unlike
 * `OrganizationMembership`) - it is an immutable captured record of what was
 * produced, so this store has exactly one write path (`record`), idempotent
 * on an exact content replay, and no optimistic-concurrency version guard is
 * needed because nothing ever mutates a recorded entry in place.
 *
 * `get`/`listByTenant` acquire the same per-tenant lock `record` does (the
 * same CI-discovered hazard `durable-evidence-reference-store.ts` already
 * fixed: an unlocked reader could otherwise observe a torn file mid-write,
 * since `writeFileSync`'s truncate-then-write is not atomic).
 */

export class InvalidWorkArtifactStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableWorkArtifactStore operation: ${reason}`);
    this.name = "InvalidWorkArtifactStoreError";
  }
}

export class WorkArtifactConflictError extends Error {
  constructor(artifactId: string, reason: string) {
    super(`WorkArtifact "${artifactId}" conflict: ${reason}`);
    this.name = "WorkArtifactConflictError";
  }
}

export class CorruptedWorkArtifactFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable WorkArtifact file (${filePath}): ${reason}`);
    this.name = "CorruptedWorkArtifactFileError";
  }
}

export class WorkArtifactLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable WorkArtifact lock for tenant "${tenantId}"`);
    this.name = "WorkArtifactLockTimeoutError";
  }
}

export interface StoredWorkArtifact {
  readonly artifact: WorkArtifact;
}

export interface DurableWorkArtifactStore {
  record(artifact: WorkArtifact): StoredWorkArtifact;
  get(
    tenantId: TenantScope["tenantId"],
    artifactId: WorkArtifact["artifactId"],
  ): StoredWorkArtifact | undefined;
  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredWorkArtifact>;
}

interface StoredRecordsFile {
  [artifactId: string]: StoredWorkArtifact;
}

function fail(filePath: string, reason: string): never {
  throw new CorruptedWorkArtifactFileError(filePath, reason);
}

function isCanonicallyTrimmedNonEmpty(value: string): boolean {
  return value.length > 0 && value.trim().length > 0 && value.trim() === value;
}

/**
 * The ONE structural coherence check shared by BOTH the write boundary
 * (`record`, before any persistence is attempted) and replay validation.
 * `content` is checked only for "non-empty after trim" (never required to
 * already be canonically trimmed itself) - matching `work-artifact.ts`'s
 * own `createWorkArtifact` validation exactly, so a hand-built object this
 * store is handed is held to the same rule a real constructor call would
 * have enforced.
 */
function coherenceViolation(artifact: {
  readonly artifactId: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly artifactType: string;
  readonly content: string;
  readonly producedByConnectorKind: string;
  readonly producedAt: string;
}): string | undefined {
  const trimmedFields: ReadonlyArray<readonly [string, string]> = [
    ["artifactId", artifact.artifactId],
    ["tenantId", artifact.tenantId],
    ["customerId", artifact.customerId],
    ["projectId", artifact.projectId],
    ["jobId", artifact.jobId],
    ["artifactType", artifact.artifactType],
    ["producedByConnectorKind", artifact.producedByConnectorKind],
    ["producedAt", artifact.producedAt],
  ];
  for (const [field, value] of trimmedFields) {
    if (typeof value !== "string" || !isCanonicallyTrimmedNonEmpty(value)) {
      return `${field} must be a non-empty string with no leading or trailing whitespace`;
    }
  }
  if (typeof artifact.content !== "string" || artifact.content.trim().length === 0) {
    return "content must be a non-empty string";
  }
  return undefined;
}

function requireStringTypeField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string") {
    fail(filePath, `${field} must be a string`);
  }
  return value as string;
}

function artifactIdentical(a: WorkArtifact, b: WorkArtifact): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validatePersistedWorkArtifact(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  expectedKey: string,
  filePath: string,
): StoredWorkArtifact {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, `record "${expectedKey}" must be a JSON object, not an array or primitive`);
  }
  const outer = raw as Record<string, unknown>;

  const rawArtifact = outer["artifact"];
  if (typeof rawArtifact !== "object" || rawArtifact === null || Array.isArray(rawArtifact)) {
    fail(filePath, `record "${expectedKey}".artifact must be a JSON object`);
  }
  const record = rawArtifact as Record<string, unknown>;

  const artifactId = requireStringTypeField(record["artifactId"], `record "${expectedKey}".artifact.artifactId`, filePath);
  if (artifactId !== expectedKey) {
    fail(
      filePath,
      `stored key "${expectedKey}" does not match embedded artifactId "${artifactId}" - key-identity substitution`,
    );
  }
  const tenantId = requireStringTypeField(record["tenantId"], `record "${expectedKey}".artifact.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${expectedKey}" is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant record contamination`,
    );
  }
  const customerId = requireStringTypeField(record["customerId"], `record "${expectedKey}".artifact.customerId`, filePath);
  const projectId = requireStringTypeField(record["projectId"], `record "${expectedKey}".artifact.projectId`, filePath);
  const jobId = requireStringTypeField(record["jobId"], `record "${expectedKey}".artifact.jobId`, filePath);
  const artifactType = requireStringTypeField(record["artifactType"], `record "${expectedKey}".artifact.artifactType`, filePath);
  const content = requireStringTypeField(record["content"], `record "${expectedKey}".artifact.content`, filePath);
  const producedByConnectorKind = requireStringTypeField(
    record["producedByConnectorKind"],
    `record "${expectedKey}".artifact.producedByConnectorKind`,
    filePath,
  );
  const producedAt = requireStringTypeField(record["producedAt"], `record "${expectedKey}".artifact.producedAt`, filePath);

  const violation = coherenceViolation({
    artifactId,
    tenantId,
    customerId,
    projectId,
    jobId,
    artifactType,
    content,
    producedByConnectorKind,
    producedAt,
  });
  if (violation !== undefined) {
    fail(filePath, `record "${expectedKey}".artifact ${violation}`);
  }

  return {
    artifact: {
      artifactId: artifactId as WorkArtifact["artifactId"],
      tenantId: tenantId as WorkArtifact["tenantId"],
      customerId: customerId as WorkArtifact["customerId"],
      projectId: projectId as WorkArtifact["projectId"],
      jobId: jobId as WorkArtifact["jobId"],
      artifactType,
      content,
      producedByConnectorKind,
      producedAt,
    },
  };
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs`/`node:crypto` - no new runtime dependency, matching every other
 * durable store in this repository.
 */
export class FileDurableWorkArtifactStore implements DurableWorkArtifactStore {
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

  private withTenantLock<T>(tenantId: TenantScope["tenantId"], criticalSection: () => T): T {
    const lockPath = this.lockPathFor(tenantId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, String(process.pid), "utf8");
    const deadline = Date.now() + FileDurableWorkArtifactStore.LOCK_TIMEOUT_MS;
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
          if (Date.now() - statSync(lockPath).mtimeMs > FileDurableWorkArtifactStore.STALE_LOCK_THRESHOLD_MS) {
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
          throw new WorkArtifactLockTimeoutError(tenantId);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableWorkArtifactStore.LOCK_RETRY_BACKOFF_MS,
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
      throw new CorruptedWorkArtifactFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CorruptedWorkArtifactFileError(
        filePath,
        "file content must be a JSON object keyed by artifactId, not an array or primitive",
      );
    }
    const result: StoredRecordsFile = Object.create(null) as StoredRecordsFile;
    for (const [key, rawRecord] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = validatePersistedWorkArtifact(rawRecord, tenantId, key, filePath);
    }
    return result;
  }

  private writeAll(tenantId: TenantScope["tenantId"], records: StoredRecordsFile): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(records), "utf8");
  }

  record(artifact: WorkArtifact): StoredWorkArtifact {
    const violation = coherenceViolation(artifact);
    if (violation !== undefined) {
      throw new InvalidWorkArtifactStoreError(`cannot record artifact "${artifact.artifactId}": ${violation}`);
    }
    return this.withTenantLock(artifact.tenantId, () => {
      const records = this.readAll(artifact.tenantId);
      const existing = records[artifact.artifactId];

      if (existing === undefined) {
        const created: StoredWorkArtifact = { artifact };
        records[artifact.artifactId] = created;
        this.writeAll(artifact.tenantId, records);
        return created;
      }

      if (artifactIdentical(existing.artifact, artifact)) {
        return existing;
      }

      throw new WorkArtifactConflictError(
        artifact.artifactId,
        "an existing record under this artifactId already differs from the given artifact - record can never silently overwrite or coexist with a non-identical record",
      );
    });
  }

  get(
    tenantId: TenantScope["tenantId"],
    artifactId: WorkArtifact["artifactId"],
  ): StoredWorkArtifact | undefined {
    return this.withTenantLock(tenantId, () => this.readAll(tenantId)[artifactId]);
  }

  listByTenant(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredWorkArtifact> {
    return this.withTenantLock(tenantId, () => Object.values(this.readAll(tenantId)));
  }
}
