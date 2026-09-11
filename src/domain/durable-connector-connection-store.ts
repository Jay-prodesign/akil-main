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
import type { ConnectionBinding, ConnectionState } from "./connection-authority.js";
import type {
  ConnectorConnectionInstance,
  ConnectorKind,
  ConnectorAuthMode,
} from "./integration-connector-catalog.js";

export class ConnectorConnectionVersionConflictError extends Error {
  constructor(connectionBindingId: string, expectedVersion: number | undefined, actualVersion: number | undefined) {
    super(
      `ConnectorConnectionInstance "${connectionBindingId}" version conflict: expected ${expectedVersion ?? "(none - create)"}, actual ${actualVersion ?? "(none - not yet created)"}`,
    );
    this.name = "ConnectorConnectionVersionConflictError";
  }
}

export class CorruptedConnectorConnectionFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable connector connection file (${filePath}): ${reason}`);
    this.name = "CorruptedConnectorConnectionFileError";
  }
}

export class ConnectorConnectionLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable connector-connection lock for tenant "${tenantId}"`);
    this.name = "ConnectorConnectionLockTimeoutError";
  }
}

/**
 * CONN-001 slice 2 (persistence/secret-ref boundary): the durable
 * persistence interface for `ConnectorConnectionInstance`. Unlike
 * `OutcomeJob` (`durable-outcome-job-store.ts`'s `putIfAbsent`-only, never-
 * mutated record) a connector connection's whole point is to change state
 * over its lifecycle (REQUESTED -> CONNECTED_UNVERIFIED -> VERIFIED ->
 * DEGRADED/REVOKED, secret rotation, reconnection), so this store supports
 * genuine updates - gated by optimistic concurrency rather than blind
 * overwrite, to prevent a lost update between two concurrent lifecycle
 * operations on the same binding (e.g. a health-check-driven `DEGRADED`
 * transition racing a `rotateConnectorSecret` call).
 *
 * `save`'s `expectedVersion` contract (reusing this session's own
 * artifact-database `if_version` idiom, adapted to this repo's plain
 * TypeScript/no-database context):
 * - no stored record yet AND `expectedVersion` omitted -> create at
 *   version 1.
 * - no stored record yet AND `expectedVersion` supplied -> fail-closed
 *   `ConnectorConnectionVersionConflictError` (there is nothing at that
 *   version to update).
 * - a stored record exists AND `expectedVersion` matches its current
 *   version -> update, version increments by exactly 1.
 * - a stored record exists AND `expectedVersion` is omitted or does not
 *   match -> fail-closed `ConnectorConnectionVersionConflictError` (a
 *   caller must read the current version before overwriting it; blind
 *   overwrite of an already-persisted connection is never permitted).
 *
 * Rev94 F1 correction: the version check above is enforced correctly
 * in-process, but the original implementation's "read whole file -> check
 * -> rewrite whole file" was not atomic *across* processes - two
 * independent processes could both read the same current version, both
 * pass the check, and one silently clobber the other's write (a lost
 * update). `save` now wraps its entire read-check-write critical section
 * in a real OS-level mutual-exclusion lock (see `withTenantLock` below),
 * reusing the exact `linkSync`-based atomic-creation primitive already
 * accepted for `FileDurableOutcomeJobStore.putIfAbsent` (AUD-DURABILITY-GAP)
 * - `linkSync` either creates the lock's directory entry or fails with
 * `EEXIST`, atomically, with no window in which a second process could
 * observe a half-acquired lock. Only one process can ever be inside the
 * critical section for a given tenant at a time, so the version check and
 * the write it gates can never be split across two racing processes.
 */
export interface StoredConnectorConnection {
  readonly instance: ConnectorConnectionInstance;
  readonly version: number;
}

