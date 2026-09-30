import type { TenantScope } from "./tenant-scope.js";
import type { Organization } from "./organization.js";
import { isOrganizationMembershipActive, type OrganizationMembership } from "./organization-membership.js";
import { isOrganizationServicePrincipalActive, type OrganizationServicePrincipal } from "./organization-service-principal.js";
import type { Project } from "./project.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { ConnectionBinding } from "./connection-authority.js";

export class InvalidOrganizationResourceBindingError extends Error {
  constructor(reason: string) {
    super(`Invalid OrganizationResourceBinding: ${reason}`);
    this.name = "InvalidOrganizationResourceBindingError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidOrganizationResourceBindingError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidOrganizationResourceBindingError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidOrganizationResourceBindingError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidOrganizationResourceBindingError(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(raw))) {
    throw new InvalidOrganizationResourceBindingError(`${field} must be a valid ISO timestamp`);
  }
  return raw;
}

function requireOpaqueStringArray(value: unknown, field: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new InvalidOrganizationResourceBindingError(`${field} must be an array`);
  }
  const entries = value.map((entry, index) => requireNonEmptyString(entry, `${field}[${index}]`));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) {
      throw new InvalidOrganizationResourceBindingError(`${field} contains a duplicate entry "${entry}"`);
    }
    seen.add(entry);
  }
  return entries;
}

/**
 * OS-V0-09 "Organization Zero Bootstrap / AKILTA Resource Binding": the
 * durable, immutable record of WHICH real resources were bound to a given
 * `Organization`, expressed entirely as opaque already-validated ids/refs
 * from their own authoritative owners - never a copy of any resource's own
 * mutable state (that would let this record silently drift from the truth
 * it claims to reflect). `secretRef`/raw credential material never appears
 * anywhere in this shape: `connectionBindingRefs` carries only
 * `ConnectionBinding["connectionBindingId"]`, never the binding's own
 * `secretRef`/`providerRef`/`workspaceRef` payload.
 *
 * "Organization Zero" (AKILTA itself, `org_akilta`) is representable
 * through this exact same contract with no `isSystem`/bypass flag, no
 * privileged constructor, and no hidden authority grant - the same
 * discipline `organization.ts` already established for `Organization`
 * itself. A controlled second Organization is bound through the identical
 * `createOrganizationResourceBinding` call with different identifiers; this
 * module contains no `org_akilta`-specific branch anywhere.
 */
export interface OrganizationResourceBinding {
  readonly version: 1;
  readonly tenantId: TenantScope["tenantId"];
  readonly organizationId: Organization["organizationId"];
  readonly membershipRefs: ReadonlyArray<OrganizationMembership["membershipId"]>;
  readonly servicePrincipalRefs: ReadonlyArray<OrganizationServicePrincipal["servicePrincipalId"]>;
  readonly projectRef: Project["projectId"];
  readonly ownership: ProjectOwnershipRef;
  readonly connectionBindingRefs: ReadonlyArray<ConnectionBinding["connectionBindingId"]>;
  readonly effectiveConfigRefs: ReadonlyArray<string>;
  readonly effectivePolicyRefs: ReadonlyArray<string>;
  readonly workerRouteRefs: ReadonlyArray<string>;
  readonly knowledgeEvidenceRefs: ReadonlyArray<string>;
  readonly boundAt: string;
}

/**
 * Construction-time fail-closed checks, all against the REAL supplied
 * objects (never a caller's bare claim): every membership/service-principal
 * must belong to `organization.tenantId`, and at least one ACTIVE, coherent
 * membership must be present - "create current Founder/internal
 * membership... references only from authoritative identity inputs" means
 * a binding can never be bootstrapped from zero real founder evidence.
 * `project`/`ownership` must agree with each other and with the
 * organization's own tenant. `secretRef`/raw credential material is
 * structurally impossible to pass here - only `connectionBindingRefs`
 * (opaque ids) are accepted, never a `ConnectionBinding`/`SecretRef` object
 * itself, so this factory cannot leak one even by caller mistake.
 */
