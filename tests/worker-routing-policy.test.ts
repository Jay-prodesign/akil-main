import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveWorkerRoute,
  InvalidWorkerRoutingRequestError,
  type AdmittedWorker,
  type WorkerRoutingRequest,
} from "../src/domain/worker-routing-policy.js";

const requiredCapabilityRef = "cap:engineering.typescript";

function worker(overrides: Partial<AdmittedWorker> & { workerId: string }): AdmittedWorker {
  return {
    declaredCapabilityRefs: [requiredCapabilityRef],
    declaredToolRefs: ["tool:repo-write"],
    declaredPolicyConstraintRefs: ["policy:privacy-tier-1"],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: `evidence:${overrides.workerId}`,
    ...overrides,
  };
}

function request(
  overrides: Partial<WorkerRoutingRequest> & {
    executorCandidates: ReadonlyArray<AdmittedWorker>;
  },
): WorkerRoutingRequest {
  return {
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiredToolRefs: ["tool:repo-write"],
    requiredPolicyConstraintRefs: ["policy:privacy-tier-1"],
    requiredAuthorityLevel: "STANDARD",
    requiresIndependentReview: false,
    ...overrides,
  };
}

test("A1: an ADMITTED, AVAILABLE, capable worker is routed as executor for STANDARD risk with no review required", () => {
  const w = worker({ workerId: "claude" });
  const decision = resolveWorkerRoute(request({ executorCandidates: [w] }));
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "claude");
  assert.equal(decision.reviewerWorkerId, undefined);
  assert.match(decision.reason, /claude/);
});

test("A2: an UNTRUSTED worker cannot be selected as executor even if it is the only candidate", () => {
  const w = worker({ workerId: "unknown-provider", trustStatus: "UNTRUSTED" });
  const decision = resolveWorkerRoute(request({ executorCandidates: [w] }));
  assert.equal(decision.status, "REJECTED");
  assert.match(decision.reason, /no admitted, available worker/);
});

test("A3: a REVOKED worker cannot be selected as executor", () => {
  const w = worker({ workerId: "revoked-worker", trustStatus: "REVOKED" });
  const decision = resolveWorkerRoute(request({ executorCandidates: [w] }));
  assert.equal(decision.status, "REJECTED");
});

test("A4: an UNAVAILABLE worker cannot be selected as executor (provider outage)", () => {
  const w = worker({ workerId: "down-worker", availability: "UNAVAILABLE" });
  const decision = resolveWorkerRoute(request({ executorCandidates: [w] }));
  assert.equal(decision.status, "REJECTED");
});

test("A5: a DEGRADED worker cannot be selected as executor", () => {
  const w = worker({ workerId: "degraded-worker", availability: "DEGRADED" });
  const decision = resolveWorkerRoute(request({ executorCandidates: [w] }));
  assert.equal(decision.status, "REJECTED");
});

test("A6: provider outage degrades gracefully to a fallback candidate that still meets full policy, never a reduced one", () => {
  const primary = worker({ workerId: "primary", availability: "UNAVAILABLE" });
  const fallback = worker({ workerId: "fallback" });
  const decision = resolveWorkerRoute(request({ executorCandidates: [primary, fallback] }));
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "fallback");
});

test("A7: a cheaper but ineligible worker earlier in the list is never selected over an eligible one later in it (cost cannot bypass policy)", () => {
  const cheapButUntrusted = worker({ workerId: "cheap-untrusted", trustStatus: "UNTRUSTED", costWeight: 0 });
  const eligibleButPricier = worker({ workerId: "eligible-pricier", costWeight: 10 });
  const decision = resolveWorkerRoute(
    request({ executorCandidates: [cheapButUntrusted, eligibleButPricier] }),
  );
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "eligible-pricier");
});

test("A8: a worker lacking the required capability is never selected", () => {
  const w = worker({ workerId: "no-cap", declaredCapabilityRefs: ["cap:something.else"] });
  const decision = resolveWorkerRoute(request({ executorCandidates: [w] }));
  assert.equal(decision.status, "REJECTED");
});

test("A9: a worker with no evaluationEvidenceRef cannot be selected, even if otherwise eligible", () => {
  const w = worker({ workerId: "no-evidence", evaluationEvidenceRef: "" });
  const decision = resolveWorkerRoute(request({ executorCandidates: [w] }));
  assert.equal(decision.status, "REJECTED");
});

