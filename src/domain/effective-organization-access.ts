import type { TenantScope } from "./tenant-scope.js";
import type { Organization } from "./organization.js";
import {
  resolveAssignmentStatus,
  isOrganizationMembershipActive,
  type AssignmentReference,
  type OrganizationMembership,
} from "./organization-membership.js";
import type { AuthorityContext, Permission } from "./authority.js";
import type { Project } from "./project.js";
import { isValidOrganizationAccessRole, type OrganizationAccessRole, type OrganizationAccessRoleContext } from "./organization-access-role.js";
import {
  isOrganizationServicePrincipalActive,
  type OrganizationServicePrincipal,
} from "./organization-service-principal.js";

export type AccessDecision = "GRANTED" | "DENIED";

/**
 * OS-V0-02 Phase A: legacy `OrganizationMembership.role` (`STAFF`/`JUNIOR`/
 * `STUDENT`/`CLIENT_ASSOCIATE`) projects uniformly to `"MEMBER"` when no
 * curated role context is supplied - none of those legacy roles, nor
 * `Project.ownerRef`/`OwnershipAssignment` (never even imported here), can
 * be used to fabricate a richer `OWNER`/`ADMIN` classification. (Phase D,
 * Rev135) `OWNER`/`ADMIN` are now representable, but only via an exact,
 * structurally-validated `OrganizationAccessRoleContext` (see
 * `organization-access-role.ts`) bound to the current membership's own
 * identity - never inferred from legacy role, ownership, or any other
 * signal.
 */
export type EffectiveOrganizationRole = OrganizationAccessRole;

/**
 * OS-V0-02 "Effective Access Resolution Foundation": a pure, deterministic,
 * explainable composition over already-distinct primitives - `Organization`
 * (OS-V0-01), `OrganizationMembership`, a caller-supplied
 * `currentPrincipalRef` identity claim, a caller-supplied `AuthorityContext`,
 * an optional `Project` scope, and (Phase B) an optional list of the
 * caller's current `AssignmentReference` evidence. This module does not
 * authenticate `currentPrincipalRef` or resolve who the current caller is
 * (that identity boundary remains a future, separate application concern);
 * it requires (Phase C, Rev131) the supplied membership to be an active,
 * coherent `OrganizationMembership` record via `isOrganizationMembershipActive`
 * - a revoked or malformed membership fails closed regardless of any other
 * input - it then proves that membership belongs to the identity the
 * caller currently asserts (Rev129: closes same-tenant membership
 * substitution, which tenant correlation alone cannot detect) and, when a
 * `Project` is supplied, that exact current assignment evidence exists for
 * that membership and project via the existing `resolveAssignmentStatus`
 * semantics (Rev130 Phase B: tenant correlation alone does not prove the
 * member is actually assigned to that project). (Phase D, Rev135) an
 * optional `OrganizationAccessRoleContext` may additionally project `role`
 * as `OWNER`/`ADMIN` instead of the `MEMBER` floor, but ONLY when that
 * context's own `tenantId`/`membershipId`/`principalRef` exactly match the
 * already-validated current membership - a mismatched, malformed, or
 * substituted role context denies the ENTIRE resolution (never silently
 * downgraded to `MEMBER`), and this check runs only after every Phase A-C
 * gate (membership currentness, principal binding, tenant correlation,
 * project assignment) has already passed, so a stale role context can
 * never rescue a revoked membership or a missing project assignment. It
 * grants no permission of its own: `permissions`/`canPerformProtectedActions`
 * on a `GRANTED` resolution are always the exact `AuthorityContext` values,
 * read verbatim, after membership-currentness, tenant-correlation,
 * principal-binding, assignment, and role-context validation - never
 * widened by role (curated or legacy), ownership, revocation-lifecycle
 * state, or any other signal. `reasons` always explains the decision
 * explicitly; there is no silent default. This function is pure (no
 * wall-clock/randomness/persistence), so re-invoking it with current
 * inputs is the only way to get a current answer - it cannot itself
 * preserve a stale decision, and re-resolving after a membership is
 * revoked is exactly how a caller observes that revocation.
 */
