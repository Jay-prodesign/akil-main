import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateIdea,
  scoreIdeaValuation,
  validateIdeaValuationInput,
  IDEA_VALUATION_RUBRIC,
  InvalidIdeaValuationInputError,
  InvalidIdeaValuationAssessmentError,
  type IdeaValuationInput,
  type IdeaValuationReasoner,
  type IdeaValuationReasonerOutput,
  type IdeaValuationCriterionId,
} from "../src/domain/idea-valuation.js";

const VALID_INPUT = { ideaSummary: "A tool that helps small bakeries schedule custom cake orders." };

function fullAssessments(
  overrides: Partial<Record<IdeaValuationCriterionId, { rating?: number; rationale?: string; evidenceKind?: string }>> = {},
): IdeaValuationReasonerOutput["criterionAssessments"] {
  return IDEA_VALUATION_RUBRIC.map(({ criterionId }) => ({
    criterionId,
    rating: overrides[criterionId]?.rating ?? 60,
    rationale: overrides[criterionId]?.rationale ?? `rationale for ${criterionId}`,
    evidenceKind: (overrides[criterionId]?.evidenceKind ?? "USER_PROVIDED") as never,
  }));
}

function fakeReasoner(
  output: Partial<IdeaValuationReasonerOutput> & { callCount?: { count: number } } = {},
): IdeaValuationReasoner & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async evaluate(_input: IdeaValuationInput) {
      state.calls += 1;
      return {
        workerRef: output.workerRef ?? "worker:fake-reasoner-1",
        criterionAssessments: output.criterionAssessments ?? fullAssessments(),
      };
    },
  };
}

test("TEST 1: valid input -> exactly one reasoner invocation -> deterministic weighted report", async () => {
  const reasoner = fakeReasoner();
  const report = await evaluateIdea(reasoner, VALID_INPUT);
  assert.equal(reasoner.calls, 1);
  assert.equal(report.criterionResults.length, IDEA_VALUATION_RUBRIC.length);
  assert.equal(report.finalScore, 60);
  assert.equal(report.capabilityId, "idea-valuation");
  assert.equal(report.learningEligibility, "NONE");
  assert.equal(report.researchPolicy, "NONE");
});

test("TEST 2: rubric weights total exactly 100", () => {
  const total = IDEA_VALUATION_RUBRIC.reduce((sum, c) => sum + c.weight, 0);
  assert.equal(total, 100);
});

test("TEST 3: missing required criterion is rejected", () => {
  const assessments = fullAssessments().filter((a) => a.criterionId !== "feasibility");
  assert.throws(
    () => scoreIdeaValuation(validateIdeaValuationInput(VALID_INPUT), { workerRef: "w1", criterionAssessments: assessments }),
    InvalidIdeaValuationAssessmentError,
  );
});

test("TEST 4: duplicate criterion is rejected", () => {
  const assessments = [...fullAssessments(), { criterionId: "problemClarity", rating: 10, rationale: "dup", evidenceKind: "USER_PROVIDED" as const }];
  assert.throws(
    () => scoreIdeaValuation(validateIdeaValuationInput(VALID_INPUT), { workerRef: "w1", criterionAssessments: assessments }),
    InvalidIdeaValuationAssessmentError,
  );
});

test("TEST 5: unknown/unrecognized criterion is rejected", () => {
  const assessments = [...fullAssessments(), { criterionId: "virality", rating: 10, rationale: "n/a", evidenceKind: "USER_PROVIDED" as const }];
  assert.throws(
    () => scoreIdeaValuation(validateIdeaValuationInput(VALID_INPUT), { workerRef: "w1", criterionAssessments: assessments }),
    InvalidIdeaValuationAssessmentError,
  );
});

test("TEST 6a: out-of-range rating is rejected", () => {
  const assessments = fullAssessments({ problemClarity: { rating: 101 } });
  assert.throws(
    () => scoreIdeaValuation(validateIdeaValuationInput(VALID_INPUT), { workerRef: "w1", criterionAssessments: assessments }),
    InvalidIdeaValuationAssessmentError,
  );
});

test("TEST 6b: non-finite rating (NaN) is rejected", () => {
  const assessments = fullAssessments({ problemClarity: { rating: NaN } });
  assert.throws(
    () => scoreIdeaValuation(validateIdeaValuationInput(VALID_INPUT), { workerRef: "w1", criterionAssessments: assessments }),
    InvalidIdeaValuationAssessmentError,
  );
});

test("TEST 6c: string rating is rejected", () => {
  const assessments = IDEA_VALUATION_RUBRIC.map(({ criterionId }) => ({
    criterionId,
    rating: criterionId === "problemClarity" ? ("high" as unknown as number) : 60,
    rationale: `rationale for ${criterionId}`,
    evidenceKind: "USER_PROVIDED" as const,
  }));
  assert.throws(
    () => scoreIdeaValuation(validateIdeaValuationInput(VALID_INPUT), { workerRef: "w1", criterionAssessments: assessments }),
    InvalidIdeaValuationAssessmentError,
  );
});

test("TEST 7: empty rationale is rejected", () => {
  const assessments = fullAssessments({ differentiation: { rationale: "   " } });
  assert.throws(
    () => scoreIdeaValuation(validateIdeaValuationInput(VALID_INPUT), { workerRef: "w1", criterionAssessments: assessments }),
    InvalidIdeaValuationAssessmentError,
  );
});

