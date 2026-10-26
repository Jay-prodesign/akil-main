import type { TenantScope } from "./tenant-scope.js";

export class InvalidReusableCapabilityCandidateError extends Error {
  constructor(reason: string) {
    super(`Invalid ReusableCapabilityCandidate: ${reason}`);
    this.name = "InvalidReusableCapabilityCandidateError";
  }
}

type ReusableCapabilityCandidateId = string & {
  readonly __brand: "ReusableCapabilityCandidateId";
};

/**
 * V5 Workstream G (Product Lab / Reusable Capability Learning), §11 text,
 * verbatim: "Candidate lifecycle: OBSERVED_PATTERN -> CANDIDATE -> EVALUATED
 * -> APPROVED_REUSABLE -> PRODUCT/CAPABILITY_CANDIDATE -> separately
 * governed release/commercial state." This module implements exactly the
 * first four states - the fifth (PRODUCT/CAPABILITY_CANDIDATE) and beyond
 * is explicitly "separately governed release/commercial state" and is not
 * fabricated here, matching this repository's existing declared-but-not-
 * producible discipline (see `commercial-authority.ts`'s
 * `DiscountAuthorityLevel`).
 */
export type ReusableCapabilityCandidateStatus =
  | "OBSERVED_PATTERN"
  | "CANDIDATE"
  | "EVALUATED"
  | "APPROVED_REUSABLE";

/**
 * §11: "eval evidence required." An `EVALUATED` candidate carries this
 * outcome, and only `REUSABLE` can ever be promoted further - `NOT_REUSABLE`
 * is a genuine terminal negative result, not merely an unfinished
 * evaluation, matching §11's "customer-specific prompt/data cannot be
 * promoted raw" acceptance direction.
 */
export type CapabilityEvaluationOutcome = "REUSABLE" | "NOT_REUSABLE";

/**
 * One tenant/project's contribution toward proving a pattern is genuinely
 * reusable rather than a single artifact. §11: "one customer artifact or
 * one successful agent run never becomes a product by assertion" - this
 * type is what `promoteToCandidate` inspects to enforce that structurally
 * (see below): a candidate needs more than one occurrence, from more than
 * one tenant, before it may leave `OBSERVED_PATTERN`.
 */
export interface CapabilityObservationRef {
  readonly tenantScope: TenantScope;
  readonly projectRef: string;
  readonly observedAt: string;
}

/**
 * `patternRef` is an opaque pointer to whatever pattern/component/prompt
 * description this candidate represents while it is still pre-approval
 * (`OBSERVED_PATTERN`/`CANDIDATE`/`EVALUATED`) - this module never reads
 * or interprets its content, only carries it, matching every other
 * `src/domain/` module's isolation from what a ref actually points to.
 * Because `patternRef` may itself be, or point to, raw customer-specific
 * prompt/data/confidential context (this module cannot know), it is never
 * present once a candidate reaches `APPROVED_REUSABLE` - see
 * `reusableAssetRef` and `promoteToReusable` below.
 *
 * `observationRefs` is present only while a candidate carries customer/
 * tenant-specific provenance (`OBSERVED_PATTERN`/`CANDIDATE`/`EVALUATED`).
 * §11: "reusable learning must strip customer secrets/confidential
 * context." `promoteToReusable` (below) is the only function that can
 * produce `APPROVED_REUSABLE`, and it always omits `observationRefs` from
 * the object it returns - an approved-reusable candidate structurally
 * cannot carry forward which tenant/project it was originally observed in.
 *
 * `reusableAssetRef` is present only once `APPROVED_REUSABLE`. Rev90 Brain
 * correction: omitting `observationRefs` alone does not prove the reusable
 * asset itself is free of raw customer-bound content, because the prior
 * design carried `patternRef` - the same potentially-raw pointer supplied
 * at `OBSERVED_PATTERN` - straight through into the approved result.
 * `reusableAssetRef` is a distinct, separately-supplied pointer to the
 * sanitized/reusable asset (never the original `patternRef` itself -
 * `promoteToReusable` fail-closed rejects a `reusableAssetRef` identical
 * to the candidate's own `patternRef`), and `patternRef` is never included
 * on an `APPROVED_REUSABLE` object at all - the raw source pattern
 * reference cannot leak into the reusable asset the module reports.
 */
export interface ReusableCapabilityCandidate {
  readonly capabilityCandidateId: ReusableCapabilityCandidateId;
  readonly patternRef?: string;
  readonly status: ReusableCapabilityCandidateStatus;
  readonly observationRefs?: ReadonlyArray<CapabilityObservationRef>;
  readonly evalEvidenceRef?: string;
  readonly evaluationOutcome?: CapabilityEvaluationOutcome;
  readonly licenseOrIpNote?: string;
  readonly reusableAssetVersion?: string;
  readonly reusableAssetRef?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidReusableCapabilityCandidateError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(raw))) {
    throw new InvalidReusableCapabilityCandidateError(`${field} must be a valid ISO timestamp`);
  }
  return raw;
}

