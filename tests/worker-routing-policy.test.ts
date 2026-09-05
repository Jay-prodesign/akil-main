import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveWorkerRoute,
  InvalidWorkerRoutingRequestError,
  type AdmittedWorker,
} from "../src/domain/worker-routing-policy.js";

const requiredCapabilityRef = "cap:engineering.typescript";

function worker(overrides: Partial<AdmittedWorker> & { workerId: string }): AdmittedWorker {
  return {
    declaredCapabilityRefs: [requiredCapabilityRef],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: `evidence:${overrides.workerId}`,
    ...overrides,
  };
}

test("A1: an ADMITTED, AVAILABLE, capable worker is routed as executor for STANDARD risk with no review required", () => {
  const w = worker({ workerId: "claude" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [w],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "claude");
  assert.equal(decision.reviewerWorkerId, undefined);
  assert.match(decision.reason, /claude/);
});

test("A2: an UNTRUSTED worker cannot be selected as executor even if it is the only candidate", () => {
  const w = worker({ workerId: "unknown-provider", trustStatus: "UNTRUSTED" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [w],
  });
  assert.equal(decision.status, "REJECTED");
  assert.match(decision.reason, /no admitted, available worker/);
});

test("A3: a REVOKED worker cannot be selected as executor", () => {
  const w = worker({ workerId: "revoked-worker", trustStatus: "REVOKED" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [w],
  });
  assert.equal(decision.status, "REJECTED");
});

test("A4: an UNAVAILABLE worker cannot be selected as executor (provider outage)", () => {
  const w = worker({ workerId: "down-worker", availability: "UNAVAILABLE" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [w],
  });
  assert.equal(decision.status, "REJECTED");
});

test("A5: a DEGRADED worker cannot be selected as executor", () => {
  const w = worker({ workerId: "degraded-worker", availability: "DEGRADED" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [w],
  });
  assert.equal(decision.status, "REJECTED");
});

test("A6: provider outage degrades gracefully to a fallback candidate that still meets full policy, never a reduced one", () => {
  const primary = worker({ workerId: "primary", availability: "UNAVAILABLE" });
  const fallback = worker({ workerId: "fallback" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [primary, fallback],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "fallback");
});

test("A7: a cheaper but ineligible worker earlier in the list is never selected over an eligible one later in it (cost cannot bypass policy)", () => {
  const cheapButUntrusted = worker({ workerId: "cheap-untrusted", trustStatus: "UNTRUSTED", costWeight: 0 });
  const eligibleButPricier = worker({ workerId: "eligible-pricier", costWeight: 10 });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [cheapButUntrusted, eligibleButPricier],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "eligible-pricier");
});

test("A8: a worker lacking the required capability is never selected", () => {
  const w = worker({ workerId: "no-cap", declaredCapabilityRefs: ["cap:something.else"] });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [w],
  });
  assert.equal(decision.status, "REJECTED");
});

test("A9: a worker with no evaluationEvidenceRef cannot be selected, even if otherwise eligible", () => {
  const w = worker({ workerId: "no-evidence", evaluationEvidenceRef: "" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [w],
  });
  assert.equal(decision.status, "REJECTED");
});

test("A10: a STANDARD-only worker cannot be selected as executor for HIGH_RISK work", () => {
  const w = worker({ workerId: "standard-only", maxRiskLevel: "STANDARD" });
  const reviewer = worker({ workerId: "reviewer", maxRiskLevel: "HIGH_RISK" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "HIGH_RISK",
    requiresIndependentReview: false,
    executorCandidates: [w],
    reviewerCandidates: [reviewer],
  });
  assert.equal(decision.status, "REJECTED");
});

