import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { OrganizationResourceBinding } from "./organization-resource-binding.js";

export class InvalidDurableOrganizationResourceBindingStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableOrganizationResourceBindingStore operation: ${reason}`);
    this.name = "InvalidDurableOrganizationResourceBindingStoreError";
  }
}

export class CorruptedOrganizationResourceBindingLineError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable organization-resource-binding line (${filePath}): ${reason}`);
    this.name = "CorruptedOrganizationResourceBindingLineError";
  }
}

export interface PersistOrganizationResourceBindingResult {
  readonly binding: OrganizationResourceBinding;
  readonly created: boolean;
}

function fail(filePath: string, reason: string): never {
  throw new CorruptedOrganizationResourceBindingLineError(filePath, reason);
}

function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  return value as string;
}

function requireStringArrayField(value: unknown, field: string, filePath: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    fail(filePath, `${field} must be an array of non-empty strings`);
  }
  return value as ReadonlyArray<string>;
}

/**
 * Rev94-pattern discipline reused verbatim: persisted state is an
 * external/untrusted boundary on replay - this revalidates the structural
 * shape `createOrganizationResourceBinding` itself produces rather than
 * trusting a blind `JSON.parse(...) as {...}` cast, and cross-checks
 * tenant-file/record tenant correlation (fail-closed on cross-tenant
 * contamination).
 */
function validatePersistedBindingRecord(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  filePath: string,
): { organizationId: string; binding: OrganizationResourceBinding } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, "line must be a JSON object, not an array or primitive");
  }
  const record = raw as Record<string, unknown>;
  const organizationId = requireNonEmptyStringField(record["organizationId"], "organizationId", filePath);

  const rawBinding = record["binding"];
  if (typeof rawBinding !== "object" || rawBinding === null || Array.isArray(rawBinding)) {
    fail(filePath, `record "${organizationId}".binding must be a JSON object`);
  }
  const bindingObj = rawBinding as Record<string, unknown>;

  if (bindingObj["version"] !== 1) {
    fail(filePath, `record "${organizationId}".binding.version must be 1`);
  }
  const tenantId = requireNonEmptyStringField(bindingObj["tenantId"], `record "${organizationId}".binding.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${organizationId}" is stored under tenant file "${expectedTenantId}" but binding.tenantId is "${tenantId}" - cross-tenant contamination`,
    );
  }
  const bindingOrganizationId = requireNonEmptyStringField(
    bindingObj["organizationId"],
    `record "${organizationId}".binding.organizationId`,
    filePath,
  );
  if (bindingOrganizationId !== organizationId) {
    fail(filePath, `record "${organizationId}".binding.organizationId does not match the record's own key`);
  }
  const membershipRefs = requireStringArrayField(bindingObj["membershipRefs"], `record "${organizationId}".binding.membershipRefs`, filePath);
  const servicePrincipalRefs = requireStringArrayField(
    bindingObj["servicePrincipalRefs"],
    `record "${organizationId}".binding.servicePrincipalRefs`,
    filePath,
  );
  const projectRef = requireNonEmptyStringField(bindingObj["projectRef"], `record "${organizationId}".binding.projectRef`, filePath);

  const rawOwnership = bindingObj["ownership"];
  if (typeof rawOwnership !== "object" || rawOwnership === null || Array.isArray(rawOwnership)) {
    fail(filePath, `record "${organizationId}".binding.ownership must be a JSON object`);
  }
  const ownershipObj = rawOwnership as Record<string, unknown>;
  const ownershipTenantId = requireNonEmptyStringField(ownershipObj["tenantId"], `record "${organizationId}".binding.ownership.tenantId`, filePath);
  if (ownershipTenantId !== expectedTenantId) {
    fail(filePath, `record "${organizationId}".binding.ownership.tenantId does not match the expected tenant`);
  }
  const ownershipCustomerId = requireNonEmptyStringField(ownershipObj["customerId"], `record "${organizationId}".binding.ownership.customerId`, filePath);
  const ownershipProjectId = requireNonEmptyStringField(ownershipObj["projectId"], `record "${organizationId}".binding.ownership.projectId`, filePath);
  const ownershipServiceRef = ownershipObj["serviceRef"];
  if (ownershipServiceRef !== undefined && (typeof ownershipServiceRef !== "string" || ownershipServiceRef.trim().length === 0)) {
    fail(filePath, `record "${organizationId}".binding.ownership.serviceRef must be a non-empty string when present`);
  }

  const connectionBindingRefs = requireStringArrayField(
    bindingObj["connectionBindingRefs"],
    `record "${organizationId}".binding.connectionBindingRefs`,
    filePath,
  );
  const effectiveConfigRefs = requireStringArrayField(
    bindingObj["effectiveConfigRefs"],
    `record "${organizationId}".binding.effectiveConfigRefs`,
    filePath,
  );
  const effectivePolicyRefs = requireStringArrayField(
    bindingObj["effectivePolicyRefs"],
    `record "${organizationId}".binding.effectivePolicyRefs`,
    filePath,
  );
  const workerRouteRefs = requireStringArrayField(bindingObj["workerRouteRefs"], `record "${organizationId}".binding.workerRouteRefs`, filePath);
  const knowledgeEvidenceRefs = requireStringArrayField(
    bindingObj["knowledgeEvidenceRefs"],
    `record "${organizationId}".binding.knowledgeEvidenceRefs`,
    filePath,
  );
  const boundAt = requireNonEmptyStringField(bindingObj["boundAt"], `record "${organizationId}".binding.boundAt`, filePath);
  if (Number.isNaN(Date.parse(boundAt))) {
    fail(filePath, `record "${organizationId}".binding.boundAt must be a valid ISO timestamp`);
  }

  const binding: OrganizationResourceBinding = {
    version: 1,
    tenantId: tenantId as TenantScope["tenantId"],
    organizationId: bindingOrganizationId as unknown as OrganizationResourceBinding["organizationId"],
    membershipRefs: membershipRefs as unknown as OrganizationResourceBinding["membershipRefs"],
    servicePrincipalRefs: servicePrincipalRefs as unknown as OrganizationResourceBinding["servicePrincipalRefs"],
    projectRef: projectRef as unknown as OrganizationResourceBinding["projectRef"],
    ownership: {
      tenantId: ownershipTenantId as TenantScope["tenantId"],
      customerId: ownershipCustomerId as unknown as OrganizationResourceBinding["ownership"]["customerId"],
      projectId: ownershipProjectId as unknown as OrganizationResourceBinding["ownership"]["projectId"],
      ...(ownershipServiceRef !== undefined ? { serviceRef: ownershipServiceRef as string } : {}),
    },
    connectionBindingRefs: connectionBindingRefs as unknown as OrganizationResourceBinding["connectionBindingRefs"],
    effectiveConfigRefs,
    effectivePolicyRefs,
    workerRouteRefs,
    knowledgeEvidenceRefs,
    boundAt,
  };

  return { organizationId, binding };
}