/**
 * A candidate always starts `OBSERVED_PATTERN` with exactly one observation
 * - this is the only construction function in this module, and it accepts
 * no `status`, `evalEvidenceRef`, `evaluationOutcome`, or promotion-related
 * field from the caller, so a candidate can never be born partway through
 * (or past) its own lifecycle.
 */
export function observeCapabilityPattern(input: {
  capabilityCandidateId: unknown;
  patternRef: unknown;
  tenantScope: TenantScope;
  projectRef: unknown;
  observedAt: unknown;
}): ReusableCapabilityCandidate {
  const capabilityCandidateId = requireNonEmptyString(
    input.capabilityCandidateId,
    "capabilityCandidateId",
  );
  const patternRef = requireNonEmptyString(input.patternRef, "patternRef");
  const projectRef = requireNonEmptyString(input.projectRef, "projectRef");
  const observedAt = requireValidTimestamp(input.observedAt, "observedAt");
  return {
    capabilityCandidateId: capabilityCandidateId as ReusableCapabilityCandidateId,
    patternRef,
    status: "OBSERVED_PATTERN",
    observationRefs: [{ tenantScope: input.tenantScope, projectRef, observedAt }],
  };
}

/**
 * Records one further independent occurrence of the same pattern. Only
 * valid while the candidate is still `OBSERVED_PATTERN` - once it has been
 * promoted to `CANDIDATE` its observation set is frozen as the evidence
 * base for that promotion, so a later observation cannot be silently
 * folded in after the fact.
 *
 * Rejects an occurrence from a `tenantScope`/`projectRef` pair the
 * candidate has already recorded (a repeat sighting in the same
 * tenant/project is not a new, independent data point toward "more than
 * one customer artifact or agent run").
 */
export function recordAdditionalObservation(input: {
  candidate: ReusableCapabilityCandidate;
  tenantScope: TenantScope;
  projectRef: unknown;
  observedAt: unknown;
}): ReusableCapabilityCandidate {
  if (input.candidate.status !== "OBSERVED_PATTERN") {
    throw new InvalidReusableCapabilityCandidateError(
      `only an OBSERVED_PATTERN candidate can record a further observation (current status: ${input.candidate.status})`,
    );
  }
  const projectRef = requireNonEmptyString(input.projectRef, "projectRef");
  const observedAt = requireValidTimestamp(input.observedAt, "observedAt");
  const existing = input.candidate.observationRefs ?? [];
  const isDuplicate = existing.some(
    (observation) =>
      observation.tenantScope.tenantId === input.tenantScope.tenantId &&
      observation.projectRef === projectRef,
  );
  if (isDuplicate) {
    throw new InvalidReusableCapabilityCandidateError(
      "this tenantScope/projectRef has already been recorded as an observation for this candidate",
    );
  }
  return {
    ...input.candidate,
    observationRefs: [...existing, { tenantScope: input.tenantScope, projectRef, observedAt }],
  };
}

/**
 * §11 acceptance: "one customer artifact or one successful agent run never
 * becomes a product by assertion." Enforced structurally, not merely
 * documented: promotion out of `OBSERVED_PATTERN` requires at least two
 * recorded observations spanning at least two distinct tenants. A pattern
 * observed only once, or observed multiple times within a single tenant,
 * is rejected outright rather than allowed to advance.
 */
export function promoteToCandidate(
  candidate: ReusableCapabilityCandidate,
): ReusableCapabilityCandidate {
  if (candidate.status !== "OBSERVED_PATTERN") {
    throw new InvalidReusableCapabilityCandidateError(
      `only an OBSERVED_PATTERN candidate can be promoted to CANDIDATE (current status: ${candidate.status})`,
    );
  }
  const observations = candidate.observationRefs ?? [];
  if (observations.length < 2) {
    throw new InvalidReusableCapabilityCandidateError(
      "at least two independent observations are required before promotion to CANDIDATE (one customer artifact or one agent run never becomes a product by assertion)",
    );
  }
  const distinctTenants = new Set(observations.map((observation) => observation.tenantScope.tenantId));
  if (distinctTenants.size < 2) {
    throw new InvalidReusableCapabilityCandidateError(
      "observations must span at least two distinct tenants before promotion to CANDIDATE (repeated observation within a single tenant is not a reusable pattern)",
    );
  }
  return { ...candidate, status: "CANDIDATE" };
}

/**
 * §11 acceptance: "eval evidence required." Only a `CANDIDATE` can be
 * evaluated, and only with a non-empty `evalEvidenceRef` - an evaluation
 * with no evidence is rejected outright. The outcome may be `REUSABLE` or
 * `NOT_REUSABLE`; this function does not judge which is correct, only that
 * an evaluation with a real evidence pointer occurred. `NOT_REUSABLE` is a
 * genuine terminal result (see `promoteToReusable` below, which is the only
 * function that inspects `evaluationOutcome`).
 */
