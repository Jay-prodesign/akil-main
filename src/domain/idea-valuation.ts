export class InvalidIdeaValuationInputError extends Error {
  constructor(reason: string) {
    super(`Invalid IdeaValuationInput: ${reason}`);
    this.name = "InvalidIdeaValuationInputError";
  }
}

export class InvalidIdeaValuationAssessmentError extends Error {
  constructor(reason: string) {
    super(`Invalid IdeaValuationAssessment: ${reason}`);
    this.name = "InvalidIdeaValuationAssessmentError";
  }
}

/**
 * V5X-CAP-001 (DEC-172/AA-012) versioned capability identity. Each of
 * these signals a materially different evaluation contract to a
 * downstream consumer; none is inferred from content or from a caller -
 * all six are explicit constants for this capability's current bounded
 * slice.
 */
export const CAPABILITY_ID = "idea-valuation" as const;
export const CAPABILITY_VERSION = "v1" as const;
export const METHODOLOGY_VERSION = "v1" as const;
export const RUBRIC_VERSION = "v1" as const;
export const WORKFLOW_VERSION = "v1" as const;
export const PROMPT_VERSION = "v1" as const;

const MAX_FIELD_LENGTH = 4000;

/**
 * Anonymous-first minimal input (DEC-172/REQ-AI-013/014): structurally
 * carries no identity, account, tenant or customer field - there is no
 * way to supply one, so this capability cannot be made to depend on
 * caller identity by accident.
 */
export interface IdeaValuationInput {
  readonly ideaSummary: string;
  readonly targetAudience?: string;
  readonly problemStatement?: string;
}

function requireBoundedString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidIdeaValuationInputError(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new InvalidIdeaValuationInputError(`${field} must not be empty or whitespace-only`);
  }
  if (value.length > MAX_FIELD_LENGTH) {
    throw new InvalidIdeaValuationInputError(`${field} must not exceed ${MAX_FIELD_LENGTH} characters`);
  }
  return value;
}

function requireOptionalBoundedString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireBoundedString(value, field);
}

/**
 * Fails closed on a missing/empty/whitespace-only/oversized `ideaSummary`,
 * and on any *present* optional field that fails the same bar - an
 * optional field is validated exactly like a required one whenever a
 * caller actually supplies it.
 */
export function validateIdeaValuationInput(input: {
  readonly ideaSummary: unknown;
  readonly targetAudience?: unknown;
  readonly problemStatement?: unknown;
}): IdeaValuationInput {
  const ideaSummary = requireBoundedString(input.ideaSummary, "ideaSummary");
  const targetAudience = requireOptionalBoundedString(input.targetAudience, "targetAudience");
  const problemStatement = requireOptionalBoundedString(input.problemStatement, "problemStatement");
  return {
    ideaSummary,
    ...(targetAudience !== undefined ? { targetAudience } : {}),
    ...(problemStatement !== undefined ? { problemStatement } : {}),
  };
}

export type IdeaValuationCriterionId =
  | "problemClarity"
  | "audienceSpecificity"
  | "differentiation"
  | "feasibility"
  | "monetizationClarity"
  | "riskAwareness";

/**
 * Fixed rubric for RUBRIC_VERSION "v1". Weights must total exactly 100 -
 * enforced immediately below at module load, not merely by convention, so
 * a future edit that desyncs the weights fails closed at import time
 * rather than silently shipping a miscalibrated score.
 */
export const IDEA_VALUATION_RUBRIC: ReadonlyArray<{
  readonly criterionId: IdeaValuationCriterionId;
  readonly weight: number;
}> = [
  { criterionId: "problemClarity", weight: 20 },
  { criterionId: "audienceSpecificity", weight: 15 },
  { criterionId: "differentiation", weight: 15 },
  { criterionId: "feasibility", weight: 20 },
  { criterionId: "monetizationClarity", weight: 15 },
  { criterionId: "riskAwareness", weight: 15 },
];

const RUBRIC_WEIGHT_TOTAL = IDEA_VALUATION_RUBRIC.reduce((sum, criterion) => sum + criterion.weight, 0);
if (RUBRIC_WEIGHT_TOTAL !== 100) {
  throw new Error(`IDEA_VALUATION_RUBRIC weights must total 100, got ${RUBRIC_WEIGHT_TOTAL}`);
}

