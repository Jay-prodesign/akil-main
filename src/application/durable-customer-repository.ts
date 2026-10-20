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
import type { TenantScope } from "../domain/tenant-scope.js";
import type { Customer, LearningEligibility } from "../domain/customer.js";
import type { CustomerRepository } from "../ports/customer-repository.js";

/**
 * REV216 (AA-005, Founder Completion Directive / Continuous Software Finish
 * Mode, 2026-10-15 — independently verified via Drive `modifiedTime` advance
 * and full-content fresh-read, not accepted on a bare PR-comment claim):
 * `src/ports/customer-repository.ts`'s `CustomerRepository` port and
 * `InMemoryCustomerRepository` (`AKI-BE-001`) have existed since the very
 * first checkpoint in this repository, with "production storage... deferred"
 * explicitly disclosed in that module's own doc comment - this closes
 * exactly that gap, mirroring `durable-customer-offboarding-request-store.ts`'s
 * and `durable-project-store.ts`'s own established discipline: one JSON file
 * per tenant under `baseDir`, a real cross-process `linkSync` mutual-
 * exclusion lock for the read-check-write critical section (Rev94 F1's own
 * primitive, cloned verbatim per this repository's own established per-
 * module convention), and full structural revalidation of persisted JSON on
 * every read.
 *
 * Unlike `Project`/`CustomerOffboardingRequest`, `CustomerRepository`'s own
 * port contract (`save(customer): void`) carries no optimistic-concurrency
 * or create/update distinction at all - `save` is a plain, unconditional
 * upsert by design (the port interface itself has no version field, no
 * `created` flag, no conflict error). This store honors that contract
 * exactly: no version is invented, no "already exists" rejection is added
 * that the port's own signature does not ask for. The real concurrency
 * hazard this store still has to prevent is a TORN whole-file read-modify-
 * write: two processes calling `save()` for two DIFFERENT customers in the
 * same tenant at the same time could otherwise race on the same JSON file
 * and lose one of the two writes entirely (a "lost update," not a
 * conflict) - the same per-tenant lock already proven in every sibling
 * store closes that gap here too (proven by a dedicated multi-process race
 * test, not merely asserted).
 *
 * Applies `PROJ-DURABLE-001`'s own F1 correction (Brain CHANGES_REQUIRED,
 * PR #145 `6194622589`) from the start rather than as a later fix:
 * persisted string fields preserve the exact canonical-trim invariant
 * `customer.ts`'s own `createCustomer` already enforces at construction
 * time (`value.trim() !== value` fails closed on replay too), not merely
 * "non-empty."
 *
 * CI/Brain correction (PR #167 batch-merge-review, systemic torn-read
 * finding): `findByTenantAndId` now acquires the same per-tenant
 * `withTenantLock` as `save`. `writeAll`'s `writeFileSync` is a whole-file
 * truncate-then-write, not atomic - an unlocked reader could observe a
 * torn file mid-write from a concurrent locked writer. Readers and
 * writers now share one mutual exclusion, not just writer-vs-writer.
 */

export class CorruptedCustomerRecordFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable Customer record file (${filePath}): ${reason}`);
    this.name = "CorruptedCustomerRecordFileError";
  }
}

export class CustomerRepositoryLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the durable CustomerRepository lock for tenant "${tenantId}"`);
    this.name = "CustomerRepositoryLockTimeoutError";
  }
}

interface StoredRecordsFile {
  [customerId: string]: Customer;
}

const RECOGNIZED_LEARNING_ELIGIBILITIES: ReadonlySet<string> = new Set<LearningEligibility>(["NONE"]);

function fail(filePath: string, reason: string): never {
  throw new CorruptedCustomerRecordFileError(filePath, reason);
}

function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  if (value.trim() !== value) {
    fail(filePath, `${field} must not contain leading or trailing whitespace`);
  }
  return value as string;
}

