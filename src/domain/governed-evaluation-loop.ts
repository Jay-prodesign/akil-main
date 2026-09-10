export class InvalidGovernedChangeProposalError extends Error {
  constructor(reason: string) {
    super(`Invalid GovernedChangeProposal: ${reason}`);
    this.name = "InvalidGovernedChangeProposalError";
  }
}

type GovernedChangeProposalId = string & { readonly __brand: "GovernedChangeProposalId" };

/**
 * V5 Workstream I (Governed Evaluation / Improvement Loop), §13 text,
 * verbatim loop: "collect governed evidence -> evaluate against versioned
 * metrics -> diagnose -> propose change -> classify impact/authority ->
 * test in bounded environment -> independent review where material ->
 * adopt/reject -> monitor." The first three steps (collect/evaluate/
 * diagnose) are inputs a caller performs before ever constructing a
 * proposal - `evalEvidenceRef`/`evalVersionRef` on `proposeChange` are
 * where that evidence enters this module. `MONITOR` (the final loop step)
 * is deliberately not modeled as a status: monitoring a live, already-
 * adopted change is a distinct, ongoing external activity, not a further
 * proposal-lifecycle transition, and this module does not fabricate a
 * monitoring/telemetry system that does not exist anywhere in this
 * repository.
 */
export type GovernedChangeProposalStatus =
  | "PROPOSED"
  | "CLASSIFIED"
  | "TESTED"
  | "REVIEWED"
  | "ADOPTED"
  | "REJECTED";

/**
 * §13 rule: "change to protected policy/scope requires proper decision
 * authority." `MATERIAL` is this module's structural trigger for that rule
 * - see `reviewProposal`/`adoptChange` below, which both key off this
 * field rather than leaving "material" as an undefined judgment call.
 */
export type ChangeImpactClassification = "SAFE" | "MATERIAL";

/**
 * `changeRef` is an opaque pointer to whatever routing policy, prompt,
 * execution pattern or reusable contract is being proposed for change -
 * this module never reads or interprets it, only carries and compares it
 * for identity, matching every other `src/domain/` module's isolation
 * from what a ref actually points to.
 *
 * `evalEvidenceRef`/`evalVersionRef` are required at construction and
 * carried immutably through every transition - §13 acceptance: "eval
 * version and sample provenance retained." `regressionOnCriticalBoundary`/
 * `safetyRegression` are recorded, never silently dropped, by
 * `recordBoundedEnvironmentTest` - §13 acceptance: "regression on critical
 * boundary blocks affected adoption" / "cost wins cannot override safety"
 * (there is no cost field on this type at all - a cost improvement
 * structurally cannot be weighed against these two flags because nothing
 * here ever reads a cost value when deciding adoption).
 */
