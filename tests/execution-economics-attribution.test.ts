import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  InvalidExecutionEconomicsError,
  DuplicateIdempotencyKeyConflictError,
  createExecutionEconomicsLineage,
  createCostAmount,
  recordExecutionEconomicsEvent,
  appendExecutionEconomicsEvent,
  selectExecutionEconomicsEvents,
  resolveCostBucketTotal,
  resolveTotalDeliveryCost,
  resolveCohortComparability,
  isRecognizedUsageSource,
  EMPTY_EXECUTION_ECONOMICS_LEDGER,
  type ExecutionEconomicsEvent,
} from "../src/domain/execution-economics-attribution.js";

const tenantA = createTenantScope("tenant-a");
const tenantB = createTenantScope("tenant-b");

function lineage(overrides: Partial<Parameters<typeof createExecutionEconomicsLineage>[0]> = {}) {
  return createExecutionEconomicsLineage({
    tenantScope: tenantA,
    projectId: "project-1",
    planId: "plan-1",
    jobId: "job-1",
    taskRef: "task-1",
    runRef: "run-1",
    attemptRef: "attempt-1",
    ...overrides,
  });
}

function event(overrides: Partial<Parameters<typeof recordExecutionEconomicsEvent>[0]> = {}): ExecutionEconomicsEvent {
  return recordExecutionEconomicsEvent({
    lineage: lineage(),
    idempotencyKey: "evt-1",
    usageSource: "API_PAYG",
    costBuckets: [
      { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 500, currency: "USD" }) },
    ],
    capturedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  });
}

// --- M1-M2: lineage construction ---

test("M1: createExecutionEconomicsLineage binds tenant + project + plan + job + task + run + attempt", () => {
  const l = lineage();
  assert.equal(l.tenantId, "tenant-a");
  assert.equal(l.projectId, "project-1");
  assert.equal(l.planId, "plan-1");
  assert.equal(l.jobId, "job-1");
  assert.equal(l.taskRef, "task-1");
  assert.equal(l.runRef, "run-1");
  assert.equal(l.attemptRef, "attempt-1");
});

test("M2: createExecutionEconomicsLineage rejects an empty hierarchy field", () => {
  assert.throws(() => lineage({ runRef: "" }), InvalidExecutionEconomicsError);
  assert.throws(() => lineage({ attemptRef: "   " }), InvalidExecutionEconomicsError);
});

// --- M3-M6: event construction ---

test("M3: recordExecutionEconomicsEvent builds a valid event with cost/attribution/time", () => {
  const e = event({
    attribution: { workerRef: "worker-1", modelRef: "model-x" },
    time: { activeTimeMs: 1000, wallTimeMs: 2000, humanMinutes: 5, reworkCount: 0, independentQaPerformed: true },
  });
  assert.equal(e.usageSource, "API_PAYG");
  assert.equal(e.attribution.workerRef, "worker-1");
  assert.equal(e.attribution.providerRef, undefined);
  assert.equal(e.time.activeTimeMs, 1000);
});

test("M4: recordExecutionEconomicsEvent rejects an empty idempotencyKey", () => {
  assert.throws(() => event({ idempotencyKey: "" }), InvalidExecutionEconomicsError);
});

test("M5: recordExecutionEconomicsEvent rejects an unrecognized usageSource", () => {
  assert.throws(() => event({ usageSource: "FREE_TIER" as never }), InvalidExecutionEconomicsError);
  assert.equal(isRecognizedUsageSource("FREE_TIER"), false);
  assert.equal(isRecognizedUsageSource("SUBSCRIPTION_SHARED"), true);
});

test("M6: recordExecutionEconomicsEvent rejects a duplicate cost bucket kind in the same event", () => {
  assert.throws(
    () =>
      event({
        costBuckets: [
          { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }) },
          { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 200, currency: "USD" }) },
        ],
      }),
    InvalidExecutionEconomicsError,
  );
});

// --- M7-M8: cost amount presence discipline ---

test("M7: createCostAmount REPORTED requires a non-negative finite amount and a currency", () => {
  const amount = createCostAmount({ presence: "REPORTED", amountMinorUnits: 1234, currency: "USD" });
  assert.deepEqual(amount, { presence: "REPORTED", amountMinorUnits: 1234, currency: "USD" });
  assert.throws(() => createCostAmount({ presence: "REPORTED", amountMinorUnits: -1, currency: "USD" }), InvalidExecutionEconomicsError);
  assert.throws(() => createCostAmount({ presence: "REPORTED", amountMinorUnits: Number.NaN, currency: "USD" }), InvalidExecutionEconomicsError);
});