export interface EffectiveAccessResolution {
  readonly decision: AccessDecision;
  readonly tenantId: TenantScope["tenantId"];
  readonly organizationId: Organization["organizationId"];
  readonly membershipId?: OrganizationMembership["membershipId"];
  readonly projectId?: Project["projectId"];
  readonly role?: EffectiveOrganizationRole;
  readonly permissions: ReadonlySet<Permission>;
  readonly canPerformProtectedActions: boolean;
  readonly reasons: ReadonlyArray<string>;
}

function denied(input: {
  organization: Organization;
  membership: OrganizationMembership | undefined;
  project: Project | undefined;
  reason: string;
}): EffectiveAccessResolution {
  return {
    decision: "DENIED",
    tenantId: input.organization.tenantId,
    organizationId: input.organization.organizationId,
    ...(input.membership !== undefined ? { membershipId: input.membership.membershipId } : {}),
    ...(input.project !== undefined ? { projectId: input.project.projectId } : {}),
    permissions: new Set<Permission>(),
    canPerformProtectedActions: false,
    reasons: [input.reason],
  };
}

/**
 * Rev129 correction: `currentPrincipalRef` is an already-resolved
 * application-boundary identity claim - the same trust footing as
 * `AuthorityContext` - supplied by the caller, never inferred from
 * `membership`/`role`/`ownerRef`/permissions. It is validated here purely
 * structurally (non-empty, non-whitespace, no leading/trailing
 * whitespace); this module does not authenticate it or resolve who the
 * current caller is, it only proves the supplied membership record belongs
 * to the identity the caller currently asserts.
 */
function isValidCurrentPrincipalRef(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.trim() === value
  );
}

/**
 * Resolution order: membership presence, then (Phase C, Rev131) membership
 * currentness via `isOrganizationMembershipActive` - a revoked or
 * incoherent membership denies immediately, before `currentPrincipalRef`
 * is even inspected - then `currentPrincipalRef` structural validity, then
 * membership/authority/(optional) project tenant correlation (each
 * against the given `Organization`'s own `tenantId` - the exact structural
 * anchor), then exact `membership.principalRef === currentPrincipalRef`
 * equality (Rev129: closes same-tenant membership substitution, which
 * tenant correlation alone cannot detect), then - only when a `Project` is
 * supplied - exact assignment evidence via the existing
 * `resolveAssignmentStatus` (Rev130 Phase B: `assignments` defaults to an
 * empty list, which `resolveAssignmentStatus` already resolves to
 * `"UNASSIGNED"`, so an omitted/empty evidence list fails closed exactly
 * like a missing membership does), then finally - only when a `roleContext`
 * is supplied - exact `OrganizationAccessRoleContext` correlation (Phase D,
 * Rev135): its `tenantId`/`membershipId`/`principalRef` must exactly match
 * the already-validated current membership and its `role` must be a valid
 * `OrganizationAccessRole`, or the entire resolution denies (never silently
 * downgraded to `MEMBER`). Placing this check last means a stale/malformed
 * role context can never rescue a revoked membership, a wrong-principal
 * caller, or a missing project assignment - every earlier gate has already
 * run. Only once every check passes does this function read
 * `authority.permissions`/`authority.canPerformProtectedActions` verbatim
 * onto the `GRANTED` resolution. `membership.role`, `membership.state`,
 * and `Project.ownerRef` are never read to *grant* anything - `state` only
 * ever gates (via `isOrganizationMembershipActive`), a legacy role or an
 * ownerRef match can never substitute for `AssignmentReference` evidence,
 * a curated role context, or grant permission; the projected `role` output
 * is `"MEMBER"` unless a validated `roleContext` says otherwise.
 */
