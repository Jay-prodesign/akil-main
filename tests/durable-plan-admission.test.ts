import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSoldScope } from "../src/domain/sold-scope.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import { admitPlan } from "../src/domain/plan-admission.js";
import {
  FileDurablePlanAdmissionStore,
  recordEvaluation,
  recordAnswer,
  InvalidPlanAdmissionAnswerError,
} from "../src/domain/durable-plan-admission-store.js";
import { createEvaluationRecordedEvent, createAnswerRecordedEvent } from "../src/domain/plan-admission-event.js";
import {
  applyPlanAdmissionEvent,
  InvalidPlanAdmissionRunStateError,
} from "../src/domain/plan-admission-run-state.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "del-003-plan-admission-store-"));
}

test("T7: a durably recorded WAITING evaluation survives a simulated process restart (fresh store instance over the same directory)", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const waitingSoldScope = createSoldScope({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      soldScopeId: "sold-scope-durable-t7-waiting",
      outcomeContractRef: "outcome-contract-durable-t7",
      includedRequirementIds: ["optional-multilingual-content"],
      // "optional-ecommerce-integration" intentionally left unresolved.
    });
    const waitingPlan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-durable-t7",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: waitingSoldScope,
      evidence: fixture.evidence,
      now: "2026-08-19T00:00:00.000Z",
    });
    const waitingResult = admitPlan({ plan: waitingPlan, blueprint: fixture.blueprint });
    assert.equal(waitingResult.status, "WAITING");
    assert.equal(waitingResult.awaiting?.entity, "optional-ecommerce-integration");

    const storeA = new FileDurablePlanAdmissionStore(dir);
    const stateBeforeRestart = recordEvaluation({
      store: storeA,
      result: waitingResult,
      recordedAt: "2026-08-19T00:00:00.000Z",
    });
    assert.equal(stateBeforeRestart.latestResult?.status, "WAITING");

    // Simulate process restart: a brand-new store instance, no in-memory
    // state carried over, reading the same durable directory.
    const storeB = new FileDurablePlanAdmissionStore(dir);
    const stateAfterRestart = storeB.getState(
      fixture.tenantScope.tenantId,
      fixture.customer.customerId,
      fixture.project.projectId,
      waitingPlan.planId,
    );
    assert.deepEqual(stateAfterRestart, stateBeforeRestart);
    assert.equal(stateAfterRestart?.latestResult?.status, "WAITING");
    assert.equal(stateAfterRestart?.latestResult?.awaiting?.entity, "optional-ecommerce-integration");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4: an answer binds to the exact awaited entity, one recorded resume evaluation is durable, and a duplicate/replayed answer cannot double-resume", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const waitingSoldScope = createSoldScope({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      soldScopeId: "sold-scope-durable-t4-waiting",
      outcomeContractRef: "outcome-contract-durable-t4",
      includedRequirementIds: ["optional-multilingual-content"],
    });
    const waitingPlan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-durable-t4",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: waitingSoldScope,
      evidence: fixture.evidence,
      now: "2026-08-19T00:00:00.000Z",
    });
    const waitingResult = admitPlan({ plan: waitingPlan, blueprint: fixture.blueprint });
    assert.equal(waitingResult.status, "WAITING");

    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result: waitingResult, recordedAt: "2026-08-19T00:00:00.000Z" });

    // Answer binding: an answer naming the wrong entity is rejected, not
    // silently accepted against whatever happens to be currently awaited.
    assert.throws(
      () =>
        recordAnswer({
          store,
          tenantId: fixture.tenantScope.tenantId,
          customerId: fixture.customer.customerId,
          projectId: fixture.project.projectId,
          planId: waitingPlan.planId,
          answeredEntity: "not-the-awaited-entity",
          eventId: "answer-durable-t4-wrong",
          recordedAt: "2026-08-19T00:05:00.000Z",
        }),
      InvalidPlanAdmissionAnswerError,
    );

    const answeredState = recordAnswer({
      store,
      tenantId: fixture.tenantScope.tenantId,
      customerId: fixture.customer.customerId,
      projectId: fixture.project.projectId,
      planId: waitingPlan.planId,
      answeredEntity: "optional-ecommerce-integration",
      eventId: "answer-durable-t4",
      recordedAt: "2026-08-19T00:05:00.000Z",
    });
    assert.equal(answeredState.answeredEntities.length, 1);
    // Recording the answer alone does not itself resume - it only durably
    // binds the answer; the plan is still WAITING until a fresh evaluation
    // (reflecting the resolved scope) is recorded.
    assert.equal(answeredState.latestResult?.status, "WAITING");

    // Replaying the exact same answer (same eventId) before any new
    // evaluation is a safe, non-duplicating no-op.
    const replayedAnswerState = recordAnswer({
      store,
      tenantId: fixture.tenantScope.tenantId,
      customerId: fixture.customer.customerId,
      projectId: fixture.project.projectId,
      planId: waitingPlan.planId,
      answeredEntity: "optional-ecommerce-integration",
      eventId: "answer-durable-t4",
      recordedAt: "2026-08-19T00:05:00.000Z",
    });
    assert.deepEqual(replayedAnswerState, answeredState);
    assert.equal(replayedAnswerState.answeredEntities.length, 1);

    // The actual "resume": a new plan version incorporating the answered
    // scope decision, admitted, and durably recorded.
    const resolvedSoldScope = createSoldScope({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      soldScopeId: "sold-scope-durable-t4-resolved",
      outcomeContractRef: "outcome-contract-durable-t4",
      includedRequirementIds: ["optional-multilingual-content"],
      excludedRequirementIds: ["optional-ecommerce-integration"],
    });
    const resolvedPlan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-durable-t4",
      version: 2,
      blueprint: fixture.blueprint,
      soldScope: resolvedSoldScope,
      evidence: fixture.evidence,
      now: "2026-08-19T00:10:00.000Z",
    });
    const approval = createApprovalReference({
      plan: resolvedPlan,
      approvalId: "approval-durable-t4",
      approvedAt: "2026-08-19T00:10:00.000Z",
      approverRef: "owner:founder",
    });
    const resolvedResult = admitPlan({
      plan: resolvedPlan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, resolvedPlan),
      approval,
    });
    assert.equal(resolvedResult.status, "ADMITTED");
    const resumedState = recordEvaluation({
      store,
      result: resolvedResult,
      recordedAt: "2026-08-19T00:10:00.000Z",
    });
    assert.equal(resumedState.latestResult?.status, "ADMITTED");
    assert.equal(resumedState.latestResult?.planVersion, 2);

    // Duplicate resume: recording the exact same v2 evaluation again is a
    // provable no-op (deterministic eventId dedup).
    const resumedAgain = recordEvaluation({
      store,
      result: resolvedResult,
      recordedAt: "2026-08-19T00:10:00.000Z",
    });
    assert.deepEqual(resumedAgain, resumedState);

    // A late/replayed answer for the now-resolved entity, arriving after
    // resume already happened, cannot re-trigger or double-authorize
    // anything - the plan is no longer WAITING, so it fails closed.
    assert.throws(
      () =>
        recordAnswer({
          store,
          tenantId: fixture.tenantScope.tenantId,
          customerId: fixture.customer.customerId,
          projectId: fixture.project.projectId,
          planId: waitingPlan.planId,
          answeredEntity: "optional-ecommerce-integration",
          eventId: "answer-durable-t4-late-duplicate",
          recordedAt: "2026-08-19T00:15:00.000Z",
        }),
      InvalidPlanAdmissionAnswerError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T8: duplicate ANSWER_RECORDED delivery at the raw event-log level is idempotent (reducer-level dedup, independent of the recordAnswer wrapper)", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const store = new FileDurablePlanAdmissionStore(dir);
    const waitingSoldScope = createSoldScope({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      soldScopeId: "sold-scope-durable-t8-waiting",
      outcomeContractRef: "outcome-contract-durable-t8",
      includedRequirementIds: ["optional-multilingual-content"],
    });
    const waitingPlan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-durable-t8",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: waitingSoldScope,
      evidence: fixture.evidence,
      now: "2026-08-19T00:00:00.000Z",
    });
    const waitingResult = admitPlan({ plan: waitingPlan, blueprint: fixture.blueprint });
    recordEvaluation({ store, result: waitingResult, recordedAt: "2026-08-19T00:00:00.000Z" });

    const duplicateAnswerEvent = createAnswerRecordedEvent({
      tenantId: fixture.tenantScope.tenantId,
      customerId: fixture.customer.customerId,
      projectId: fixture.project.projectId,
      planId: waitingPlan.planId,
      planVersion: waitingResult.planVersion,
      answeredEntity: "optional-ecommerce-integration",
      eventId: "answer-durable-t8-raw",
      recordedAt: "2026-08-19T00:05:00.000Z",
    });
    // Append the exact same event twice directly, bypassing recordAnswer's
    // business-level guard, to exercise the pure reducer's own dedup.
    store.appendEvent(duplicateAnswerEvent);
    store.appendEvent(duplicateAnswerEvent);
    const state = store.getState(
      fixture.tenantScope.tenantId,
      fixture.customer.customerId,
      fixture.project.projectId,
      waitingPlan.planId,
    );
    assert.equal(state?.answeredEntities.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T8: an out-of-order/stale EVALUATION_RECORDED event (lower plan version, arriving after a newer one) never regresses the projected state", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const store = new FileDurablePlanAdmissionStore(dir);

    const v1Plan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-durable-t8-order",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-08-19T00:00:00.000Z",
    });
    const v1Result = admitPlan({
      plan: v1Plan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, v1Plan),
      // no approval supplied
    });
    assert.equal(v1Result.status, "WAITING");

    const v2Plan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-durable-t8-order",
      version: 2,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-08-19T00:05:00.000Z",
    });
    const approval = createApprovalReference({
      plan: v2Plan,
      approvalId: "approval-durable-t8-order",
      approvedAt: "2026-08-19T00:05:00.000Z",
      approverRef: "owner:founder",
    });
    const v2Result = admitPlan({
      plan: v2Plan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, v2Plan),
      approval,
    });
    assert.equal(v2Result.status, "ADMITTED");

    // v2 (newer) is recorded first, then v1 (older/stale) arrives after -
    // an out-of-order delivery.
    store.appendEvent(createEvaluationRecordedEvent({ result: v2Result, recordedAt: "2026-08-19T00:05:00.000Z" }));
    store.appendEvent(createEvaluationRecordedEvent({ result: v1Result, recordedAt: "2026-08-19T00:00:00.000Z" }));

    const state = store.getState(
      fixture.tenantScope.tenantId,
      fixture.customer.customerId,
      fixture.project.projectId,
      v1Plan.planId,
    );
    assert.equal(state?.latestResult?.status, "ADMITTED");
    assert.equal(state?.latestResult?.planVersion, 2);
    // Both events are still durably present, even the one that did not win.
    assert.equal(state?.appliedEventIds.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CXP-001L (adversarial): applyPlanAdmissionEvent rejects an event belonging to a different customer within the SAME tenant/project/planId", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-durable-cxp-001l",
    version: 1,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const result = admitPlan({
    plan,
    blueprint: fixture.blueprint,
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
  });
  const legitEvent = createEvaluationRecordedEvent({ result, recordedAt: "2026-08-19T00:00:00.000Z" });
  const state = applyPlanAdmissionEvent(undefined, legitEvent);

  // A hand-built event carrying the SAME tenantId/projectId/planId as the
  // existing state, but a forged customerId, must fail closed at the
  // reducer's own lineage check - this is defense in depth independent of
  // any store-level file partitioning by customerId (a different
  // DurablePlanAdmissionStore implementation might not partition this way).
  const foreignCustomerEvent = {
    ...legitEvent,
    eventId: "answer-cxp-001l-foreign-customer" as never,
    customerId: "cust-cxp-001l-foreign" as never,
  };
  assert.throws(
    () => applyPlanAdmissionEvent(state, foreignCustomerEvent),
    InvalidPlanAdmissionRunStateError,
  );
});