test("M8: createCostAmount UNKNOWN forbids a supplied amount/currency - never conflated with a reported 0", () => {
  const amount = createCostAmount({ presence: "UNKNOWN" });
  assert.deepEqual(amount, { presence: "UNKNOWN" });
  assert.throws(() => createCostAmount({ presence: "UNKNOWN", amountMinorUnits: 0, currency: "USD" }), InvalidExecutionEconomicsError);
});

test("M8b (F3 fix, adversarial): a raw malformed object cannot bypass createCostAmount by claiming to already be a valid CostAmount", () => {
  const malformedAmount = { presence: "REPORTED", amountMinorUnits: Number.NaN, currency: "USD" };
  assert.throws(
    () => event({ costBuckets: [{ kind: "MARGINAL_CASH", amount: malformedAmount as never }] }),
    InvalidExecutionEconomicsError,
  );
  const missingCurrency = { presence: "REPORTED", amountMinorUnits: 100 };
  assert.throws(
    () => event({ costBuckets: [{ kind: "MARGINAL_CASH", amount: missingCurrency as never }] }),
    InvalidExecutionEconomicsError,
  );
  const forgedUnknownWithValue = { presence: "UNKNOWN", amountMinorUnits: 500, currency: "USD" };
  assert.throws(
    () => event({ costBuckets: [{ kind: "MARGINAL_CASH", amount: forgedUnknownWithValue as never }] }),
    InvalidExecutionEconomicsError,
  );
});

// --- M9-M11: time/attribution discipline ---

test("M9: an event's activeTimeMs must never exceed wallTimeMs - wait/blocker time is not active execution", () => {
  assert.throws(() => event({ time: { activeTimeMs: 500, wallTimeMs: 100 } }), InvalidExecutionEconomicsError);
});

test("M10: activeTimeMs equal to wallTimeMs is a valid boundary (fully active, no wait time)", () => {
  const e = event({ time: { activeTimeMs: 300, wallTimeMs: 300 } });
  assert.equal(e.time.activeTimeMs, 300);
  assert.equal(e.time.wallTimeMs, 300);
});

test("M11: attribution never fabricates an absent worker/provider/model/route field", () => {
  const e = event({ attribution: { providerRef: "provider-x" } });
  assert.equal(e.attribution.providerRef, "provider-x");
  assert.equal("workerRef" in e.attribution, false);
  assert.equal("modelRef" in e.attribution, false);
  assert.equal("routeRef" in e.attribution, false);
});

// --- M12-M14: idempotent ledger ---

test("M12: appendExecutionEconomicsEvent appends a fresh event once", () => {
  const ledger = appendExecutionEconomicsEvent(EMPTY_EXECUTION_ECONOMICS_LEDGER, event());
  assert.equal(ledger.events.length, 1);
});

test("M13: an identical replay of the same idempotencyKey is a safe no-op - never double-counted", () => {
  const first = appendExecutionEconomicsEvent(EMPTY_EXECUTION_ECONOMICS_LEDGER, event());
  const replay = appendExecutionEconomicsEvent(first, event());
  assert.equal(replay.events.length, 1);
  assert.equal(replay, first);
});

test("M14: a conflicting replay (same idempotencyKey, different content) fails closed rather than overwriting", () => {
  const first = appendExecutionEconomicsEvent(EMPTY_EXECUTION_ECONOMICS_LEDGER, event({ idempotencyKey: "evt-x" }));
  assert.throws(
    () =>
      appendExecutionEconomicsEvent(
        first,
        event({
          idempotencyKey: "evt-x",
          costBuckets: [
            { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 999, currency: "USD" }) },
          ],
        }),
      ),
    DuplicateIdempotencyKeyConflictError,
  );
});

// --- M15-M17: isolation / scoping ---

test("M15: selectExecutionEconomicsEvents returns only events matching tenant+project+plan", () => {
  let ledger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  ledger = appendExecutionEconomicsEvent(ledger, event({ idempotencyKey: "e1" }));
  ledger = appendExecutionEconomicsEvent(
    ledger,
    event({ idempotencyKey: "e2", lineage: lineage({ planId: "plan-2" }) }),
  );
  const selected = selectExecutionEconomicsEvents(ledger, { tenantId: tenantA.tenantId, projectId: "project-1", planId: "plan-1" });
  assert.equal(selected.length, 1);
  assert.equal(selected.at(0)?.idempotencyKey, "e1");
});

