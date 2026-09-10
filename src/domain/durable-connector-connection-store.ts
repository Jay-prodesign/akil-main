import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { ConnectionBinding } from "./connection-authority.js";
import type { ConnectorConnectionInstance } from "./integration-connector-catalog.js";

export class ConnectorConnectionVersionConflictError extends Error {
  constructor(connectionBindingId: string, expectedVersion: number | undefined, actualVersion: number | undefined) {
    super(
      `ConnectorConnectionInstance "${connectionBindingId}" version conflict: expected ${expectedVersion ?? "(none - create)"}, actual ${actualVersion ?? "(none - not yet created)"}`,
    );
    this.name = "ConnectorConnectionVersionConflictError";
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
 * never return another tenant's record.
 */
export class FileDurableConnectorConnectionStore implements DurableConnectorConnectionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.json`);
  }

  private readAll(tenantId: TenantScope["tenantId"]): StoredRecordsFile {
    const filePath = this.filePathFor(tenantId);
    if (!existsSync(filePath)) {
      return {};
    }
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content) as StoredRecordsFile;
  }

  private writeAll(tenantId: TenantScope["tenantId"], records: StoredRecordsFile): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(records), "utf8");
  }

  save(instance: ConnectorConnectionInstance, expectedVersion?: number): StoredConnectorConnection {
    const tenantId = instance.binding.ownership.tenantId;
    const connectionBindingId = instance.binding.connectionBindingId;
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