test("CXP-001L (adversarial): two different customers within the SAME tenant, reusing the exact same projectId/planId strings, persist as two independent, non-contaminating durable records", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const planA = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-shared-planid-cxp-001l",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-08-19T00:00:00.000Z",
    });
    const resultA = admitPlan({
      plan: planA,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, planA),
    });
    assert.equal(resultA.status, "WAITING");

    // Deliberately reuses the SAME tenantScope and the SAME projectId/
    // planId strings from a different customer, so this case is caught
    // ONLY by customerId-scoped durable partitioning - a tenantId or
    // projectId/planId check alone would not distinguish it (project.ts
    // does not enforce projectId global uniqueness across customers).
    const otherCustomer = createCustomer({
      tenantScope: fixture.tenantScope,
      customerId: "cust-cxp-001l-other",
      displayName: "Other Customer, Same Tenant",
    });
    const otherCustomerProject = createProject({
      tenantScope: fixture.tenantScope,
      customer: otherCustomer,
      projectId: fixture.project.projectId,
      ownerRef: "owner-cxp-001l-other",
      state: "active",
    });
    const otherCustomerSoldScope = createSoldScope({
      tenantScope: fixture.tenantScope,
      project: otherCustomerProject,
      soldScopeId: "sold-scope-cxp-001l-other",
      outcomeContractRef: "outcome-contract-cxp-001l-other",
      includedRequirementIds: ["optional-multilingual-content"],
      excludedRequirementIds: ["optional-ecommerce-integration"],
    });
    const planB = compilePlan({
      tenantScope: fixture.tenantScope,
      project: otherCustomerProject,
      planId: "plan-shared-planid-cxp-001l",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: otherCustomerSoldScope,
      now: "2026-08-19T00:00:00.000Z",
    });
    const approvalB = createApprovalReference({
      plan: planB,
      approvalId: "approval-cxp-001l-other",
      approvedAt: "2026-08-19T00:00:00.000Z",
      approverRef: "owner:founder",
    });
    const resultB = admitPlan({
      plan: planB,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, otherCustomerProject, planB),
      approval: approvalB,
    });
    assert.equal(resultB.status, "ADMITTED");

    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result: resultA, recordedAt: "2026-08-19T00:00:00.000Z" });
    recordEvaluation({ store, result: resultB, recordedAt: "2026-08-19T00:00:00.000Z" });

    const stateA = store.getState(
      fixture.tenantScope.tenantId,
      fixture.customer.customerId,
      fixture.project.projectId,
      planA.planId,
    );
    const stateB = store.getState(
      fixture.tenantScope.tenantId,
      otherCustomer.customerId,
      otherCustomerProject.projectId,
      planB.planId,
    );
    assert.equal(stateA?.latestResult?.status, "WAITING");
    assert.equal(stateB?.latestResult?.status, "ADMITTED");
    assert.equal(stateA?.appliedEventIds.length, 1);
    assert.equal(stateB?.appliedEventIds.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
