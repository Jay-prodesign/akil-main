import type { TenantScope } from "./tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "./organization.js";
import { createOrganizationMembership, type OrganizationMembership } from "./organization-membership.js";
import { createOrganizationAccessRoleContext, type OrganizationAccessRoleContext } from "./organization-access-role.js";

/**
 * ORG-ONBOARD-001 (AKILTA OS blueprint's own V2 section: "customer-facing
 * organization provisioning/onboarding"): the genuine gap this closes is
 * narrow. `controlled-organization-provisioning.ts` (OS-V1-01) already
 * provisions an Organization end to end, but it is deliberately
 * "controlled" - its own `provisionControlledOrganization` takes a
 * `founderPrincipalRef`/`founderMembershipId` and immediately constructs the
 * Organization with no admission/evaluation step at all, because every
 * caller of that function is already a trusted internal/regression actor.
 * There is no honest path anywhere in this repository from "an
 * unauthenticated prospective customer submitted a request" to "an admitted,
 * real Organization" - exposing `provisionControlledOrganization` directly
 * to such a prospect would let an arbitrary caller mint an Organization with
 * no review at all.
 *
 * This module is that missing admission gate, composing `organization.ts`'s
 * `createOrganization`/`activateOrganization`, `organization-membership.ts`'s
 * `createOrganizationMembership`, and `organization-access-role.ts`'s
 * `createOrganizationAccessRoleContext` entirely unmodified - no second
 * Organization-construction path, no second IAM. The admission discipline
 * mirrors `service-catalog-admission.ts`/`partner-capability-admission.ts`'s
 * own established floor exactly: a request is always born `SUBMITTED`
 * (never auto-admitted); only an explicit `admitOrganizationOnboardingRequest`
 * call, requiring a non-empty `evidenceRef` and an `admittingAuthorityPrincipalRef`
 * that is fail-closed rejected when it equals the request's own
 * `requestedByRef` (a prospect can never self-admit their own application,
 * exactly like `PartnerCapabilityClaim`'s Rev55 F1 self-certification guard),
 * can produce `ADMITTED`; `REJECTED` is terminal, with no reactivation path.
 *
 * Deliberately NOT a real self-service signup flow: `requestedByRef` and
 * `admittingAuthorityPrincipalRef` are opaque caller-supplied strings, never
 * validated against any real identity provider (a production IdP is its own,
 * separately gated, later activation decision - explicitly out of scope
 * here and for every other dark/internal checkpoint in this corridor). No
 * HTTP route, admin UI, or billing/subscription wiring is added by this
 * checkpoint - the domain contract only, matching every other OS V0-V2
 * floor-slice checkpoint's own established scope discipline.
 */

export class InvalidOrganizationOnboardingError extends Error {
  constructor(reason: string) {
    super(`Invalid OrganizationOnboarding operation: ${reason}`);
    this.name = "InvalidOrganizationOnboardingError";
  }
}

