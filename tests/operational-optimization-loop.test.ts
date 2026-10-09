import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InvalidOptimizationPolicyError,
  InvalidOptimizationCandidateActionError,
  createOptimizationPolicy,
  createOptimizationCandidateAction,
  evaluateOptimizationCandidate,
} from "../src/domain/operational-optimization-loop.js";
import type { MetricReadModel } from "../src/domain/observability-telemetry.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";

const tenantScope = createTenantScope("tenant-optloop-1");

function policy(overrides: Partial<Parameters<typeof createOptimizationPolicy>[0]> = {}) {
  return createOptimizationPolicy({
    policyRef: "policy-1",
    authorizedByWorkerId: "worker-authority-1",
    maxRiskLevel: "STANDARD",
    budgetLimit: 100,
    reversibilityRequired: true,
    ...overrides,
  });
}

function telemetry(status: MetricReadModel["status"]): MetricReadModel {
  return {
    tenantId: tenantScope.tenantId,
    metricRef: "metric-1",
    sourceRef: "source-1",
    unit: "COUNT",
    status,
  };
}

function candidate(overrides: Partial<Parameters<typeof createOptimizationCandidateAction>[0]> = {}) {
  return createOptimizationCandidateAction({
    actionRef: "action-1",
    riskLevel: "STANDARD",
    reversible: true,
    estimatedCost: 10,
    telemetrySignal: telemetry("REPORTED_FRESH"),
    ...overrides,
  });
}

// --- Policy construction ---

test("O1: createOptimizationPolicy rejects empty policyRef", () => {
  assert.throws(() => policy({ policyRef: "" }), InvalidOptimizationPolicyError);
});

test("O2: createOptimizationPolicy rejects empty authorizedByWorkerId (no policy without declared authority)", () => {
  assert.throws(() => policy({ authorizedByWorkerId: "" }), InvalidOptimizationPolicyError);
});

test("O3: createOptimizationPolicy rejects invalid maxRiskLevel", () => {
  assert.throws(() => policy({ maxRiskLevel: "EXTREME" }), InvalidOptimizationPolicyError);
});

test("O4: createOptimizationPolicy rejects zero/negative budgetLimit", () => {
  assert.throws(() => policy({ budgetLimit: 0 }), InvalidOptimizationPolicyError);
  assert.throws(() => policy({ budgetLimit: -5 }), InvalidOptimizationPolicyError);
});

test("O5: createOptimizationPolicy rejects non-boolean reversibilityRequired", () => {
  assert.throws(() => policy({ reversibilityRequired: "yes" as unknown as boolean }), InvalidOptimizationPolicyError);
});

// --- Candidate construction ---

test("O6: createOptimizationCandidateAction rejects empty actionRef", () => {
  assert.throws(() => candidate({ actionRef: "" }), InvalidOptimizationCandidateActionError);
});

test("O7: createOptimizationCandidateAction rejects invalid riskLevel", () => {
  assert.throws(() => candidate({ riskLevel: "EXTREME" }), InvalidOptimizationCandidateActionError);
});

test("O8: createOptimizationCandidateAction rejects negative estimatedCost", () => {
  assert.throws(() => candidate({ estimatedCost: -1 }), InvalidOptimizationCandidateActionError);
});

test("O9: createOptimizationCandidateAction accepts zero estimatedCost", () => {
  assert.equal(candidate({ estimatedCost: 0 }).estimatedCost, 0);
});

// --- Evaluation: telemetry honesty gate ---

test("O10: MISSING telemetry escalates - absence of evidence is never promoted to safe-to-continue", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy(),
    candidate: candidate({ telemetrySignal: telemetry("MISSING") }),
    spentSoFar: 0,
  });
  assert.deepEqual(result, { actionRef: "action-1", decision: "ESCALATE", escalationReason: "TELEMETRY_UNAVAILABLE" });
});

test("O11: NOT_MONITORED telemetry escalates", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy(),
    candidate: candidate({ telemetrySignal: telemetry("NOT_MONITORED") }),
    spentSoFar: 0,
  });
  assert.equal(result.decision, "ESCALATE");
  assert.equal(result.escalationReason, "TELEMETRY_UNAVAILABLE");
});

