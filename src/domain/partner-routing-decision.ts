import type { PartnerOrganization, PartnerEmployeeMembership, PartnerClientAssignment } from "./partner-organization.js";
import { resolvePartnerClientAccess } from "./partner-organization.js";
import { resolvePartnerCapabilityClaimStatus, type PartnerCapabilityClaim } from "./partner-capability-admission.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";

export class InvalidPartnerRoutingRequestError extends Error {
  constructor(reason: string) {
    super(`Invalid PartnerRoutingRequest: ${reason}`);
    this.name = "InvalidPartnerRoutingRequestError";
  }
}

/**
 * V5 Workstream H (Partner Network Operations), §12 required semantics:
 * "partner routing records reason, owner and fallback." This is the one
 * required-semantics bullet neither `partner-organization.ts` (V3-PTR-001)
 * nor `partner-capability-admission.ts` (V5-PTN-001) addressed on its
 * own, structurally mirroring `resolveWorkerRoute` (V5-WRK-001, §6) for
 * partners instead of workers.
 *
 * Rev98 gap-audit reconciliation note: an earlier draft (the now-stale
 * PR #24) modeled eligibility on capability admission alone. That misses
 * §6's own "explicit agency employee -> client/account assignment"
 * authority: an admitted capability claim only proves a partner
 * organization CAN perform the work in general, never that any specific
 * partner employee is actually authorized against the specific
 * tenant/customer/project this routing decision is FOR. This module
 * therefore composes both existing authority dimensions - capability
 * admission (`resolvePartnerCapabilityClaimStatus`) AND per-employee
 * client/project access (`resolvePartnerClientAccess`) - rather than
 * reusing only one of them.
 *
 * Rev101 F1 correction: `decidedByOwnerId` is a bare, unbranded, caller-
 * supplied opaque string with no repository-enforced binding to
 * `PartnerOrganization["partnerOrganizationId"]` or any other identity
 * type - no admitted delegation/cross-domain identity-mapping primitive
 * exists anywhere in this codebase that could prove `decidedByOwnerId`
 * genuinely belongs to a different, independent party than the routed
 * candidate, and this module does not invent one. `isEligible` therefore
 * makes only the narrow, honestly-provable claim that `decidedByOwnerId`
 * does not literally reuse either identifier the candidate itself
 * carries - its `partnerOrganizationId` or its own distinct
 * `partnerEmployeeMembershipId` - mirroring the same bounded opaque-
 * identity-reuse discipline `admitPartnerCapabilityClaim`'s own self-
 * admission guard (`partner-capability-admission.ts`, Rev55 F1) already
 * uses. This detects a decision owner who literally reuses the
 * candidate's own identifier; it is not a proof of independently
 * verified authority (that would require a real cross-domain IAM binding,
 * out of scope here) - callers must not read a `ROUTED` decision as
 * evidence that `decidedByOwnerId` was independently authenticated.
 */
export type PartnerRoutingDecisionStatus = "ROUTED" | "REJECTED";

/**
 * A candidate bundles everything one specific partner employee brings to
 * one routing attempt: which partner organization they belong to, which
 * capability claim that organization holds, and which client assignments
 * that specific employee has been granted (only the employee's own
 * assignments need be supplied - this module has no persistence/lookup
 * capability of its own, consistent with every other pure domain module
 * in this codebase).
 */
export interface PartnerRoutingCandidate {
  readonly partnerOrganization: PartnerOrganization;
  readonly capabilityClaim: PartnerCapabilityClaim;
  readonly partnerEmployeeMembership: PartnerEmployeeMembership;
  readonly clientAssignments: ReadonlyArray<PartnerClientAssignment>;
}

/**
 * §12 acceptance: "partner routing records reason, owner and fallback."
 * `reason` and `decidedByOwnerId` are always populated, for both `ROUTED`
 * and `REJECTED` outcomes - a caller can never observe a routing decision
 * with no explanation of why it was made or who is accountable for it.
 * `fallbackPartnerOrganizationIds` lists every other eligible candidate's
 * partner organization, in the caller-supplied order, distinct from the
 * selected partner - empty when none exists, never fabricated.
 */
export interface PartnerRoutingDecision {
  readonly requiredCapabilityRef: string;
  readonly targetOwnership: ProjectOwnershipRef;
  readonly status: PartnerRoutingDecisionStatus;
  readonly decidedByOwnerId: string;
  readonly selectedPartnerOrganizationId?: PartnerOrganization["partnerOrganizationId"];
  readonly selectedPartnerEmployeeMembershipId?: PartnerEmployeeMembership["partnerEmployeeMembershipId"];
  readonly fallbackPartnerOrganizationIds: ReadonlyArray<PartnerOrganization["partnerOrganizationId"]>;
  readonly reason: string;
}

export interface PartnerRoutingRequest {
  readonly requiredCapabilityRef: unknown;
  readonly targetOwnership: ProjectOwnershipRef;
  readonly asOf: unknown;
  readonly decidedByOwnerId: unknown;
  readonly candidates: ReadonlyArray<PartnerRoutingCandidate>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidPartnerRoutingRequestError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(raw))) {
    throw new InvalidPartnerRoutingRequestError(`${field} must be a valid ISO timestamp`);
  }
  return raw;
}