test("A10: a STANDARD-only worker cannot be selected as executor for HIGH_RISK work", () => {
  const w = worker({ workerId: "standard-only", maxRiskLevel: "STANDARD" });
  const reviewer = worker({ workerId: "reviewer", maxRiskLevel: "HIGH_RISK" });
  const decision = resolveWorkerRoute(
    request({ riskLevel: "HIGH_RISK", executorCandidates: [w], reviewerCandidates: [reviewer] }),
  );
  assert.equal(decision.status, "REJECTED");
});

test("A11: HIGH_RISK work with an eligible high-risk-authorized executor and reviewer routes both", () => {
  const executor = worker({ workerId: "executor", maxRiskLevel: "HIGH_RISK" });
  const reviewer = worker({ workerId: "reviewer", maxRiskLevel: "HIGH_RISK" });
  const decision = resolveWorkerRoute(
    request({ riskLevel: "HIGH_RISK", executorCandidates: [executor], reviewerCandidates: [reviewer] }),
  );
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "executor");
  assert.equal(decision.reviewerWorkerId, "reviewer");
});

test("A12: reviewer independence - the same worker cannot be both executor and reviewer", () => {
  const solo = worker({ workerId: "solo", maxRiskLevel: "HIGH_RISK" });
  const decision = resolveWorkerRoute(
    request({ riskLevel: "HIGH_RISK", executorCandidates: [solo], reviewerCandidates: [solo] }),
  );
  assert.equal(decision.status, "REJECTED");
  assert.match(decision.reason, /cannot review its own work/);
});

test("A13: requiresIndependentReview also enforces reviewer independence at STANDARD risk", () => {
  const solo = worker({ workerId: "solo" });
  const decision = resolveWorkerRoute(
    request({ requiresIndependentReview: true, executorCandidates: [solo], reviewerCandidates: [solo] }),
  );
  assert.equal(decision.status, "REJECTED");
});

test("A14: requiresIndependentReview with a second eligible worker as reviewer routes successfully", () => {
  const executor = worker({ workerId: "executor" });
  const reviewer = worker({ workerId: "reviewer" });
  const decision = resolveWorkerRoute(
    request({
      requiresIndependentReview: true,
      executorCandidates: [executor],
      reviewerCandidates: [executor, reviewer],
    }),
  );
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "executor");
  assert.equal(decision.reviewerWorkerId, "reviewer");
});

test("A15: an ineligible reviewer candidate (untrusted) is skipped in favor of a later eligible, independent one", () => {
  const executor = worker({ workerId: "executor" });
  const untrustedReviewer = worker({ workerId: "untrusted-reviewer", trustStatus: "UNTRUSTED" });
  const goodReviewer = worker({ workerId: "good-reviewer" });
  const decision = resolveWorkerRoute(
    request({
      requiresIndependentReview: true,
      executorCandidates: [executor],
      reviewerCandidates: [untrustedReviewer, goodReviewer],
    }),
  );
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.reviewerWorkerId, "good-reviewer");
});

test("A16: no eligible executor at all rejects gracefully with a reason, not a thrown error", () => {
  const w1 = worker({ workerId: "w1", availability: "UNAVAILABLE" });
  const w2 = worker({ workerId: "w2", trustStatus: "REVOKED" });
  const decision = resolveWorkerRoute(request({ executorCandidates: [w1, w2] }));
  assert.equal(decision.status, "REJECTED");
  assert.equal(typeof decision.reason, "string");
  assert.ok(decision.reason.length > 0);
});

test("A17: an empty requiredCapabilityRef fails closed with a thrown error", () => {
  assert.throws(() => {
    resolveWorkerRoute(request({ requiredCapabilityRef: "", executorCandidates: [] }));
  }, InvalidWorkerRoutingRequestError);
});

test("A18: an invalid riskLevel fails closed with a thrown error", () => {
  assert.throws(() => {
    resolveWorkerRoute(
      request({
        // @ts-expect-error deliberately invalid for the test
        riskLevel: "MEDIUM",
        executorCandidates: [],
      }),
    );
  }, InvalidWorkerRoutingRequestError);
});