export interface GovernedChangeProposal {
  readonly proposalId: GovernedChangeProposalId;
  readonly changeRef: string;
  readonly proposedByWorkerId: string;
  readonly evalEvidenceRef: string;
  readonly evalVersionRef: string;
  readonly status: GovernedChangeProposalStatus;
  readonly impactClassification?: ChangeImpactClassification;
  readonly regressionOnCriticalBoundary?: boolean;
  readonly safetyRegression?: boolean;
  readonly reviewedByWorkerId?: string;
  readonly rollbackPlanRef?: string;
  readonly rejectionReason?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidGovernedChangeProposalError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * A proposal always starts `PROPOSED` - this is the only construction
 * function in this module, and it accepts no `status`, classification,
 * test, review, or adoption-related field from the caller, so a proposal
 * can never be born partway through (or past) its own lifecycle. §13
 * acceptance "benchmark/eval score does not equal production readiness"
 * begins here: `evalEvidenceRef`/`evalVersionRef` alone construct only a
 * `PROPOSED` record, nothing closer to adoption.
 */
export function proposeChange(input: {
  proposalId: unknown;
  changeRef: unknown;
  proposedByWorkerId: unknown;
  evalEvidenceRef: unknown;
  evalVersionRef: unknown;
}): GovernedChangeProposal {
  return {
    proposalId: requireNonEmptyString(input.proposalId, "proposalId") as GovernedChangeProposalId,
    changeRef: requireNonEmptyString(input.changeRef, "changeRef"),
    proposedByWorkerId: requireNonEmptyString(input.proposedByWorkerId, "proposedByWorkerId"),
    evalEvidenceRef: requireNonEmptyString(input.evalEvidenceRef, "evalEvidenceRef"),
    evalVersionRef: requireNonEmptyString(input.evalVersionRef, "evalVersionRef"),
    status: "PROPOSED",
  };
}

/**
 * §13 loop step "classify impact/authority." Only a `PROPOSED` proposal
 * can be classified; re-classifying an already-classified/tested/
 * reviewed/decided proposal is rejected (classification is a one-time
 * judgment, not something that can be silently redone to route around an
 * earlier `MATERIAL` finding).
 */
export function classifyChangeImpact(input: {
  proposal: GovernedChangeProposal;
  impactClassification: ChangeImpactClassification;
}): GovernedChangeProposal {
  if (input.proposal.status !== "PROPOSED") {
    throw new InvalidGovernedChangeProposalError(
      `only a PROPOSED proposal can be classified (current status: ${input.proposal.status})`,
    );
  }
  if (input.impactClassification !== "SAFE" && input.impactClassification !== "MATERIAL") {
    throw new InvalidGovernedChangeProposalError(
      'impactClassification must be "SAFE" or "MATERIAL"',
    );
  }
  return { ...input.proposal, status: "CLASSIFIED", impactClassification: input.impactClassification };
}

/**
 * §13 loop step "test in bounded environment." Only a `CLASSIFIED`
 * proposal can be tested. Both outcome flags are required explicitly (no
 * default) - a test that does not report on both critical-boundary
 * regression and safety regression is not a complete bounded-environment
 * test result. This function itself never throws on a positive
 * (regression-found) result: recording a true regression is a valid,
 * important test outcome, not an invalid input. `adoptChange` (below) is
 * the fail-closed gate that acts on these flags.
 */
export function recordBoundedEnvironmentTest(input: {
  proposal: GovernedChangeProposal;
  regressionOnCriticalBoundary: boolean;
  safetyRegression: boolean;
}): GovernedChangeProposal {
  if (input.proposal.status !== "CLASSIFIED") {
    throw new InvalidGovernedChangeProposalError(
      `only a CLASSIFIED proposal can be tested (current status: ${input.proposal.status})`,
    );
  }
  if (typeof input.regressionOnCriticalBoundary !== "boolean") {
    throw new InvalidGovernedChangeProposalError("regressionOnCriticalBoundary must be a boolean");
  }
  if (typeof input.safetyRegression !== "boolean") {
    throw new InvalidGovernedChangeProposalError("safetyRegression must be a boolean");
  }
  return {
    ...input.proposal,
    status: "TESTED",
    regressionOnCriticalBoundary: input.regressionOnCriticalBoundary,
    safetyRegression: input.safetyRegression,
  };
}

/**
 * §13 loop step "independent review where material," directly reusing this
 * repository's existing self-certification-prevention pattern (see
 * `admitPartnerCapabilityClaim`, V5 Workstream H): `reviewedByWorkerId`
 * must be non-empty and independent of the proposal's own
 * `proposedByWorkerId` - fail-closed rejected outright when they are
 * equal, regardless of how thorough the "review" claims to be. Only a
 * `TESTED` proposal can be reviewed.
 */
export function reviewProposal(input: {
  proposal: GovernedChangeProposal;
  reviewedByWorkerId: unknown;
}): GovernedChangeProposal {
  if (input.proposal.status !== "TESTED") {
    throw new InvalidGovernedChangeProposalError(
      `only a TESTED proposal can be reviewed (current status: ${input.proposal.status})`,
    );
  }
  const reviewedByWorkerId = requireNonEmptyString(input.reviewedByWorkerId, "reviewedByWorkerId");
  if (reviewedByWorkerId === input.proposal.proposedByWorkerId) {
    throw new InvalidGovernedChangeProposalError(
      "reviewedByWorkerId must be independent of the proposal's own proposedByWorkerId (self-review is not permitted)",
    );
  }
  return { ...input.proposal, status: "REVIEWED", reviewedByWorkerId };
}

/**
 * §13 acceptance, all four enforced structurally:
 * - "regression on critical boundary blocks affected adoption" - fail-
 *   closed rejected whenever `regressionOnCriticalBoundary` is `true`,
 *   unconditionally.
 * - "cost wins cannot override safety" - fail-closed rejected whenever
 *   `safetyRegression` is `true`; there is no cost field anywhere on this
 *   type capable of overriding that rejection.
 * - "benchmark/eval score does not equal production readiness" - only a
 *   `TESTED` (for `SAFE`) or `REVIEWED` (for `MATERIAL`) proposal may be
 *   adopted; a `MATERIAL` proposal that has not been independently
 *   reviewed is rejected outright, regardless of its test result.
 * - "rollback path exists for material routing/prompt/process change" - a
 *   `MATERIAL` proposal requires a non-empty `rollbackPlanRef`; a `SAFE`
 *   proposal does not require one.
 */
export function adoptChange(input: {
  proposal: GovernedChangeProposal;
  rollbackPlanRef?: unknown;
}): GovernedChangeProposal {
  const proposal = input.proposal;
  if (proposal.regressionOnCriticalBoundary === true) {
    throw new InvalidGovernedChangeProposalError(
      "a proposal with a critical-boundary regression cannot be adopted",
    );
  }
  if (proposal.safetyRegression === true) {
    throw new InvalidGovernedChangeProposalError(
      "a proposal with a safety regression cannot be adopted, regardless of any other tradeoff",
    );
  }
  if (proposal.impactClassification === "MATERIAL") {
    if (proposal.status !== "REVIEWED") {
      throw new InvalidGovernedChangeProposalError(
        `a MATERIAL proposal requires independent review before adoption (current status: ${proposal.status})`,
      );
    }
    const rollbackPlanRef = requireNonEmptyString(input.rollbackPlanRef, "rollbackPlanRef");
    return { ...proposal, status: "ADOPTED", rollbackPlanRef };
  }
  if (proposal.status !== "TESTED" && proposal.status !== "REVIEWED") {
    throw new InvalidGovernedChangeProposalError(
      `a proposal must be TESTED (or REVIEWED) before adoption (current status: ${proposal.status})`,
    );
  }
  return { ...proposal, status: "ADOPTED" };
}

/**
 * A proposal may be rejected from any non-terminal status, including
 * `PROPOSED` (an idea can be rejected outright without ever being
 * classified/tested). `ADOPTED`/`REJECTED` are both terminal - rejecting
 * an already-decided proposal is refused rather than silently overwriting
 * its disposition.
 */
export function rejectChange(input: {
  proposal: GovernedChangeProposal;
  rejectionReason: unknown;
}): GovernedChangeProposal {
  if (input.proposal.status === "ADOPTED" || input.proposal.status === "REJECTED") {
    throw new InvalidGovernedChangeProposalError(
      `a proposal that is already ${input.proposal.status} cannot be rejected`,
    );
  }
  const rejectionReason = requireNonEmptyString(input.rejectionReason, "rejectionReason");
  return { ...input.proposal, status: "REJECTED", rejectionReason };
}
