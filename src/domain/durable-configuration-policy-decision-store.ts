import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { ConfigurationPolicyDecisionProjectionEntry } from "./configuration-policy-decision-projection.js";

export class InvalidDurableConfigurationPolicyDecisionStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableConfigurationPolicyDecisionStore operation: ${reason}`);
    this.name = "InvalidDurableConfigurationPolicyDecisionStoreError";
  }
}

export class CorruptedConfigurationPolicyDecisionLineError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable configuration-policy-decision line (${filePath}): ${reason}`);
    this.name = "CorruptedConfigurationPolicyDecisionLineError";
  }
}

export interface PersistResult<T> {
  readonly value: T;
  readonly created: boolean;
}

const VALID_ENTRY_KINDS: ReadonlySet<string> = new Set(["COMPUTED", "ROLLBACK"]);

function fail(filePath: string, reason: string): never {
  throw new CorruptedConfigurationPolicyDecisionLineError(filePath, reason);
}

function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  return value as string;
}

function validatePersistedEntry(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  expectedDecisionKey: string,
  filePath: string,
): ConfigurationPolicyDecisionProjectionEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, "line must be a JSON object, not an array or primitive");
  }
  const outer = raw as Record<string, unknown>;
  const decisionKey = requireNonEmptyStringField(outer["decisionKey"], "decisionKey", filePath);
  if (decisionKey !== expectedDecisionKey) {
    fail(filePath, `entry is stored under decisionKey file "${expectedDecisionKey}" but entry.decisionKey is "${decisionKey}" - cross-key contamination`);
  }
  const decisionId = requireNonEmptyStringField(outer["decisionId"], `entry "${decisionKey}".decisionId`, filePath);

  const rawIdentity = outer["identity"];
  if (typeof rawIdentity !== "object" || rawIdentity === null || Array.isArray(rawIdentity)) {
    fail(filePath, `entry "${decisionId}".identity must be a JSON object`);
  }
  const identityObj = rawIdentity as Record<string, unknown>;
  const tenantId = requireNonEmptyStringField(identityObj["tenantId"], `entry "${decisionId}".identity.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(filePath, `entry "${decisionId}" is stored under tenant file "${expectedTenantId}" but identity.tenantId is "${tenantId}" - cross-tenant contamination`);
  }

  const rawResolution = outer["resolution"];
  if (typeof rawResolution !== "object" || rawResolution === null || Array.isArray(rawResolution)) {
    fail(filePath, `entry "${decisionId}".resolution must be a JSON object`);
  }

  const inputControlsSnapshot = outer["inputControlsSnapshot"];
  if (!Array.isArray(inputControlsSnapshot)) {
    fail(filePath, `entry "${decisionId}".inputControlsSnapshot must be an array`);
  }

  const computedAt = requireNonEmptyStringField(outer["computedAt"], `entry "${decisionId}".computedAt`, filePath);

  const entryKind = outer["entryKind"];
  if (typeof entryKind !== "string" || !VALID_ENTRY_KINDS.has(entryKind)) {
    fail(filePath, `entry "${decisionId}".entryKind must be exactly "COMPUTED" or "ROLLBACK"`);
  }

  let rolledBackToDecisionId: string | undefined;
  if (entryKind === "ROLLBACK") {
    rolledBackToDecisionId = requireNonEmptyStringField(
      outer["rolledBackToDecisionId"],
      `entry "${decisionId}".rolledBackToDecisionId`,
      filePath,
    );
  } else if (outer["rolledBackToDecisionId"] !== undefined) {
    fail(filePath, `entry "${decisionId}": rolledBackToDecisionId may only be present on a ROLLBACK entry`);
  }

  return {
    decisionKey,
    decisionId,
    identity: identityObj as unknown as ConfigurationPolicyDecisionProjectionEntry["identity"],
    resolution: rawResolution as unknown as ConfigurationPolicyDecisionProjectionEntry["resolution"],
    inputControlsSnapshot: inputControlsSnapshot as ReadonlyArray<unknown>,
    computedAt,
    entryKind: entryKind as "COMPUTED" | "ROLLBACK",
    ...(rolledBackToDecisionId !== undefined ? { rolledBackToDecisionId } : {}),
  };
}

function entryCoreIdentityEquals(
  a: ConfigurationPolicyDecisionProjectionEntry,
  b: ConfigurationPolicyDecisionProjectionEntry,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * OS-V0-11 Phase A: a per-`decisionKey` APPEND LOG, never a single mutable
 * record - a scope identity's effective configuration/policy decision is
 * expected to change over its lifetime (that is the entire point of
 * staleness detection), so unlike `DurableProtectedDecisionRecordStore`'s
 * "created once, revised at most once" contract, this store's `decisionId`
 * claim is single-use (exactly one durable winner per `decisionId`, the
 * SAME proven atomic `linkSync` pattern) but the per-`decisionKey` HISTORY
 * itself is open-ended. `getActiveDecisionProjection` is "latest wins over
 * the full append log" (mirroring `getDecisionRecord`'s own discipline),
 * so the most-recently-appended entry is always the current decision -
 * never a stale first-write snapshot.
 */
export interface DurableConfigurationPolicyDecisionStore {
  appendDecisionProjection(
    tenantId: TenantScope["tenantId"],
    entry: ConfigurationPolicyDecisionProjectionEntry,
  ): PersistResult<ConfigurationPolicyDecisionProjectionEntry>;
  getActiveDecisionProjection(
    tenantId: TenantScope["tenantId"],
    decisionKey: string,
  ): ConfigurationPolicyDecisionProjectionEntry | undefined;
  getDecisionProjectionHistory(
    tenantId: TenantScope["tenantId"],
    decisionKey: string,
  ): ReadonlyArray<ConfigurationPolicyDecisionProjectionEntry>;
  getDecisionProjectionById(
    tenantId: TenantScope["tenantId"],
    decisionKey: string,
    decisionId: string,
  ): ConfigurationPolicyDecisionProjectionEntry | undefined;
}

export class FileDurableConfigurationPolicyDecisionStore implements DurableConfigurationPolicyDecisionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.appendLockDir(), { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"], decisionKey: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const decisionKeyEncoded = Buffer.from(decisionKey, "utf8").toString("base64url");
    return join(this.baseDir, `${tenantKey}.${decisionKeyEncoded}.decision-log.jsonl`);
  }

  private appendLockDir(): string {
    return join(this.baseDir, ".decision-append-locks");
  }

  private appendLockPathFor(tenantId: TenantScope["tenantId"], decisionKey: string, decisionId: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const decisionKeyEncoded = Buffer.from(decisionKey, "utf8").toString("base64url");
    const decisionIdKey = Buffer.from(decisionId, "utf8").toString("base64url");
    return join(this.appendLockDir(), `${tenantKey}.${decisionKeyEncoded}.${decisionIdKey}.lock`);
  }

  private readAll(
    tenantId: TenantScope["tenantId"],
    decisionKey: string,
  ): ReadonlyArray<ConfigurationPolicyDecisionProjectionEntry> {
    const filePath = this.filePathFor(tenantId, decisionKey);
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
        throw new CorruptedConfigurationPolicyDecisionLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
      }
      return validatePersistedEntry(parsed, tenantId, decisionKey, filePath);
    });
  }

  appendDecisionProjection(
    tenantId: TenantScope["tenantId"],
    entry: ConfigurationPolicyDecisionProjectionEntry,
  ): PersistResult<ConfigurationPolicyDecisionProjectionEntry> {
    if (entry.decisionKey.trim().length === 0) {
      throw new InvalidDurableConfigurationPolicyDecisionStoreError("entry.decisionKey must be a non-empty string");
    }
    if (entry.decisionId.trim().length === 0) {
      throw new InvalidDurableConfigurationPolicyDecisionStoreError("entry.decisionId must be a non-empty string");
    }
    if (entry.identity.tenantId !== tenantId) {
      throw new InvalidDurableConfigurationPolicyDecisionStoreError(
        "entry.identity.tenantId must exactly match the given tenantId",
      );
    }

    const existing = this.getDecisionProjectionById(tenantId, entry.decisionKey, entry.decisionId);
    if (existing !== undefined) {
      if (!entryCoreIdentityEquals(existing, entry)) {
        throw new InvalidDurableConfigurationPolicyDecisionStoreError(
          `decisionId "${entry.decisionId}" is already recorded with different content`,
        );
      }
      return { value: existing, created: false };
    }

    const lockPath = this.appendLockPathFor(tenantId, entry.decisionKey, entry.decisionId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(entry);
    writeFileSync(tmpPath, payload, "utf8");
    let wonAppend: boolean;
    try {
      linkSync(tmpPath, lockPath);
      wonAppend = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      wonAppend = false;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only.
      }
    }

    if (!wonAppend) {
      const winnerRaw = readFileSync(lockPath, "utf8");
      const winner = validatePersistedEntry(JSON.parse(winnerRaw), tenantId, entry.decisionKey, lockPath);
      if (!entryCoreIdentityEquals(winner, entry)) {
        throw new InvalidDurableConfigurationPolicyDecisionStoreError(
          `decisionId "${entry.decisionId}" was already appended with different content by a concurrent caller`,
        );
      }
      if (this.getDecisionProjectionById(tenantId, entry.decisionKey, entry.decisionId) === undefined) {
        appendFileSync(this.filePathFor(tenantId, entry.decisionKey), `${winnerRaw}\n`, "utf8");
      }
      return { value: winner, created: false };
    }

    appendFileSync(this.filePathFor(tenantId, entry.decisionKey), `${payload}\n`, "utf8");
    return { value: entry, created: true };
  }

  getActiveDecisionProjection(
    tenantId: TenantScope["tenantId"],
    decisionKey: string,
  ): ConfigurationPolicyDecisionProjectionEntry | undefined {
    const all = this.readAll(tenantId, decisionKey);
    return all.length === 0 ? undefined : all[all.length - 1];
  }

  getDecisionProjectionHistory(
    tenantId: TenantScope["tenantId"],
    decisionKey: string,
  ): ReadonlyArray<ConfigurationPolicyDecisionProjectionEntry> {
    return this.readAll(tenantId, decisionKey);
  }

  getDecisionProjectionById(
    tenantId: TenantScope["tenantId"],
    decisionKey: string,
    decisionId: string,
  ): ConfigurationPolicyDecisionProjectionEntry | undefined {
    return this.readAll(tenantId, decisionKey).find((e) => e.decisionId === decisionId);
  }
}