function bindingCoreIdentityEquals(a: OrganizationResourceBinding, b: OrganizationResourceBinding): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Mirrors `durable-external-sale-bootstrap-store.ts`'s own already-
 * established `putIfAbsent`-only idempotency pattern rather than inventing
 * a new one: this is the durable layer that lets a caller safely replay
 * `createOrganizationResourceBinding` for the SAME `organizationId` on
 * duplicate bootstrap calls or crash-recovery restart, without ever
 * producing a second binding record and without ever silently overwriting
 * an existing one with materially different content. `putIfAbsent` is the
 * sole write path - there is no plain "insert," and no "update": once
 * bootstrapped, a binding's own ref list is immutable; a caller observes a
 * changed real-world resource (a revoked membership, a degraded
 * connection) only by re-resolving `resolveOrganizationResourceBindingStatus`
 * with current evidence, never by mutating this durable record.
 */
export interface DurableOrganizationResourceBindingStore {
  putIfAbsent(
    tenantId: TenantScope["tenantId"],
    organizationId: string,
    binding: OrganizationResourceBinding,
  ): PersistOrganizationResourceBindingResult;
  get(tenantId: TenantScope["tenantId"], organizationId: string): OrganizationResourceBinding | undefined;
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs` - no new runtime dependency. Directly clones
 * `FileDurableExternalSaleBootstrapStore`'s exact race-honest
 * `linkSync`-based atomic-creation primitive: each writer first writes its
 * own record to a uniquely-named temp file, then attempts `linkSync` onto
 * an organizationId-scoped lock path, which either creates the destination
 * directory entry or fails `EEXIST` atomically - so exactly one writer's
 * `linkSync` can ever succeed for a given organizationId, regardless of
 * whether competing payloads are identical. The durable per-tenant `.jsonl`
 * file (read by `get`) is appended to only by the winning writer, as pure
 * durability bookkeeping - never part of the race arbitration itself.
 * Replay revalidates every persisted line (`validatePersistedBindingRecord`)
 * instead of blind-casting JSON, closing the same crash-recovery/corruption
 * gap `FileDurableExternalSaleBootstrapStore` already closes.
 */
export class FileDurableOrganizationResourceBindingStore implements DurableOrganizationResourceBindingStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.creationLockDir(), { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  private creationLockDir(): string {
    return join(this.baseDir, ".creation-locks");
  }

  private creationLockPathFor(tenantId: TenantScope["tenantId"], organizationId: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const orgKey = Buffer.from(organizationId, "utf8").toString("base64url");
    return join(this.creationLockDir(), `${tenantKey}.${orgKey}.lock`);
  }

  private readAll(tenantId: TenantScope["tenantId"]): Array<{ organizationId: string; binding: OrganizationResourceBinding }> {
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
        throw new CorruptedOrganizationResourceBindingLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
      }
      return validatePersistedBindingRecord(parsed, tenantId, filePath);
    });
  }

  private dedupedByOrganizationId(
    records: ReadonlyArray<{ organizationId: string; binding: OrganizationResourceBinding }>,
  ): Map<string, OrganizationResourceBinding> {
    const byId = new Map<string, OrganizationResourceBinding>();
    for (const record of records) {
      if (!byId.has(record.organizationId)) {
        byId.set(record.organizationId, record.binding);
      }
    }
    return byId;
  }

  putIfAbsent(
    tenantId: TenantScope["tenantId"],
    organizationId: string,
    binding: OrganizationResourceBinding,
  ): PersistOrganizationResourceBindingResult {
    if (organizationId.trim().length === 0) {
      throw new InvalidDurableOrganizationResourceBindingStoreError("organizationId must be a non-empty string");
    }
    if (binding.tenantId !== tenantId || binding.organizationId !== organizationId) {
      throw new InvalidDurableOrganizationResourceBindingStoreError(
        "binding.tenantId/organizationId must exactly match the given tenantId/organizationId",
      );
    }

    const existing = this.get(tenantId, organizationId);
    if (existing !== undefined) {
      if (!bindingCoreIdentityEquals(existing, binding)) {
        throw new InvalidDurableOrganizationResourceBindingStoreError(
          `organizationId "${organizationId}" is already bound with a different resource-binding record - duplicate bootstrap cannot duplicate or silently replace authority/resources`,
        );
      }
      return { binding: existing, created: false };
    }

    const lockPath = this.creationLockPathFor(tenantId, organizationId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ organizationId, binding });
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
        // best-effort cleanup only - the published lock (hard link) already
        // carries its own independent copy of the content.
      }
    }

    if (!wonCreation) {
      const winnerRaw = readFileSync(lockPath, "utf8");
      let winner: { organizationId: string; binding: OrganizationResourceBinding };
      try {
        winner = validatePersistedBindingRecord(JSON.parse(winnerRaw), tenantId, lockPath);
      } catch (cause) {
        throw new InvalidDurableOrganizationResourceBindingStoreError(
          `internal error: creation-lock content for organizationId "${organizationId}" is not a valid persisted record (${(cause as Error).message})`,
        );
      }
      if (!bindingCoreIdentityEquals(winner.binding, binding)) {
        throw new InvalidDurableOrganizationResourceBindingStoreError(
          `organizationId "${organizationId}" is already bound under a different resource-binding record`,
        );
      }
      return { binding: winner.binding, created: false };
    }

    const filePath = this.filePathFor(tenantId);
    appendFileSync(filePath, `${payload}\n`, "utf8");
    return { binding, created: true };
  }

  get(tenantId: TenantScope["tenantId"], organizationId: string): OrganizationResourceBinding | undefined {
    return this.dedupedByOrganizationId(this.readAll(tenantId)).get(organizationId);
  }
}