test("M16 (adversarial): a same-named project/plan/job under a different tenant never leaks into the scoped total", () => {
  let ledger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  ledger = appendExecutionEconomicsEvent(
    ledger,
    event({
      idempotencyKey: "tenant-a-evt",
      costBuckets: [
        { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 500, currency: "USD" }) },
        { kind: "ALLOCATED_SUBSCRIPTION", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }) },
        { kind: "HUMAN_SHADOW", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }) },
      ],
    }),
  );
  ledger = appendExecutionEconomicsEvent(
    ledger,
    event({
      idempotencyKey: "tenant-b-evt",
      lineage: lineage({ tenantScope: tenantB }),
      costBuckets: [
        { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 999999, currency: "USD" }) },
      ],
    }),
  );
  const selected = selectExecutionEconomicsEvents(ledger, { tenantId: tenantA.tenantId, projectId: "project-1", planId: "plan-1" });
  assert.equal(selected.length, 1);
  const total = resolveTotalDeliveryCost(selected);
  assert.deepEqual(total, { status: "COMPUTED", amountMinorUnits: 650, currency: "USD" });
});

test("M16b (F1 fix, adversarial): an entirely absent required cost bucket makes the grand total INCOMPLETE, never zero-by-omission", () => {
  const e = event({
    costBuckets: [
      { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 500, currency: "USD" }) },
      // ALLOCATED_SUBSCRIPTION and HUMAN_SHADOW are never supplied at all.
    ],
  });
  const result = resolveTotalDeliveryCost([e]);
  assert.equal(result.status, "INCOMPLETE");
});

test("M17b (F2 fix): selectExecutionEconomicsEvents isolates by taskRef/runRef/attemptRef - no cross-task/run/attempt leakage", () => {
  let ledger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  ledger = appendExecutionEconomicsEvent(ledger, event({ idempotencyKey: "run-1-evt" }));
  ledger = appendExecutionEconomicsEvent(
    ledger,
    event({ idempotencyKey: "run-2-evt", lineage: lineage({ runRef: "run-2" }) }),
  );
  ledger = appendExecutionEconomicsEvent(
    ledger,
    event({ idempotencyKey: "attempt-2-evt", lineage: lineage({ attemptRef: "attempt-2" }) }),
  );
  ledger = appendExecutionEconomicsEvent(
    ledger,
    event({ idempotencyKey: "task-2-evt", lineage: lineage({ taskRef: "task-2" }) }),
  );
  const byRun = selectExecutionEconomicsEvents(ledger, {
    tenantId: tenantA.tenantId,
    projectId: "project-1",
    planId: "plan-1",
    runRef: "run-1",
  });
  assert.equal(byRun.length, 3, "run-1 scope must include every task/attempt recorded under run-1, and no other run");
  const byTask = selectExecutionEconomicsEvents(ledger, {
    tenantId: tenantA.tenantId,
    projectId: "project-1",
    planId: "plan-1",
    taskRef: "task-1",
  });
  assert.equal(byTask.length, 3, "task-1 scope must include every run/attempt recorded under task-1 and exclude the task-2 event - no cross-task leakage");
  assert.ok(byTask.every((e) => e.idempotencyKey !== "task-2-evt"));
  const byAttempt = selectExecutionEconomicsEvents(ledger, {
    tenantId: tenantA.tenantId,
    projectId: "project-1",
    planId: "plan-1",
    runRef: "run-1",
    attemptRef: "attempt-2",
  });
  assert.equal(byAttempt.length, 1);
  assert.equal(byAttempt.at(0)?.idempotencyKey, "attempt-2-evt");
});

test("M17: selectExecutionEconomicsEvents narrows further by jobId when supplied", () => {
  let ledger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  ledger = appendExecutionEconomicsEvent(ledger, event({ idempotencyKey: "job-1-evt" }));
  ledger = appendExecutionEconomicsEvent(ledger, event({ idempotencyKey: "job-2-evt", lineage: lineage({ jobId: "job-2" }) }));
  const selected = selectExecutionEconomicsEvents(ledger, {
    tenantId: tenantA.tenantId,
    projectId: "project-1",
    planId: "plan-1",
    jobId: "job-2",
  });
  assert.equal(selected.length, 1);
  assert.equal(selected.at(0)?.idempotencyKey, "job-2-evt");
});