test("A19: HIGH_RISK work with no reviewerCandidates supplied at all fails closed with a thrown error", () => {
  assert.throws(() => {
    resolveWorkerRoute(
      request({
        riskLevel: "HIGH_RISK",
        executorCandidates: [worker({ workerId: "solo", maxRiskLevel: "HIGH_RISK" })],
      }),
    );
  }, InvalidWorkerRoutingRequestError);
});

test("A20: requiresIndependentReview with no reviewerCandidates supplied at all fails closed with a thrown error", () => {
  assert.throws(() => {
    resolveWorkerRoute(
      request({
        requiresIndependentReview: true,
        executorCandidates: [worker({ workerId: "solo" })],
      }),
    );
  }, InvalidWorkerRoutingRequestError);
});

test("A21: an empty candidate list rejects gracefully rather than throwing", () => {
  const decision = resolveWorkerRoute(request({ executorCandidates: [] }));
  assert.equal(decision.status, "REJECTED");
});

test("A22: the returned decision always carries a non-empty reason for both ROUTED and REJECTED outcomes", () => {
  const routed = resolveWorkerRoute(request({ executorCandidates: [worker({ workerId: "w" })] }));
  const rejected = resolveWorkerRoute(request({ executorCandidates: [] }));
  assert.ok(routed.reason.length > 0);
  assert.ok(rejected.reason.length > 0);
});

// --- Rev52 F1: required tool access / policy constraints / authority level ---

test("A23 (Rev52 F1): a worker missing a required tool ref cannot be selected, even if otherwise eligible", () => {
  const w = worker({ workerId: "no-tool", declaredToolRefs: [] });
  const decision = resolveWorkerRoute(
    request({ requiredToolRefs: ["tool:repo-write"], executorCandidates: [w] }),
  );
  assert.equal(decision.status, "REJECTED");
});

test("A24 (Rev52 F1): a worker declaring only some of several required tools cannot be selected", () => {
  const w = worker({ workerId: "partial-tools", declaredToolRefs: ["tool:repo-write"] });
  const decision = resolveWorkerRoute(
    request({
      requiredToolRefs: ["tool:repo-write", "tool:deploy-console"],
      executorCandidates: [w],
    }),
  );
  assert.equal(decision.status, "REJECTED");
});

test("A25 (Rev52 F1): a worker declaring every required tool is selected", () => {
  const w = worker({
    workerId: "full-tools",
    declaredToolRefs: ["tool:repo-write", "tool:deploy-console"],
  });
  const decision = resolveWorkerRoute(
    request({
      requiredToolRefs: ["tool:repo-write", "tool:deploy-console"],
      executorCandidates: [w],
    }),
  );
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "full-tools");
});

test("A26 (Rev52 F1): a worker missing a required policy/privacy-security constraint cannot be selected", () => {
  const w = worker({ workerId: "no-policy", declaredPolicyConstraintRefs: [] });
  const decision = resolveWorkerRoute(
    request({ requiredPolicyConstraintRefs: ["policy:privacy-tier-1"], executorCandidates: [w] }),
  );
  assert.equal(decision.status, "REJECTED");
});

test("A27 (Rev52 F1): a worker with insufficient authorityLevel (STANDARD) cannot be selected for an ELEVATED-authority route", () => {
  const w = worker({ workerId: "standard-authority", authorityLevel: "STANDARD" });
  const decision = resolveWorkerRoute(
    request({ requiredAuthorityLevel: "ELEVATED", executorCandidates: [w] }),
  );
  assert.equal(decision.status, "REJECTED");
});

test("A28 (Rev52 F1): a worker with ELEVATED authorityLevel satisfies an ELEVATED-authority route", () => {
  const w = worker({ workerId: "elevated-authority", authorityLevel: "ELEVATED" });
  const decision = resolveWorkerRoute(
    request({ requiredAuthorityLevel: "ELEVATED", executorCandidates: [w] }),
  );
  assert.equal(decision.status, "ROUTED");
});

test("A29 (Rev52 F1): an ELEVATED-authority worker still satisfies a STANDARD-authority route", () => {
  const w = worker({ workerId: "elevated-authority", authorityLevel: "ELEVATED" });
  const decision = resolveWorkerRoute(
    request({ requiredAuthorityLevel: "STANDARD", executorCandidates: [w] }),
  );
  assert.equal(decision.status, "ROUTED");
});

