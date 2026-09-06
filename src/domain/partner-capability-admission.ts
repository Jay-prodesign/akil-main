import type { PartnerOrganization } from "./partner-organization.js";

export class InvalidPartnerCapabilityClaimError extends Error {
  constructor(reason: string) {
    super(`Invalid PartnerCapabilityClaim: ${reason}`);
    this.name = "InvalidPartnerCapabilityClaimError";
  }
}

type PartnerCapabilityClaimId = string & { readonly __brand: "PartnerCapabilityClaimId" };

/**
 * Rev55 F1 correction: the identity of whoever admits a claim, kept as its
 * own branded type so it can never be silently confused with (or
 * substituted by) a `PartnerOrganizationId`. This is what makes "capability
 * claim cannot self-certify" an enforced invariant rather than a caller
 * convention - see the fail-closed check in `admitPartnerCapabilityClaim`.
 */
type AdmittingAuthorityId = string & { readonly __brand: "AdmittingAuthorityId" };

/**
 * V5 Workstream H (Partner Network Operations), §12 text: "partner
 * capability claims require evidence/admission and may expire/review."
 * A claim is always constructed `UNVERIFIED` (see `createPartnerCapabilityClaim`
 * below) - there is no construction path that produces `ADMITTED` directly,
 * which is what makes §12's acceptance "capability claim cannot self-certify"
 * a structural guarantee rather than a convention: the partner organization
 * whose claim this is has no function in this module that can move it past
 * `UNVERIFIED` on its own assertion. `EXPIRED` is never stored - it is only
 * ever a computed, caller-`asOf`-relative disposition (see
 * `resolvePartnerCapabilityClaimStatus`), matching this module's
 * deterministic, clock-free discipline. `REVOKED` is a distinct terminal
 * state from `EXPIRED` (an explicit revocation is not the same as time
 * passing) and, once set, is never reversible by this module - a
 * revoked claim requires an entirely new claim, never resurrection.
 */
export type PartnerCapabilityClaimStatus = "UNVERIFIED" | "ADMITTED" | "EXPIRED" | "REVOKED";

/**
 * §12: "partner capability claims require evidence/admission ... require
 * evidence/admission and may expire/review." `capabilityRef` is an opaque
 * pointer to whatever capability description exists elsewhere - this
 * module never interprets it, only carries and compares it for identity.
 * `evidenceRef`/`admittedAt`/`reviewByAt` are present only once a claim has
 * been through `admitPartnerCapabilityClaim` - a freshly created claim (see
 * `createPartnerCapabilityClaim`) has none of them. `admittedByAuthorityId`
 * (Rev55 F1 correction) records exactly which independent authority
 * performed the admission, distinct from `partnerOrganizationId` - the
 * claimant - making that provenance explicit and auditable on the claim
 * itself rather than left to caller convention.
 */
export interface PartnerCapabilityClaim {
  readonly partnerCapabilityClaimId: PartnerCapabilityClaimId;
  readonly partnerOrganizationId: PartnerOrganization["partnerOrganizationId"];
  readonly capabilityRef: string;
  readonly status: PartnerCapabilityClaimStatus;
  readonly evidenceRef?: string;
  readonly admittedAt?: string;
  readonly reviewByAt?: string;
  readonly admittedByAuthorityId?: AdmittingAuthorityId;
  readonly revokedAt?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidPartnerCapabilityClaimError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): { raw: string; ms: number } {
  const raw = requireNonEmptyString(value, field);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new InvalidPartnerCapabilityClaimError(`${field} must be a valid ISO timestamp`);
  }
  return { raw, ms };
}

/**
 * A capability claim always starts `UNVERIFIED` - this is the only
 * construction function in this module, and it accepts no `status`,
 * `evidenceRef`, or admission-related field from the caller, so a partner
 * organization's own claim can never be born pre-admitted.
 */
export function createPartnerCapabilityClaim(input: {
  partnerCapabilityClaimId: unknown;
  partnerOrganization: PartnerOrganization;
  capabilityRef: unknown;
}): PartnerCapabilityClaim {
  const partnerCapabilityClaimId = requireNonEmptyString(
    input.partnerCapabilityClaimId,
    "partnerCapabilityClaimId",
  );
  const capabilityRef = requireNonEmptyString(input.capabilityRef, "capabilityRef");
  return {
    partnerCapabilityClaimId: partnerCapabilityClaimId as PartnerCapabilityClaimId,
    partnerOrganizationId: input.partnerOrganization.partnerOrganizationId,
    capabilityRef,
    status: "UNVERIFIED",
  };
}

