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
 * replay-safe owner `organization.ts` itself explicitly leaves to V1 (its
 * own OS-V0-01 doc comment: "richer suspend/reactivate/offboarding
 * semantics are a V1 concern, not invented in this bounded slice"). This
 * module invents NO second IAM/workflow/provisioning framework - it is a
 * thin, deterministic, event-sourced orchestration layer over already-
 * accepted primitives (`createOrganization`/`activateOrganization`/
 * `suspendOrganization`/`reactivateOrganization`, `createOrganizationMembership`/
 * `revokeOrganizationMembership`, `createOrganizationAccessRoleContext`),
 * mirroring two already-established house patterns exactly: the
 * idempotencyKey-keyed replay-safety ledger of `execution-quota-admission.ts`
 * (`durable-quota-reservation-store.ts`), and the deterministic-composition-
 * plus-durable-store split of `external-sale-bootstrap.ts`/
 * `durable-external-sale-bootstrap-store.ts`.
 *
 * Every public function here is pure (no fs/network/randomness/wall-clock
 * read) - the durable persistence boundary is
 * `durable-controlled-organization-provisioning-store.ts`, which calls
 * these exactly as `FileDurableQuotaReservationStore` calls
 * `admitQuotaReservation`/`commitQuotaUsage`/`releaseQuotaReservation`.
 *
 * DELIBERATE SCOPE DISCIPLINE (Rev202's own explicit prohibition): no public
 * signup/onboarding, no live provider credential/effect, no billing/DNS/
 * spend, no customer/public effect, no merge/MAIN mutation, no V1-02 work.
 * "Switching" between two controlled Organizations is not a separate
 * runtime concept to invent - it falls out for free from this module's own
 * per-(tenantId, organizationId) ledger scoping (see the durable store):
 * resolving Organization A's current state and Organization B's current
 * state are two independent, freshly-re-derived calls against two
 * independent ledgers, with no shared mutable cache to leak between them.
 */

/**
 * The current, freshly-composed truth for one controlled Organization at
 * one point in its own history. Every lifecycle event below carries one of
 * these verbatim - there is no separate "current pointer" a caller could
 * read instead; `projectCurrentControlledOrganizationState` (below) is the
 * ONLY way to ask "what is true now," and it always re-scans the ledger
 * rather than trusting any cached value.
 */
export interface ControlledOrganizationProvisioningSnapshot {
  readonly organization: Organization;
  readonly founderMembership: OrganizationMembership;
  readonly founderAccessRoleContext: OrganizationAccessRoleContext;
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
  /** Rev202 "no stale resurrection": the founder membership this reinitialization explicitly superseded, carried as evidence - never deleted, never silently dropped. */
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
}): { readonly ledger: ControlledOrganizationProvisioningLedger; readonly outcome: ControlledOrganizationProvisioningOutcome } {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const organizationId = requireNonEmptyString(input.organizationId, "organizationId");

  const existingForKey = findByIdempotencyKey(input.ledger, idempotencyKey);
  if (existingForKey !== undefined) {
    if (
      existingForKey.type === "PROVISIONED" &&
      existingForKey.tenantId === input.tenantScope.tenantId &&
      existingForKey.organizationId === organizationId &&
      existingForKey.snapshot.organization.displayName === input.displayName &&
      existingForKey.snapshot.founderMembership.principalRef === input.founderPrincipalRef &&
      existingForKey.snapshot.founderMembership.membershipId === input.founderMembershipId
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

  const createdAt = requireNonEmptyString(input.occurredAt, "occurredAt");
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId,
      tenantScope: input.tenantScope,
      displayName: input.displayName,
      createdAt,
    }),
    activatedAt: createdAt,
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

  const snapshot: ControlledOrganizationProvisioningSnapshot = {
    organization,
    founderMembership,
    founderAccessRoleContext,
  };
  const event: ProvisionedEvent = {
    type: "PROVISIONED",
    tenantId: input.tenantScope.tenantId,
    organizationId: organizationId as Organization["organizationId"],
    idempotencyKey,
    occurredAt: createdAt,
    snapshot,
  };
  return {
    ledger: { events: [...input.ledger.events, event] },
    outcome: { status: "PROVISIONED", snapshot },
  };
}

export function suspendControlledOrganization(input: {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly tenantScope: TenantScope;
  readonly organizationId: unknown;
  readonly suspendedAt: unknown;
  readonly idempotencyKey: unknown;
}): { readonly ledger: ControlledOrganizationProvisioningLedger; readonly outcome: ControlledOrganizationProvisioningOutcome } {
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
 * Rev202 "reactivation without stale membership/connection/config/session
 * resurrection": this function touches ONLY the `Organization` lifecycle
 * bit via `reactivateOrganization` - it never reads, re-validates, or
 * re-issues `founderMembership`/`founderAccessRoleContext` at all, so a
 * membership independently revoked while the organization was SUSPENDED
 * stays revoked straight through reactivation (the carried-forward
 * `snapshot.founderMembership` below is whatever the caller's own current
 * membership evidence says it is, never silently re-activated by this
 * function).
 */
export function reactivateControlledOrganization(input: {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly tenantScope: TenantScope;
  readonly organizationId: unknown;
  readonly reactivatedAt: unknown;
  readonly idempotencyKey: unknown;
}): { readonly ledger: ControlledOrganizationProvisioningLedger; readonly outcome: ControlledOrganizationProvisioningOutcome } {
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
 * Rev202 "independent reset/reinitialize": deliberately requires the
 * CURRENT organization to be `ACTIVE` - reinitializing a `SUSPENDED`
 * organization is rejected (this IS the "suspend blocking new effects"
 * witness: suspension blocks this new-founder-provisioning effect exactly
 * as it blocks everything else gated on organization currentness). The
 * prior founder membership is explicitly `revokeOrganizationMembership`'d
 * (never silently superseded/ignored - its revocation is itself durable
 * evidence, carried in `supersededFounderMembership`), and a genuinely NEW
 * `OrganizationMembership`/`OrganizationAccessRoleContext` pair is minted
 * for the new founder. The `Organization` value itself is untouched (no
 * lifecycle transition) - reinitialize is a founder-identity reset, not a
 * suspend/reactivate cycle.
 */
export function reinitializeControlledOrganization(input: {
  readonly ledger: ControlledOrganizationProvisioningLedger;
  readonly tenantScope: TenantScope;
  readonly organizationId: unknown;
  readonly newFounderMembershipId: unknown;
  readonly newFounderPrincipalRef: unknown;
  readonly supersessionReason: unknown;
  readonly occurredAt: unknown;
  readonly idempotencyKey: unknown;
}): { readonly ledger: ControlledOrganizationProvisioningLedger; readonly outcome: ControlledOrganizationProvisioningOutcome } {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const organizationId = requireNonEmptyString(input.organizationId, "organizationId");

  const existingForKey = findByIdempotencyKey(input.ledger, idempotencyKey);
  if (existingForKey !== undefined) {
    if (
      existingForKey.type === "REINITIALIZED" &&
      existingForKey.tenantId === input.tenantScope.tenantId &&
      existingForKey.organizationId === organizationId &&
      existingForKey.snapshot.founderMembership.membershipId === input.newFounderMembershipId &&
      existingForKey.snapshot.founderMembership.principalRef === input.newFounderPrincipalRef
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

  const occurredAt = requireNonEmptyString(input.occurredAt, "occurredAt");
  const supersededFounderMembership = revokeOrganizationMembership({
    membership: current.founderMembership,
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

  const snapshot: ControlledOrganizationProvisioningSnapshot = {
    organization: current.organization,
    founderMembership: newFounderMembership,
    founderAccessRoleContext: newFounderAccessRoleContext,
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
    outcome: { status: "REINITIALIZED", snapshot },
  };
}