test("A11: HIGH_RISK work with an eligible high-risk-authorized executor and reviewer routes both", () => {
  const executor = worker({ workerId: "executor", maxRiskLevel: "HIGH_RISK" });
  const reviewer = worker({ workerId: "reviewer", maxRiskLevel: "HIGH_RISK" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "HIGH_RISK",
    requiresIndependentReview: false,
    executorCandidates: [executor],
    reviewerCandidates: [reviewer],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "executor");
  assert.equal(decision.reviewerWorkerId, "reviewer");
});

test("A12: reviewer independence - the same worker cannot be both executor and reviewer", () => {
  const solo = worker({ workerId: "solo", maxRiskLevel: "HIGH_RISK" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "HIGH_RISK",
    requiresIndependentReview: false,
    executorCandidates: [solo],
    reviewerCandidates: [solo],
  });
  assert.equal(decision.status, "REJECTED");
  assert.match(decision.reason, /cannot review its own work/);
});

test("A13: requiresIndependentReview also enforces reviewer independence at STANDARD risk", () => {
  const solo = worker({ workerId: "solo" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: true,
    executorCandidates: [solo],
    reviewerCandidates: [solo],
  });
  assert.equal(decision.status, "REJECTED");
});

test("A14: requiresIndependentReview with a second eligible worker as reviewer routes successfully", () => {
  const executor = worker({ workerId: "executor" });
  const reviewer = worker({ workerId: "reviewer" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: true,
    executorCandidates: [executor],
    reviewerCandidates: [executor, reviewer],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.executorWorkerId, "executor");
  assert.equal(decision.reviewerWorkerId, "reviewer");
});

test("A15: an ineligible reviewer candidate (untrusted) is skipped in favor of a later eligible, independent one", () => {
  const executor = worker({ workerId: "executor" });
  const untrustedReviewer = worker({ workerId: "untrusted-reviewer", trustStatus: "UNTRUSTED" });
  const goodReviewer = worker({ workerId: "good-reviewer" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: true,
    executorCandidates: [executor],
    reviewerCandidates: [untrustedReviewer, goodReviewer],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.reviewerWorkerId, "good-reviewer");
});

test("A16: no eligible executor at all rejects gracefully with a reason, not a thrown error", () => {
  const w1 = worker({ workerId: "w1", availability: "UNAVAILABLE" });
  const w2 = worker({ workerId: "w2", trustStatus: "REVOKED" });
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [w1, w2],
  });
  assert.equal(decision.status, "REJECTED");
  assert.equal(typeof decision.reason, "string");
  assert.ok(decision.reason.length > 0);
});

test("A17: an empty requiredCapabilityRef fails closed with a thrown error", () => {
  assert.throws(() => {
    resolveWorkerRoute({
      requiredCapabilityRef: "",
      riskLevel: "STANDARD",
      requiresIndependentReview: false,
      executorCandidates: [],
    });
  }, InvalidWorkerRoutingRequestError);
});

test("A18: an invalid riskLevel fails closed with a thrown error", () => {
  assert.throws(() => {
    resolveWorkerRoute({
      requiredCapabilityRef,
      // @ts-expect-error deliberately invalid for the test
      riskLevel: "MEDIUM",
      requiresIndependentReview: false,
      executorCandidates: [],
    });
  }, InvalidWorkerRoutingRequestError);
});

test("A19: HIGH_RISK work with no reviewerCandidates supplied at all fails closed with a thrown error", () => {
  assert.throws(() => {
    resolveWorkerRoute({
      requiredCapabilityRef,
      riskLevel: "HIGH_RISK",
      requiresIndependentReview: false,
      executorCandidates: [worker({ workerId: "solo", maxRiskLevel: "HIGH_RISK" })],
    });
  }, InvalidWorkerRoutingRequestError);
});

test("A20: requiresIndependentReview with no reviewerCandidates supplied at all fails closed with a thrown error", () => {
  assert.throws(() => {
    resolveWorkerRoute({
      requiredCapabilityRef,
      riskLevel: "STANDARD",
      requiresIndependentReview: true,
      executorCandidates: [worker({ workerId: "solo" })],
    });
  }, InvalidWorkerRoutingRequestError);
});

test("A21: an empty candidate list rejects gracefully rather than throwing", () => {
  const decision = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [],
  });
  assert.equal(decision.status, "REJECTED");
});

test("A22: the returned decision always carries a non-empty reason for both ROUTED and REJECTED outcomes", () => {
  const routed = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [worker({ workerId: "w" })],
  });
  const rejected = resolveWorkerRoute({
    requiredCapabilityRef,
    riskLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [],
  });
  assert.ok(routed.reason.length > 0);
  assert.ok(rejected.reason.length > 0);
});
