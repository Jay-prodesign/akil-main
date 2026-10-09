import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { ProtectedDecisionRecord } from "./protected-decision-record.js";

export class InvalidDurableProtectedDecisionRecordStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableProtectedDecisionRecordStore operation: ${reason}`);
    this.name = "InvalidDurableProtectedDecisionRecordStoreError";
  }
}

export class CorruptedProtectedDecisionRecordLineError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable protected-decision-record line (${filePath}): ${reason}`);
    this.name = "CorruptedProtectedDecisionRecordLineError";
  }
}

export interface PersistResult<T> {
  readonly value: T;
  readonly created: boolean;
}

const VALID_OUTCOMES: ReadonlySet<string> = new Set(["APPROVED", "DENIED", "REVOKED"]);

function fail(filePath: string, reason: string): never {
  throw new CorruptedProtectedDecisionRecordLineError(filePath, reason);
}

function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  return value as string;
}

function validatePersistedDecisionRecord(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  filePath: string,
): { decisionRef: string; record: ProtectedDecisionRecord } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, "line must be a JSON object, not an array or primitive");
  }
  const outer = raw as Record<string, unknown>;
  const decisionRef = requireNonEmptyStringField(outer["decisionRef"], "decisionRef", filePath);
  const rawRecord = outer["record"];
  if (typeof rawRecord !== "object" || rawRecord === null || Array.isArray(rawRecord)) {
    fail(filePath, `record "${decisionRef}".record must be a JSON object`);
  }
  const recordObj = rawRecord as Record<string, unknown>;
  const recordDecisionRef = requireNonEmptyStringField(recordObj["decisionRef"], `record "${decisionRef}".record.decisionRef`, filePath);
  if (recordDecisionRef !== decisionRef) {
    fail(filePath, `record "${decisionRef}".record.decisionRef does not match the record's own key`);
  }
  const tenantId = requireNonEmptyStringField(recordObj["tenantId"], `record "${decisionRef}".record.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${decisionRef}" is stored under tenant file "${expectedTenantId}" but record.tenantId is "${tenantId}" - cross-tenant contamination`,
    );
  }
  const outcome = recordObj["outcome"];
  if (typeof outcome !== "string" || !VALID_OUTCOMES.has(outcome)) {
    fail(filePath, `record "${decisionRef}".record.outcome must be exactly "APPROVED", "DENIED", or "REVOKED"`);
  }
  const decidedByPrincipalRef = requireNonEmptyStringField(
    recordObj["decidedByPrincipalRef"],
    `record "${decisionRef}".record.decidedByPrincipalRef`,
    filePath,
  );
  const decidedAt = requireNonEmptyStringField(recordObj["decidedAt"], `record "${decisionRef}".record.decidedAt`, filePath);
  const evidenceRef = requireNonEmptyStringField(recordObj["evidenceRef"], `record "${decisionRef}".record.evidenceRef`, filePath);

  const record: ProtectedDecisionRecord = {
    decisionRef: recordDecisionRef,
    tenantId: tenantId as TenantScope["tenantId"],
    outcome: outcome as ProtectedDecisionRecord["outcome"],
    decidedByPrincipalRef,
    decidedAt,
    evidenceRef,
  };
  return { decisionRef, record };
}