/**
 * A candidate is eligible only when every one of the following holds:
 * - its `capabilityClaim` and `partnerEmployeeMembership` structurally
 *   belong to its `partnerOrganization` (a mismatched candidate entry is
 *   simply ineligible, never fatal to the whole route - one corrupted
 *   candidate never blocks routing to the rest);
 * - the claim's `capabilityRef` matches `requiredCapabilityRef` and it
 *   resolves `ADMITTED` as of `asOf` (§12: an expired/unverified/revoked
 *   claim is never routable, no matter how early it appears);
 * - `decidedByOwnerId` does not literally reuse either identifier the
 *   candidate itself brings to this attempt - its partner organization id
 *   or its own partner-employee-membership id (Rev101 F1 correction, see
 *   below);
 * - the specific candidate employee resolves `AUTHORIZED` client access
 *   (`resolvePartnerClientAccess`) for `targetOwnership` - an admitted
 *   organization-level capability claim never substitutes for a real,
 *   unrevoked, tenant/customer/project/service-matched client assignment
 *   for the actual employee being routed.
 */
function isEligible(
  candidate: PartnerRoutingCandidate,
  requiredCapabilityRef: string,
  asOf: string,
  decidedByOwnerId: string,
  targetOwnership: ProjectOwnershipRef,
): boolean {
  if (
    candidate.capabilityClaim.partnerOrganizationId !== candidate.partnerOrganization.partnerOrganizationId
  ) {
    return false;
  }
  if (
    candidate.partnerEmployeeMembership.partnerOrganizationId !==
    candidate.partnerOrganization.partnerOrganizationId
  ) {
    return false;
  }
  if (candidate.capabilityClaim.capabilityRef !== requiredCapabilityRef) {
    return false;
  }
  if (resolvePartnerCapabilityClaimStatus({ claim: candidate.capabilityClaim, asOf }) !== "ADMITTED") {
    return false;
  }
  if (
    (candidate.partnerOrganization.partnerOrganizationId as string) === decidedByOwnerId ||
    (candidate.partnerEmployeeMembership.partnerEmployeeMembershipId as string) === decidedByOwnerId
  ) {
    return false;
  }
  const clientAccess = resolvePartnerClientAccess({
    partnerEmployeeMembershipId: candidate.partnerEmployeeMembership.partnerEmployeeMembershipId,
    assignments: candidate.clientAssignments,
    ownership: targetOwnership,
  });
  if (clientAccess !== "AUTHORIZED") {
    return false;
  }
  return true;
}

/**
 * Resolves a §12-governed partner routing decision. Pure function - never
 * persists anything, never reads the system clock (status resolution is
 * bound to the caller-supplied `asOf`, exactly like
 * `resolvePartnerCapabilityClaimStatus` itself).
 *
 * Fails closed (throws `InvalidPartnerRoutingRequestError`) only on
 * malformed structural input (empty `requiredCapabilityRef`/
 * `decidedByOwnerId`, an invalid `asOf`, or a non-array `candidates`). No
 * eligible candidate is never a thrown error - it is an explicit
 * `REJECTED` decision with a reason, matching `resolveWorkerRoute`'s
 * graceful-degradation discipline rather than crashing the caller.
 *
 * Selection: the first eligible candidate in `candidates` order becomes
 * the selected partner/employee; every other eligible candidate's
 * partner organization (same order, deduplicated by id) becomes
 * `fallbackPartnerOrganizationIds`. Candidate order is caller-supplied
 * preference - it has no effect on eligibility itself, so an
 * ineligible-but-earlier candidate is never chosen over an eligible
 * later one.
 */
export function resolvePartnerRoute(request: PartnerRoutingRequest): PartnerRoutingDecision {
  const requiredCapabilityRef = requireNonEmptyString(
    request.requiredCapabilityRef,
    "requiredCapabilityRef",
  );
  const decidedByOwnerId = requireNonEmptyString(request.decidedByOwnerId, "decidedByOwnerId");
  const asOf = requireValidTimestamp(request.asOf, "asOf");
  if (!Array.isArray(request.candidates)) {
    throw new InvalidPartnerRoutingRequestError(
      "candidates must be an array (an empty array is valid)",
    );
  }

  const eligible = request.candidates.filter((candidate) =>
    isEligible(candidate, requiredCapabilityRef, asOf, decidedByOwnerId, request.targetOwnership),
  );

  if (eligible.length === 0) {
    return {
      requiredCapabilityRef,
      targetOwnership: request.targetOwnership,
      status: "REJECTED",
      decidedByOwnerId,
      fallbackPartnerOrganizationIds: [],
      reason:
        "no candidate partner has both an ADMITTED capability claim for the required capability as of the given date and an AUTHORIZED client assignment for the target project, independent of the routing decision owner",
    };
  }

  const [selected, ...rest] = eligible;
  const fallbackPartnerOrganizationIds: Array<PartnerOrganization["partnerOrganizationId"]> = [];
  const seen = new Set<string>([selected.partnerOrganization.partnerOrganizationId as string]);
  for (const candidate of rest) {
    const id = candidate.partnerOrganization.partnerOrganizationId;
    if (!seen.has(id as string)) {
      seen.add(id as string);
      fallbackPartnerOrganizationIds.push(id);
    }
  }

  return {
    requiredCapabilityRef,
    targetOwnership: request.targetOwnership,
    status: "ROUTED",
    decidedByOwnerId,
    selectedPartnerOrganizationId: selected.partnerOrganization.partnerOrganizationId,
    selectedPartnerEmployeeMembershipId: selected.partnerEmployeeMembership.partnerEmployeeMembershipId,
    fallbackPartnerOrganizationIds,
    reason: `partner ${selected.partnerOrganization.partnerOrganizationId} (employee ${selected.partnerEmployeeMembership.partnerEmployeeMembershipId}) holds an ADMITTED capability claim for ${requiredCapabilityRef} as of ${asOf} and an AUTHORIZED client assignment for the target project, independent of decision owner ${decidedByOwnerId}${
      fallbackPartnerOrganizationIds.length > 0
        ? `; ${fallbackPartnerOrganizationIds.length} eligible fallback candidate(s) recorded`
        : ""
    }`,
  };
}