export class OrganizationOnboardingAdmissionError extends Error {
  constructor(reason: string) {
    super(`OrganizationOnboarding admission rejected: ${reason}`);
    this.name = "OrganizationOnboardingAdmissionError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidOrganizationOnboardingError(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new InvalidOrganizationOnboardingError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidOrganizationOnboardingError(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

const TERMINAL_ONLY_FIELDS = [
  "admittedOrganizationId",
  "decidedByRef",
  "decidedAt",
  "rejectionReason",
  "admissionEvidenceRef",
] as const;

/**
 * Brain correction (comment `6311999915`, F1): `OrganizationOnboardingRequest`
 * is an exported structural interface, so a caller can hand-build a
 * nominally `SUBMITTED` object - the status guard alone (`request.status
 * !== "SUBMITTED"`) does not prove the rest of the object is coherent.
 * Revalidates `requestId`/`requestedDisplayName`/`requestedByRef`/
 * `submittedAt` against the exact same invariants
 * `submitOrganizationOnboardingRequest` itself enforces, and fails closed
 * if any terminal-only field (`admittedOrganizationId`/`decidedByRef`/
 * `decidedAt`/`rejectionReason`/`admissionEvidenceRef`) is already
 * populated on a request claiming to still be `SUBMITTED` - no terminal
 * decision ever consumes stale/forged terminal metadata. Returns the
 * parsed `submittedAt` instant so both `admitOrganizationOnboardingRequest`
 * and `rejectOrganizationOnboardingRequest` can order their own decision
 * timestamp against it.
 */
function requireCoherentSubmittedRequest(request: OrganizationOnboardingRequest): number {
  requireNonEmptyString(request.requestId, "request.requestId");
  requireNonEmptyString(request.requestedDisplayName, "request.requestedDisplayName");
  requireNonEmptyString(request.requestedByRef, "request.requestedByRef");
  const submittedAt = requireNonEmptyString(request.submittedAt, "request.submittedAt");
  const submittedAtMs = Date.parse(submittedAt);
  if (Number.isNaN(submittedAtMs)) {
    throw new InvalidOrganizationOnboardingError("request.submittedAt must be a valid ISO timestamp");
  }
  for (const field of TERMINAL_ONLY_FIELDS) {
    if (request[field] !== undefined) {
      throw new OrganizationOnboardingAdmissionError(
        `request "${request.requestId}" claims status "SUBMITTED" but already carries terminal-only field "${field}" - a SUBMITTED request can never carry terminal decision metadata`,
      );
    }
  }
  return submittedAtMs;
}

function requireDecisionNotBeforeSubmission(decisionAtMs: number, submittedAtMs: number, field: string): void {
  if (decisionAtMs < submittedAtMs) {
    throw new InvalidOrganizationOnboardingError(
      `${field} must not be chronologically before the request's own submittedAt - a decision can never predate the submission it decides`,
    );
  }
}

export type OrganizationOnboardingRequestId = string & { readonly __brand: "OrganizationOnboardingRequestId" };

export type OrganizationOnboardingRequestStatus = "SUBMITTED" | "ADMITTED" | "REJECTED";

/**
 * Deliberately carries no `tenantId`/`TenantScope` at all: a prospect has no
 * tenant identity before admission - inventing one here would misrepresent
 * an unreviewed application as already-provisioned tenant truth. Only
 * `admitOrganizationOnboardingRequest` ever introduces a real `TenantScope`,
 * and only as a caller-supplied input to that one call, never derived or
 * guessed from this request.
 */
export interface OrganizationOnboardingRequest {
  readonly requestId: OrganizationOnboardingRequestId;
  readonly requestedDisplayName: string;
  readonly requestedByRef: string;
  readonly submittedAt: string;
  readonly status: OrganizationOnboardingRequestStatus;
  readonly admittedOrganizationId?: Organization["organizationId"];
  readonly decidedByRef?: string;
  readonly decidedAt?: string;
  readonly rejectionReason?: string;
  /**
   * The exact validated `evidenceRef` that supported this admission decision
   * (ORG-ONBOARD-001 Brain correction, comment `6294369735`). Present only on
   * an `ADMITTED` request - a durable, replayable provenance pointer proving
   * which reviewing evidence justified this specific admission, mirroring
   * `service-catalog-admission.ts`'s own `ServiceCatalogAdmission.evidenceRef`
   * precedent. Never set by `submitOrganizationOnboardingRequest`.
   */
  readonly admissionEvidenceRef?: string;
}

/** The only construction path for a request: always born `SUBMITTED`, no caller-forgeable status. */
export function submitOrganizationOnboardingRequest(input: {
  requestId: unknown;
  requestedDisplayName: unknown;
  requestedByRef: unknown;
  submittedAt: unknown;
}): OrganizationOnboardingRequest {
  const requestId = requireNonEmptyString(input.requestId, "requestId") as OrganizationOnboardingRequestId;
  const requestedDisplayName = requireNonEmptyString(input.requestedDisplayName, "requestedDisplayName");
  const requestedByRef = requireNonEmptyString(input.requestedByRef, "requestedByRef");
  const submittedAt = requireNonEmptyString(input.submittedAt, "submittedAt");
  if (Number.isNaN(Date.parse(submittedAt))) {
    throw new InvalidOrganizationOnboardingError("submittedAt must be a valid ISO timestamp");
  }
  return { requestId, requestedDisplayName, requestedByRef, submittedAt, status: "SUBMITTED" };
}

export interface OrganizationOnboardingAdmissionResult {
  readonly admittedRequest: OrganizationOnboardingRequest;
  readonly organization: Organization;
  readonly founderMembership: OrganizationMembership;
  readonly founderAccessRoleContext: OrganizationAccessRoleContext;
}

/**
 * Fails closed unless: `request.status === "SUBMITTED"` (never admits an
 * already-admitted or already-rejected request - no resurrection);
 * `evidenceRef` is non-empty (an admission with no recorded reviewing
 * evidence is never accepted, mirroring `service-catalog-admission.ts`);
 * `admittingAuthorityPrincipalRef` is non-empty AND distinct from the
 * request's own `requestedByRef` (self-admission is structurally
 * impossible, mirroring `partner-capability-admission.ts`'s Rev55 F1 fix).
 * On success, delegates the actual Organization/membership/access-role
 * construction entirely to the existing, unmodified
 * `createOrganization`/`activateOrganization`/`createOrganizationMembership`/
 * `createOrganizationAccessRoleContext` - this function adds no second
 * construction path for any of them. The admitted request's own
 * `admittedOrganizationId` is the forward-provenance pointer back from the
 * new Organization to the application that produced it, and its
 * `admissionEvidenceRef` is the forward-provenance pointer to the exact
 * reviewing evidence that justified the decision (Brain correction,
 * comment `6294369735` - the validated `evidenceRef` was previously
 * discarded via `void evidenceRef`, making two admissions over different
 * evidence observationally identical and unauditable).
 */
export function admitOrganizationOnboardingRequest(input: {
  request: OrganizationOnboardingRequest;
  newTenantScope: TenantScope;
  newOrganizationId: unknown;
  founderMembershipId: unknown;
  admittingAuthorityPrincipalRef: unknown;
  evidenceRef: unknown;
  admittedAt: unknown;
}): OrganizationOnboardingAdmissionResult {
  const { request } = input;
  if (request.status !== "SUBMITTED") {
    throw new OrganizationOnboardingAdmissionError(
      `request "${request.requestId}" has status "${request.status}" - only a SUBMITTED request may be admitted, never resurrected from ADMITTED or REJECTED`,
    );
  }
  const submittedAtMs = requireCoherentSubmittedRequest(request);
  const admittingAuthorityPrincipalRef = requireNonEmptyString(
    input.admittingAuthorityPrincipalRef,
    "admittingAuthorityPrincipalRef",
  );
  if (admittingAuthorityPrincipalRef === request.requestedByRef) {
    throw new OrganizationOnboardingAdmissionError(
      "admittingAuthorityPrincipalRef must not equal the request's own requestedByRef - a prospective applicant can never admit their own application",
    );
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  const admittedAt = requireNonEmptyString(input.admittedAt, "admittedAt");
  const admittedAtMs = Date.parse(admittedAt);
  if (Number.isNaN(admittedAtMs)) {
    throw new InvalidOrganizationOnboardingError("admittedAt must be a valid ISO timestamp");
  }
  requireDecisionNotBeforeSubmission(admittedAtMs, submittedAtMs, "admittedAt");

  const organizationId = requireNonEmptyString(input.newOrganizationId, "newOrganizationId");
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId,
      tenantScope: input.newTenantScope,
      displayName: request.requestedDisplayName,
      createdAt: admittedAt,
    }),
    activatedAt: admittedAt,
  });
  const founderMembership = createOrganizationMembership({
    membershipId: input.founderMembershipId,
    tenantScope: input.newTenantScope,
    principalRef: request.requestedByRef,
    role: "STAFF",
  });
  const founderAccessRoleContext = createOrganizationAccessRoleContext({
    membership: founderMembership,
    role: "OWNER",
  });

  const admittedRequest: OrganizationOnboardingRequest = {
    ...request,
    status: "ADMITTED",
    admittedOrganizationId: organization.organizationId,
    decidedByRef: admittingAuthorityPrincipalRef,
    decidedAt: admittedAt,
    admissionEvidenceRef: evidenceRef,
  };
  return { admittedRequest, organization, founderMembership, founderAccessRoleContext };
}