export function createOrganizationResourceBinding(input: {
  organization: Organization;
  memberships: ReadonlyArray<OrganizationMembership>;
  servicePrincipals?: ReadonlyArray<OrganizationServicePrincipal>;
  project: Project;
  ownership: ProjectOwnershipRef;
  connectionBindingRefs?: unknown;
  effectiveConfigRefs?: unknown;
  effectivePolicyRefs?: unknown;
  workerRouteRefs?: unknown;
  knowledgeEvidenceRefs?: unknown;
  boundAt: unknown;
}): OrganizationResourceBinding {
  const memberships = input.memberships;
  if (memberships.length === 0) {
    throw new InvalidOrganizationResourceBindingError(
      "at least one membership is required - a binding cannot be bootstrapped from zero founder/internal identity evidence",
    );
  }
  const membershipIds = new Set<string>();
  for (const membership of memberships) {
    if (membership.tenantId !== input.organization.tenantId) {
      throw new InvalidOrganizationResourceBindingError(
        `membership "${membership.membershipId}" belongs to a different tenant than the organization`,
      );
    }
    if (membershipIds.has(membership.membershipId)) {
      throw new InvalidOrganizationResourceBindingError(`duplicate membership ref "${membership.membershipId}"`);
    }
    membershipIds.add(membership.membershipId);
  }
  if (!memberships.some((membership) => isOrganizationMembershipActive(membership))) {
    throw new InvalidOrganizationResourceBindingError(
      "at least one supplied membership must be an active, coherent record - a binding cannot be bootstrapped entirely from revoked/incoherent identity evidence",
    );
  }

  const servicePrincipals = input.servicePrincipals ?? [];
  const servicePrincipalIds = new Set<string>();
  for (const servicePrincipal of servicePrincipals) {
    if (servicePrincipal.tenantId !== input.organization.tenantId) {
      throw new InvalidOrganizationResourceBindingError(
        `service principal "${servicePrincipal.servicePrincipalId}" belongs to a different tenant than the organization`,
      );
    }
    if (servicePrincipalIds.has(servicePrincipal.servicePrincipalId)) {
      throw new InvalidOrganizationResourceBindingError(
        `duplicate service principal ref "${servicePrincipal.servicePrincipalId}"`,
      );
    }
    servicePrincipalIds.add(servicePrincipal.servicePrincipalId);
  }

  if (input.project.tenantId !== input.organization.tenantId) {
    throw new InvalidOrganizationResourceBindingError("project belongs to a different tenant than the organization");
  }
  if (
    input.ownership.tenantId !== input.organization.tenantId ||
    input.ownership.customerId !== input.project.customerId ||
    input.ownership.projectId !== input.project.projectId
  ) {
    throw new InvalidOrganizationResourceBindingError(
      "ownership does not match the given organization's tenant and project",
    );
  }

  const boundAt = requireValidTimestamp(input.boundAt, "boundAt");

  return {
    version: 1,
    tenantId: input.organization.tenantId,
    organizationId: input.organization.organizationId,
    membershipRefs: memberships.map((membership) => membership.membershipId),
    servicePrincipalRefs: servicePrincipals.map((servicePrincipal) => servicePrincipal.servicePrincipalId),
    projectRef: input.project.projectId,
    ownership: input.ownership,
    connectionBindingRefs: requireOpaqueStringArray(
      input.connectionBindingRefs ?? [],
      "connectionBindingRefs",
    ) as unknown as ReadonlyArray<ConnectionBinding["connectionBindingId"]>,
    effectiveConfigRefs: requireOpaqueStringArray(input.effectiveConfigRefs ?? [], "effectiveConfigRefs"),
    effectivePolicyRefs: requireOpaqueStringArray(input.effectivePolicyRefs ?? [], "effectivePolicyRefs"),
    workerRouteRefs: requireOpaqueStringArray(input.workerRouteRefs ?? [], "workerRouteRefs"),
    knowledgeEvidenceRefs: requireOpaqueStringArray(input.knowledgeEvidenceRefs ?? [], "knowledgeEvidenceRefs"),
    boundAt,
  };
}

/** Truthful current disposition of a durable binding - never cached, always re-derived from currently-supplied evidence. */
export type OrganizationBindingState = "READY" | "ACTION_REQUIRED" | "BLOCKED";

/** Which side must act next. `NONE` is reachable only when `state === "READY"`. */
export type OrganizationBindingActor = "NONE" | "FOUNDER" | "AKILTA" | "HUMAN_REVIEW";

export interface NextRequiredOrganizationAction {
  readonly code: string;
  readonly reason: string;
}

export interface OrganizationResourceBindingStatus {
  readonly tenantId: TenantScope["tenantId"];
  readonly organizationId: Organization["organizationId"];
  readonly state: OrganizationBindingState;
  readonly nextRequiredActor: OrganizationBindingActor;
  readonly nextRequiredAction?: NextRequiredOrganizationAction;
  readonly unresolvedGates: ReadonlyArray<string>;
}

function blocked(
  binding: OrganizationResourceBinding,
  code: string,
  reason: string,
): OrganizationResourceBindingStatus {
  return {
    tenantId: binding.tenantId,
    organizationId: binding.organizationId,
    state: "BLOCKED",
    nextRequiredActor: "HUMAN_REVIEW",
    nextRequiredAction: { code, reason },
    unresolvedGates: [code],
  };
}

function actionRequired(
  binding: OrganizationResourceBinding,
  actor: OrganizationBindingActor,
  code: string,
  reason: string,
): OrganizationResourceBindingStatus {
  return {
    tenantId: binding.tenantId,
    organizationId: binding.organizationId,
    state: "ACTION_REQUIRED",
    nextRequiredActor: actor,
    nextRequiredAction: { code, reason },
    unresolvedGates: [code],
  };
}

