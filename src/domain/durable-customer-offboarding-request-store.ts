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
import type {
  CustomerOffboardingRequest,
  CustomerOffboardingRequestId,
  CustomerOffboardingRequestStatus,
} from "./customer-offboarding.js";

/**
 * CUS-OFFBOARD-DURABLE-001 (Brain reconciliation on PR #145, comment
 * `6164598498`): `CustomerOffboardingRequest` (`CUS-OFFBOARD-001`) has been
 * a pure, zero-persistence domain record since it was first built, and
 * `V2-ADMIN-SURFACE-001`'s own `CustomerOffboardingAdminSource` port was
 * explicitly left wired to nothing because no durable truth existed for it
 * to read. This module closes exactly that gap - the durable persistence
 * boundary for a `CustomerOffboardingRequest`'s own lifecycle
 * (`REQUESTED` -> `COMPLETED` | `DENIED`), mirroring
 * `durable-connector-connection-store.ts`'s exact established discipline:
 * optimistic-concurrency versioned updates, a real cross-process
 * `linkSync`-based mutual-exclusion lock for the read-check-write critical
 * section (Rev94 F1's own primitive, cloned verbatim rather than imported -
 * this repository's own established per-module convention; every other
 * durable store here duplicates its lock/validation helpers locally too),
 * and full structural revalidation of persisted JSON on every read (replay
 * input is untrusted, exactly like every other durable store in this
 * repository).
 *
 * "Collision-safe requestId keying": `requestId` is a caller-supplied
 * opaque string (`customer-offboarding.ts`'s own doc comment), never
 * asserted globally unique across customers within a tenant - the exact
 * same shape `connectionBindingId` already has in
 * `durable-connector-connection-store.ts`. Rather than inventing a
 * compound tuple key, this store reuses that file's own proven answer:
 * key by `requestId` within one per-tenant file, and fail closed with an
 * identity/ownership mismatch (never a silent overwrite) whenever an
 * existing record under that key does not match the caller's own
 * tenant/customer/request identity - so an accidental `requestId`
 * collision between two different customers' requests can never let one
 * silently co-opt or clobber the other.
 */

export class InvalidCustomerOffboardingRequestStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableCustomerOffboardingRequestStore operation: ${reason}`);
    this.name = "InvalidCustomerOffboardingRequestStoreError";
  }
}

export class CustomerOffboardingRequestConflictError extends Error {
  constructor(requestId: string, reason: string) {
    super(`CustomerOffboardingRequest "${requestId}" conflict: ${reason}`);
    this.name = "CustomerOffboardingRequestConflictError";
  }
}

export class CustomerOffboardingRequestVersionConflictError extends Error {
  constructor(requestId: string, expectedVersion: number | undefined, actualVersion: number | undefined) {
    super(
      `CustomerOffboardingRequest "${requestId}" version conflict: expected ${expectedVersion ?? "(none)"}, actual ${actualVersion ?? "(none - not yet created)"}`,
    );
    this.name = "CustomerOffboardingRequestVersionConflictError";
  }
}

export class CustomerOffboardingRequestTerminalError extends Error {
  constructor(requestId: string, currentStatus: CustomerOffboardingRequestStatus) {
    super(
      `CustomerOffboardingRequest "${requestId}" is already terminal (status "${currentStatus}") - a terminal request can never be transitioned again (no resurrection)`,
    );
    this.name = "CustomerOffboardingRequestTerminalError";
  }
}

export class CorruptedCustomerOffboardingRequestFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable CustomerOffboardingRequest file (${filePath}): ${reason}`);
    this.name = "CorruptedCustomerOffboardingRequestFileError";
  }
}

export class CustomerOffboardingRequestLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable CustomerOffboardingRequest lock for tenant "${tenantId}"`);
    this.name = "CustomerOffboardingRequestLockTimeoutError";
  }
}

export interface StoredCustomerOffboardingRequest {
  readonly request: CustomerOffboardingRequest;
  readonly version: number;
}

/**
 * `createRequested` is the sole creation path and is idempotent on an
 * EXACT content replay (a retried submission of the identical request is
 * a safe no-op, never an error and never a version bump) - but any
 * existing record under the same `(tenantId, requestId)` whose content
 * differs even in one field (including one that has since moved past
 * `REQUESTED`) fails closed rather than silently coexisting with or
 * overwriting it. `transitionToTerminal` is the sole terminal-transition
 * path: it requires the CURRENT durable record to still be `REQUESTED`
 * (no resurrection of an already-`COMPLETED`/`DENIED` request) and to be
 * at the caller's own `expectedVersion` (no conflicting terminal overwrite
 * of a transition the caller never observed), and requires `next`'s own
 * tenant/customer/request identity to exactly match the existing record's
 * (never silently reassigning a request to a different customer).
 */
export interface DurableCustomerOffboardingRequestStore {
  createRequested(request: CustomerOffboardingRequest): StoredCustomerOffboardingRequest;
  transitionToTerminal(input: {
    tenantId: TenantScope["tenantId"];
    requestId: CustomerOffboardingRequestId;
    expectedVersion: number;
    next: CustomerOffboardingRequest;
  }): StoredCustomerOffboardingRequest;
  get(
    tenantId: TenantScope["tenantId"],
    requestId: CustomerOffboardingRequestId,
  ): StoredCustomerOffboardingRequest | undefined;
  list(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredCustomerOffboardingRequest>;
  listPending(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredCustomerOffboardingRequest>;
}

interface StoredRecordsFile {
  [requestId: string]: StoredCustomerOffboardingRequest;
}

const RECOGNIZED_STATUSES: ReadonlySet<string> = new Set<CustomerOffboardingRequestStatus>([
  "REQUESTED",
  "COMPLETED",
  "DENIED",
]);

function fail(filePath: string, reason: string): never {
  throw new CorruptedCustomerOffboardingRequestFileError(filePath, reason);
}

function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  return value as string;
}

function requireValidTimestampField(value: unknown, field: string, filePath: string): string {
  const timestamp = requireNonEmptyStringField(value, field, filePath);
  if (Number.isNaN(Date.parse(timestamp))) {
    fail(filePath, `${field} must be a valid ISO timestamp`);
  }
  return timestamp;
}

function requestsIdentical(a: CustomerOffboardingRequest, b: CustomerOffboardingRequest): boolean {
  return (
    a.requestId === b.requestId &&
    a.tenantId === b.tenantId &&
    a.customerId === b.customerId &&
    a.requestedByRef === b.requestedByRef &&
    a.requestedAt === b.requestedAt &&
    a.status === b.status &&
    a.decidedByRef === b.decidedByRef &&
    a.decidedAt === b.decidedAt &&
    a.denialReason === b.denialReason
  );
}

/**
 * Rev94 F2-equivalent: persisted state is an external/untrusted boundary on
 * replay. Every structural invariant `customer-offboarding.ts`'s own
 * constructors already enforce at creation time is re-checked here, plus
 * the status/decision-field shape consistency `requestCustomerOffboarding`/
 * `completeCustomerOffboarding`/`denyCustomerOffboarding` each guarantee in
 * memory but which a corrupted or hand-forged file could violate: a
 * `REQUESTED` record must carry no decision fields at all; a `COMPLETED`
 * record must carry `decidedByRef`/`decidedAt` and no `denialReason`; a
 * `DENIED` record must carry all three. Every failure throws
 * `CorruptedCustomerOffboardingRequestFileError` (fail-closed) rather than
 * silently coercing or dropping a bad field.
 */
function validatePersistedCustomerOffboardingRequest(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  expectedKey: string,
  filePath: string,
): StoredCustomerOffboardingRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, `record "${expectedKey}" must be a JSON object, not an array or primitive`);
  }
  const outer = raw as Record<string, unknown>;

  if (!Number.isInteger(outer["version"]) || (outer["version"] as number) < 1) {
    fail(filePath, `record "${expectedKey}".version must be a positive integer`);
  }
  const version = outer["version"] as number;

  const rawRequest = outer["request"];
  if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
    fail(filePath, `record "${expectedKey}".request must be a JSON object`);
  }
  const record = rawRequest as Record<string, unknown>;

  const requestId = requireNonEmptyStringField(record["requestId"], `record "${expectedKey}".request.requestId`, filePath);
  if (requestId !== expectedKey) {
    fail(filePath, `stored key "${expectedKey}" does not match embedded request.requestId "${requestId}"`);
  }
  const tenantId = requireNonEmptyStringField(record["tenantId"], `record "${expectedKey}".request.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${expectedKey}" is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant record contamination`,
    );
  }
  const customerId = requireNonEmptyStringField(record["customerId"], `record "${expectedKey}".request.customerId`, filePath);
  const requestedByRef = requireNonEmptyStringField(
    record["requestedByRef"],
    `record "${expectedKey}".request.requestedByRef`,
    filePath,
  );
  const requestedAt = requireValidTimestampField(
    record["requestedAt"],
    `record "${expectedKey}".request.requestedAt`,
    filePath,
  );
  if (typeof record["status"] !== "string" || !RECOGNIZED_STATUSES.has(record["status"])) {
    fail(filePath, `record "${expectedKey}".request.status is not a recognized CustomerOffboardingRequestStatus`);
  }
  const status = record["status"] as CustomerOffboardingRequestStatus;

  let decidedByRef: string | undefined;
  let decidedAt: string | undefined;
  let denialReason: string | undefined;

  if (status === "REQUESTED") {
    if (record["decidedByRef"] !== undefined || record["decidedAt"] !== undefined || record["denialReason"] !== undefined) {
      fail(filePath, `record "${expectedKey}" has status REQUESTED but carries a decision field - a pending request must carry no decision fields`);
    }
  } else if (status === "COMPLETED") {
    decidedByRef = requireNonEmptyStringField(record["decidedByRef"], `record "${expectedKey}".request.decidedByRef`, filePath);
    decidedAt = requireValidTimestampField(record["decidedAt"], `record "${expectedKey}".request.decidedAt`, filePath);
    if (record["denialReason"] !== undefined) {
      fail(filePath, `record "${expectedKey}" has status COMPLETED but carries a denialReason - only a DENIED request may carry one`);
    }
  } else {
    // DENIED
    decidedByRef = requireNonEmptyStringField(record["decidedByRef"], `record "${expectedKey}".request.decidedByRef`, filePath);
    decidedAt = requireValidTimestampField(record["decidedAt"], `record "${expectedKey}".request.decidedAt`, filePath);
    denialReason = requireNonEmptyStringField(record["denialReason"], `record "${expectedKey}".request.denialReason`, filePath);
  }

  const request: CustomerOffboardingRequest = {
    requestId: requestId as CustomerOffboardingRequestId,
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as Customer["customerId"],
    requestedByRef,
    requestedAt,
    status,
    ...(decidedByRef !== undefined ? { decidedByRef } : {}),
    ...(decidedAt !== undefined ? { decidedAt } : {}),
    ...(denialReason !== undefined ? { denialReason } : {}),
  };

  return { request, version };
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs`/`node:crypto` - no new runtime dependency, matching every other
 * durable store in this repository. One JSON file per tenant under
 * `baseDir`, keyed by `requestId`; every read reconstructs the full tenant
 * record set from disk (no separate in-memory index that could diverge),
 * proving restart-safety by construction exactly like
 * `FileDurableConnectorConnectionStore` does.
 */
export class FileDurableCustomerOffboardingRequestStore implements DurableCustomerOffboardingRequestStore {
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
   * (this repository's own established per-module duplication convention -
   * see `durable-connector-connection-store.ts`'s own identical doc
   * comment): `linkSync(tmpPath, lockPath)` either creates the `lockPath`
   * directory entry or fails with `EEXIST`, atomically, with no window in
   * which a second process could observe a half-acquired lock, so exactly
   * one process can hold the lock for a given tenant at a time.
   */
  private withTenantLock<T>(tenantId: TenantScope["tenantId"], criticalSection: () => T): T {
    const lockPath = this.lockPathFor(tenantId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, String(process.pid), "utf8");
    const deadline = Date.now() + FileDurableCustomerOffboardingRequestStore.LOCK_TIMEOUT_MS;
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
          throw new CustomerOffboardingRequestLockTimeoutError(tenantId);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableCustomerOffboardingRequestStore.LOCK_RETRY_BACKOFF_MS,
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
   * defense `durable-connector-connection-store.ts` already applies,
   * required for the identical reason: `requestId` is a bare caller-
   * supplied string with no disallowed-value restriction, so a legal
   * requestId such as `"__proto__"` must behave as an ordinary own-record
   * key, never as an inherited `Object.prototype` member.
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
      throw new CorruptedCustomerOffboardingRequestFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CorruptedCustomerOffboardingRequestFileError(
        filePath,
        "file content must be a JSON object keyed by requestId, not an array or primitive",
      );
    }
    const result: StoredRecordsFile = Object.create(null) as StoredRecordsFile;
    for (const [key, rawRecord] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = validatePersistedCustomerOffboardingRequest(rawRecord, tenantId, key, filePath);
    }
    return result;
  }

  private writeAll(tenantId: TenantScope["tenantId"], records: StoredRecordsFile): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(records), "utf8");
  }

  createRequested(request: CustomerOffboardingRequest): StoredCustomerOffboardingRequest {
    if (request.status !== "REQUESTED") {
      throw new InvalidCustomerOffboardingRequestStoreError(
        "createRequested only accepts a request already in REQUESTED status - this store is never the place a request is first minted into a terminal status",
      );
    }
    return this.withTenantLock(request.tenantId, () => {
      const records = this.readAll(request.tenantId);
      const existing = records[request.requestId];

      if (existing === undefined) {
        const created: StoredCustomerOffboardingRequest = { request, version: 1 };
        records[request.requestId] = created;
        this.writeAll(request.tenantId, records);
        return created;
      }

      if (requestsIdentical(existing.request, request)) {
        // Idempotent identical replay - a safe no-op, never a version bump.
        return existing;
      }

      throw new CustomerOffboardingRequestConflictError(
        request.requestId,
        "an existing record under this requestId already differs from the given request - a create can never silently overwrite or coexist with a non-identical record (collision-safe keying)",
      );
    });
  }

  transitionToTerminal(input: {
    tenantId: TenantScope["tenantId"];
    requestId: CustomerOffboardingRequestId;
    expectedVersion: number;
    next: CustomerOffboardingRequest;
  }): StoredCustomerOffboardingRequest {
    if (input.next.status !== "COMPLETED" && input.next.status !== "DENIED") {
      throw new InvalidCustomerOffboardingRequestStoreError(
        "transitionToTerminal only accepts next.status COMPLETED or DENIED - REQUESTED is never a valid transition target",
      );
    }
    return this.withTenantLock(input.tenantId, () => {
      const records = this.readAll(input.tenantId);
      const existing = records[input.requestId];

      if (existing === undefined) {
        throw new CustomerOffboardingRequestVersionConflictError(input.requestId, input.expectedVersion, undefined);
      }
      /**
       * Version-conflict is checked BEFORE terminal-ness, deliberately:
       * `transitionToTerminal` always increments the version on success, so
       * a caller whose `expectedVersion` still matches the current version
       * can only ever be looking at a `REQUESTED` record (nothing else
       * could have changed it without also bumping the version past what
       * this caller observed). Checking terminal-ness first would make a
       * genuinely stale caller - one who raced against a winner that
       * already terminalized the request - surface a misleading
       * `CustomerOffboardingRequestTerminalError` instead of the real
       * `CustomerOffboardingRequestVersionConflictError` their own stale
       * read actually represents. (Caught live by this checkpoint's own
       * multi-process race test: every loser was throwing
       * `CustomerOffboardingRequestTerminalError` - an uncaught, crashing
       * outcome for a caller that only expects a version conflict - until
       * this reorder.) The one case that still needs terminal-ness checked
       * at all - a caller who legitimately re-reads the CURRENT (matching)
       * version of an already-terminal record and attempts to transition
       * it again - is unaffected: version matches, so this check passes
       * through, and the status check immediately below still fires.
       */
      if (existing.version !== input.expectedVersion) {
        throw new CustomerOffboardingRequestVersionConflictError(input.requestId, input.expectedVersion, existing.version);
      }
      if (existing.request.status !== "REQUESTED") {
        throw new CustomerOffboardingRequestTerminalError(input.requestId, existing.request.status);
      }
      if (
        existing.request.tenantId !== input.next.tenantId ||
        existing.request.customerId !== input.next.customerId ||
        existing.request.requestId !== input.next.requestId
      ) {
        throw new CustomerOffboardingRequestConflictError(
          input.requestId,
          "next's own tenant/customer/requestId does not exactly match the existing record's - a transition can never reassign a request to a different identity",
        );
      }

      const updated: StoredCustomerOffboardingRequest = { request: input.next, version: existing.version + 1 };
      records[input.requestId] = updated;
      this.writeAll(input.tenantId, records);
      return updated;
    });
  }

  get(
    tenantId: TenantScope["tenantId"],
    requestId: CustomerOffboardingRequestId,
  ): StoredCustomerOffboardingRequest | undefined {
    return this.readAll(tenantId)[requestId];
  }

  list(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredCustomerOffboardingRequest> {
    return Object.values(this.readAll(tenantId));
  }

  listPending(tenantId: TenantScope["tenantId"]): ReadonlyArray<StoredCustomerOffboardingRequest> {
    return this.list(tenantId).filter((stored) => stored.request.status === "REQUESTED");
  }
}
