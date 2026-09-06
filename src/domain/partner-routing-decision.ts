import type { PartnerOrganization } from "./partner-organization.js";
import { resolvePartnerCapabilityClaimStatus, type PartnerCapabilityClaim } from "./partner-capability-admission.js";

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
 * nor `partner-capability-admission.ts` (V5-PTN-001) addressed - routing a
 * unit of work to a specific partner organization, with an explicit
 * decision owner, reason, and fallback candidates, structurally mirroring
 * `resolveWorkerRoute` (V5-WRK-001, §6) for partners instead of workers.
 */
export type PartnerRoutingDecisionStatus = "ROUTED" | "REJECTED";

/**
 * §12: "partner capability claims require evidence/admission and may
 * expire/review" (already enforced in `partner-capability-admission.ts`)
 * is extended here into the routing boundary itself - see `isEligible`
 * below. `capabilityClaim` and `partnerOrganization` are supplied together
 * per candidate rather than looked up internally, since this module has no
 * persistence/lookup capability of its own (consistent with every other
 * pure domain module in this codebase).
 */
export interface PartnerRoutingCandidate {
  readonly partnerOrganization: PartnerOrganization;
  readonly capabilityClaim: PartnerCapabilityClaim;
}

/**
 * §12 acceptance: "partner routing records reason, owner and fallback."
 * `reason` and `decidedByOwnerId` are always populated, for both `ROUTED`
 * and `REJECTED` outcomes - a caller can never observe a routing decision
 * with no explanation of why it was made or who is accountable for it.
 * `fallbackPartnerOrganizationIds` lists every other eligible candidate, in
 * the caller-supplied order, distinct from the selected partner - empty
 * when none exists, never fabricated.
 */
export interface PartnerRoutingDecision {
  readonly requiredCapabilityRef: string;
  readonly status: PartnerRoutingDecisionStatus;
  readonly decidedByOwnerId: string;
  readonly selectedPartnerOrganizationId?: PartnerOrganization["partnerOrganizationId"];
  readonly fallbackPartnerOrganizationIds: ReadonlyArray<PartnerOrganization["partnerOrganizationId"]>;
  readonly reason: string;
}

export interface PartnerRoutingRequest {
  readonly requiredCapabilityRef: unknown;
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
 * A candidate is eligible only when: its `capabilityClaim` actually
 * belongs to its `partnerOrganization` (a structural mismatch makes just
 * that candidate ineligible rather than aborting the whole route - one
 * corrupted candidate entry never blocks routing to the rest); the claim's
 * `capabilityRef` matches `requiredCapabilityRef`; the claim resolves
 * `ADMITTED` as of `asOf` (§12: an expired/unverified/revoked claim is
 * never routable, no matter how early it appears in the candidate list);
 * and the candidate partner is not itself the routing decision's own
 * owner (§12's "cannot self-certify" discipline, already enforced at
 * admission in `partner-capability-admission.ts`, extended here to
 * routing - a partner can never be recorded as routing work to itself).
 */
function isEligible(
  candidate: PartnerRoutingCandidate,
  requiredCapabilityRef: string,
  asOf: string,
  decidedByOwnerId: string,
): boolean {
  if (
    candidate.capabilityClaim.partnerOrganizationId !== candidate.partnerOrganization.partnerOrganizationId
  ) {
    return false;
  }
  if (candidate.capabilityClaim.capabilityRef !== requiredCapabilityRef) {
    return false;
  }
  if (resolvePartnerCapabilityClaimStatus({ claim: candidate.capabilityClaim, asOf }) !== "ADMITTED") {
    return false;
  }
  if ((candidate.partnerOrganization.partnerOrganizationId as string) === decidedByOwnerId) {
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
 * `selectedPartnerOrganizationId`; every other eligible candidate (same
 * order, deduplicated by id) becomes `fallbackPartnerOrganizationIds`.
 * Candidate order is caller-supplied preference - it has no effect on
 * eligibility itself, so an ineligible-but-earlier candidate is never
 * chosen over an eligible later one.
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
    isEligible(candidate, requiredCapabilityRef, asOf, decidedByOwnerId),
  );

  if (eligible.length === 0) {
    return {
      requiredCapabilityRef,
      status: "REJECTED",
      decidedByOwnerId,
      fallbackPartnerOrganizationIds: [],
      reason:
        "no candidate partner declares an ADMITTED capability claim for the required capability as of the given date, independent of the routing decision owner",
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
    status: "ROUTED",
    decidedByOwnerId,
    selectedPartnerOrganizationId: selected.partnerOrganization.partnerOrganizationId,
    fallbackPartnerOrganizationIds,
    reason: `partner ${selected.partnerOrganization.partnerOrganizationId} holds an ADMITTED capability claim for ${requiredCapabilityRef} as of ${asOf}, independent of decision owner ${decidedByOwnerId}${
      fallbackPartnerOrganizationIds.length > 0
        ? `; ${fallbackPartnerOrganizationIds.length} eligible fallback candidate(s) recorded`
        : ""
    }`,
  };
}