test("O12: REPORTED_STALE telemetry escalates - stale is never trusted as current", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy(),
    candidate: candidate({ telemetrySignal: telemetry("REPORTED_STALE") }),
    spentSoFar: 0,
  });
  assert.deepEqual(result, { actionRef: "action-1", decision: "ESCALATE", escalationReason: "TELEMETRY_STALE" });
});

// --- Evaluation: risk vs policy ---

test("O13: risk exceeding policy escalates even with ample budget and reversible action", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy({ maxRiskLevel: "STANDARD", budgetLimit: 1000 }),
    candidate: candidate({ riskLevel: "HIGH_RISK", reversible: true, estimatedCost: 1 }),
    spentSoFar: 0,
  });
  assert.deepEqual(result, { actionRef: "action-1", decision: "ESCALATE", escalationReason: "RISK_EXCEEDS_POLICY" });
});

test("O14: HIGH_RISK candidate within a HIGH_RISK-authorized policy does not escalate on risk", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy({ maxRiskLevel: "HIGH_RISK", reversibilityRequired: false }),
    candidate: candidate({ riskLevel: "HIGH_RISK" }),
    spentSoFar: 0,
  });
  assert.equal(result.decision, "CONTINUE");
});

// --- Evaluation: reversibility ---

test("O15: irreversible action under a reversibility-required policy escalates, regardless of risk tier", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy({ reversibilityRequired: true }),
    candidate: candidate({ reversible: false, riskLevel: "STANDARD" }),
    spentSoFar: 0,
  });
  assert.deepEqual(result, {
    actionRef: "action-1",
    decision: "ESCALATE",
    escalationReason: "IRREVERSIBLE_ACTION_REQUIRES_REVIEW",
  });
});

test("O16: irreversible action is fine when the policy does not require reversibility", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy({ reversibilityRequired: false }),
    candidate: candidate({ reversible: false }),
    spentSoFar: 0,
  });
  assert.equal(result.decision, "CONTINUE");
});

// --- Evaluation: budget ---

test("O17: exceeding budgetLimit stops the loop", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy({ budgetLimit: 100 }),
    candidate: candidate({ estimatedCost: 50 }),
    spentSoFar: 60,
  });
  assert.deepEqual(result, { actionRef: "action-1", decision: "STOP", stopReason: "BUDGET_EXHAUSTED" });
});

test("O18: landing exactly on budgetLimit does not stop (only strictly over stops)", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy({ budgetLimit: 100 }),
    candidate: candidate({ estimatedCost: 40 }),
    spentSoFar: 60,
  });
  assert.equal(result.decision, "CONTINUE");
});

test("O19: budget check never fires ahead of a risk/reversibility/telemetry escalation", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy({ maxRiskLevel: "STANDARD", budgetLimit: 1000 }),
    candidate: candidate({ riskLevel: "HIGH_RISK", estimatedCost: 1 }),
    spentSoFar: 999,
  });
  assert.equal(result.decision, "ESCALATE");
  assert.equal(result.escalationReason, "RISK_EXCEEDS_POLICY");
});

// --- Evaluation: happy path ---

test("O20: CONTINUE only when telemetry fresh, risk within policy, reversible, and within budget", () => {
  const result = evaluateOptimizationCandidate({
    policy: policy(),
    candidate: candidate(),
    spentSoFar: 0,
  });
  assert.deepEqual(result, { actionRef: "action-1", decision: "CONTINUE" });
});

test("O21: rejects a non-finite/negative spentSoFar", () => {
  assert.throws(
    () => evaluateOptimizationCandidate({ policy: policy(), candidate: candidate(), spentSoFar: -1 }),
    InvalidOptimizationCandidateActionError,
  );
  assert.throws(
    () => evaluateOptimizationCandidate({ policy: policy(), candidate: candidate(), spentSoFar: NaN }),
    InvalidOptimizationCandidateActionError,
  );
});
