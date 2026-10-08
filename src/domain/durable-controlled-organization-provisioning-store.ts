import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { Organization, OrganizationLifecycleState } from "./organization.js";
import type { Project } from "./project.js";
import type { OrganizationMembership, OrganizationMembershipLifecycleState, OrganizationRole, AssignmentReference } from "./organization-membership.js";
import type { OrganizationResourceBinding, OrganizationResourceBindingStatus } from "./organization-resource-binding.js";
import type { AuthorityContext } from "./authority.js";
import {
  provisionControlledOrganization,
  suspendControlledOrganization,
  reactivateControlledOrganization,
  reinitializeControlledOrganization,
  resolveControlledOrganizationSwitch,
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

function strArray(record: Record<string, unknown>, field: string, filePath: string): ReadonlyArray<string> {
  const value = record[field];
  if (!Array.isArray(value)) {
    fail(filePath, `${field} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      fail(filePath, `${field}[${index}] must be a non-empty string`);
    }
    return entry as string;
  });
}

function obj(raw: unknown, field: string, filePath: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, `${field} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

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

function validateProject(raw: unknown, expectedTenantId: string, field: string, filePath: string): Project {
  const record = obj(raw, field, filePath);
  const tenantId = str(record, "tenantId", filePath);
  if (tenantId !== expectedTenantId) {
    fail(filePath, `${field}.tenantId "${tenantId}" does not match the expected tenant "${expectedTenantId}"`);
  }
  const customerId = str(record, "customerId", filePath);
  const projectId = str(record, "projectId", filePath);
  const ownerRef = str(record, "ownerRef", filePath);
  const state = str(record, "state", filePath);
  return {
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as unknown as Project["customerId"],
    projectId: projectId as unknown as Project["projectId"],
    ownerRef,
    state,
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

function validateResourceBinding(
  raw: unknown,
  expectedTenantId: string,
  field: string,
  filePath: string,
): OrganizationResourceBinding {
  const record = obj(raw, field, filePath);
  const version = record["version"];
  if (version !== 1) {
    fail(filePath, `${field}.version must be 1`);
  }
  const tenantId = str(record, "tenantId", filePath);
  if (tenantId !== expectedTenantId) {
    fail(filePath, `${field}.tenantId "${tenantId}" does not match the expected tenant "${expectedTenantId}"`);
  }
  const organizationId = str(record, "organizationId", filePath);
  const projectRef = str(record, "projectRef", filePath);
  const rawOwnership = obj(record["ownership"], `${field}.ownership`, filePath);
  const ownershipTenantId = str(rawOwnership, "tenantId", filePath);
  if (ownershipTenantId !== expectedTenantId) {
    fail(filePath, `${field}.ownership.tenantId "${ownershipTenantId}" does not match the expected tenant "${expectedTenantId}"`);
  }
  const ownershipCustomerId = str(rawOwnership, "customerId", filePath);
  const ownershipProjectId = str(rawOwnership, "projectId", filePath);
  const boundAt = str(record, "boundAt", filePath);

  const membershipRefs = strArray(record, "membershipRefs", filePath);
  const servicePrincipalRefs = strArray(record, "servicePrincipalRefs", filePath);
  const connectionBindingRefs = strArray(record, "connectionBindingRefs", filePath);
  const effectiveConfigRefs = strArray(record, "effectiveConfigRefs", filePath);
  const effectivePolicyRefs = strArray(record, "effectivePolicyRefs", filePath);
  const workerRouteRefs = strArray(record, "workerRouteRefs", filePath);
  const knowledgeEvidenceRefs = strArray(record, "knowledgeEvidenceRefs", filePath);
  const outcomeIdentityRefs = strArray(record, "outcomeIdentityRefs", filePath);
  const repositoryWorkspaceRefs = strArray(record, "repositoryWorkspaceRefs", filePath);
  const usageQuotaNamespaceRefs = strArray(record, "usageQuotaNamespaceRefs", filePath);
  const auditRecoveryRefs = strArray(record, "auditRecoveryRefs", filePath);
  const admittedCapabilityRefs = strArray(record, "admittedCapabilityRefs", filePath);

  return {
    version: 1,
    tenantId: tenantId as TenantScope["tenantId"],
    organizationId: organizationId as Organization["organizationId"],
    membershipRefs: membershipRefs as ReadonlyArray<OrganizationMembership["membershipId"]>,
    servicePrincipalRefs: servicePrincipalRefs as ReadonlyArray<never>,
    projectRef: projectRef as unknown as Project["projectId"],
    ownership: {
      tenantId: ownershipTenantId as TenantScope["tenantId"],
      customerId: ownershipCustomerId as unknown as Project["customerId"],
      projectId: ownershipProjectId as unknown as Project["projectId"],
    },
    connectionBindingRefs: connectionBindingRefs as ReadonlyArray<never>,
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
}

function validateSnapshot(raw: unknown, expectedTenantId: string, filePath: string): ControlledOrganizationProvisioningSnapshot {
  const record = obj(raw, "snapshot", filePath);
  return {
    organization: validateOrganization(record["organization"], expectedTenantId, "snapshot.organization", filePath),
    project: validateProject(record["project"], expectedTenantId, "snapshot.project", filePath),
    resourceBinding: validateResourceBinding(record["resourceBinding"], expectedTenantId, "snapshot.resourceBinding", filePath),
    founderMembershipId: str(record, "founderMembershipId", filePath) as unknown as OrganizationMembership["membershipId"],
    founderPrincipalRef: str(record, "founderPrincipalRef", filePath),
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
 * organizationId) pair, which is what gives storage-level A<->B isolation.
 * Real single-process atomicity comes from `provision`/`suspend`/
 * `reactivate`/`reinitialize` being fully SYNCHRONOUS methods with no
 * `await` anywhere in their read-decide-write critical section.
 *
 * `writeLedger` is `protected` (not `private`) specifically so a test
 * double can override it to inject a deterministic crash point between
 * pure computation and durable persistence (Rev203 F4's own required
 * intermediate-failure/restart-resume witness).
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

  protected writeLedger(
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
    readonly currentFounderMembership: OrganizationMembership;
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

  /**
   * Rev203 F2 / Rev204 F2-R1: the real switch-admission check, re-resolved
   * fresh from the target organization's own durable ledger every call -
   * never cached. Binds `currentMembership` to `currentPrincipalRef` via
   * `resolveEffectiveOrganizationAccess` before even reaching the
   * organization-currentness/binding gate - see
   * `resolveControlledOrganizationSwitch`'s own doc comment.
   */
  resolveSwitch(input: {
    readonly tenantScope: TenantScope;
    readonly organizationId: string;
    readonly currentMembership: OrganizationMembership;
    readonly currentPrincipalRef: unknown;
    readonly authority: AuthorityContext;
    readonly assignments?: ReadonlyArray<AssignmentReference>;
  }): OrganizationResourceBindingStatus {
    return resolveControlledOrganizationSwitch({
      ledger: this.readLedger(input.tenantScope.tenantId, input.organizationId),
      organizationId: input.organizationId,
      currentMembership: input.currentMembership,
      currentPrincipalRef: input.currentPrincipalRef,
      authority: input.authority,
      ...(input.assignments !== undefined ? { assignments: input.assignments } : {}),
    });
  }
}
