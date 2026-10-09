import type { TenantScope } from "./tenant-scope.js";
import type { Organization } from "./organization.js";
import { isOrganizationMembershipActive, type OrganizationMembership } from "./organization-membership.js";
import type { AuthorityContext, Permission } from "./authority.js";
import type { AccessDecision, EffectiveAccessResolution } from "./effective-organization-access.js";

export class InvalidDelegatedAccessGrantError extends Error {
  constructor(reason: string) {
    super(`Invalid DelegatedAccessGrant: ${reason}`);
    this.name = "InvalidDelegatedAccessGrantError";
  }
}

export class InvalidDelegatedAccessGrantTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid DelegatedAccessGrant transition: ${reason}`);
    this.name = "InvalidDelegatedAccessGrantTransitionError";
  }
}

type DelegationId = string & { readonly __brand: "DelegationId" };

const VALID_PERMISSIONS: ReadonlySet<string> = new Set(["READ", "WRITE", "EXECUTE"]);

/**
 * OS-V1-02 ("temporary/scoped delegated grants with expiry" + "fail-closed
 * ... stale delegated authority"): the minimum V1 lifecycle floor for a
 * delegated-access grant, mirroring `OrganizationMembership`'s/
 * `OrganizationServicePrincipal`'s own `ACTIVE`/`REVOKED` floor exactly. No
 * renewal/reactivation is representable here - a delegation that expires or
 * is revoked is gone; a principal who still needs delegated authority
 * receives a genuinely NEW `DelegatedAccessGrant`, never a resurrected one.
 */
export type DelegatedAccessGrantLifecycleState = "ACTIVE" | "REVOKED";

/**
 * A caller-supplied, application-boundary evidence record proving that one
 * already-authenticated human membership (`delegatorMembershipId`/
 * `delegatorPrincipalRef`) has temporarily handed a bounded SUBSET of its
 * own current `AuthorityContext` to a second principal
 * (`delegatePrincipalRef` - deliberately a bare string, not a required
 * second `OrganizationMembership`, since a delegate may be acting under a
 * session/identity that has no membership of its own yet; this module
 * never requires one). This is NOT a second IAM/RBAC/ABAC system: it holds
 * no role, no policy language, no inheritance graph - it is a single flat
 * evidence record this module's own `resolveEffectiveDelegatedAccess`
 * resolves exactly once, the same "pure, deterministic, explainable
 * composition over already-distinct primitives" discipline
 * `effective-organization-access.ts` already established.
 *
 * `expiresAt` is mandatory (never optional) - unlike a plain
 * `OrganizationMembership`, "temporary" is this type's entire reason to
 * exist, so an unbounded delegation is not representable at all.
 * `permissions`/`canPerformProtectedActions` are validated at construction
 * to never exceed the delegator's own `AuthorityContext` at mint time (no
 * privilege escalation through delegation), but this module never assumes
 * that proof stays true forever: `resolveEffectiveDelegatedAccess` requires
 * the caller to supply a FRESHLY re-resolved `delegatorCurrentAccess`
 * (`EffectiveAccessResolution`) immediately before granting, and clamps the
 * effective permission set to the INTERSECTION of what the grant itself
 * says and what the delegator currently, actually holds - this is exactly
 * what closes "stale delegated authority": if the delegator's own
 * membership is later revoked, or their own authority shrinks, the
 * delegation can never retain the old, now-stale power.
 */
export interface DelegatedAccessGrant {
  readonly delegationId: DelegationId;
  readonly tenantId: TenantScope["tenantId"];
  readonly organizationId: Organization["organizationId"];
  readonly delegatorMembershipId: OrganizationMembership["membershipId"];
  readonly delegatorPrincipalRef: string;
  readonly delegatePrincipalRef: string;
  readonly permissions: ReadonlySet<Permission>;
  readonly canPerformProtectedActions: boolean;
  readonly projectId?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: DelegatedAccessGrantLifecycleState;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || value.trim() !== value) {
    throw new InvalidDelegatedAccessGrantError(`${field} must be a non-empty string with no leading/trailing whitespace`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): { raw: string; ms: number } {
  const raw = requireNonEmptyString(value, field);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new InvalidDelegatedAccessGrantError(`${field} must be a valid ISO timestamp`);
  }
  return { raw, ms };
}

/**
 * Deterministic factory. `tenantId`/`organizationId`/`delegatorMembershipId`/
 * `delegatorPrincipalRef` are always inherited from the given `organization`/
 * `delegatorMembership` - never separately caller-supplied - so a grant can
 * never be constructed detached from, or claiming a different identity
 * than, a real current membership. Refuses a revoked/incoherent delegator
 * membership via the existing `isOrganizationMembershipActive` predicate,
 * mirroring `createOrganizationAccessRoleContext`'s own exact precedent: a
 * delegation can never be minted by a membership that could not itself pass
 * effective-access's own currentness gate. `permissions` must be a
 * non-strict SUBSET of `delegatorAuthority.permissions`, and
 * `canPerformProtectedActions` can only be `true` here if
 * `delegatorAuthority.canPerformProtectedActions` is also `true` - no
 * privilege escalation through delegation, checked at mint time (and
 * independently re-checked, against then-CURRENT authority, at resolution
 * time - see `resolveEffectiveDelegatedAccess`). `expiresAt` must be
 * strictly after `issuedAt` - a zero-or-negative-duration delegation is
 * never constructible.
 */
export function createDelegatedAccessGrant(input: {
  tenantScope: TenantScope;
  organization: Organization;
  delegatorMembership: OrganizationMembership;
  delegatorAuthority: AuthorityContext;
  delegationId: unknown;
  delegatePrincipalRef: unknown;
  permissions: Iterable<unknown>;
  canPerformProtectedActions: unknown;
  projectId?: unknown;
  issuedAt: unknown;
  expiresAt: unknown;
}): DelegatedAccessGrant {
  if (input.organization.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidDelegatedAccessGrantError("organization does not belong to the given tenantScope");
  }
  if (input.delegatorMembership.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidDelegatedAccessGrantError("delegatorMembership does not belong to the given tenantScope");
  }
  if (!isOrganizationMembershipActive(input.delegatorMembership)) {
    throw new InvalidDelegatedAccessGrantError(
      "delegatorMembership must be an active, coherent membership record to mint a delegation",
    );
  }
  if (input.delegatorAuthority.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidDelegatedAccessGrantError("delegatorAuthority does not belong to the given tenantScope");
  }
  const delegationId = requireNonEmptyString(input.delegationId, "delegationId") as DelegationId;
  const delegatePrincipalRef = requireNonEmptyString(input.delegatePrincipalRef, "delegatePrincipalRef");

  const permissions = new Set<Permission>();
  for (const permission of input.permissions) {
    if (typeof permission !== "string" || !VALID_PERMISSIONS.has(permission)) {
      throw new InvalidDelegatedAccessGrantError(`permissions must only contain "READ", "WRITE", or "EXECUTE"; got ${JSON.stringify(permission)}`);
    }
    if (!input.delegatorAuthority.permissions.has(permission as Permission)) {
      throw new InvalidDelegatedAccessGrantError(
        `permission "${permission}" cannot be delegated - the delegator's own current authority does not hold it`,
      );
    }
    permissions.add(permission as Permission);
  }
  if (typeof input.canPerformProtectedActions !== "boolean") {
    throw new InvalidDelegatedAccessGrantError("canPerformProtectedActions must be a boolean");
  }
  if (input.canPerformProtectedActions && !input.delegatorAuthority.canPerformProtectedActions) {
    throw new InvalidDelegatedAccessGrantError(
      "canPerformProtectedActions cannot be delegated as true - the delegator's own current authority does not hold it",
    );
  }

  const issuedAt = requireValidTimestamp(input.issuedAt, "issuedAt");
  const expiresAt = requireValidTimestamp(input.expiresAt, "expiresAt");
  if (expiresAt.ms <= issuedAt.ms) {
    throw new InvalidDelegatedAccessGrantError("expiresAt must be strictly after issuedAt");
  }

  const projectId = input.projectId === undefined ? undefined : requireNonEmptyString(input.projectId, "projectId");

  return {
    delegationId,
    tenantId: input.tenantScope.tenantId,
    organizationId: input.organization.organizationId,
    delegatorMembershipId: input.delegatorMembership.membershipId,
    delegatorPrincipalRef: input.delegatorMembership.principalRef,
    delegatePrincipalRef,
    permissions,
    canPerformProtectedActions: input.canPerformProtectedActions,
    ...(projectId !== undefined ? { projectId } : {}),
    issuedAt: issuedAt.raw,
    expiresAt: expiresAt.raw,
    state: "ACTIVE",
  };
}