export interface DurableConnectorConnectionStore {
  save(instance: ConnectorConnectionInstance, expectedVersion?: number): StoredConnectorConnection;
  get(
    tenantId: TenantScope["tenantId"],
    connectionBindingId: ConnectionBinding["connectionBindingId"],
  ): StoredConnectorConnection | undefined;
  list(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredConnectorConnection>;
}

interface StoredRecordsFile {
  [connectionBindingId: string]: StoredConnectorConnection;
}

const RECOGNIZED_CONNECTOR_KINDS: ReadonlySet<string> = new Set<ConnectorKind>([
  "GOOGLE_DRIVE",
  "GOOGLE_WORKSPACE",
  "OPENAI",
  "ANTHROPIC",
  "GOOGLE_AI",
  "GITHUB",
  "META",
  "GENERIC_CUSTOM_API",
  "GENERIC_CUSTOM_OAUTH",
]);

const RECOGNIZED_AUTH_MODES: ReadonlySet<string> = new Set<ConnectorAuthMode>([
  "API_KEY",
  "OAUTH2",
  "BASIC",
  "BEARER_TOKEN",
  "CUSTOM_HEADER",
]);

const RECOGNIZED_CONNECTION_STATES: ReadonlySet<string> = new Set<ConnectionState>([
  "REQUESTED",
  "CONNECTED_UNVERIFIED",
  "VERIFIED",
  "DEGRADED",
  "REVOKED",
  "HANDOVER_COMPLETE",
]);

function fail(filePath: string, reason: string): never {
  throw new CorruptedConnectorConnectionFileError(filePath, reason);
}

function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  return value as string;
}

/**
 * Rev94 F2: persisted state is an external/untrusted boundary on replay -
 * this revalidates every structural invariant this repository's own
 * constructors already enforce at creation time, rather than trusting a
 * blind `JSON.parse(...) as StoredConnectorConnection` cast. Every check
 * below throws `CorruptedConnectorConnectionFileError` (fail-closed) rather
 * than silently coercing or dropping a bad field.
 */
