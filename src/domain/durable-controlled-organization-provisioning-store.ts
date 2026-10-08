import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { Organization, OrganizationLifecycleState } from "./organization.js";
import type { OrganizationMembership, OrganizationMembershipLifecycleState, OrganizationRole } from "./organization-membership.js";
import type { OrganizationAccessRoleContext, OrganizationAccessRole } from "./organization-access-role.js";
import {
  provisionControlledOrganization,
  suspendControlledOrganization,
  reactivateControlledOrganization,
  reinitializeControlledOrganization,
  projectCurrentControlledOrganizationState,
  EMPTY_CONTROLLED_ORGANIZATION_PROVISIONING_LEDGER,
  type ControlledOrganizationProvisioningLedger,
  type ControlledOrganizationProvisioningEvent,
  type ControlledOrganizationProvisioningOutcome,
  type ControlledOrganizationProvisioningSnapshot,
} from "./controlled-organization-provisioning.js";

export class CorruptedControlledOrganizationProvisioningRecordError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable controlled-organization-provisioning record (${filePath}): ${reason}`);
    this.name = "CorruptedControlledOrganizationProvisioningRecordError";
  }
}

const RECOGNIZED_ORGANIZATION_STATES: ReadonlySet<string> = new Set<OrganizationLifecycleState>([
  "BOOTSTRAPPING",
  "ACTIVE",
  "SUSPENDED",
]);
const RECOGNIZED_MEMBERSHIP_STATES: ReadonlySet<string> = new Set<OrganizationMembershipLifecycleState>([
  "ACTIVE",
  "REVOKED",
]);
const RECOGNIZED_MEMBERSHIP_ROLES: ReadonlySet<string> = new Set<OrganizationRole>([
  "STAFF",
  "JUNIOR",
  "STUDENT",
  "CLIENT_ASSOCIATE",
]);
const RECOGNIZED_ACCESS_ROLES: ReadonlySet<string> = new Set<OrganizationAccessRole>(["OWNER", "ADMIN", "MEMBER"]);
const RECOGNIZED_EVENT_TYPES: ReadonlySet<string> = new Set(["PROVISIONED", "SUSPENDED", "REACTIVATED", "REINITIALIZED"]);

function fail(filePath: string, reason: string): never {
  throw new CorruptedControlledOrganizationProvisioningRecordError(filePath, reason);
}

function str(record: Record<string, unknown>, field: string, filePath: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  return value as string;
}

function optionalStr(record: Record<string, unknown>, field: string, filePath: string): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field}, if present, must be a non-empty string`);
  }
  return value as string;
}