test("TEST 8: RESEARCHED evidence kind is rejected (no admitted research tool in this slice)", () => {
  const assessments = fullAssessments({ monetizationClarity: { evidenceKind: "RESEARCHED" } });
  assert.throws(
    () => scoreIdeaValuation(validateIdeaValuationInput(VALID_INPUT), { workerRef: "w1", criterionAssessments: assessments }),
    InvalidIdeaValuationAssessmentError,
  );
});

test("TEST 9: unrecognized evidenceKind string is rejected", () => {
  const assessments = fullAssessments({ riskAwareness: { evidenceKind: "GUESSED" } });
  assert.throws(
    () => scoreIdeaValuation(validateIdeaValuationInput(VALID_INPUT), { workerRef: "w1", criterionAssessments: assessments }),
    InvalidIdeaValuationAssessmentError,
  );
});

test("TEST 10: final score is always recomputed by code, never accepted from the reasoner", async () => {
  // Even if a reasoner-shaped object smuggles an extra "finalScore" field,
  // the accepted type carries no such field and it is never read.
  const smuggled = {
    workerRef: "worker:smuggler",
    criterionAssessments: fullAssessments(),
    finalScore: 999,
  } as unknown as IdeaValuationReasonerOutput;
  const reasoner: IdeaValuationReasoner = { evaluate: async () => smuggled };
  const report = await evaluateIdea(reasoner, VALID_INPUT);
  assert.equal(report.finalScore, 60);
  assert.notEqual(report.finalScore, 999);
});

test("TEST 11: learningEligibility and researchPolicy are always NONE regardless of input", async () => {
  const reasoner = fakeReasoner();
  const report = await evaluateIdea(reasoner, {
    ideaSummary: "Another idea entirely.",
    targetAudience: "restaurants",
    problemStatement: "scheduling is manual",
  });
  assert.equal(report.learningEligibility, "NONE");
  assert.equal(report.researchPolicy, "NONE");
});

test("TEST 12: next-action policy is deterministic across score-band boundaries", () => {
  const bands: Array<[number, string]> = [
    [0, "WEAK_SIGNAL_RECONSIDER"],
    [39, "WEAK_SIGNAL_RECONSIDER"],
    [40, "MODERATE_SIGNAL_REFINE"],
    [69, "MODERATE_SIGNAL_REFINE"],
    [70, "STRONG_SIGNAL_CONSIDER_NEXT_STEPS"],
    [100, "STRONG_SIGNAL_CONSIDER_NEXT_STEPS"],
  ];
  for (const [rating, expected] of bands) {
    const assessments = IDEA_VALUATION_RUBRIC.map(({ criterionId }) => ({
      criterionId,
      rating,
      rationale: `rationale for ${criterionId}`,
      evidenceKind: "USER_PROVIDED" as const,
    }));
    const report = scoreIdeaValuation(validateIdeaValuationInput(VALID_INPUT), {
      workerRef: "w1",
      criterionAssessments: assessments,
    });
    assert.equal(report.finalScore, rating);
    assert.equal(report.nextActionPolicy, expected, `score ${rating} should map to ${expected}`);
  }
});

test("TEST 13: two independent evaluations never share or leak state", async () => {
  const reasonerA = fakeReasoner({ workerRef: "worker:a", criterionAssessments: fullAssessments({ problemClarity: { rating: 10 } }) });
  const reasonerB = fakeReasoner({ workerRef: "worker:b", criterionAssessments: fullAssessments({ problemClarity: { rating: 90 } }) });
  const [reportA, reportB] = await Promise.all([
    evaluateIdea(reasonerA, { ideaSummary: "Idea A" }),
    evaluateIdea(reasonerB, { ideaSummary: "Idea B" }),
  ]);
  assert.equal(reasonerA.calls, 1);
  assert.equal(reasonerB.calls, 1);
  assert.equal(reportA.workerRef, "worker:a");
  assert.equal(reportB.workerRef, "worker:b");
  assert.notEqual(reportA.finalScore, reportB.finalScore);
  assert.equal(reportA.input.ideaSummary, "Idea A");
  assert.equal(reportB.input.ideaSummary, "Idea B");
});

test("TEST 14: input is structurally anonymous (no identity/tenant/customer field exists)", async () => {
  const reasoner = fakeReasoner();
  const report = await evaluateIdea(reasoner, VALID_INPUT);
  const keys = Object.keys(report.input);
  for (const forbidden of ["tenantId", "customerId", "accountId", "userId"]) {
    assert.ok(!keys.includes(forbidden), `input must not carry ${forbidden}`);
  }
});

test("TEST 15a: missing ideaSummary is rejected", () => {
  assert.throws(() => validateIdeaValuationInput({ ideaSummary: undefined }), InvalidIdeaValuationInputError);
});

test("TEST 15b: empty/whitespace-only ideaSummary is rejected", () => {
  assert.throws(() => validateIdeaValuationInput({ ideaSummary: "   " }), InvalidIdeaValuationInputError);
});

test("TEST 15c: oversized ideaSummary is rejected", () => {
  assert.throws(
    () => validateIdeaValuationInput({ ideaSummary: "x".repeat(4001) }),
    InvalidIdeaValuationInputError,
  );
});

test("TEST 15d: present-but-invalid optional field is rejected the same way as a required one", () => {
  assert.throws(
    () => validateIdeaValuationInput({ ideaSummary: "ok", targetAudience: "   " }),
    InvalidIdeaValuationInputError,
  );
});

test("TEST 15e: absent optional fields are accepted", () => {
  const input = validateIdeaValuationInput({ ideaSummary: "A valid idea summary." });
  assert.equal(input.ideaSummary, "A valid idea summary.");
  assert.equal("targetAudience" in input, false);
  assert.equal("problemStatement" in input, false);
});