export function resolveEffectiveOrganizationAccess(input: {
  organization: Organization;
  membership?: OrganizationMembership;
  currentPrincipalRef: string;
  authority: AuthorityContext;
  project?: Project;
  assignments?: ReadonlyArray<AssignmentReference>;
  roleContext?: OrganizationAccessRoleContext;
}): EffectiveAccessResolution {
  if (input.membership === undefined) {
    return denied({
      organization: input.organization,
      membership: undefined,
      project: input.project,
      reason: "membership is required for effective access resolution",
    });
  }
  if (!isOrganizationMembershipActive(input.membership)) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason: "membership is not an active, coherent membership record",
    });
  }
  if (!isValidCurrentPrincipalRef(input.currentPrincipalRef)) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason:
        "currentPrincipalRef is required and must be a non-empty, non-whitespace string",
    });
  }
  if (input.membership.tenantId !== input.organization.tenantId) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason: "membership belongs to a different tenant than the organization",
    });
  }
  if (input.authority.tenantId !== input.organization.tenantId) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason: "authority belongs to a different tenant than the organization",
    });
  }
  if (input.project !== undefined && input.project.tenantId !== input.organization.tenantId) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason: "project belongs to a different tenant than the organization",
    });
  }
  if (input.membership.principalRef !== input.currentPrincipalRef) {
    return denied({
      organization: input.organization,
      membership: input.membership,
      project: input.project,
      reason: "membership belongs to a different principal than the current caller identity",
    });
  }
  if (input.project !== undefined) {
    const assignmentStatus = resolveAssignmentStatus({
      membership: input.membership,
      assignments: input.assignments ?? [],
      customerId: input.project.customerId,
      projectId: input.project.projectId,
    });
    if (assignmentStatus !== "ASSIGNED") {
      return denied({
        organization: input.organization,
        membership: input.membership,
        project: input.project,
        reason:
          "no exact assignment evidence exists for the current membership and project scope",
      });
    }
  }

  let role: OrganizationAccessRole = "MEMBER";
  if (input.roleContext !== undefined) {
    if (
      input.roleContext.tenantId !== input.membership.tenantId ||
      input.roleContext.membershipId !== input.membership.membershipId ||
      input.roleContext.principalRef !== input.membership.principalRef ||
      !isValidOrganizationAccessRole(input.roleContext.role)
    ) {
      return denied({
        organization: input.organization,
        membership: input.membership,
        project: input.project,
        reason:
          "role context does not exactly match the current membership identity, or is malformed",
      });
    }
    role = input.roleContext.role;
  }

  return {
    decision: "GRANTED",
    tenantId: input.organization.tenantId,
    organizationId: input.organization.organizationId,
    membershipId: input.membership.membershipId,
    ...(input.project !== undefined ? { projectId: input.project.projectId } : {}),
    role,
    permissions: new Set(input.authority.permissions),
    canPerformProtectedActions: input.authority.canPerformProtectedActions,
    reasons: [
      "organization/membership/authority tenant correlation verified; membership principal matches current caller identity" +
        (input.project !== undefined
          ? "; exact assignment evidence verified for the project scope"
          : "") +
        (input.roleContext !== undefined
          ? "; curated role context verified against the current membership identity"
          : ""),
    ],
  };
}

/**
 * OS-V0-02 final convergence (Rev136): the non-human counterpart to
 * `resolveEffectiveOrganizationAccess`, deliberately a SEPARATE function
 * with a SEPARATE result type - it accepts no `OrganizationMembership`,
 * projects no `EffectiveOrganizationRole` (`OWNER`/`ADMIN`/`MEMBER` remain
 * exclusively human-membership-bound, per `organization-access-role.ts`),
 * and cannot be handed a human identity by accident (the input shapes are
 * structurally disjoint). This is what "human and worker identity families
 * cannot substitute for one another" means at the type level, not merely by
 * runtime convention. `currentWorkerRef` is an already-resolved
 * application-boundary identity claim - the exact same trust footing as
 * `currentPrincipalRef` for humans - never inferred from the service
 * principal record itself. Permission comes only from the supplied
 * `AuthorityContext`, read verbatim, after every correlation below passes:
 * this function never reads worker trust/admission/capability/cost/
 * availability (it has no dependency on `worker-routing-policy.ts` at all),
 * so worker routing status can never manufacture Organization authority,
 * and Organization authority can never manufacture worker admission -
 * those remain two entirely separate concerns composed later by a caller,
 * not fused here. Project-scoped worker grants are explicitly NOT
 * implemented in this slice (see `docs/exec-plans/active/OS-V0-02.md`'s
 * final convergence audit) - inventing a hidden equivalence to human
 * `AssignmentReference` would misrepresent a service principal as a
 * membership, which this module must never do.
 */
