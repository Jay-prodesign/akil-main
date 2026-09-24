import type { TenantScope } from "./tenant-scope.js";

export class InvalidOrganizationError extends Error {
  constructor(reason: string) {
    super(`Invalid Organization: ${reason}`);
    this.name = "InvalidOrganizationError";
  }
}

export class InvalidOrganizationTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid Organization transition: ${reason}`);
    this.name = "InvalidOrganizationTransitionError";
  }
}

type OrganizationId = string & { readonly __brand: "OrganizationId" };

/**
 * OS-V0-01: minimal V0 lifecycle. `BOOTSTRAPPING` is construction/bootstrap;
 * `ACTIVE` is normal usable state; `SUSPENDED` is a controlled stop. No
 * reactivation is representable here - richer suspend/reactivate/offboarding
 * semantics are a V1 concern, not invented in this bounded slice.
 */
export type OrganizationLifecycleState = "BOOTSTRAPPING" | "ACTIVE" | "SUSPENDED";

/**
 * OS-V0-01 "Organization Kernel": the minimum explicit Organization product/
 * domain identity required for OS V0. `TenantScope` remains the reused
 * isolation boundary (imported, never replaced) - `tenantId` here is always
 * taken from a supplied `TenantScope`, never a separately supplied value, so
 * an Organization can never be constructed detached from a real tenant
 * partition. Deliberately carries no customer/commercial field (`Customer`
 * is a distinct concept), no members/roles/assignments field
 * (`OrganizationMembership` remains separately constructible against the
 * same `TenantScope`), no permissions/authorization field (`AuthorityContext`
 * remains solely `authority.ts`'s concern - creating/activating an
 * Organization can never manufacture one), and no partner-relationship
 * field (`PartnerOrganization` remains separate). "Organization Zero"
 * (AKILTA itself) is representable through this exact same contract with no
 * `isSystem`/bypass flag, no privileged constructor, and no hidden authority
 * grant - it is ordinary evidence, not a special code path.
 */
export interface Organization {
  readonly organizationId: OrganizationId;
  readonly tenantId: TenantScope["tenantId"];
  readonly displayName: string;
  readonly state: OrganizationLifecycleState;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly suspendedAt?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidOrganizationError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidOrganizationError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidOrganizationError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidOrganizationError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * Mirrors `service-catalog-admission.ts`'s `requireValidTimestamp`: a
 * malformed or non-parseable timestamp is rejected as a base
 * `InvalidOrganizationError` (shape/format defect), never as a
 * `InvalidOrganizationTransitionError` (state/ordering defect) - the two
 * failure classes stay distinct even though both can surface during a
 * transition call. Every ordering comparison uses the parsed `ms` value,
 * never the raw string, so two chronologically-equal instants expressed
 * with different timezone offsets compare correctly.
 */
function requireValidTimestamp(value: unknown, field: string): { raw: string; ms: number } {
  const raw = requireNonEmptyString(value, field);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new InvalidOrganizationError(`${field} must be a valid ISO timestamp`);
  }
  return { raw, ms };
}

/**
 * O1/O2/O3: always starts `BOOTSTRAPPING` - callers cannot forge an initial
 * `ACTIVE`/`SUSPENDED` state, since this factory accepts no `state` input at
 * all. `tenantId` is taken from `tenantScope`, never a separately supplied
 * value, so two Organizations with the same-looking `organizationId` under
 * different `TenantScope`s remain structurally tenant-distinct values (their
 * `tenantId` fields differ) - tenant identity is never inferred from
 * `organizationId`.
 */
export function createOrganization(input: {
  organizationId: unknown;
  tenantScope: TenantScope;
  displayName: unknown;
  createdAt: unknown;
}): Organization {
  const organizationId = requireNonEmptyString(input.organizationId, "organizationId");
  const displayName = requireNonEmptyString(input.displayName, "displayName");
  const createdAt = requireValidTimestamp(input.createdAt, "createdAt");
  return {
    organizationId: organizationId as OrganizationId,
    tenantId: input.tenantScope.tenantId,
    displayName,
    state: "BOOTSTRAPPING",
    createdAt: createdAt.raw,
  };
}

/**
 * Rev126 F1: `Organization` is an exported structural interface, so a
 * caller can hand-build an object with an impossible lifecycle-field
 * combination (e.g. `state: "ACTIVE"` with a stale/absent `activatedAt`, or
 * a stray `suspendedAt` already present) instead of reaching that shape
 * only through `createOrganization`/`activateOrganization`/
 * `suspendOrganization`. Both transition functions below revalidate the
 * FULL pre-existing record's lifecycle shape/timestamps - not merely the
 * newly-supplied transition timestamp - before consuming it, so a forged
 * record can never be advanced into a valid-looking later state. Exactly
 * one shape is valid per state: `BOOTSTRAPPING` => valid `createdAt`, no
 * `activatedAt`/`suspendedAt`; `ACTIVE` => valid `createdAt` + valid
 * `activatedAt` with `activatedAt >= createdAt`, no `suspendedAt`;
 * `SUSPENDED` => all three valid and `createdAt <= activatedAt <=
 * suspendedAt` (enforced incrementally as each state is reached).
 */

/**
 * O4/O6/O7/Rev126 F1: only `BOOTSTRAPPING -> ACTIVE`. Returns a new value
 * (immutable); the prior `createdAt`/`displayName`/`tenantId`/
 * `organizationId` provenance is preserved verbatim via spread, never
 * recomputed. Rejects a hand-built `BOOTSTRAPPING` record that already
 * carries a stale `activatedAt` or `suspendedAt` - a genuinely
 * `BOOTSTRAPPING` value can never have either field set. `activatedAt` must
 * be a valid instant not chronologically before `createdAt` - equal is
 * accepted (immediate activation), matching the repository's existing
 * `revokeServiceCatalogAdmission`/`partner-capability-admission.ts` "equal
 * is not before" precedent.
 */
export function activateOrganization(input: {
  organization: Organization;
  activatedAt: unknown;
}): Organization {
  if (input.organization.state !== "BOOTSTRAPPING") {
    throw new InvalidOrganizationTransitionError(
      `organization must be BOOTSTRAPPING to activate (got "${input.organization.state}")`,
    );
  }
  if (input.organization.activatedAt !== undefined) {
    throw new InvalidOrganizationTransitionError(
      "a BOOTSTRAPPING organization must not already carry activatedAt",
    );
  }
  if (input.organization.suspendedAt !== undefined) {
    throw new InvalidOrganizationTransitionError(
      "a BOOTSTRAPPING organization must not already carry suspendedAt",
    );
  }
  const createdAt = requireValidTimestamp(input.organization.createdAt, "organization.createdAt");
  const activatedAt = requireValidTimestamp(input.activatedAt, "activatedAt");
  if (activatedAt.ms < createdAt.ms) {
    throw new InvalidOrganizationTransitionError("activatedAt must not be before createdAt");
  }
  return {
    ...input.organization,
    state: "ACTIVE",
    activatedAt: activatedAt.raw,
  };
}

/**
 * O5/O6/O7/Rev126 F1: only `ACTIVE -> SUSPENDED`. Rejects a hand-built
 * `ACTIVE` record that already carries a stale `suspendedAt` - a genuinely
 * `ACTIVE` value can never have it set. Revalidates the FULL pre-existing
 * record (`createdAt` and `activatedAt`, not merely `activatedAt` alone)
 * and re-proves `createdAt <= activatedAt`, closing the gap where a forged
 * `ACTIVE` object with `createdAt` after `activatedAt` could otherwise
 * reach `SUSPENDED` merely because the new `suspendedAt` compares correctly
 * against the (already-inconsistent) `activatedAt`. `suspendedAt` must not
 * be chronologically before `activatedAt`; equal is accepted (immediate
 * suspension).
 */
export function suspendOrganization(input: {
  organization: Organization;
  suspendedAt: unknown;
}): Organization {
  if (input.organization.state !== "ACTIVE") {
    throw new InvalidOrganizationTransitionError(
      `organization must be ACTIVE to suspend (got "${input.organization.state}")`,
    );
  }
  if (input.organization.suspendedAt !== undefined) {
    throw new InvalidOrganizationTransitionError(
      "an ACTIVE organization must not already carry suspendedAt",
    );
  }
  const createdAt = requireValidTimestamp(input.organization.createdAt, "organization.createdAt");
  const activatedAt = requireValidTimestamp(input.organization.activatedAt, "organization.activatedAt");
  if (activatedAt.ms < createdAt.ms) {
    throw new InvalidOrganizationTransitionError("organization.activatedAt must not be before organization.createdAt");
  }
  const suspendedAt = requireValidTimestamp(input.suspendedAt, "suspendedAt");
  if (suspendedAt.ms < activatedAt.ms) {
    throw new InvalidOrganizationTransitionError("suspendedAt must not be before activatedAt");
  }
  return {
    ...input.organization,
    state: "SUSPENDED",
    suspendedAt: suspendedAt.raw,
  };
}