/**
 * Pure, deterministic, always-re-resolved-from-current-evidence composition
 * - mirrors `ProjectActivationProfile`'s own "never cache/copy owner state"
 * discipline and `resolveEffectiveOrganizationAccess`'s own "re-invoking is
 * the only way to get a current answer" discipline. The durable
 * `OrganizationResourceBinding` itself never changes once bootstrapped
 * (historical evidence is never deleted); calling this function again with
 * now-revoked/now-missing current evidence is exactly how a caller observes
 * that revocation, without ever mutating or discarding the binding record.
 *
 * Blocker priority (first failing gate wins, mirroring
 * `compileProjectActivationProfile`'s own ordering discipline): organization
 * lifecycle state, then membership currentness (at least one ACTIVE,
 * tenant-correct membership from the CURRENT supplied list must still exist
 * and its id must still appear in the binding's own `membershipRefs` -
 * closing "same-looking refs in another Organization cannot substitute"),
 * then service-principal currentness (only for principals actually
 * referenced), then project/ownership structural correlation, then
 * connection currentness (only for connections actually referenced) - a
 * referenced connection that no longer resolves, or resolves to a
 * `REVOKED`/`DEGRADED` state, or resolves to a DIFFERENT organization's
 * ownership, blocks. Only once every gate is clean does this return
 * `READY`.
 */
export function resolveOrganizationResourceBindingStatus(input: {
  binding: OrganizationResourceBinding;
  organization: Organization;
  currentMemberships: ReadonlyArray<OrganizationMembership>;
  currentServicePrincipals: ReadonlyArray<OrganizationServicePrincipal>;
  currentConnections: ReadonlyArray<ConnectionBinding>;
}): OrganizationResourceBindingStatus {
  const { binding, organization } = input;

  if (organization.organizationId !== binding.organizationId || organization.tenantId !== binding.tenantId) {
    return blocked(
      binding,
      "ORGANIZATION_IDENTITY_MISMATCH",
      "the supplied current organization does not match this binding's own organizationId/tenantId",
    );
  }
  if (organization.state === "SUSPENDED") {
    return blocked(binding, "ORGANIZATION_SUSPENDED", "the organization is currently SUSPENDED");
  }
  if (organization.state === "BOOTSTRAPPING") {
    return actionRequired(binding, "AKILTA", "ORGANIZATION_NOT_ACTIVATED", "the organization has not yet been activated");
  }

  const currentActiveMemberships = input.currentMemberships.filter(
    (membership) =>
      membership.tenantId === binding.tenantId &&
      binding.membershipRefs.includes(membership.membershipId) &&
      isOrganizationMembershipActive(membership),
  );
  if (currentActiveMemberships.length === 0) {
    return blocked(
      binding,
      "NO_ACTIVE_BOUND_MEMBERSHIP",
      "none of this binding's own membershipRefs currently resolve to an active, coherent, tenant-correct membership",
    );
  }

  for (const servicePrincipalRef of binding.servicePrincipalRefs) {
    const current = input.currentServicePrincipals.find(
      (servicePrincipal) => servicePrincipal.servicePrincipalId === servicePrincipalRef,
    );
    if (current === undefined || current.tenantId !== binding.tenantId) {
      return actionRequired(
        binding,
        "AKILTA",
        "SERVICE_PRINCIPAL_MISSING",
        `bound service principal "${servicePrincipalRef}" no longer resolves to a current, tenant-correct record`,
      );
    }
    if (!isOrganizationServicePrincipalActive(current)) {
      return actionRequired(
        binding,
        "AKILTA",
        "SERVICE_PRINCIPAL_REVOKED",
        `bound service principal "${servicePrincipalRef}" is revoked`,
      );
    }
  }

  for (const connectionBindingRef of binding.connectionBindingRefs) {
    const current = input.currentConnections.find(
      (connection) => connection.connectionBindingId === connectionBindingRef,
    );
    if (current === undefined || current.ownership.tenantId !== binding.tenantId || current.ownership.projectId !== binding.projectRef) {
      return actionRequired(
        binding,
        "AKILTA",
        "CONNECTION_MISSING",
        `bound connection "${connectionBindingRef}" no longer resolves to a current, tenant/project-correct binding`,
      );
    }
    if (current.connectionState === "REVOKED" || current.connectionState === "DEGRADED") {
      const actor: OrganizationBindingActor = "AKILTA";
      return actionRequired(
        binding,
        actor,
        "CONNECTION_NOT_CURRENT",
        `bound connection "${connectionBindingRef}" is currently ${current.connectionState}`,
      );
    }
  }

  return {
    tenantId: binding.tenantId,
    organizationId: binding.organizationId,
    state: "READY",
    nextRequiredActor: "NONE",
    unresolvedGates: [],
  };
}