test("A30 (Rev52 F1): fallback cannot weaken required tool/policy/authority constraints - a fallback missing a required tool is skipped, not selected", () => {
  const primaryDown = worker({ workerId: "primary-down", availability: "UNAVAILABLE" });
  const fallbackMissingTool = worker({ workerId: "fallback-missing-tool", declaredToolRefs: [] });
  const fallbackFullyEligible = worker({ workerId: "fallback-eligible" });
  const decision = resolveWorkerRoute(
    request({
      requiredToolRefs: ["tool:repo-write"],
      executorCandidates: [primaryDown, fallbackMissingTool, fallbackFullyEligible],
    }),
  );
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "fallback-eligible");
});

test("A31 (Rev52 F1): an invalid requiredAuthorityLevel fails closed with a thrown error", () => {
  assert.throws(() => {
    resolveWorkerRoute(
      request({
        // @ts-expect-error deliberately invalid for the test
        requiredAuthorityLevel: "SUPREME",
        executorCandidates: [],
      }),
    );
  }, InvalidWorkerRoutingRequestError);
});

test("A32 (Rev52 F1): reviewer selection also enforces required tool/policy/authority constraints, not just executor selection", () => {
  const executor = worker({ workerId: "executor" });
  const weakReviewer = worker({ workerId: "weak-reviewer", declaredPolicyConstraintRefs: [] });
  const decision = resolveWorkerRoute(
    request({
      requiresIndependentReview: true,
      requiredPolicyConstraintRefs: ["policy:privacy-tier-1"],
      executorCandidates: [executor],
      reviewerCandidates: [weakReviewer],
    }),
  );
  assert.equal(decision.status, "REJECTED");
});

test("A33 (Rev60 F1): a candidate with a malformed/unknown runtime authorityLevel cannot be selected for a STANDARD-authority route", () => {
  const malformed = worker({
    workerId: "malformed-authority",
    // @ts-expect-error deliberately invalid runtime value for the test - simulates untyped/external input bypassing the compile-time union
    authorityLevel: "SUPREME",
  });
  const decision = resolveWorkerRoute(
    request({ requiredAuthorityLevel: "STANDARD", executorCandidates: [malformed] }),
  );
  assert.equal(decision.status, "REJECTED");
});

test("A34 (Rev60 F1): a candidate with a malformed/unknown runtime authorityLevel cannot be selected for an ELEVATED-authority route", () => {
  const malformed = worker({
    workerId: "malformed-authority",
    // @ts-expect-error deliberately invalid runtime value for the test - simulates untyped/external input bypassing the compile-time union
    authorityLevel: "SUPREME",
  });
  const decision = resolveWorkerRoute(
    request({ requiredAuthorityLevel: "ELEVATED", executorCandidates: [malformed] }),
  );
  assert.equal(decision.status, "REJECTED");
});

test("A35 (Rev60 F1): a malformed-authority fallback is skipped, and routing still succeeds on a later, fully eligible worker - fallback never weakens the authority requirement", () => {
  const malformedFallback = worker({
    workerId: "malformed-fallback",
    // @ts-expect-error deliberately invalid runtime value for the test
    authorityLevel: "SUPREME",
  });
  const fullyEligible = worker({ workerId: "fully-eligible", authorityLevel: "ELEVATED" });
  const decision = resolveWorkerRoute(
    request({
      requiredAuthorityLevel: "ELEVATED",
      executorCandidates: [malformedFallback, fullyEligible],
    }),
  );
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "fully-eligible");
});

test("A36 (Rev60 F1): a malformed-authority reviewer candidate cannot be selected as an independent reviewer", () => {
  const executor = worker({ workerId: "executor" });
  const malformedReviewer = worker({
    workerId: "malformed-reviewer",
    // @ts-expect-error deliberately invalid runtime value for the test
    authorityLevel: "SUPREME",
  });
  const decision = resolveWorkerRoute(
    request({
      requiresIndependentReview: true,
      executorCandidates: [executor],
      reviewerCandidates: [malformedReviewer],
    }),
  );
  assert.equal(decision.status, "REJECTED");
});
