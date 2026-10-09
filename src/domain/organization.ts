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
 * `ACTIVE` is normal usable state; `SUSPENDED` is a controlled stop.
 * Reactivation (`SUSPENDED` -> `ACTIVE`) was the first V1 concern, closed by
 * OS-V1-01's `reactivateOrganization`. `OFFBOARDED` (OS-V1-04) is the second:
 * a one-way terminal "deleted" stop, reachable only from `SUSPENDED`, with
 * no reactivation function implemented or exposed for it - once offboarded,
 * an Organization can never return to any other state. This is the minimal
 * floor the Master Roadmap's "offboarding invalidates dependent
 * projections"/"deleted-data reappearance" requirement needs, not a richer
 * data-residency/legal-hold concept.
 */
export type OrganizationLifecycleState = "BOOTSTRAPPING" | "ACTIVE" | "SUSPENDED" | "OFFBOARDED";

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
  readonly offboardedAt?: string;
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
/**
 * OS-V1-01: the reactivation transition explicitly left to V1 by this
 * file's own original OS-V0-01 doc comment ("No reactivation is
 * representable here - richer suspend/reactivate... semantics are a V1
 * concern"). Only `SUSPENDED -> ACTIVE`. Revalidates the FULL pre-existing
 * `SUSPENDED` record first (mirrors `suspendOrganization`'s own
 * revalidation of its `ACTIVE` predecessor) - `createdAt <= activatedAt <=
 * suspendedAt` must all still hold before this transition is even
 * considered, closing the same forged-record gap Rev126 F1 closed for
 * `activateOrganization`/`suspendOrganization`. `reactivatedAt` must not be
 * chronologically before `suspendedAt` (equal accepted, immediate
 * reactivation).
 *
 * The returned `ACTIVE` value has EXACTLY the same shape as any other
 * coherent `ACTIVE` record (valid `createdAt` + valid `activatedAt` with
 * `activatedAt >= createdAt`, no `suspendedAt`) - reactivation is treated as
 * a fresh activation instant (`activatedAt` becomes `reactivatedAt`), not a
 * parallel third state, so every existing `ACTIVE`-gated check elsewhere in
 * the repository (e.g. `resolveOrganizationResourceBindingStatus`) needs no
 * new branch to handle a reactivated organization. This function touches
 * nothing beyond the `Organization` value itself: it grants no permission,
 * restores no membership/connection/config, and resurrects no stale
 * evidence of any kind - `OrganizationMembership`/`ConnectionBinding`/
 * `OrganizationResourceBinding` currentness remain entirely their own
 * separate primitives' concern, re-resolved fresh exactly as before.
 */
export function reactivateOrganization(input: {
  organization: Organization;
  reactivatedAt: unknown;
}): Organization {
  if (input.organization.state !== "SUSPENDED") {
    throw new InvalidOrganizationTransitionError(
      `organization must be SUSPENDED to reactivate (got "${input.organization.state}")`,
    );
  }
  const createdAt = requireValidTimestamp(input.organization.createdAt, "organization.createdAt");
  const activatedAt = requireValidTimestamp(input.organization.activatedAt, "organization.activatedAt");
  if (activatedAt.ms < createdAt.ms) {
    throw new InvalidOrganizationTransitionError("organization.activatedAt must not be before organization.createdAt");
  }
  const suspendedAt = requireValidTimestamp(input.organization.suspendedAt, "organization.suspendedAt");
  if (suspendedAt.ms < activatedAt.ms) {
    throw new InvalidOrganizationTransitionError("organization.suspendedAt must not be before organization.activatedAt");
  }
  const reactivatedAt = requireValidTimestamp(input.reactivatedAt, "reactivatedAt");
  if (reactivatedAt.ms < suspendedAt.ms) {
    throw new InvalidOrganizationTransitionError("reactivatedAt must not be before organization.suspendedAt");
  }
  const { suspendedAt: _droppedSuspendedAt, ...reactivatedBase } = input.organization;
  return {
    ...reactivatedBase,
    state: "ACTIVE",
    activatedAt: reactivatedAt.raw,
  };
}

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

/**
 * OS-V1-04 ("offboarding" - the second half of this file's own original
 * OS-V0-01 doc comment, "richer suspend/reactivate/offboarding semantics are
 * a V1 concern"). Only `SUSPENDED -> OFFBOARDED`. Revalidates the FULL
 * pre-existing `SUSPENDED` record first (mirrors `reactivateOrganization`'s
 * own revalidation of its `SUSPENDED` predecessor) - `createdAt <=
 * activatedAt <= suspendedAt` must all still hold before this transition is
 * even considered. `offboardedAt` must not be chronologically before
 * `suspendedAt` (equal accepted, immediate offboarding). This is a one-way
 * terminal stop: no reactivation function is implemented or exposed for
 * `OFFBOARDED` - `reactivateOrganization`'s own existing `state !==
 * "SUSPENDED"` guard already refuses an `OFFBOARDED` record unconditionally,
 * with no change needed there. This function touches nothing beyond the
 * `Organization` value itself: it revokes no membership/connection/config of
 * its own (those remain entirely their own separate primitives' concern) -
 * offboarding's actual effect on dependent resource-binding readiness comes
 * from `resolveOrganizationResourceBindingStatus`'s own new `OFFBOARDED`
 * gate (`organization-resource-binding.ts`), re-resolved fresh exactly like
 * every other currentness check already is, never cached.
 */
export function offboardOrganization(input: {
  organization: Organization;
  offboardedAt: unknown;
}): Organization {
  if (input.organization.state !== "SUSPENDED") {
    throw new InvalidOrganizationTransitionError(
      `organization must be SUSPENDED to offboard (got "${input.organization.state}")`,
    );
  }
  if (input.organization.offboardedAt !== undefined) {
    throw new InvalidOrganizationTransitionError(
      "a SUSPENDED organization must not already carry offboardedAt",
    );
  }
  const createdAt = requireValidTimestamp(input.organization.createdAt, "organization.createdAt");
  const activatedAt = requireValidTimestamp(input.organization.activatedAt, "organization.activatedAt");
  if (activatedAt.ms < createdAt.ms) {
    throw new InvalidOrganizationTransitionError("organization.activatedAt must not be before organization.createdAt");
  }
  const suspendedAt = requireValidTimestamp(input.organization.suspendedAt, "organization.suspendedAt");
  if (suspendedAt.ms < activatedAt.ms) {
    throw new InvalidOrganizationTransitionError("organization.suspendedAt must not be before organization.activatedAt");
  }
  const offboardedAt = requireValidTimestamp(input.offboardedAt, "offboardedAt");
  if (offboardedAt.ms < suspendedAt.ms) {
    throw new InvalidOrganizationTransitionError("offboardedAt must not be before organization.suspendedAt");
  }
  return {
    ...input.organization,
    state: "OFFBOARDED",
    offboardedAt: offboardedAt.raw,
  };
}