/**
 * Persisted state is an external/untrusted boundary on replay, exactly like
 * every other durable store in this repository. Every structural invariant
 * `customer.ts`'s own `createCustomer` enforces at construction time is
 * re-checked here: non-empty, canonically-trimmed `customerId`/
 * `displayName`, a `tenantId` matching the tenant file it was read from
 * (cross-tenant contamination), a stored key matching the embedded
 * `customerId` (collision/key-identity consistency), and a
 * `learningEligibility` that is the one single value `createCustomer` can
 * ever actually produce (`"NONE"`) - any other value is corruption, not a
 * forward-compatible-but-unused literal, since no code path anywhere in
 * this repository can legitimately persist one. Every failure throws
 * `CorruptedCustomerRecordFileError` (fail-closed) rather than silently
 * coercing or dropping a bad field.
 */
function validatePersistedCustomer(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  expectedKey: string,
  filePath: string,
): Customer {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, `record "${expectedKey}" must be a JSON object, not an array or primitive`);
  }
  const record = raw as Record<string, unknown>;

  const tenantId = requireNonEmptyStringField(record["tenantId"], `record "${expectedKey}".tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${expectedKey}" is stored under tenant file "${expectedTenantId}" but its own tenantId is "${tenantId}" - cross-tenant record contamination`,
    );
  }
  const customerId = requireNonEmptyStringField(record["customerId"], `record "${expectedKey}".customerId`, filePath);
  if (customerId !== expectedKey) {
    fail(filePath, `stored key "${expectedKey}" does not match embedded customerId "${customerId}"`);
  }
  const displayName = requireNonEmptyStringField(record["displayName"], `record "${expectedKey}".displayName`, filePath);
  if (typeof record["learningEligibility"] !== "string" || !RECOGNIZED_LEARNING_ELIGIBILITIES.has(record["learningEligibility"])) {
    fail(
      filePath,
      `record "${expectedKey}".learningEligibility is not a value this repository can legitimately persist (expected "NONE")`,
    );
  }
  const learningEligibility = record["learningEligibility"] as LearningEligibility;

  return {
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as Customer["customerId"],
    displayName,
    learningEligibility,
  };
}

/**
 * Reference/local durable implementation of the EXISTING `CustomerRepository`
 * port using only Node's built-in `node:fs`/`node:crypto` - no new runtime
 * dependency, matching every other durable store in this repository. One
 * JSON file per tenant under `baseDir`, keyed by `customerId` (plain, not
 * compound: the per-tenant file itself already provides exact tenant
 * isolation, unlike `InMemoryCustomerRepository`'s own single global map,
 * which needed a compound-tuple key for exactly that reason - see
 * `in-memory-customer-repository.ts`'s own CXP-001W doc comment). Every
 * read reconstructs the full tenant record set from disk, proving restart-
 * safety by construction.
 */
export class FileDurableCustomerRepository implements CustomerRepository {
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
    const deadline = Date.now() + FileDurableCustomerRepository.LOCK_TIMEOUT_MS;
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
          throw new CustomerRepositoryLockTimeoutError(tenantId);
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          FileDurableCustomerRepository.LOCK_RETRY_BACKOFF_MS,
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
   * defense every other durable store in this repository already applies:
   * `customerId` is a bare caller-supplied string with no disallowed-value
   * restriction, so a legal customerId such as `"__proto__"` must behave
   * as an ordinary own-record key, never as an inherited `Object.prototype`
   * member.
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
      throw new CorruptedCustomerRecordFileError(filePath, `file is not valid JSON (${(cause as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CorruptedCustomerRecordFileError(
        filePath,
        "file content must be a JSON object keyed by customerId, not an array or primitive",
      );
    }
    const result: StoredRecordsFile = Object.create(null) as StoredRecordsFile;
    for (const [key, rawRecord] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = validatePersistedCustomer(rawRecord, tenantId, key, filePath);
    }
    return result;
  }

  private writeAll(tenantId: TenantScope["tenantId"], records: StoredRecordsFile): void {
    writeFileSync(this.filePathFor(tenantId), JSON.stringify(records), "utf8");
  }

  save(customer: Customer): void {
    this.withTenantLock(customer.tenantId, () => {
      const records = this.readAll(customer.tenantId);
      records[customer.customerId] = customer;
      this.writeAll(customer.tenantId, records);
    });
  }

  findByTenantAndId(
    tenantScope: TenantScope,
    customerId: Customer["customerId"],
  ): Customer | undefined {
    return this.withTenantLock(tenantScope.tenantId, () => this.readAll(tenantScope.tenantId)[customerId]);
  }
}
