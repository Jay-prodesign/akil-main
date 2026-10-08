import type { TenantScope } from "./tenant-scope.js";
import {
  createOrganization,
  activateOrganization,
  suspendOrganization,
  reactivateOrganization,
  type Organization,
} from "./organization.js";
import {
  createOrganizationMembership,
  revokeOrganizationMembership,
  type OrganizationMembership,
} from "./organization-membership.js";
import {
  createOrganizationAccessRoleContext,
  type OrganizationAccessRoleContext,
} from "./organization-access-role.js";
import { createCustomer, type Customer } from "./customer.js";
import { createProject, type Project } from "./project.js";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "./project-ownership.js";
import {
  createOrganizationResourceBinding,
  resolveOrganizationResourceBindingStatus,
  type OrganizationResourceBinding,
  type OrganizationResourceBindingStatus,
} from "./organization-resource-binding.js";

export class InvalidControlledOrganizationProvisioningError extends Error {
  constructor(reason: string) {
    super(`Invalid ControlledOrganizationProvisioning input: ${reason}`);
    this.name = "InvalidControlledOrganizationProvisioningError";
  }
}

export class InvalidControlledOrganizationProvisioningTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid ControlledOrganizationProvisioning transition: ${reason}`);
    this.name = "InvalidControlledOrganizationProvisioningTransitionError";
  }
}

export class ConflictingControlledOrganizationProvisioningReplayError extends Error {
  constructor(reason: string) {
    super(`Conflicting ControlledOrganizationProvisioning replay: ${reason}`);
    this.name = "ConflictingControlledOrganizationProvisioningReplayError";
  }
}

/**
 * OS-V1-01 "Controlled Organization Provisioning & Switching": the durable,
 * replay-safe owner `organization.ts` itself explicitly leaves to V1. This
 * module invents NO second IAM/workflow/provisioning framework - it is a
 * thin, deterministic, event-sourced orchestration layer over already-
 * accepted primitives (`createOrganization`/`activateOrganization`/
 * `suspendOrganization`/`reactivateOrganization`, `createOrganizationMembership`/
 * `revokeOrganizationMembership`, `createOrganizationAccessRoleContext`,
 * `createCustomer`/`createProject`/`createProjectOwnershipRef`,
 * `createOrganizationResourceBinding`/`resolveOrganizationResourceBindingStatus`).
 *
 * Rev203 correction round (F1-F4):
 *
 * **F1** - the baseline snapshot now composes a full `OrganizationResourceBinding`
 * (OS-V0-09) alongside the `Organization`, not just the founder identity.
 * `effectiveConfigRefs`/`effectivePolicyRefs`/`usageQuotaNamespaceRefs`/
 * `auditRecoveryRefs`/etc default to `[]` exactly as OS-V0-09 itself already
 * does for a candidate with no durable "current" registry yet for those
 * categories - an honest "not currently admitted" posture, not a fabricated
 * placeholder, per that module's own established discipline.
 *
 * **F2** - `resolveControlledOrganizationSwitch` is the new, explicit,
 * server-authoritative switch-admission check: it delegates WHOLESALE to
 * `resolveOrganizationResourceBindingStatus` (OS-V0-09, Rev183), which
 * already proves "is this exact membership currently, coherently, tenant-
 * correctly bound to THIS organization's own binding.membershipRefs" - the
 * precise check that makes a stale/foreign A-bound membership fail closed
 * against organization B (its id is simply never in B's own membershipRefs).
 * Per-organization ledger-file scoping still gives storage isolation; this
 * is the separate, now-present, admission-authority layer on top.
 *
 * **F3** - the persisted snapshot NEVER stores a founder `OrganizationMembership`/
 * `OrganizationAccessRoleContext` object at all - only the opaque
 * `founderMembershipId`/`founderPrincipalRef` REFS, mirroring
 * `OrganizationResourceBinding`'s own "opaque ref, never a copy of a
 * resource's own mutable state" discipline exactly. There is structurally
 * nothing in this module's own durable state for `reactivateControlledOrganization`
 * (which touches only the `Organization` lifecycle bit) to expose as a
 * stale membership state - membership currentness is always a fresh,
 * separately-supplied check via `resolveControlledOrganizationSwitch`/
 * `resolveOrganizationResourceBindingStatus`, never this module's own cached
 * copy.
 *
 * **F4** - `reinitializeControlledOrganization` now requires the CALLER's
 * own fresh, current founder-membership evidence (`currentFounderMembership`)
 * to revoke, rather than trusting any value this module might have cached -
 * consistent with F3's same "never cache authority state" discipline.
 */

export interface ControlledOrganizationProvisioningSnapshot {
  readonly organization: Organization;
  readonly project: Project;
  readonly resourceBinding: OrganizationResourceBinding;
  readonly founderMembershipId: OrganizationMembership["membershipId"];
  readonly founderPrincipalRef: string;
}

interface BaseProvisioningEvent {
  readonly tenantId: TenantScope["tenantId"];
  readonly organizationId: Organization["organizationId"];
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

export interface ProvisionedEvent extends BaseProvisioningEvent {
  readonly type: "PROVISIONED";
  readonly snapshot: ControlledOrganizationProvisioningSnapshot;
}

export interface SuspendedEvent extends BaseProvisioningEvent {
  readonly type: "SUSPENDED";
  readonly snapshot: ControlledOrganizationProvisioningSnapshot;
}

export interface ReactivatedEvent extends BaseProvisioningEvent {
  readonly type: "REACTIVATED";
  readonly snapshot: ControlledOrganizationProvisioningSnapshot;
}

export interface ReinitializedEvent extends BaseProvisioningEvent {
  readonly type: "REINITIALIZED";
  readonly snapshot: ControlledOrganizationProvisioningSnapshot;
  /** Rev202/Rev203 "no stale resurrection": the founder membership this reinitialization explicitly superseded, carried as evidence - never deleted, never silently dropped. */
  readonly supersededFounderMembership: OrganizationMembership;
}

export type ControlledOrganizationProvisioningEvent =
  | ProvisionedEvent
  | SuspendedEvent
  | ReactivatedEvent
  | ReinitializedEvent;

export interface ControlledOrganizationProvisioningLedger {
  readonly events: ReadonlyArray<ControlledOrganizationProvisioningEvent>;
}

export const EMPTY_CONTROLLED_ORGANIZATION_PROVISIONING_LEDGER: ControlledOrganizationProvisioningLedger = {
  events: [],
};

export interface ControlledOrganizationProvisioningOutcome {
  readonly status:
    | "PROVISIONED"
    | "ALREADY_PROVISIONED"
    | "SUSPENDED"
    | "ALREADY_SUSPENDED"
    | "REACTIVATED"
    | "ALREADY_REACTIVATED"
    | "REINITIALIZED"
    | "ALREADY_REINITIALIZED";
  readonly snapshot: ControlledOrganizationProvisioningSnapshot;
  /** Freshly (re)minted only on PROVISIONED/REINITIALIZED - the exact founder identity just created. Never read back from durable state; pure/deterministic given the same inputs. Absent on SUSPENDED/REACTIVATED (nothing minted) and on ALREADY_* idempotent replays (nothing newly minted). */
  readonly mintedFounderMembership?: OrganizationMembership;
  readonly mintedFounderAccessRoleContext?: OrganizationAccessRoleContext;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidControlledOrganizationProvisioningError(`${field} must be a non-empty string`);
  }
  return value;
}

/** Latest event in append order carrying this exact idempotencyKey, or undefined. There is never more than one per well-formed ledger - replay always returns the first (only) match without appending a second. */
function findByIdempotencyKey(
  ledger: ControlledOrganizationProvisioningLedger,
  idempotencyKey: string,
): ControlledOrganizationProvisioningEvent | undefined {
  return ledger.events.find((event) => event.idempotencyKey === idempotencyKey);
}

/**
 * Pure projection, mirroring `resolveOrganizationResourceBindingStatus`'s
 * own "never cache, always re-derive from current evidence" discipline:
 * the latest event in append order IS the current truth - there is no
 * separate mutable "current state" field anywhere to drift from it.
 */
export function projectCurrentControlledOrganizationState(
  ledger: ControlledOrganizationProvisioningLedger,
  organizationId: string,
): ControlledOrganizationProvisioningSnapshot | undefined {
  for (let i = ledger.events.length - 1; i >= 0; i -= 1) {
    const event = ledger.events[i];
    if (event !== undefined && event.organizationId === organizationId) {
      return event.snapshot;
    }
  }
  return undefined;
}

export function provisionControlledOrganization(input: {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly tenantScope: TenantScope;
  readonly organizationId: unknown;
  readonly displayName: unknown;
  readonly founderMembershipId: unknown;
  readonly founderPrincipalRef: unknown;
  readonly idempotencyKey: unknown;
  readonly occurredAt: unknown;
}): {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly outcome: ControlledOrganizationProvisioningOutcome;
} {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const organizationId = requireNonEmptyString(input.organizationId, "organizationId");

  const existingForKey = findByIdempotencyKey(input.ledger, idempotencyKey);
  if (existingForKey !== undefined) {
    if (
      existingForKey.type === "PROVISIONED" &&
      existingForKey.tenantId === input.tenantScope.tenantId &&
      existingForKey.organizationId === organizationId &&
      existingForKey.snapshot.organization.displayName === input.displayName &&
      existingForKey.snapshot.founderMembershipId === input.founderMembershipId &&
      existingForKey.snapshot.founderPrincipalRef === input.founderPrincipalRef
    ) {
      return { ledger: input.ledger, outcome: { status: "ALREADY_PROVISIONED", snapshot: existingForKey.snapshot } };
    }
    throw new ConflictingControlledOrganizationProvisioningReplayError(
      `idempotencyKey "${idempotencyKey}" is already recorded against a different provisioning operation/content`,
    );
  }

  const existingSnapshot = projectCurrentControlledOrganizationState(input.ledger, organizationId);
  if (existingSnapshot !== undefined) {
    throw new InvalidControlledOrganizationProvisioningError(
      `organizationId "${organizationId}" already has provisioning history under a different idempotencyKey - use reinitializeControlledOrganization to re-provision an existing organization, never provisionControlledOrganization again`,
    );
  }

  const occurredAt = requireNonEmptyString(input.occurredAt, "occurredAt");
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId,
      tenantScope: input.tenantScope,
      displayName: input.displayName,
      createdAt: occurredAt,
    }),
    activatedAt: occurredAt,
  });
  const founderMembership = createOrganizationMembership({
    membershipId: input.founderMembershipId,
    tenantScope: input.tenantScope,
    principalRef: input.founderPrincipalRef,
    role: "STAFF",
  });
  const founderAccessRoleContext = createOrganizationAccessRoleContext({
    membership: founderMembership,
    role: "OWNER",
  });

  const customer = createCustomer({
    tenantScope: input.tenantScope,
    customerId: `org-customer:${organizationId}`,
    displayName: input.displayName,
  });
  const project = createProject({
    tenantScope: input.tenantScope,
    customer,
    projectId: `org-baseline-project:${organizationId}`,
    ownerRef: `membership:${founderMembership.membershipId}`,
    state: "active",
  });
  const ownership = createProjectOwnershipRef({
    tenantId: input.tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
  });
  const resourceBinding = createOrganizationResourceBinding({
    organization,
    memberships: [founderMembership],
    project,
    ownership,
    boundAt: occurredAt,
  });

  const snapshot: ControlledOrganizationProvisioningSnapshot = {
    organization,
    project,
    resourceBinding,
    founderMembershipId: founderMembership.membershipId,
    founderPrincipalRef: founderMembership.principalRef,
  };
  const event: ProvisionedEvent = {
    type: "PROVISIONED",
    tenantId: input.tenantScope.tenantId,
    organizationId: organizationId as Organization["organizationId"],
    idempotencyKey,
    occurredAt,
    snapshot,
  };
  return {
    ledger: { events: [...input.ledger.events, event] },
    outcome: { status: "PROVISIONED", snapshot, mintedFounderMembership: founderMembership, mintedFounderAccessRoleContext: founderAccessRoleContext },
  };
}

export function suspendControlledOrganization(input: {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly tenantScope: TenantScope;
  readonly organizationId: unknown;
  readonly suspendedAt: unknown;
  readonly idempotencyKey: unknown;
}): {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly outcome: ControlledOrganizationProvisioningOutcome;
} {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const organizationId = requireNonEmptyString(input.organizationId, "organizationId");

  const existingForKey = findByIdempotencyKey(input.ledger, idempotencyKey);
  if (existingForKey !== undefined) {
    if (
      existingForKey.type === "SUSPENDED" &&
      existingForKey.tenantId === input.tenantScope.tenantId &&
      existingForKey.organizationId === organizationId
    ) {
      return { ledger: input.ledger, outcome: { status: "ALREADY_SUSPENDED", snapshot: existingForKey.snapshot } };
    }
    throw new ConflictingControlledOrganizationProvisioningReplayError(
      `idempotencyKey "${idempotencyKey}" is already recorded against a different provisioning operation/content`,
    );
  }

  const current = projectCurrentControlledOrganizationState(input.ledger, organizationId);
  if (current === undefined) {
    throw new InvalidControlledOrganizationProvisioningTransitionError(
      `organizationId "${organizationId}" has no provisioning history to suspend`,
    );
  }
  if (current.organization.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidControlledOrganizationProvisioningTransitionError(
      "the current provisioning record for this organizationId belongs to a different tenant",
    );
  }

  const suspendedOrganization = suspendOrganization({
    organization: current.organization,
    suspendedAt: input.suspendedAt,
  });
  const snapshot: ControlledOrganizationProvisioningSnapshot = {
    ...current,
    organization: suspendedOrganization,
  };
  const event: SuspendedEvent = {
    type: "SUSPENDED",
    tenantId: input.tenantScope.tenantId,
    organizationId: organizationId as Organization["organizationId"],
    idempotencyKey,
    occurredAt: requireNonEmptyString(input.suspendedAt, "suspendedAt"),
    snapshot,
  };
  return {
    ledger: { events: [...input.ledger.events, event] },
    outcome: { status: "SUSPENDED", snapshot },
  };
}

/**
 * Rev203 F3: this function touches ONLY the `Organization` lifecycle bit
 * via `reactivateOrganization`. It never reads, re-validates, or re-issues
 * any founder-membership evidence at all, and the snapshot it returns
 * carries no membership STATE claim whatsoever (only the opaque
 * `founderMembershipId`/`founderPrincipalRef` refs, unchanged) - there is
 * structurally nothing here that could expose a stale ACTIVE membership,
 * because this module never stores a membership's live state in the first
 * place. A caller who needs to know whether the founder membership is
 * CURRENTLY active must ask via `resolveControlledOrganizationSwitch`
 * (which re-resolves it fresh every time, never from a cache).
 */
export function reactivateControlledOrganization(input: {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly tenantScope: TenantScope;
  readonly organizationId: unknown;
  readonly reactivatedAt: unknown;
  readonly idempotencyKey: unknown;
}): {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly outcome: ControlledOrganizationProvisioningOutcome;
} {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const organizationId = requireNonEmptyString(input.organizationId, "organizationId");

  const existingForKey = findByIdempotencyKey(input.ledger, idempotencyKey);
  if (existingForKey !== undefined) {
    if (
      existingForKey.type === "REACTIVATED" &&
      existingForKey.tenantId === input.tenantScope.tenantId &&
      existingForKey.organizationId === organizationId
    ) {
      return { ledger: input.ledger, outcome: { status: "ALREADY_REACTIVATED", snapshot: existingForKey.snapshot } };
    }
    throw new ConflictingControlledOrganizationProvisioningReplayError(
      `idempotencyKey "${idempotencyKey}" is already recorded against a different provisioning operation/content`,
    );
  }

  const current = projectCurrentControlledOrganizationState(input.ledger, organizationId);
  if (current === undefined) {
    throw new InvalidControlledOrganizationProvisioningTransitionError(
      `organizationId "${organizationId}" has no provisioning history to reactivate`,
    );
  }
  if (current.organization.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidControlledOrganizationProvisioningTransitionError(
      "the current provisioning record for this organizationId belongs to a different tenant",
    );
  }

  const reactivatedOrganization = reactivateOrganization({
    organization: current.organization,
    reactivatedAt: input.reactivatedAt,
  });
  const snapshot: ControlledOrganizationProvisioningSnapshot = {
    ...current,
    organization: reactivatedOrganization,
  };
  const event: ReactivatedEvent = {
    type: "REACTIVATED",
    tenantId: input.tenantScope.tenantId,
    organizationId: organizationId as Organization["organizationId"],
    idempotencyKey,
    occurredAt: requireNonEmptyString(input.reactivatedAt, "reactivatedAt"),
    snapshot,
  };
  return {
    ledger: { events: [...input.ledger.events, event] },
    outcome: { status: "REACTIVATED", snapshot },
  };
}

/**
 * Rev202 "independent reset/reinitialize", Rev203 F3/F4: requires the
 * CALLER's own fresh, current founder-membership evidence
 * (`currentFounderMembership`) to revoke - never a value this module might
 * have cached (it never caches one at all). Its identity must match this
 * organization's own current `founderMembershipId`/tenantId, and it must
 * still be a coherent ACTIVE record (a caller who already knows it is
 * revoked has nothing live left here to supersede). Mints a genuinely NEW
 * founder membership/access-role/baseline-project/resource-binding
 * (deterministically derived from the new idempotencyKey, never reusing
 * the old project/binding) - the current organization must be `ACTIVE`
 * (this IS the "suspend blocking new effects" witness: suspension blocks
 * this provisioning-layer effect exactly as `resolveOrganizationResourceBindingStatus`
 * already blocks resource-binding readiness while suspended).
 */
export function reinitializeControlledOrganization(input: {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly tenantScope: TenantScope;
  readonly organizationId: unknown;
  readonly currentFounderMembership: OrganizationMembership;
  readonly newFounderMembershipId: unknown;
  readonly newFounderPrincipalRef: unknown;
  readonly supersessionReason: unknown;
  readonly occurredAt: unknown;
  readonly idempotencyKey: unknown;
}): {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly outcome: ControlledOrganizationProvisioningOutcome;
} {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const organizationId = requireNonEmptyString(input.organizationId, "organizationId");

  const existingForKey = findByIdempotencyKey(input.ledger, idempotencyKey);
  if (existingForKey !== undefined) {
    if (
      existingForKey.type === "REINITIALIZED" &&
      existingForKey.tenantId === input.tenantScope.tenantId &&
      existingForKey.organizationId === organizationId &&
      existingForKey.snapshot.founderMembershipId === input.newFounderMembershipId &&
      existingForKey.snapshot.founderPrincipalRef === input.newFounderPrincipalRef
    ) {
      return { ledger: input.ledger, outcome: { status: "ALREADY_REINITIALIZED", snapshot: existingForKey.snapshot } };
    }
    throw new ConflictingControlledOrganizationProvisioningReplayError(
      `idempotencyKey "${idempotencyKey}" is already recorded against a different provisioning operation/content`,
    );
  }

  const current = projectCurrentControlledOrganizationState(input.ledger, organizationId);
  if (current === undefined) {
    throw new InvalidControlledOrganizationProvisioningTransitionError(
      `organizationId "${organizationId}" has no provisioning history to reinitialize`,
    );
  }
  if (current.organization.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidControlledOrganizationProvisioningTransitionError(
      "the current provisioning record for this organizationId belongs to a different tenant",
    );
  }
  if (current.organization.state !== "ACTIVE") {
    throw new InvalidControlledOrganizationProvisioningTransitionError(
      `organization must be ACTIVE to reinitialize (got "${current.organization.state}") - reactivate first`,
    );
  }
  if (
    input.currentFounderMembership.membershipId !== current.founderMembershipId ||
    input.currentFounderMembership.tenantId !== input.tenantScope.tenantId
  ) {
    throw new InvalidControlledOrganizationProvisioningTransitionError(
      "currentFounderMembership does not match this organization's own current founderMembershipId/tenant - fresh, correctly-identified evidence is required, never a cached or substituted value",
    );
  }

  const occurredAt = requireNonEmptyString(input.occurredAt, "occurredAt");
  const supersededFounderMembership = revokeOrganizationMembership({
    membership: input.currentFounderMembership,
    revokedAt: occurredAt,
    revokedReason: input.supersessionReason,
  });
  const newFounderMembership = createOrganizationMembership({
    membershipId: input.newFounderMembershipId,
    tenantScope: input.tenantScope,
    principalRef: input.newFounderPrincipalRef,
    role: "STAFF",
  });
  const newFounderAccessRoleContext = createOrganizationAccessRoleContext({
    membership: newFounderMembership,
    role: "OWNER",
  });

  const customer = createCustomer({
    tenantScope: input.tenantScope,
    customerId: `org-customer:${organizationId}:${idempotencyKey}`,
    displayName: current.organization.displayName,
  });
  const project = createProject({
    tenantScope: input.tenantScope,
    customer,
    projectId: `org-baseline-project:${organizationId}:${idempotencyKey}`,
    ownerRef: `membership:${newFounderMembership.membershipId}`,
    state: "active",
  });
  const ownership = createProjectOwnershipRef({
    tenantId: input.tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
  });
  const resourceBinding = createOrganizationResourceBinding({
    organization: current.organization,
    memberships: [newFounderMembership],
    project,
    ownership,
    boundAt: occurredAt,
  });

  const snapshot: ControlledOrganizationProvisioningSnapshot = {
    organization: current.organization,
    project,
    resourceBinding,
    founderMembershipId: newFounderMembership.membershipId,
    founderPrincipalRef: newFounderMembership.principalRef,
  };
  const event: ReinitializedEvent = {
    type: "REINITIALIZED",
    tenantId: input.tenantScope.tenantId,
    organizationId: organizationId as Organization["organizationId"],
    idempotencyKey,
    occurredAt,
    snapshot,
    supersededFounderMembership,
  };
  return {
    ledger: { events: [...input.ledger.events, event] },
    outcome: {
      status: "REINITIALIZED",
      snapshot,
      mintedFounderMembership: newFounderMembership,
      mintedFounderAccessRoleContext: newFounderAccessRoleContext,
    },
  };
}

/**
 * Rev203 F2: the genuine, explicit, server-authoritative switch-admission
 * check (not merely "two files exist independently"). Delegates WHOLESALE
 * to the already-accepted `resolveOrganizationResourceBindingStatus`
 * (OS-V0-09, Rev183) - no second admission model is invented. A caller
 * requesting to switch INTO `organizationId` supplies their own current,
 * freshly-resolved membership evidence (`currentMemberships`, exactly the
 * same shape `resolveOrganizationResourceBindingStatus` already consumes
 * elsewhere); the result is `READY` only when that resolver's own full
 * gate chain passes, including the exact "is this membership's id
 * currently in THIS organization's own binding.membershipRefs" check that
 * makes a stale/foreign (e.g. Organization-A-bound) membership fail closed
 * against Organization B.
 */
export function resolveControlledOrganizationSwitch(input: {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly organizationId: unknown;
  readonly currentMemberships: ReadonlyArray<OrganizationMembership>;
}): OrganizationResourceBindingStatus {
  const organizationId = requireNonEmptyString(input.organizationId, "organizationId");
  const current = projectCurrentControlledOrganizationState(input.ledger, organizationId);
  if (current === undefined) {
    throw new InvalidControlledOrganizationProvisioningTransitionError(
      `organizationId "${organizationId}" has no provisioning history to switch into`,
    );
  }
  return resolveOrganizationResourceBindingStatus({
    binding: current.resourceBinding,
    organization: current.organization,
    currentMemberships: input.currentMemberships,
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: current.project,
    currentEffectiveConfigRefs: current.resourceBinding.effectiveConfigRefs,
    currentEffectivePolicyRefs: current.resourceBinding.effectivePolicyRefs,
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: current.resourceBinding.knowledgeEvidenceRefs,
  });
}