/**
 * The single reusable currentness predicate: `false` for `REVOKED`
 * (coherent or not), for any record already carrying stale revocation
 * metadata, or for a record whose `expiresAt` is not strictly after `now`
 * (expiry is a hard, always-checked dimension here - unlike
 * `StaffSessionContext.expiresAt`, `DelegatedAccessGrant.expiresAt` is
 * mandatory, so there is no "no clock supplied, treat as non-expiring"
 * case to consider: `now` is always required).
 */
export function isDelegatedAccessGrantActive(grant: DelegatedAccessGrant, now: string): boolean {
  if (grant.state === "REVOKED") {
    return false;
  }
  if (grant.revokedAt !== undefined || grant.revokedReason !== undefined) {
    return false;
  }
  const nowMs = Date.parse(now);
  const expiresAtMs = Date.parse(grant.expiresAt);
  if (Number.isNaN(nowMs) || Number.isNaN(expiresAtMs)) {
    return false;
  }
  return nowMs < expiresAtMs;
}

/**
 * The single one-way `ACTIVE -> REVOKED` transition, mirroring
 * `revokeOrganizationMembership`/`revokeOrganizationServicePrincipal`/
 * `revokeStaffSessionContext` exactly: no reactivation function is
 * implemented or exposed.
 */
export function revokeDelegatedAccessGrant(input: {
  grant: DelegatedAccessGrant;
  revokedAt: unknown;
  revokedReason: unknown;
}): DelegatedAccessGrant {
  if (input.grant.state === "REVOKED" || input.grant.revokedAt !== undefined || input.grant.revokedReason !== undefined) {
    throw new InvalidDelegatedAccessGrantTransitionError(
      "grant must be a coherent ACTIVE record (no existing revocation metadata) to revoke",
    );
  }
  const revokedAt = requireValidTimestamp(input.revokedAt, "revokedAt");
  const revokedReason = requireNonEmptyString(input.revokedReason, "revokedReason");
  return {
    ...input.grant,
    state: "REVOKED",
    revokedAt: revokedAt.raw,
    revokedReason,
  };
}