/**
 * §12 acceptance: "capability claim cannot self-certify." This is the only
 * function that can produce an `ADMITTED` claim, and it requires a
 * non-empty `evidenceRef` plus a `reviewByAt` that is strictly after
 * `admittedAt` - an admission with no evidence, or with a review date that
 * has already lapsed at the moment of admission, is rejected. Only an
 * `UNVERIFIED` claim can be admitted; `ADMITTED`/`EXPIRED`/`REVOKED` all
 * reject re-admission (a stale or already-decided claim cannot be silently
 * re-processed into a fresh admission).
 *
 * Rev55 F1 correction: `evidenceRef`/`reviewByAt` alone do not prove the
 * admission came from an authority independent of the claimant - a
 * partner organization could otherwise supply its own evidence and dates
 * and call this function on its own claim. `admittingAuthorityId` makes
 * that authority explicit and auditable (persisted as
 * `admittedByAuthorityId`), and self-admission is now a structural,
 * fail-closed rejection: an `admittingAuthorityId` equal to the claim's own
 * `partnerOrganizationId` is refused outright, independent of whatever
 * evidence/dates accompany it.
 */
export function admitPartnerCapabilityClaim(input: {
  claim: PartnerCapabilityClaim;
  admittingAuthorityId: unknown;
  evidenceRef: unknown;
  admittedAt: unknown;
  reviewByAt: unknown;
}): PartnerCapabilityClaim {
  if (input.claim.status !== "UNVERIFIED") {
    throw new InvalidPartnerCapabilityClaimError(
      `only an UNVERIFIED claim can be admitted (current status: ${input.claim.status})`,
    );
  }
  const admittingAuthorityId = requireNonEmptyString(
    input.admittingAuthorityId,
    "admittingAuthorityId",
  ) as AdmittingAuthorityId;
  if ((admittingAuthorityId as string) === (input.claim.partnerOrganizationId as string)) {
    throw new InvalidPartnerCapabilityClaimError(
      "admittingAuthorityId must be independent of the claimant partner organization (self-admission is not permitted)",
    );
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  const admittedAt = requireValidTimestamp(input.admittedAt, "admittedAt");
  const reviewByAt = requireValidTimestamp(input.reviewByAt, "reviewByAt");
  if (reviewByAt.ms <= admittedAt.ms) {
    throw new InvalidPartnerCapabilityClaimError("reviewByAt must be strictly after admittedAt");
  }
  return {
    ...input.claim,
    status: "ADMITTED",
    evidenceRef,
    admittedAt: admittedAt.raw,
    reviewByAt: reviewByAt.raw,
    admittedByAuthorityId: admittingAuthorityId,
  };
}

/**
 * §12: "revoked assignment removes access deterministically" (the same
 * discipline `revokePartnerClientAssignment`, in `partner-organization.ts`,
 * already applies to client assignments). Only an `ADMITTED` claim can be
 * revoked - revoking an `UNVERIFIED`, already-`REVOKED`, or `EXPIRED`
 * (computed, never stored - see `resolvePartnerCapabilityClaimStatus`)
 * claim is rejected, so a caller cannot manufacture a `REVOKED` record for
 * a claim that was never actually admitted.
 */
export function revokePartnerCapabilityClaim(input: {
  claim: PartnerCapabilityClaim;
  revokedAt: unknown;
}): PartnerCapabilityClaim {
  if (input.claim.status !== "ADMITTED") {
    throw new InvalidPartnerCapabilityClaimError(
      `only an ADMITTED claim can be revoked (current status: ${input.claim.status})`,
    );
  }
  const revokedAt = requireNonEmptyString(input.revokedAt, "revokedAt");
  return { ...input.claim, status: "REVOKED", revokedAt };
}

/**
 * §12: "...may expire/review." Resolves the claim's effective status as of
 * a caller-supplied `asOf` - never the system clock, so this function is
 * fully deterministic and replayable. `UNVERIFIED`/`REVOKED` pass through
 * unchanged (neither is time-relative). An `ADMITTED` claim whose
 * `reviewByAt` is at or before `asOf` resolves `EXPIRED` - expiry is a
 * computed disposition, never a stored mutation, so the same stored claim
 * can honestly resolve `ADMITTED` as of one `asOf` and `EXPIRED` as of a
 * later one without any write occurring.
 */
export function resolvePartnerCapabilityClaimStatus(input: {
  claim: PartnerCapabilityClaim;
  asOf: unknown;
}): PartnerCapabilityClaimStatus {
  if (input.claim.status !== "ADMITTED") {
    return input.claim.status;
  }
  const asOf = requireValidTimestamp(input.asOf, "asOf");
  const reviewByAt = requireValidTimestamp(
    input.claim.reviewByAt,
    "claim.reviewByAt",
  );
  if (asOf.ms >= reviewByAt.ms) {
    return "EXPIRED";
  }
  return "ADMITTED";
}