export function evaluateCandidate(input: {
  candidate: ReusableCapabilityCandidate;
  evalEvidenceRef: unknown;
  outcome: CapabilityEvaluationOutcome;
}): ReusableCapabilityCandidate {
  if (input.candidate.status !== "CANDIDATE") {
    throw new InvalidReusableCapabilityCandidateError(
      `only a CANDIDATE can be evaluated (current status: ${input.candidate.status})`,
    );
  }
  const evalEvidenceRef = requireNonEmptyString(input.evalEvidenceRef, "evalEvidenceRef");
  if (input.outcome !== "REUSABLE" && input.outcome !== "NOT_REUSABLE") {
    throw new InvalidReusableCapabilityCandidateError(
      'outcome must be "REUSABLE" or "NOT_REUSABLE"',
    );
  }
  return {
    ...input.candidate,
    status: "EVALUATED",
    evalEvidenceRef,
    evaluationOutcome: input.outcome,
  };
}

/**
 * §11 acceptance: "customer-specific prompt/data cannot be promoted raw";
 * "IP/license constraints recorded"; "reusable asset versioned and
 * independently testable." This is the only function that can produce
 * `APPROVED_REUSABLE`, and it fail-closed rejects anything but an
 * `EVALUATED` candidate whose `evaluationOutcome` is exactly `REUSABLE` -
 * a `NOT_REUSABLE` evaluation, or a candidate that was never evaluated at
 * all, cannot be promoted regardless of caller intent. Requires a
 * non-empty `licenseOrIpNote` and `reusableAssetVersion`.
 *
 * §11: "reusable learning must strip customer secrets/confidential
 * context." The returned candidate's `observationRefs` is always
 * `undefined` - the tenant/project provenance that justified promotion is
 * not carried forward into the reusable asset itself.
 *
 * Rev90 Brain correction (F1): omitting `observationRefs` alone does not
 * prove the promoted asset is free of raw customer-specific content,
 * because the candidate's own `patternRef` may itself be (or point to) a
 * raw customer prompt/data description. This function now requires a
 * separately-supplied, non-empty `reusableAssetRef` naming the sanitized
 * reusable asset - fail-closed rejected outright if it is identical to
 * the candidate's own `patternRef` (a caller cannot simply pass the raw
 * pattern reference through under a new field name). The returned
 * `APPROVED_REUSABLE` object never includes `patternRef` at all: only
 * `reusableAssetRef` plus the non-sensitive evaluation/license/version
 * lineage (`evalEvidenceRef`, `evaluationOutcome`, `licenseOrIpNote`,
 * `reusableAssetVersion`) needed to audit where the asset came from.
 */
export function promoteToReusable(input: {
  candidate: ReusableCapabilityCandidate;
  reusableAssetRef: unknown;
  licenseOrIpNote: unknown;
  reusableAssetVersion: unknown;
}): ReusableCapabilityCandidate {
  if (input.candidate.status !== "EVALUATED") {
    throw new InvalidReusableCapabilityCandidateError(
      `only an EVALUATED candidate can be promoted to APPROVED_REUSABLE (current status: ${input.candidate.status})`,
    );
  }
  if (input.candidate.evaluationOutcome !== "REUSABLE") {
    throw new InvalidReusableCapabilityCandidateError(
      `a candidate whose evaluationOutcome is not REUSABLE cannot be promoted (current evaluationOutcome: ${input.candidate.evaluationOutcome})`,
    );
  }
  const reusableAssetRef = requireNonEmptyString(input.reusableAssetRef, "reusableAssetRef");
  if (reusableAssetRef === input.candidate.patternRef) {
    throw new InvalidReusableCapabilityCandidateError(
      "reusableAssetRef must be a distinct, sanitized asset reference - it cannot be identical to the candidate's own (potentially raw) patternRef",
    );
  }
  const licenseOrIpNote = requireNonEmptyString(input.licenseOrIpNote, "licenseOrIpNote");
  const reusableAssetVersion = requireNonEmptyString(
    input.reusableAssetVersion,
    "reusableAssetVersion",
  );
  // observationRefs and patternRef are deliberately never set here - see
  // doc comment above: an APPROVED_REUSABLE candidate structurally cannot
  // carry forward the tenant/project provenance or raw source pattern
  // reference that justified its promotion.
  return {
    capabilityCandidateId: input.candidate.capabilityCandidateId,
    status: "APPROVED_REUSABLE",
    reusableAssetRef,
    licenseOrIpNote,
    reusableAssetVersion,
    ...(input.candidate.evalEvidenceRef !== undefined
      ? { evalEvidenceRef: input.candidate.evalEvidenceRef }
      : {}),
    ...(input.candidate.evaluationOutcome !== undefined
      ? { evaluationOutcome: input.candidate.evaluationOutcome }
      : {}),
  };
}