export interface EffectiveDelegatedAccessResolution {
  readonly decision: AccessDecision;
  readonly tenantId: TenantScope["tenantId"];
  readonly organizationId: Organization["organizationId"];
  readonly delegationId?: DelegatedAccessGrant["delegationId"];
  readonly permissions: ReadonlySet<Permission>;
  readonly canPerformProtectedActions: boolean;
  readonly reasons: ReadonlyArray<string>;
}

function denied(input: {
  organization: Organization;
  grant: DelegatedAccessGrant | undefined;
  reason: string;
}): EffectiveDelegatedAccessResolution {
  return {
    decision: "DENIED",
    tenantId: input.organization.tenantId,
    organizationId: input.organization.organizationId,
    ...(input.grant !== undefined ? { delegationId: input.grant.delegationId } : {}),
    permissions: new Set<Permission>(),
    canPerformProtectedActions: false,
    reasons: [input.reason],
  };
}

function isValidCurrentPrincipalRef(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.trim().length > 0 && value.trim() === value;
}

/**
 * Resolution order (deliberately mirrors `resolveEffectiveOrganizationAccess`'s
 * own explainable, ordered-gate structure): grant presence, then grant/
 * organization tenant+organization correlation, then grant currentness
 * (`isDelegatedAccessGrantActive` - not expired, not revoked) BEFORE
 * `currentPrincipalRef` is even inspected, then `currentPrincipalRef`
 * structural validity, then exact `grant.delegatePrincipalRef ===
 * currentPrincipalRef` equality (closes cross-identity substitution: a
 * caller cannot claim a delegation issued to a different principal), then -
 * only once every grant-side check passes - the delegator's OWN current
 * standing: `delegatorCurrentAccess` must be a GRANTED, same-tenant
 * `EffectiveAccessResolution` whose `membershipId` exactly equals
 * `grant.delegatorMembershipId`. This is the load-bearing "stale delegated
 * authority" closure - `delegatorCurrentAccess` is caller-supplied and MUST
 * be freshly re-resolved by the caller (via `resolveEffectiveOrganizationAccess`)
 * immediately before this call, exactly like every other "re-resolve fresh
 * immediately before granting" primitive in this repository
 * (`requireInternalOsAccess`, `authorizeProtectedDecisionResume`,
 * `resolveControlledOrganizationSwitch`) - this function does not and
 * cannot re-derive it itself, since it has no membership/store/session
 * dependency of its own. A delegator whose own membership was revoked,
 * whose own authority shrank, or who has moved tenant/organization since
 * the grant was minted, denies here even if the grant record itself is
 * still unexpired and unrevoked. Only once every gate passes does this
 * function return `GRANTED` with permissions clamped to the INTERSECTION of
 * `grant.permissions` and `delegatorCurrentAccess.permissions` (never a
 * union - delegation can only narrow what the grant itself already
 * narrowed, and can never regrant a permission the delegator has since
 * lost) and `canPerformProtectedActions` as the logical AND of both. A
 * narrower-than-the-grant intersection (e.g. empty) is still `GRANTED` -
 * exactly like `resolveEffectiveOrganizationAccess` itself, this function
 * grants no specific permission on its own; a caller still separately
 * checks the exact permission it needs (`requirePermission`) before
 * performing any protected action.
 */