export interface EffectiveServicePrincipalAccessResolution {
  readonly decision: AccessDecision;
  readonly tenantId: TenantScope["tenantId"];
  readonly organizationId: Organization["organizationId"];
  readonly servicePrincipalId?: OrganizationServicePrincipal["servicePrincipalId"];
  readonly permissions: ReadonlySet<Permission>;
  readonly canPerformProtectedActions: boolean;
  readonly reasons: ReadonlyArray<string>;
}

function deniedServicePrincipal(input: {
  organization: Organization;
  servicePrincipal: OrganizationServicePrincipal | undefined;
  reason: string;
}): EffectiveServicePrincipalAccessResolution {
  return {
    decision: "DENIED",
    tenantId: input.organization.tenantId,
    organizationId: input.organization.organizationId,
    ...(input.servicePrincipal !== undefined
      ? { servicePrincipalId: input.servicePrincipal.servicePrincipalId }
      : {}),
    permissions: new Set<Permission>(),
    canPerformProtectedActions: false,
    reasons: [input.reason],
  };
}

function isValidCurrentWorkerRef(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.trim() === value
  );
}

/**
 * Resolution order (deliberately mirrors `resolveEffectiveOrganizationAccess`'s
 * own structure, so the two identity families stay explainable in the same
 * way without ever sharing state): service-principal presence, then
 * currentness/coherence via `isOrganizationServicePrincipalActive` (a
 * revoked or incoherent service principal denies immediately), then
 * `currentWorkerRef` structural validity, then service-principal/authority
 * tenant correlation against the given `Organization`'s own `tenantId`,
 * then exact `servicePrincipal.workerRef === currentWorkerRef` equality -
 * closing cross-worker substitution the same way `currentPrincipalRef`
 * closes cross-principal membership substitution for humans. Only once
 * every check passes does this function read `authority.permissions`/
 * `authority.canPerformProtectedActions` verbatim onto the `GRANTED`
 * resolution.
 */
export function resolveEffectiveServicePrincipalAccess(input: {
  organization: Organization;
  servicePrincipal?: OrganizationServicePrincipal;
  currentWorkerRef: string;
  authority: AuthorityContext;
}): EffectiveServicePrincipalAccessResolution {
  if (input.servicePrincipal === undefined) {
    return deniedServicePrincipal({
      organization: input.organization,
      servicePrincipal: undefined,
      reason: "service principal is required for effective service-principal access resolution",
    });
  }
  if (!isOrganizationServicePrincipalActive(input.servicePrincipal)) {
    return deniedServicePrincipal({
      organization: input.organization,
      servicePrincipal: input.servicePrincipal,
      reason: "service principal is not an active, coherent record",
    });
  }
  if (!isValidCurrentWorkerRef(input.currentWorkerRef)) {
    return deniedServicePrincipal({
      organization: input.organization,
      servicePrincipal: input.servicePrincipal,
      reason: "currentWorkerRef is required and must be a non-empty, non-whitespace string",
    });
  }
  if (input.servicePrincipal.tenantId !== input.organization.tenantId) {
    return deniedServicePrincipal({
      organization: input.organization,
      servicePrincipal: input.servicePrincipal,
      reason: "service principal belongs to a different tenant than the organization",
    });
  }
  if (input.authority.tenantId !== input.organization.tenantId) {
    return deniedServicePrincipal({
      organization: input.organization,
      servicePrincipal: input.servicePrincipal,
      reason: "authority belongs to a different tenant than the organization",
    });
  }
  if (input.servicePrincipal.workerRef !== input.currentWorkerRef) {
    return deniedServicePrincipal({
      organization: input.organization,
      servicePrincipal: input.servicePrincipal,
      reason: "service principal is bound to a different worker than the current caller identity",
    });
  }

  return {
    decision: "GRANTED",
    tenantId: input.organization.tenantId,
    organizationId: input.organization.organizationId,
    servicePrincipalId: input.servicePrincipal.servicePrincipalId,
    permissions: new Set(input.authority.permissions),
    canPerformProtectedActions: input.authority.canPerformProtectedActions,
    reasons: [
      "organization/service-principal/authority tenant correlation verified; service principal worker binding matches current caller identity",
    ],
  };
}