/**
 * DEC-153 "no invented business rule": this bounded slice admits no
 * research tool, so a criterion assessment can never truthfully claim
 * RESEARCHED evidence yet. The full vocabulary is declared for forward
 * compatibility (mirrors `Customer.LearningEligibility`'s pattern in
 * src/domain/customer.ts), but only USER_PROVIDED/INFERENCE/UNKNOWN are
 * reachable through validation until a real research tool is admitted
 * and wired through a distinct, explicitly proven port.
 */
export type IdeaValuationEvidenceKind = "USER_PROVIDED" | "INFERENCE" | "RESEARCHED" | "UNKNOWN";

const REACHABLE_EVIDENCE_KINDS: ReadonlySet<string> = new Set(["USER_PROVIDED", "INFERENCE", "UNKNOWN"]);

/**
 * Provider-neutral reasoner boundary (mirrors `WorkerInvoker` in
 * src/domain/worker-invoker.ts): `workerRef` is an opaque pointer, never a
 * hard-coded vendor/model name, and no real provider SDK integration
 * exists behind this interface in this bounded slice.
 */
export interface IdeaValuationReasonerCriterionAssessment {
  readonly criterionId: string;
  readonly rating: number;
  readonly rationale: string;
  readonly evidenceKind: IdeaValuationEvidenceKind;
}

export interface IdeaValuationReasonerOutput {
  readonly workerRef: string;
  readonly criterionAssessments: ReadonlyArray<IdeaValuationReasonerCriterionAssessment>;
}

export interface IdeaValuationReasoner {
  evaluate(input: IdeaValuationInput): Promise<IdeaValuationReasonerOutput>;
}

export interface IdeaValuationCriterionResult {
  readonly criterionId: IdeaValuationCriterionId;
  readonly weight: number;
  readonly rating: number;
  readonly weightedContribution: number;
  readonly rationale: string;
  readonly evidenceKind: IdeaValuationEvidenceKind;
}

export type IdeaValuationNextActionPolicy =
  | "STRONG_SIGNAL_CONSIDER_NEXT_STEPS"
  | "MODERATE_SIGNAL_REFINE"
  | "WEAK_SIGNAL_RECONSIDER";

export interface IdeaValuationReport {
  readonly capabilityId: typeof CAPABILITY_ID;
  readonly capabilityVersion: typeof CAPABILITY_VERSION;
  readonly methodologyVersion: typeof METHODOLOGY_VERSION;
  readonly rubricVersion: typeof RUBRIC_VERSION;
  readonly workflowVersion: typeof WORKFLOW_VERSION;
  readonly promptVersion: typeof PROMPT_VERSION;
  readonly workerRef: string;
  readonly input: IdeaValuationInput;
  readonly criterionResults: ReadonlyArray<IdeaValuationCriterionResult>;
  readonly finalScore: number;
  readonly nextActionPolicy: IdeaValuationNextActionPolicy;
  /**
   * EI-7: fixed to "NONE" - there is no constructor input path to set
   * this to anything else, exactly like `Customer.learningEligibility` in
   * src/domain/customer.ts. Execution/customer data never self-promotes
   * to global learning/training truth through this module.
   */
  readonly learningEligibility: "NONE";
  /** No research tool is admitted in this slice; always "NONE". */
  readonly researchPolicy: "NONE";
}

function requireFiniteRating(value: unknown, criterionId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidIdeaValuationAssessmentError(`rating for ${criterionId} must be a finite number`);
  }
  if (value < 0 || value > 100) {
    throw new InvalidIdeaValuationAssessmentError(`rating for ${criterionId} must be between 0 and 100`);
  }
  return value;
}

function requireNonEmptyRationale(value: unknown, criterionId: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidIdeaValuationAssessmentError(`rationale for ${criterionId} must be a non-empty string`);
  }
  return value;
}

function requireReachableEvidenceKind(value: unknown, criterionId: string): IdeaValuationEvidenceKind {
  if (typeof value !== "string" || !REACHABLE_EVIDENCE_KINDS.has(value)) {
    throw new InvalidIdeaValuationAssessmentError(
      `evidenceKind for ${criterionId} must be one of USER_PROVIDED, INFERENCE, or UNKNOWN in this bounded slice ` +
        `(RESEARCHED requires an admitted research tool, not yet wired)`,
    );
  }
  return value as IdeaValuationEvidenceKind;
}