// --- M18-M23: cost rollups ---

test("M18: resolveCostBucketTotal computes when every entry for that kind is REPORTED in the same currency", () => {
  const events = [
    event({ idempotencyKey: "a", costBuckets: [{ kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }) }] }),
    event({ idempotencyKey: "b", costBuckets: [{ kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 250, currency: "USD" }) }] }),
  ];
  assert.deepEqual(resolveCostBucketTotal(events, "MARGINAL_CASH"), { status: "COMPUTED", amountMinorUnits: 350, currency: "USD" });
});

test("M19: resolveCostBucketTotal is INCOMPLETE when any entry for that kind is UNKNOWN", () => {
  const events = [
    event({ idempotencyKey: "a", costBuckets: [{ kind: "HUMAN_SHADOW", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }) }] }),
    event({ idempotencyKey: "b", costBuckets: [{ kind: "HUMAN_SHADOW", amount: createCostAmount({ presence: "UNKNOWN" }) }] }),
  ];
  const result = resolveCostBucketTotal(events, "HUMAN_SHADOW");
  assert.equal(result.status, "INCOMPLETE");
});

test("M20: resolveCostBucketTotal is INCOMPLETE on mixed/incompatible currency - never silently converted", () => {
  const events = [
    event({ idempotencyKey: "a", costBuckets: [{ kind: "ALLOCATED_SUBSCRIPTION", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }) }] }),
    event({ idempotencyKey: "b", costBuckets: [{ kind: "ALLOCATED_SUBSCRIPTION", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 100, currency: "EUR" }) }] }),
  ];
  const result = resolveCostBucketTotal(events, "ALLOCATED_SUBSCRIPTION");
  assert.equal(result.status, "INCOMPLETE");
});

test("M21: resolveCostBucketTotal never fabricates a 0 for a bucket kind with zero recorded entries", () => {
  const events = [event()];
  const result = resolveCostBucketTotal(events, "HUMAN_SHADOW");
  assert.deepEqual(result, { status: "INCOMPLETE", reason: "no cost data recorded for this scope" });
});

test("M22: resolveTotalDeliveryCost sums compatible known components across all three buckets", () => {
  const e = event({
    costBuckets: [
      { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }) },
      { kind: "ALLOCATED_SUBSCRIPTION", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 50, currency: "USD" }) },
      { kind: "HUMAN_SHADOW", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 25, currency: "USD" }) },
    ],
  });
  assert.deepEqual(resolveTotalDeliveryCost([e]), { status: "COMPUTED", amountMinorUnits: 175, currency: "USD" });
});

test("M23: resolveTotalDeliveryCost is INCOMPLETE when one required component is UNKNOWN, even if others are known", () => {
  const e = event({
    costBuckets: [
      { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 100, currency: "USD" }) },
      { kind: "HUMAN_SHADOW", amount: createCostAmount({ presence: "UNKNOWN" }) },
    ],
  });
  const result = resolveTotalDeliveryCost([e]);
  assert.equal(result.status, "INCOMPLETE");
});

// --- M24-M26: comparable-cohort guard ---

test("M24: resolveCohortComparability returns COMPARABLE only for matching, both-verified cohort keys", () => {
  const a = { jobFamily: "website-build-v1", taskRef: "task-1", verified: true };
  const b = { jobFamily: "website-build-v1", taskRef: "task-1", verified: true };
  assert.equal(resolveCohortComparability(a, b), "COMPARABLE");
});

test("M25: resolveCohortComparability returns NOT_COMPARABLE for structurally different cohorts", () => {
  const a = { jobFamily: "website-build-v1", taskRef: "task-1", verified: true };
  const b = { jobFamily: "other-family", taskRef: "task-1", verified: true };
  assert.equal(resolveCohortComparability(a, b), "NOT_COMPARABLE");
});

test("M26 (adversarial): resolveCohortComparability never returns a winner/performance claim for an unverified cohort", () => {
  const a = { jobFamily: "website-build-v1", taskRef: "task-1", verified: true };
  const b = { jobFamily: "website-build-v1", taskRef: "task-1", verified: false };
  assert.equal(resolveCohortComparability(a, b), "INSUFFICIENT_EVIDENCE");
});