export function resolveEffectiveDelegatedAccess(input: {
  organization: Organization;
  grant?: DelegatedAccessGrant;
  currentPrincipalRef: string;
  now: string;
  delegatorCurrentAccess: EffectiveAccessResolution;
}): EffectiveDelegatedAccessResolution {
  if (input.grant === undefined) {
    return denied({
      organization: input.organization,
      grant: undefined,
      reason: "a delegated access grant is required for effective delegated access resolution",
    });
  }
  if (input.grant.tenantId !== input.organization.tenantId) {
    return denied({ organization: input.organization, grant: input.grant, reason: "grant belongs to a different tenant than the organization" });
  }
  if (input.grant.organizationId !== input.organization.organizationId) {
    return denied({ organization: input.organization, grant: input.grant, reason: "grant belongs to a different organization" });
  }
  if (!isDelegatedAccessGrantActive(input.grant, input.now)) {
    return denied({
      organization: input.organization,
      grant: input.grant,
      reason: "grant is not an active, current (non-expired, non-revoked) delegation",
    });
  }
  if (!isValidCurrentPrincipalRef(input.currentPrincipalRef)) {
    return denied({
      organization: input.organization,
      grant: input.grant,
      reason: "currentPrincipalRef is required and must be a non-empty, non-whitespace string",
    });
  }
  if (input.grant.delegatePrincipalRef !== input.currentPrincipalRef) {
    return denied({
      organization: input.organization,
      grant: input.grant,
      reason: "grant belongs to a different delegate than the current caller identity",
    });
  }
  if (input.delegatorCurrentAccess.decision !== "GRANTED") {
    return denied({
      organization: input.organization,
      grant: input.grant,
      reason: "the delegator's own current effective access is not GRANTED - a delegation cannot grant more than its delegator currently holds",
    });
  }
  if (input.delegatorCurrentAccess.tenantId !== input.organization.tenantId) {
    return denied({
      organization: input.organization,
      grant: input.grant,
      reason: "the delegator's current access does not belong to the same tenant as the organization",
    });
  }
  if (input.delegatorCurrentAccess.membershipId !== input.grant.delegatorMembershipId) {
    return denied({
      organization: input.organization,
      grant: input.grant,
      reason: "the delegator's current membership does not match the membership this delegation was issued under",
    });
  }

  const permissions = new Set<Permission>(
    [...input.grant.permissions].filter((permission) => input.delegatorCurrentAccess.permissions.has(permission)),
  );
  return {
    decision: "GRANTED",
    tenantId: input.organization.tenantId,
    organizationId: input.organization.organizationId,
    delegationId: input.grant.delegationId,
    permissions,
    canPerformProtectedActions: input.grant.canPerformProtectedActions && input.delegatorCurrentAccess.canPerformProtectedActions,
    reasons: [
      "grant currentness (non-expired, non-revoked) verified; delegate identity matches current caller identity; delegator's own current effective access independently re-resolved as GRANTED and bound to the exact membership this delegation was issued under; effective permissions clamped to the intersection of the grant and the delegator's current authority",
    ],
  };
}