function resolveNextActionPolicy(finalScore: number): IdeaValuationNextActionPolicy {
  if (finalScore >= 70) {
    return "STRONG_SIGNAL_CONSIDER_NEXT_STEPS";
  }
  if (finalScore >= 40) {
    return "MODERATE_SIGNAL_REFINE";
  }
  return "WEAK_SIGNAL_RECONSIDER";
}

/**
 * Fail-closed, deterministic scoring. Rejects a missing, duplicate, or
 * unrecognized criterion; rejects an out-of-range/non-finite rating; an
 * empty/non-string rationale; and any evidenceKind this slice cannot back.
 * The final weighted score is always computed here, in code - the
 * accepted reasoner-output shape carries no score/result field at all,
 * so there is nothing for a reasoner to supply or override.
 */
export function scoreIdeaValuation(
  input: IdeaValuationInput,
  reasonerOutput: {
    readonly workerRef: unknown;
    readonly criterionAssessments: ReadonlyArray<{
      readonly criterionId: unknown;
      readonly rating: unknown;
      readonly rationale: unknown;
      readonly evidenceKind: unknown;
    }>;
  },
): IdeaValuationReport {
  const workerRef = requireBoundedString(reasonerOutput.workerRef, "workerRef");

  if (!Array.isArray(reasonerOutput.criterionAssessments)) {
    throw new InvalidIdeaValuationAssessmentError("criterionAssessments must be an array");
  }

  const byId = new Map<string, (typeof reasonerOutput.criterionAssessments)[number]>();
  for (const assessment of reasonerOutput.criterionAssessments) {
    const criterionId =
      typeof assessment.criterionId === "string" && assessment.criterionId.trim().length > 0
        ? assessment.criterionId
        : undefined;
    if (criterionId === undefined) {
      throw new InvalidIdeaValuationAssessmentError(
        "every criterionAssessment must carry a non-empty criterionId",
      );
    }
    if (byId.has(criterionId)) {
      throw new InvalidIdeaValuationAssessmentError(`duplicate criterionAssessment for ${criterionId}`);
    }
    byId.set(criterionId, assessment);
  }

  const criterionResults: IdeaValuationCriterionResult[] = [];
  let weightedSum = 0;
  for (const { criterionId, weight } of IDEA_VALUATION_RUBRIC) {
    const assessment = byId.get(criterionId);
    if (assessment === undefined) {
      throw new InvalidIdeaValuationAssessmentError(
        `missing criterionAssessment for required criterion ${criterionId}`,
      );
    }
    byId.delete(criterionId);

    const rating = requireFiniteRating(assessment.rating, criterionId);
    const rationale = requireNonEmptyRationale(assessment.rationale, criterionId);
    const evidenceKind = requireReachableEvidenceKind(assessment.evidenceKind, criterionId);
    const weightedContribution = (rating * weight) / 100;
    weightedSum += weightedContribution;

    criterionResults.push({ criterionId, weight, rating, weightedContribution, rationale, evidenceKind });
  }

  if (byId.size > 0) {
    throw new InvalidIdeaValuationAssessmentError(
      `unknown criterionAssessment(s) not in the rubric: ${Array.from(byId.keys()).join(", ")}`,
    );
  }

  const finalScore = Math.round(weightedSum);

  return {
    capabilityId: CAPABILITY_ID,
    capabilityVersion: CAPABILITY_VERSION,
    methodologyVersion: METHODOLOGY_VERSION,
    rubricVersion: RUBRIC_VERSION,
    workflowVersion: WORKFLOW_VERSION,
    promptVersion: PROMPT_VERSION,
    workerRef,
    input,
    criterionResults,
    finalScore,
    nextActionPolicy: resolveNextActionPolicy(finalScore),
    learningEligibility: "NONE",
    researchPolicy: "NONE",
  };
}

/**
 * Validates the raw input, then invokes the supplied reasoner exactly
 * once, then deterministically scores its output. Never retries
 * internally - a caller-driven retry after a reasoner failure is a
 * caller decision, matching `invokeSafely`'s explicit-outcome pattern in
 * src/domain/worker-invoker.ts rather than hiding a second call here.
 */
export async function evaluateIdea(
  reasoner: IdeaValuationReasoner,
  rawInput: {
    readonly ideaSummary: unknown;
    readonly targetAudience?: unknown;
    readonly problemStatement?: unknown;
  },
): Promise<IdeaValuationReport> {
  const input = validateIdeaValuationInput(rawInput);
  const reasonerOutput = await reasoner.evaluate(input);
  return scoreIdeaValuation(input, reasonerOutput);
}