function obj(raw: unknown, field: string, filePath: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, `${field} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

/** Revalidates structural shape only (every nested value was already business-rule-validated by its own constructor before being persisted; replay re-checks shape/enum coherence against this exact tenant/org, never blind-casts). */
function validateOrganization(raw: unknown, expectedTenantId: string, field: string, filePath: string): Organization {
  const record = obj(raw, field, filePath);
  const organizationId = str(record, "organizationId", filePath);
  const tenantId = str(record, "tenantId", filePath);
  if (tenantId !== expectedTenantId) {
    fail(filePath, `${field}.tenantId "${tenantId}" does not match the expected tenant "${expectedTenantId}"`);
  }
  const displayName = str(record, "displayName", filePath);
  const state = record["state"];
  if (typeof state !== "string" || !RECOGNIZED_ORGANIZATION_STATES.has(state)) {
    fail(filePath, `${field}.state is not a recognized OrganizationLifecycleState`);
  }
  const createdAt = str(record, "createdAt", filePath);
  const activatedAt = optionalStr(record, "activatedAt", filePath);
  const suspendedAt = optionalStr(record, "suspendedAt", filePath);
  return {
    organizationId: organizationId as Organization["organizationId"],
    tenantId: tenantId as TenantScope["tenantId"],
    displayName,
    state: state as OrganizationLifecycleState,
    createdAt,
    ...(activatedAt !== undefined ? { activatedAt } : {}),
    ...(suspendedAt !== undefined ? { suspendedAt } : {}),
  };
}

function validateMembership(raw: unknown, expectedTenantId: string, field: string, filePath: string): OrganizationMembership {
  const record = obj(raw, field, filePath);
  const membershipId = str(record, "membershipId", filePath);
  const tenantId = str(record, "tenantId", filePath);
  if (tenantId !== expectedTenantId) {
    fail(filePath, `${field}.tenantId "${tenantId}" does not match the expected tenant "${expectedTenantId}"`);
  }
  const principalRef = str(record, "principalRef", filePath);
  const role = record["role"];
  if (typeof role !== "string" || !RECOGNIZED_MEMBERSHIP_ROLES.has(role)) {
    fail(filePath, `${field}.role is not a recognized OrganizationRole`);
  }
  const state = record["state"];
  if (typeof state !== "string" || !RECOGNIZED_MEMBERSHIP_STATES.has(state)) {
    fail(filePath, `${field}.state is not a recognized OrganizationMembershipLifecycleState`);
  }
  const revokedAt = optionalStr(record, "revokedAt", filePath);
  const revokedReason = optionalStr(record, "revokedReason", filePath);
  return {
    membershipId: membershipId as OrganizationMembership["membershipId"],
    tenantId: tenantId as TenantScope["tenantId"],
    principalRef,
    role: role as OrganizationRole,
    state: state as OrganizationMembershipLifecycleState,
    ...(revokedAt !== undefined ? { revokedAt } : {}),
    ...(revokedReason !== undefined ? { revokedReason } : {}),
  };
}

function validateAccessRoleContext(
  raw: unknown,
  expectedTenantId: string,
  field: string,
  filePath: string,
): OrganizationAccessRoleContext {
  const record = obj(raw, field, filePath);
  const tenantId = str(record, "tenantId", filePath);
  if (tenantId !== expectedTenantId) {
    fail(filePath, `${field}.tenantId "${tenantId}" does not match the expected tenant "${expectedTenantId}"`);
  }
  const membershipId = str(record, "membershipId", filePath);
  const principalRef = str(record, "principalRef", filePath);
  const role = record["role"];
  if (typeof role !== "string" || !RECOGNIZED_ACCESS_ROLES.has(role)) {
    fail(filePath, `${field}.role is not a recognized OrganizationAccessRole`);
  }
  return {
    tenantId: tenantId as TenantScope["tenantId"],
    membershipId: membershipId as OrganizationMembership["membershipId"],
    principalRef,
    role: role as OrganizationAccessRole,
  };
}

function validateSnapshot(raw: unknown, expectedTenantId: string, filePath: string): ControlledOrganizationProvisioningSnapshot {
  const record = obj(raw, "snapshot", filePath);
  return {
    organization: validateOrganization(record["organization"], expectedTenantId, "snapshot.organization", filePath),
    founderMembership: validateMembership(record["founderMembership"], expectedTenantId, "snapshot.founderMembership", filePath),
    founderAccessRoleContext: validateAccessRoleContext(
      record["founderAccessRoleContext"],
      expectedTenantId,
      "snapshot.founderAccessRoleContext",
      filePath,
    ),
  };
}

function validatePersistedEvent(
  raw: unknown,
  expectedTenantId: string,
  expectedOrganizationId: string,
  filePath: string,
): ControlledOrganizationProvisioningEvent {
  const record = obj(raw, "event", filePath);
  const type = record["type"];
  if (typeof type !== "string" || !RECOGNIZED_EVENT_TYPES.has(type)) {
    fail(filePath, "event.type is not a recognized ControlledOrganizationProvisioningEvent type");
  }
  const tenantId = str(record, "tenantId", filePath);
  if (tenantId !== expectedTenantId) {
    fail(filePath, `event.tenantId "${tenantId}" does not match the expected tenant "${expectedTenantId}"`);
  }
  const organizationId = str(record, "organizationId", filePath);
  if (organizationId !== expectedOrganizationId) {
    fail(filePath, `event.organizationId "${organizationId}" does not match the expected organizationId "${expectedOrganizationId}"`);
  }
  const idempotencyKey = str(record, "idempotencyKey", filePath);
  const occurredAt = str(record, "occurredAt", filePath);
  const snapshot = validateSnapshot(record["snapshot"], expectedTenantId, filePath);

  const base = { tenantId: tenantId as TenantScope["tenantId"], organizationId: organizationId as Organization["organizationId"], idempotencyKey, occurredAt, snapshot };
  if (type === "REINITIALIZED") {
    const supersededFounderMembership = validateMembership(
      record["supersededFounderMembership"],
      expectedTenantId,
      "supersededFounderMembership",
      filePath,
    );
    return { type: "REINITIALIZED", ...base, supersededFounderMembership };
  }
  return { type: type as "PROVISIONED" | "SUSPENDED" | "REACTIVATED", ...base };
}

/**
 * Reference/local durable implementation using only `node:fs`, mirroring
 * `FileDurableQuotaReservationStore`'s own exact pattern: one append-only
 * JSON-lines ledger file per scope - here, scoped per (tenantId,
 * organizationId) pair rather than per budget scope, which is precisely
 * what gives "A<->B switch isolation" (Rev202's required witness) for
 * free: two different organizationIds under the same tenant are two
 * physically separate files, so there is no shared mutable state for one
 * organization's provisioning history to leak into the other's, even under
 * deliberately adversarial idempotencyKey reuse across the two.
 *
 * Real single-process atomicity comes from `provision`/`suspend`/
 * `reactivate`/`reinitialize` being fully SYNCHRONOUS methods with no
 * `await` anywhere in their read-decide-write critical section, exactly
 * the same discipline the quota/outcome-job/connector stores already rely
 * on.
 */
export class FileDurableControlledOrganizationProvisioningStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"], organizationId: string): string {
    const safeKey = Buffer.from(`${tenantId}::${organizationId}`, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  private readLedger(tenantId: TenantScope["tenantId"], organizationId: string): ControlledOrganizationProvisioningLedger {
    const filePath = this.filePathFor(tenantId, organizationId);
    if (!existsSync(filePath)) {
      return EMPTY_CONTROLLED_ORGANIZATION_PROVISIONING_LEDGER;
    }
    const content = readFileSync(filePath, "utf8");
    const events = content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (cause) {
          throw new CorruptedControlledOrganizationProvisioningRecordError(
            filePath,
            `line is not valid JSON (${(cause as Error).message})`,
          );
        }
        return validatePersistedEvent(parsed, tenantId, organizationId, filePath);
      });
    return { events };
  }

  private writeLedger(
    tenantId: TenantScope["tenantId"],
    organizationId: string,
    ledger: ControlledOrganizationProvisioningLedger,
  ): void {
    const filePath = this.filePathFor(tenantId, organizationId);
    const content = ledger.events.map((event) => JSON.stringify(event)).join("\n");
    writeFileSync(filePath, ledger.events.length > 0 ? `${content}\n` : "", "utf8");
  }

  provision(input: {
    readonly tenantScope: TenantScope;
    readonly organizationId: unknown;
    readonly displayName: unknown;
    readonly founderMembershipId: unknown;
    readonly founderPrincipalRef: unknown;
    readonly idempotencyKey: unknown;
    readonly occurredAt: unknown;
  }): ControlledOrganizationProvisioningOutcome {
    const organizationId = typeof input.organizationId === "string" ? input.organizationId : "";
    const ledger = this.readLedger(input.tenantScope.tenantId, organizationId);
    const { ledger: nextLedger, outcome } = provisionControlledOrganization({ ledger, ...input });
    this.writeLedger(input.tenantScope.tenantId, organizationId, nextLedger);
    return outcome;
  }

  suspend(input: {
    readonly tenantScope: TenantScope;
    readonly organizationId: unknown;
    readonly suspendedAt: unknown;
    readonly idempotencyKey: unknown;
  }): ControlledOrganizationProvisioningOutcome {
    const organizationId = typeof input.organizationId === "string" ? input.organizationId : "";
    const ledger = this.readLedger(input.tenantScope.tenantId, organizationId);
    const { ledger: nextLedger, outcome } = suspendControlledOrganization({ ledger, ...input });
    this.writeLedger(input.tenantScope.tenantId, organizationId, nextLedger);
    return outcome;
  }

  reactivate(input: {
    readonly tenantScope: TenantScope;
    readonly organizationId: unknown;
    readonly reactivatedAt: unknown;
    readonly idempotencyKey: unknown;
  }): ControlledOrganizationProvisioningOutcome {
    const organizationId = typeof input.organizationId === "string" ? input.organizationId : "";
    const ledger = this.readLedger(input.tenantScope.tenantId, organizationId);
    const { ledger: nextLedger, outcome } = reactivateControlledOrganization({ ledger, ...input });
    this.writeLedger(input.tenantScope.tenantId, organizationId, nextLedger);
    return outcome;
  }

  reinitialize(input: {
    readonly tenantScope: TenantScope;
    readonly organizationId: unknown;
    readonly newFounderMembershipId: unknown;
    readonly newFounderPrincipalRef: unknown;
    readonly supersessionReason: unknown;
    readonly occurredAt: unknown;
    readonly idempotencyKey: unknown;
  }): ControlledOrganizationProvisioningOutcome {
    const organizationId = typeof input.organizationId === "string" ? input.organizationId : "";
    const ledger = this.readLedger(input.tenantScope.tenantId, organizationId);
    const { ledger: nextLedger, outcome } = reinitializeControlledOrganization({ ledger, ...input });
    this.writeLedger(input.tenantScope.tenantId, organizationId, nextLedger);
    return outcome;
  }

  getCurrentState(
    tenantScope: TenantScope,
    organizationId: string,
  ): ControlledOrganizationProvisioningSnapshot | undefined {
    return projectCurrentControlledOrganizationState(this.readLedger(tenantScope.tenantId, organizationId), organizationId);
  }
}