function validatePersistedConnectorConnection(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  expectedKey: string,
  filePath: string,
): StoredConnectorConnection {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, `record "${expectedKey}" must be a JSON object, not an array or primitive`);
  }
  const record = raw as Record<string, unknown>;

  if (!Number.isInteger(record["version"]) || (record["version"] as number) < 1) {
    fail(filePath, `record "${expectedKey}".version must be a positive integer`);
  }
  const version = record["version"] as number;

  const rawInstance = record["instance"];
  if (typeof rawInstance !== "object" || rawInstance === null || Array.isArray(rawInstance)) {
    fail(filePath, `record "${expectedKey}".instance must be a JSON object`);
  }
  const instanceObj = rawInstance as Record<string, unknown>;

  if (typeof instanceObj["connectorKind"] !== "string" || !RECOGNIZED_CONNECTOR_KINDS.has(instanceObj["connectorKind"])) {
    fail(filePath, `record "${expectedKey}".instance.connectorKind is not a recognized connector kind`);
  }
  const connectorKind = instanceObj["connectorKind"] as ConnectorKind;

  if (typeof instanceObj["authMode"] !== "string" || !RECOGNIZED_AUTH_MODES.has(instanceObj["authMode"])) {
    fail(filePath, `record "${expectedKey}".instance.authMode is not a recognized auth mode`);
  }
  const authMode = instanceObj["authMode"] as ConnectorAuthMode;

  const rawBinding = instanceObj["binding"];
  if (typeof rawBinding !== "object" || rawBinding === null || Array.isArray(rawBinding)) {
    fail(filePath, `record "${expectedKey}".instance.binding must be a JSON object`);
  }
  const bindingObj = rawBinding as Record<string, unknown>;

  const connectionBindingId = requireNonEmptyStringField(
    bindingObj["connectionBindingId"],
    `record "${expectedKey}".instance.binding.connectionBindingId`,
    filePath,
  );
  if (connectionBindingId !== expectedKey) {
    fail(
      filePath,
      `stored key "${expectedKey}" does not match embedded instance.binding.connectionBindingId "${connectionBindingId}"`,
    );
  }
  const connectionRequirementId = requireNonEmptyStringField(
    bindingObj["connectionRequirementId"],
    `record "${expectedKey}".instance.binding.connectionRequirementId`,
    filePath,
  );

  const rawOwnership = bindingObj["ownership"];
  if (typeof rawOwnership !== "object" || rawOwnership === null || Array.isArray(rawOwnership)) {
    fail(filePath, `record "${expectedKey}".instance.binding.ownership must be a JSON object`);
  }
  const ownershipObj = rawOwnership as Record<string, unknown>;
  const ownershipTenantId = requireNonEmptyStringField(
    ownershipObj["tenantId"],
    `record "${expectedKey}".instance.binding.ownership.tenantId`,
    filePath,
  );
  if (ownershipTenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${expectedKey}" is stored under tenant file "${expectedTenantId}" but its ownership.tenantId is "${ownershipTenantId}" - cross-tenant record contamination`,
    );
  }
  const customerId = requireNonEmptyStringField(
    ownershipObj["customerId"],
    `record "${expectedKey}".instance.binding.ownership.customerId`,
    filePath,
  );
  const projectId = requireNonEmptyStringField(
    ownershipObj["projectId"],
    `record "${expectedKey}".instance.binding.ownership.projectId`,
    filePath,
  );
  let serviceRef: string | undefined;
  if (ownershipObj["serviceRef"] !== undefined) {
    serviceRef = requireNonEmptyStringField(
      ownershipObj["serviceRef"],
      `record "${expectedKey}".instance.binding.ownership.serviceRef`,
      filePath,
    );
  }

  const providerRef = requireNonEmptyStringField(
    bindingObj["providerRef"],
    `record "${expectedKey}".instance.binding.providerRef`,
    filePath,
  );
  if (providerRef !== connectorKind) {
    fail(
      filePath,
      `record "${expectedKey}".instance.binding.providerRef ("${providerRef}") must equal instance.connectorKind ("${connectorKind}") - this repository's invariant that providerRef is always the connector's own catalog identity`,
    );
  }
  const workspaceRef = requireNonEmptyStringField(
    bindingObj["workspaceRef"],
    `record "${expectedKey}".instance.binding.workspaceRef`,
    filePath,
  );
  const integrationInstanceRef = requireNonEmptyStringField(
    bindingObj["integrationInstanceRef"],
    `record "${expectedKey}".instance.binding.integrationInstanceRef`,
    filePath,
  );

  const rawDelegatedScope = bindingObj["delegatedScope"];
  if (!Array.isArray(rawDelegatedScope) || rawDelegatedScope.some((entry) => typeof entry !== "string")) {
    fail(filePath, `record "${expectedKey}".instance.binding.delegatedScope must be an array of strings`);
  }
  const delegatedScope = rawDelegatedScope as string[];

  if (
    typeof bindingObj["connectionState"] !== "string" ||
    !RECOGNIZED_CONNECTION_STATES.has(bindingObj["connectionState"])
  ) {
    fail(filePath, `record "${expectedKey}".instance.binding.connectionState is not a recognized connection state`);
  }
  const connectionState = bindingObj["connectionState"] as ConnectionState;

  // Structural secret boundary: secretRef, when present, must be a plain
  // opaque string (the SecretRef.secretRefId only) - never an object that
  // could hold raw credential material.
  let secretRef: string | undefined;
  if (bindingObj["secretRef"] !== undefined) {
    secretRef = requireNonEmptyStringField(
      bindingObj["secretRef"],
      `record "${expectedKey}".instance.binding.secretRef`,
      filePath,
    );
  }
  let verificationEvidenceRef: string | undefined;
  if (bindingObj["verificationEvidenceRef"] !== undefined) {
    verificationEvidenceRef = requireNonEmptyStringField(
      bindingObj["verificationEvidenceRef"],
      `record "${expectedKey}".instance.binding.verificationEvidenceRef`,
      filePath,
    );
  }

  const binding: ConnectionBinding = {
    connectionBindingId: connectionBindingId as ConnectionBinding["connectionBindingId"],
    connectionRequirementId: connectionRequirementId as ConnectionBinding["connectionRequirementId"],
    ownership: {
      tenantId: ownershipTenantId as TenantScope["tenantId"],
      customerId: customerId as ConnectionBinding["ownership"]["customerId"],
      projectId: projectId as ConnectionBinding["ownership"]["projectId"],
      ...(serviceRef !== undefined ? { serviceRef } : {}),
    },
    providerRef,
    workspaceRef,
    integrationInstanceRef,
    delegatedScope,
    connectionState,
    ...(secretRef !== undefined ? { secretRef: secretRef as NonNullable<ConnectionBinding["secretRef"]> } : {}),
    ...(verificationEvidenceRef !== undefined ? { verificationEvidenceRef } : {}),
  };

  return {
    version,
    instance: { binding, connectorKind, authMode },
  };
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs` - no new runtime dependency, matching every other durable
 * store in this repository. One JSON file per tenant under `baseDir`,
 * keyed by `connectionBindingId`; every read/write reconstructs the full
 * tenant record set from disk (no separate in-memory index that could
 * diverge), proving restart-safety by construction exactly like
 * `FileDurableOutcomeJobStore`/`FileDurablePlanAdmissionStore` do.
 *
 * Cross-tenant isolation is structural, not a runtime check: a connection
 * can only ever be looked up under the exact tenant file its own
 * `binding.ownership.tenantId` was saved under - a lookup with a
 * different `tenantId` reads a different (or nonexistent) file and can
 * never return another tenant's record. Rev94 F2 additionally revalidates
 * this on every read (see `validatePersistedConnectorConnection` above),
 * so a forged/corrupt file claiming a foreign tenant's data fails closed
 * instead of silently flowing through.
 */
export class FileDurableConnectorConnectionStore implements DurableConnectorConnectionStore {
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
   * Rev94 F1: real cross-process mutual exclusion for the read-check-write
   * critical section, reusing the exact `linkSync` atomic-creation
   * primitive already accepted for `FileDurableOutcomeJobStore.putIfAbsent`.
   * `linkSync(tmpPath, lockPath)` either creates the `lockPath` directory
   * entry or fails with `EEXIST` - atomically, with no window in which a
   * second process could observe a half-acquired lock - so exactly one
   * process can hold the lock for a given tenant at a time. A brief
   * synchronous backoff (`Atomics.wait` on a private, unshared buffer)
   * between retries avoids CPU-spinning while waiting; it contributes
   * nothing to correctness itself, which comes entirely from `linkSync`'s
   * atomicity - a process can wait an arbitrarily long or short amount of
   * time and mutual exclusion still holds. A bounded timeout throws
   * `ConnectorConnectionLockTimeoutError` rather than deadlocking forever
   * against a lock abandoned by a crashed process.
   */
  private withTenantLock<T>(tenantId: TenantScope["tenantId"], criticalSection: () => T): T {
    const lockPath = this.lockPathFor(tenantId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, String(process.pid), "utf8");
    const deadline = Date.now() + FileDurableConnectorConnectionStore.LOCK_TIMEOUT_MS;
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
          throw new ConnectorConnectionLockTimeoutError(tenantId);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableConnectorConnectionStore.LOCK_RETRY_BACKOFF_MS,
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
        // best-effort: if this somehow fails, the lock would be
        // permanently stuck, which the caller-visible timeout above
        // bounds for the next acquirer rather than deadlocking forever.
      }
    }
  }

  private readAll(tenantId: TenantScope["tenantId"]): StoredRecordsFile {
    const filePath = this.filePathFor(tenantId);
    if (!existsSync(filePath)) {
      return {};
    }
    const content = readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      throw new CorruptedConnectorConnectionFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CorruptedConnectorConnectionFileError(
        filePath,
        "file content must be a JSON object keyed by connectionBindingId, not an array or primitive",
      );
    }
    const result: StoredRecordsFile = {};
    for (const [key, rawRecord] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = validatePersistedConnectorConnection(rawRecord, tenantId, key, filePath);
    }
    return result;
  }

  private writeAll(tenantId: TenantScope["tenantId"], records: StoredRecordsFile): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(records), "utf8");
  }

  save(instance: ConnectorConnectionInstance, expectedVersion?: number): StoredConnectorConnection {
    const tenantId = instance.binding.ownership.tenantId;
    const connectionBindingId = instance.binding.connectionBindingId;

    return this.withTenantLock(tenantId, () => {
      const records = this.readAll(tenantId);
      const existing = records[connectionBindingId];

      if (existing === undefined) {
        if (expectedVersion !== undefined) {
          throw new ConnectorConnectionVersionConflictError(connectionBindingId, expectedVersion, undefined);
        }
        const created: StoredConnectorConnection = { instance, version: 1 };
        records[connectionBindingId] = created;
        this.writeAll(tenantId, records);
        return created;
      }

      if (expectedVersion === undefined || expectedVersion !== existing.version) {
        throw new ConnectorConnectionVersionConflictError(connectionBindingId, expectedVersion, existing.version);
      }
      const updated: StoredConnectorConnection = { instance, version: existing.version + 1 };
      records[connectionBindingId] = updated;
      this.writeAll(tenantId, records);
      return updated;
    });
  }

  get(
    tenantId: TenantScope["tenantId"],
    connectionBindingId: ConnectionBinding["connectionBindingId"],
  ): StoredConnectorConnection | undefined {
    return this.readAll(tenantId)[connectionBindingId];
  }

  list(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredConnectorConnection> {
    return Object.values(this.readAll(tenantId));
  }
}
