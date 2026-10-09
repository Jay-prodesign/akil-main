import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import { createOrganizationResourceBinding, type OrganizationResourceBinding } from "./organization-resource-binding.js";

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
  const str = value as string;
  if (str.trim() !== str) {
    fail(filePath, `${field} must not contain leading or trailing whitespace`);
  }
  return str;
}

/**
 * Rev183 F4: `createOrganizationResourceBinding` rejects a ref array
 * containing a duplicate entry at construction time - replay validation
 * must reapply the identical invariant, not merely check element shape, or
 * a corrupted/replayed line could reconstruct a binding no ordinary
 * construction call could ever produce.
 */
function requireStringArrayField(value: unknown, field: string, filePath: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    fail(filePath, `${field} must be an array of non-empty strings`);
  }
  const entries = (value as unknown[]).map((entry, index) => requireNonEmptyStringField(entry, `${field}[${index}]`, filePath));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) {
      fail(filePath, `${field} contains a duplicate entry "${entry}"`);
    }
    seen.add(entry);
  }
  return entries;
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
  if (membershipRefs.length === 0) {
    // Rev183 F4: `createOrganizationResourceBinding` rejects an empty
    // membership list at construction ("a binding cannot be bootstrapped
    // from zero founder/internal identity evidence") - a corrupted/replayed
    // line reconstructing this state is a state construction itself could
    // never produce, and must fail closed identically.
    fail(filePath, `record "${organizationId}".binding.membershipRefs must contain at least one entry`);
  }
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
  if (ownershipProjectId !== projectRef) {
    // Rev183 F4: `createOrganizationResourceBinding` requires
    // `ownership.projectId === project.projectId` at construction - a
    // persisted record whose top-level `projectRef` and
    // `ownership.projectId` disagree could never have been produced by
    // construction and must fail closed on replay, not silently reconstruct
    // an impossible binding.
    fail(
      filePath,
      `record "${organizationId}".binding.projectRef ("${projectRef}") does not match binding.ownership.projectId ("${ownershipProjectId}")`,
    );
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
  const outcomeIdentityRefs = requireStringArrayField(
    bindingObj["outcomeIdentityRefs"],
    `record "${organizationId}".binding.outcomeIdentityRefs`,
    filePath,
  );
  const repositoryWorkspaceRefs = requireStringArrayField(
    bindingObj["repositoryWorkspaceRefs"],
    `record "${organizationId}".binding.repositoryWorkspaceRefs`,
    filePath,
  );
  const usageQuotaNamespaceRefs = requireStringArrayField(
    bindingObj["usageQuotaNamespaceRefs"],
    `record "${organizationId}".binding.usageQuotaNamespaceRefs`,
    filePath,
  );
  const auditRecoveryRefs = requireStringArrayField(
    bindingObj["auditRecoveryRefs"],
    `record "${organizationId}".binding.auditRecoveryRefs`,
    filePath,
  );
  const admittedCapabilityRefs = requireStringArrayField(
    bindingObj["admittedCapabilityRefs"],
    `record "${organizationId}".binding.admittedCapabilityRefs`,
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
    outcomeIdentityRefs,
    repositoryWorkspaceRefs,
    usageQuotaNamespaceRefs,
    auditRecoveryRefs,
    admittedCapabilityRefs,
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
      // Rev183 F2 partial-failure/restart recovery: a prior writer can win
      // this same creation-lock race (linkSync succeeds) and then crash
      // before its own appendFileSync ever runs, leaving the durable
      // per-tenant .jsonl file with no record of this organizationId even
      // though the lock now durably exists. Without this self-heal, this
      // call would report `created: false` (implying the record is durably
      // bound) while `get()` would keep returning `undefined` forever - a
      // silent, permanent partial-bootstrap state. Self-heal by durably
      // appending the SAME winning content before returning; a benign,
      // idempotent race between two self-healing readers is safe because
      // `get()`'s own dedup-by-organizationId keeps only the first matching
      // line and the content is byte-identical either way.
      if (this.get(tenantId, organizationId) === undefined) {
        appendFileSync(this.filePathFor(tenantId), `${winnerRaw}\n`, "utf8");
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

/**
 * Rev183 F2: the smallest generic bootstrap composition Brain's remedy
 * asks for - coordinates ONLY the already-existing
 * `createOrganizationResourceBinding` factory and this store's own
 * `putIfAbsent`, in that order, for ANY organizationId (no
 * `org_akilta`-specific branch, no new IAM/router/memory/economics system).
 * Proves two things by construction rather than by a caller's own
 * discipline: (1) deterministic idempotent reinitialization - calling this
 * twice with the SAME real evidence returns `created: false` the second
 * time and the identical persisted binding, never a duplicate; (2)
 * partial-failure/restart recovery - if a prior call's process crashed
 * partway through (including between winning the creation-lock race and
 * durably recording it), calling this again with the SAME evidence
 * recovers the exact same durable binding via `putIfAbsent`'s own
 * self-healing above, rather than throwing or silently producing a second
 * record.
 */
export function bootstrapOrganizationResourceBinding(
  input: { readonly store: DurableOrganizationResourceBindingStore } & Parameters<
    typeof createOrganizationResourceBinding
  >[0],
): PersistOrganizationResourceBindingResult {
  const { store, ...factoryInput } = input;
  const binding = createOrganizationResourceBinding(factoryInput);
  return store.putIfAbsent(factoryInput.organization.tenantId, factoryInput.organization.organizationId, binding);
}