/** Terminal, one-way: a rejected request is never reconsidered by this module - submitting a fresh request is the only path forward. */
export function rejectOrganizationOnboardingRequest(input: {
  request: OrganizationOnboardingRequest;
  rejectingAuthorityPrincipalRef: unknown;
  reason: unknown;
  rejectedAt: unknown;
}): OrganizationOnboardingRequest {
  const { request } = input;
  if (request.status !== "SUBMITTED") {
    throw new OrganizationOnboardingAdmissionError(
      `request "${request.requestId}" has status "${request.status}" - only a SUBMITTED request may be rejected`,
    );
  }
  const submittedAtMs = requireCoherentSubmittedRequest(request);
  const rejectingAuthorityPrincipalRef = requireNonEmptyString(
    input.rejectingAuthorityPrincipalRef,
    "rejectingAuthorityPrincipalRef",
  );
  const reason = requireNonEmptyString(input.reason, "reason");
  const rejectedAt = requireNonEmptyString(input.rejectedAt, "rejectedAt");
  const rejectedAtMs = Date.parse(rejectedAt);
  if (Number.isNaN(rejectedAtMs)) {
    throw new InvalidOrganizationOnboardingError("rejectedAt must be a valid ISO timestamp");
  }
  requireDecisionNotBeforeSubmission(rejectedAtMs, submittedAtMs, "rejectedAt");
  return {
    ...request,
    status: "REJECTED",
    decidedByRef: rejectingAuthorityPrincipalRef,
    decidedAt: rejectedAt,
    rejectionReason: reason,
  };
}