function decisionRecordCoreIdentityEquals(a: ProtectedDecisionRecord, b: ProtectedDecisionRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Rev187 F3b (creation) + Rev188 F3-item4 (monotonic revision lifecycle):
 * a `ProtectedDecisionRecord` is durably CREATED exactly once per
 * `(tenantId, decisionRef)` (`putIfAbsentDecisionRecord`, unchanged - a
 * direct structural clone of `FileDurableProtectedDecisionWaitStore`'s own
 * `putIfAbsentWaitRequest` atomic-`linkSync`/content-revalidation-on-replay
 * pattern), and may then be REVISED at most once, from `APPROVED` to
 * `REVOKED` (`reviseDecisionRecord`) - `DENIED` and an already-`REVOKED`
 * record are both terminal; no further revision is ever accepted for
 * either. `getDecisionRecord` is a "latest wins" read over the full
 * append log - mirroring `execution-quota-admission.ts`'s own
 * `findCanonicalLatestForIdempotencyKey` discipline - so a later-appended
 * REVOKED revision is always observed over the original APPROVED creation,
 * never a stale first-write snapshot.
 */
export interface DurableProtectedDecisionRecordStore {
  putIfAbsentDecisionRecord(
    tenantId: TenantScope["tenantId"],
    decisionRef: string,
    record: ProtectedDecisionRecord,
  ): PersistResult<ProtectedDecisionRecord>;
  /**
   * Rev188 F3-item4: single-use per `decisionRef`, exactly like
   * `putIfAbsentDecisionRecord`'s own creation claim - `revision.outcome`
   * must be `"REVOKED"` and the CURRENT latest record (fetched fresh, here)
   * must be `"APPROVED"`, or this throws before any append. A concurrent
   * second caller racing the exact same revision loses the atomic claim
   * and is handed back the winner's own already-durable record (idempotent
   * if content matches, a hard conflict if it does not) - never a second,
   * silently-divergent REVOKED entry for the same `decisionRef`.
   */
  reviseDecisionRecord(
    tenantId: TenantScope["tenantId"],
    decisionRef: string,
    revision: ProtectedDecisionRecord,
  ): PersistResult<ProtectedDecisionRecord>;
  getDecisionRecord(tenantId: TenantScope["tenantId"], decisionRef: string): ProtectedDecisionRecord | undefined;
}

export class FileDurableProtectedDecisionRecordStore implements DurableProtectedDecisionRecordStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.creationLockDir(), { recursive: true });
    mkdirSync(this.revisionLockDir(), { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.decision.jsonl`);
  }

  private creationLockDir(): string {
    return join(this.baseDir, ".decision-creation-locks");
  }

  private creationLockPathFor(tenantId: TenantScope["tenantId"], decisionRef: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const decisionKey = Buffer.from(decisionRef, "utf8").toString("base64url");
    return join(this.creationLockDir(), `${tenantKey}.${decisionKey}.lock`);
  }

  private revisionLockDir(): string {
    return join(this.baseDir, ".decision-revision-locks");
  }

  private revisionLockPathFor(tenantId: TenantScope["tenantId"], decisionRef: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const decisionKey = Buffer.from(decisionRef, "utf8").toString("base64url");
    return join(this.revisionLockDir(), `${tenantKey}.${decisionKey}.lock`);
  }

  private readAll(tenantId: TenantScope["tenantId"]): Array<{ decisionRef: string; record: ProtectedDecisionRecord }> {
    const filePath = this.filePathFor(tenantId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new CorruptedProtectedDecisionRecordLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
      }
      return validatePersistedDecisionRecord(parsed, tenantId, filePath);
    });
  }

  /**
   * Rev188 F3-item4: "latest wins" over the full append log - unconditional
   * overwrite on each later entry (never `if (!byRef.has(...))`), so a
   * later-appended REVOKED revision is always what `getDecisionRecord`
   * returns, never the original APPROVED creation it superseded.
   */
  private dedupedByDecisionRef(
    records: ReadonlyArray<{ decisionRef: string; record: ProtectedDecisionRecord }>,
  ): Map<string, ProtectedDecisionRecord> {
    const byRef = new Map<string, ProtectedDecisionRecord>();
    for (const entry of records) {
      byRef.set(entry.decisionRef, entry.record);
    }
    return byRef;
  }

  putIfAbsentDecisionRecord(
    tenantId: TenantScope["tenantId"],
    decisionRef: string,
    record: ProtectedDecisionRecord,
  ): PersistResult<ProtectedDecisionRecord> {
    if (decisionRef.trim().length === 0) {
      throw new InvalidDurableProtectedDecisionRecordStoreError("decisionRef must be a non-empty string");
    }
    if (record.tenantId !== tenantId || record.decisionRef !== decisionRef) {
      throw new InvalidDurableProtectedDecisionRecordStoreError(
        "record.tenantId/decisionRef must exactly match the given tenantId/decisionRef",
      );
    }

    const existing = this.getDecisionRecord(tenantId, decisionRef);
    if (existing !== undefined) {
      if (!decisionRecordCoreIdentityEquals(existing, record)) {
        throw new InvalidDurableProtectedDecisionRecordStoreError(
          `decisionRef "${decisionRef}" is already recorded with a different decision outcome`,
        );
      }
      return { value: existing, created: false };
    }

    const lockPath = this.creationLockPathFor(tenantId, decisionRef);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ decisionRef, record });
    writeFileSync(tmpPath, payload, "utf8");
    let wonCreation: boolean;
    try {
      linkSync(tmpPath, lockPath);
      wonCreation = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      wonCreation = false;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only.
      }
    }

    if (!wonCreation) {
      const winnerRaw = readFileSync(lockPath, "utf8");
      const winner = validatePersistedDecisionRecord(JSON.parse(winnerRaw), tenantId, lockPath);
      if (!decisionRecordCoreIdentityEquals(winner.record, record)) {
        throw new InvalidDurableProtectedDecisionRecordStoreError(
          `decisionRef "${decisionRef}" is already recorded under a different decision outcome`,
        );
      }
      if (this.getDecisionRecord(tenantId, decisionRef) === undefined) {
        appendFileSync(this.filePathFor(tenantId), `${winnerRaw}\n`, "utf8");
      }
      return { value: winner.record, created: false };
    }

    appendFileSync(this.filePathFor(tenantId), `${payload}\n`, "utf8");
    return { value: record, created: true };
  }

  /**
   * Rev188 F3-item4: single-use revision claim, structurally identical to
   * `putIfAbsentDecisionRecord`'s own atomic `linkSync` creation claim,
   * applied one level up - a decision can be revised AT MOST ONCE, so the
   * SAME "exactly one durable winner, everyone else reads it back" pattern
   * fits the revision edge exactly as well as the creation edge.
   */
  reviseDecisionRecord(
    tenantId: TenantScope["tenantId"],
    decisionRef: string,
    revision: ProtectedDecisionRecord,
  ): PersistResult<ProtectedDecisionRecord> {
    if (decisionRef.trim().length === 0) {
      throw new InvalidDurableProtectedDecisionRecordStoreError("decisionRef must be a non-empty string");
    }
    if (revision.tenantId !== tenantId || revision.decisionRef !== decisionRef) {
      throw new InvalidDurableProtectedDecisionRecordStoreError(
        "revision.tenantId/decisionRef must exactly match the given tenantId/decisionRef",
      );
    }

    const current = this.getDecisionRecord(tenantId, decisionRef);
    if (current === undefined) {
      throw new InvalidDurableProtectedDecisionRecordStoreError(
        `cannot revise decisionRef "${decisionRef}" - no existing durable record to revise`,
      );
    }
    if (current.outcome !== "APPROVED") {
      // A terminal outcome (DENIED, or an already-REVOKED record) can never
      // be revised again. A repeat of the SAME already-applied revision is
      // still a safe idempotent no-op; anything else is a rejected
      // transition attempt.
      if (decisionRecordCoreIdentityEquals(current, revision)) {
        return { value: current, created: false };
      }
      throw new InvalidDurableProtectedDecisionRecordStoreError(
        `decisionRef "${decisionRef}" is already in a terminal outcome "${current.outcome}" and cannot be revised again`,
      );
    }
    if (revision.outcome !== "REVOKED") {
      throw new InvalidDurableProtectedDecisionRecordStoreError(
        `decisionRef "${decisionRef}"'s only legitimate revision from APPROVED is to REVOKED, not "${revision.outcome}"`,
      );
    }

    const lockPath = this.revisionLockPathFor(tenantId, decisionRef);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ decisionRef, record: revision });
    writeFileSync(tmpPath, payload, "utf8");
    let wonRevision: boolean;
    try {
      linkSync(tmpPath, lockPath);
      wonRevision = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      wonRevision = false;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only.
      }
    }

    if (!wonRevision) {
      const winnerRaw = readFileSync(lockPath, "utf8");
      const winner = validatePersistedDecisionRecord(JSON.parse(winnerRaw), tenantId, lockPath);
      if (!decisionRecordCoreIdentityEquals(winner.record, revision)) {
        throw new InvalidDurableProtectedDecisionRecordStoreError(
          `decisionRef "${decisionRef}" was already revised to a different outcome/evidence by a concurrent caller`,
        );
      }
      const latestNow = this.getDecisionRecord(tenantId, decisionRef);
      if (latestNow === undefined || latestNow.outcome !== "REVOKED") {
        appendFileSync(this.filePathFor(tenantId), `${winnerRaw}\n`, "utf8");
      }
      return { value: winner.record, created: false };
    }

    appendFileSync(this.filePathFor(tenantId), `${payload}\n`, "utf8");
    return { value: revision, created: true };
  }

  getDecisionRecord(tenantId: TenantScope["tenantId"], decisionRef: string): ProtectedDecisionRecord | undefined {
    return this.dedupedByDecisionRef(this.readAll(tenantId)).get(decisionRef);
  }
}