// --- M27-M28: WEBSITE_BUILD_v1 proof + multi-plan isolation ---

test("M27 (WEBSITE_BUILD_v1 proof): deterministic end-to-end attribution example with no live provider ingestion", () => {
  const websiteBuildTenant = createTenantScope("proof-tenant");
  const jobLineage = createExecutionEconomicsLineage({
    tenantScope: websiteBuildTenant,
    projectId: "proof-project",
    planId: "website-build-v1-plan",
    jobId: "website-build-v1-job",
    taskRef: "site-build",
    runRef: "run-1",
    attemptRef: "attempt-1",
  });
  const e = recordExecutionEconomicsEvent({
    lineage: jobLineage,
    idempotencyKey: "website-build-v1-proof-evt",
    usageSource: "API_PAYG",
    costBuckets: [
      { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 4200, currency: "USD" }) },
      { kind: "HUMAN_SHADOW", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 1800, currency: "USD" }) },
      { kind: "ALLOCATED_SUBSCRIPTION", amount: createCostAmount({ presence: "UNKNOWN" }) },
    ],
    attribution: { providerRef: "provider-x", modelRef: "model-x" },
    time: { activeTimeMs: 90000, wallTimeMs: 120000, humanMinutes: 12, reworkCount: 1, independentQaPerformed: true },
    capturedAt: "2026-09-16T00:00:00.000Z",
  });
  const ledger = appendExecutionEconomicsEvent(EMPTY_EXECUTION_ECONOMICS_LEDGER, e);
  const selected = selectExecutionEconomicsEvents(ledger, {
    tenantId: websiteBuildTenant.tenantId,
    projectId: "proof-project",
    planId: "website-build-v1-plan",
  });
  assert.equal(selected.length, 1);
  // ALLOCATED_SUBSCRIPTION is honestly UNKNOWN, so the grand total must stay INCOMPLETE rather than fabricate it.
  assert.equal(resolveTotalDeliveryCost(selected).status, "INCOMPLETE");
  // The two known buckets are each independently computable and stay distinct.
  assert.deepEqual(resolveCostBucketTotal(selected, "MARGINAL_CASH"), { status: "COMPUTED", amountMinorUnits: 4200, currency: "USD" });
  assert.deepEqual(resolveCostBucketTotal(selected, "HUMAN_SHADOW"), { status: "COMPUTED", amountMinorUnits: 1800, currency: "USD" });
});

test("M28 (multi-plan isolation, prepares FAS-001 but does not claim FAS S1/S2 or FULL-AUTOMATION-READY): 10 concurrent plans never leak or double-count", () => {
  const tenant = createTenantScope("isolation-tenant");
  let ledger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  const planCount = 10;
  for (let i = 0; i < planCount; i += 1) {
    const planLineage = createExecutionEconomicsLineage({
      tenantScope: tenant,
      projectId: "isolation-project",
      planId: `plan-${i}`,
      jobId: `job-${i}`,
      taskRef: "site-build",
      runRef: "run-1",
      attemptRef: "attempt-1",
    });
    const e = recordExecutionEconomicsEvent({
      lineage: planLineage,
      idempotencyKey: `plan-${i}-evt`,
      usageSource: "API_PAYG",
      costBuckets: [
        { kind: "MARGINAL_CASH", amount: createCostAmount({ presence: "REPORTED", amountMinorUnits: 100 * (i + 1), currency: "USD" }) },
      ],
      capturedAt: "2026-09-16T00:00:00.000Z",
    });
    // Replay the same event a second time (simulated duplicate delivery) - must not double-count.
    ledger = appendExecutionEconomicsEvent(ledger, e);
    ledger = appendExecutionEconomicsEvent(ledger, e);
  }
  assert.equal(ledger.events.length, planCount);
  for (let i = 0; i < planCount; i += 1) {
    const selected = selectExecutionEconomicsEvents(ledger, {
      tenantId: tenant.tenantId,
      projectId: "isolation-project",
      planId: `plan-${i}`,
    });
    assert.equal(selected.length, 1, `plan-${i} must see exactly its own event, no cross-plan leak`);
    assert.deepEqual(resolveCostBucketTotal(selected, "MARGINAL_CASH"), {
      status: "COMPUTED",
      amountMinorUnits: 100 * (i + 1),
      currency: "USD",
    });
  }
});
