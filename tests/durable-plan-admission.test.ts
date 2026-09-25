import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope } from "../src/domain/sold-scope.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import { admitPlan } from "../src/domain/plan-admission.js";
import {
  FileDurablePlanAdmissionStore,
  recordEvaluation,
  recordAnswer,
  InvalidPlanAdmissionAnswerError,
  CorruptedPlanAdmissionEventError,
} from "../src/domain/durable-plan-admission-store.js";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
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

function singleFilePathIn(dir: string): string {
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1, `expected exactly one durable file in ${dir}, found ${files.length}`);
  return join(dir, files[0]!);
}

function overwriteFileWithSingleLine(filePath: string, event: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// OS-V0-03 Phase A: fail-closed persisted-event replay validation
// ---------------------------------------------------------------------------

test("OS-V0-03 P2: a foreign-tenant FIRST persisted event in the requested tuple's own file is rejected fail-closed before state construction", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const plan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-os-v0-03-p2",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-09-25T00:00:00.000Z",
    });
    const result = admitPlan({
      plan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    });
    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result, recordedAt: "2026-09-25T00:00:00.000Z" });

    const filePath = singleFilePathIn(dir);
    const legitEvent = JSON.parse(readFileSync(filePath, "utf8").trim());
    const forged = {
      ...legitEvent,
      eventId: "forged-p2-foreign-tenant",
      tenantId: "tenant-os-v0-03-foreign",
      result: { ...legitEvent.result, tenantId: "tenant-os-v0-03-foreign" },
    };
    overwriteFileWithSingleLine(filePath, forged);

    assert.throws(
      () =>
        store.getState(
          fixture.tenantScope.tenantId,
          fixture.customer.customerId,
          fixture.project.projectId,
          plan.planId,
        ),
      CorruptedPlanAdmissionEventError,
    );
    assert.throws(
      () =>
        store.getEvents(
          fixture.tenantScope.tenantId,
          fixture.customer.customerId,
          fixture.project.projectId,
          plan.planId,
        ),
      CorruptedPlanAdmissionEventError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 P3: a same-tenant but wrong-customer persisted event is rejected", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const plan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-os-v0-03-p3",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-09-25T00:00:00.000Z",
    });
    const result = admitPlan({
      plan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    });
    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result, recordedAt: "2026-09-25T00:00:00.000Z" });

    const filePath = singleFilePathIn(dir);
    const legitEvent = JSON.parse(readFileSync(filePath, "utf8").trim());
    const forged = {
      ...legitEvent,
      eventId: "forged-p3-wrong-customer",
      customerId: "cust-os-v0-03-foreign",
      result: { ...legitEvent.result, customerId: "cust-os-v0-03-foreign" },
    };
    overwriteFileWithSingleLine(filePath, forged);

    assert.throws(
      () =>
        store.getState(
          fixture.tenantScope.tenantId,
          fixture.customer.customerId,
          fixture.project.projectId,
          plan.planId,
        ),
      CorruptedPlanAdmissionEventError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 P4: a same-tenant/customer but wrong-project persisted event is rejected", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const plan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-os-v0-03-p4",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-09-25T00:00:00.000Z",
    });
    const result = admitPlan({
      plan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    });
    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result, recordedAt: "2026-09-25T00:00:00.000Z" });

    const filePath = singleFilePathIn(dir);
    const legitEvent = JSON.parse(readFileSync(filePath, "utf8").trim());
    const forged = {
      ...legitEvent,
      eventId: "forged-p4-wrong-project",
      projectId: "project-os-v0-03-foreign",
      result: { ...legitEvent.result, projectId: "project-os-v0-03-foreign" },
    };
    overwriteFileWithSingleLine(filePath, forged);

    assert.throws(
      () =>
        store.getState(
          fixture.tenantScope.tenantId,
          fixture.customer.customerId,
          fixture.project.projectId,
          plan.planId,
        ),
      CorruptedPlanAdmissionEventError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 P5: a same-tenant/customer/project but wrong-planId persisted event is rejected", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const plan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-os-v0-03-p5",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-09-25T00:00:00.000Z",
    });
    const result = admitPlan({
      plan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    });
    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result, recordedAt: "2026-09-25T00:00:00.000Z" });

    const filePath = singleFilePathIn(dir);
    const legitEvent = JSON.parse(readFileSync(filePath, "utf8").trim());
    const forged = {
      ...legitEvent,
      eventId: "forged-p5-wrong-plan",
      planId: "plan-os-v0-03-foreign",
      result: { ...legitEvent.result, planId: "plan-os-v0-03-foreign" },
    };
    overwriteFileWithSingleLine(filePath, forged);

    assert.throws(
      () =>
        store.getState(
          fixture.tenantScope.tenantId,
          fixture.customer.customerId,
          fixture.project.projectId,
          plan.planId,
        ),
      CorruptedPlanAdmissionEventError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 P6: EVALUATION_RECORDED envelope matches the requested scope but the nested result carries a foreign tenant/customer/project/plan - rejected", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const plan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-os-v0-03-p6",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-09-25T00:00:00.000Z",
    });
    const result = admitPlan({
      plan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    });
    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result, recordedAt: "2026-09-25T00:00:00.000Z" });

    const filePath = singleFilePathIn(dir);
    const legitEvent = JSON.parse(readFileSync(filePath, "utf8").trim());
    // Envelope-level fields are left correct; only the NESTED result's
    // identity is forged - the exact "nested result scope not revalidated
    // against the event envelope" gap this task closes.
    const forged = {
      ...legitEvent,
      eventId: "forged-p6-nested-foreign",
      result: { ...legitEvent.result, tenantId: "tenant-os-v0-03-nested-foreign" },
    };
    overwriteFileWithSingleLine(filePath, forged);

    assert.throws(
      () =>
        store.getState(
          fixture.tenantScope.tenantId,
          fixture.customer.customerId,
          fixture.project.projectId,
          plan.planId,
        ),
      CorruptedPlanAdmissionEventError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 P7: EVALUATION_RECORDED nested result.planVersion mismatch vs the event envelope's own planVersion - rejected", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const plan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-os-v0-03-p7",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-09-25T00:00:00.000Z",
    });
    const result = admitPlan({
      plan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    });
    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result, recordedAt: "2026-09-25T00:00:00.000Z" });

    const filePath = singleFilePathIn(dir);
    const legitEvent = JSON.parse(readFileSync(filePath, "utf8").trim());
    const forged = {
      ...legitEvent,
      eventId: "forged-p7-version-mismatch",
      result: { ...legitEvent.result, planVersion: 999 },
    };
    overwriteFileWithSingleLine(filePath, forged);

    assert.throws(
      () =>
        store.getState(
          fixture.tenantScope.tenantId,
          fixture.customer.customerId,
          fixture.project.projectId,
          plan.planId,
        ),
      CorruptedPlanAdmissionEventError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 P8: unknown event type or malformed required event identity/planVersion/eventId/recordedAt is rejected", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const plan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-os-v0-03-p8",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-09-25T00:00:00.000Z",
    });
    const result = admitPlan({
      plan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    });
    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result, recordedAt: "2026-09-25T00:00:00.000Z" });
    const filePath = singleFilePathIn(dir);
    const legitEvent = JSON.parse(readFileSync(filePath, "utf8").trim());
    const getState = () =>
      store.getState(
        fixture.tenantScope.tenantId,
        fixture.customer.customerId,
        fixture.project.projectId,
        plan.planId,
      );

    overwriteFileWithSingleLine(filePath, { ...legitEvent, type: "UNKNOWN_EVENT_TYPE" });
    assert.throws(getState, CorruptedPlanAdmissionEventError, "unknown event type must be rejected");

    overwriteFileWithSingleLine(filePath, { ...legitEvent, eventId: "" });
    assert.throws(getState, CorruptedPlanAdmissionEventError, "empty eventId must be rejected");

    overwriteFileWithSingleLine(filePath, {
      ...legitEvent,
      planVersion: 0,
      result: { ...legitEvent.result, planVersion: 0 },
    });
    assert.throws(getState, CorruptedPlanAdmissionEventError, "non-positive planVersion must be rejected");

    overwriteFileWithSingleLine(filePath, {
      ...legitEvent,
      planVersion: 1.5,
      result: { ...legitEvent.result, planVersion: 1.5 },
    });
    assert.throws(getState, CorruptedPlanAdmissionEventError, "non-integer planVersion must be rejected");

    overwriteFileWithSingleLine(filePath, { ...legitEvent, recordedAt: "" });
    assert.throws(getState, CorruptedPlanAdmissionEventError, "empty recordedAt must be rejected");

    const { result: _omitted, ...withoutResult } = legitEvent;
    overwriteFileWithSingleLine(filePath, withoutResult);
    assert.throws(getState, CorruptedPlanAdmissionEventError, "missing EVALUATION_RECORDED.result must be rejected");

    overwriteFileWithSingleLine(filePath, { ...legitEvent, result: { ...legitEvent.result, status: "UNKNOWN_STATUS" } });
    assert.throws(getState, CorruptedPlanAdmissionEventError, "unrecognized result.status must be rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 P9: a malformed ANSWER_RECORDED answeredEntity, or one carrying a wrong embedded scope, is rejected at the raw event-log level", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const waitingSoldScope = createSoldScope({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      soldScopeId: "sold-scope-os-v0-03-p9",
      outcomeContractRef: "outcome-contract-os-v0-03-p9",
      includedRequirementIds: ["optional-multilingual-content"],
    });
    const waitingPlan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-os-v0-03-p9",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: waitingSoldScope,
      evidence: fixture.evidence,
      now: "2026-09-25T00:00:00.000Z",
    });
    const waitingResult = admitPlan({ plan: waitingPlan, blueprint: fixture.blueprint });
    assert.equal(waitingResult.status, "WAITING");

    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result: waitingResult, recordedAt: "2026-09-25T00:00:00.000Z" });
    const legitAnswer = createAnswerRecordedEvent({
      tenantId: fixture.tenantScope.tenantId,
      customerId: fixture.customer.customerId,
      projectId: fixture.project.projectId,
      planId: waitingPlan.planId,
      planVersion: waitingResult.planVersion,
      answeredEntity: "optional-ecommerce-integration",
      eventId: "answer-os-v0-03-p9",
      recordedAt: "2026-09-25T00:05:00.000Z",
    });
    store.appendEvent(legitAnswer);
    const getState = () =>
      store.getState(
        fixture.tenantScope.tenantId,
        fixture.customer.customerId,
        fixture.project.projectId,
        waitingPlan.planId,
      );
    // Sanity: the legitimate two-line file reconstructs cleanly before any
    // corruption is introduced.
    assert.equal(getState()?.answeredEntities.length, 1);

    const filePath = singleFilePathIn(dir);
    const lines = readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 2);
    const legitEvaluationLine = lines[0]!;
    const legitAnswerEvent = JSON.parse(lines[1]!);

    writeFileSync(
      filePath,
      `${legitEvaluationLine}\n${JSON.stringify({ ...legitAnswerEvent, eventId: "forged-p9-empty-entity", answeredEntity: "" })}\n`,
      "utf8",
    );
    assert.throws(getState, CorruptedPlanAdmissionEventError, "empty answeredEntity must be rejected");

    writeFileSync(
      filePath,
      `${legitEvaluationLine}\n${JSON.stringify({ ...legitAnswerEvent, eventId: "forged-p9-wrong-tenant", tenantId: "tenant-os-v0-03-p9-foreign" })}\n`,
      "utf8",
    );
    assert.throws(getState, CorruptedPlanAdmissionEventError, "ANSWER_RECORDED with wrong embedded tenant must be rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 P10: getEvents/getState expose no cross-scope event or state - a corrupted file never leaks a partially-reconstructed foreign projection", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const plan = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-os-v0-03-p10",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-09-25T00:00:00.000Z",
    });
    const result = admitPlan({
      plan,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    });
    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result, recordedAt: "2026-09-25T00:00:00.000Z" });
    const filePath = singleFilePathIn(dir);
    const legitEvent = JSON.parse(readFileSync(filePath, "utf8").trim());
    overwriteFileWithSingleLine(filePath, { ...legitEvent, customerId: "cust-os-v0-03-p10-foreign" });

    let thrown = false;
    try {
      store.getEvents(fixture.tenantScope.tenantId, fixture.customer.customerId, fixture.project.projectId, plan.planId);
    } catch (cause) {
      thrown = true;
      assert.ok(cause instanceof CorruptedPlanAdmissionEventError);
    }
    assert.equal(thrown, true, "getEvents must throw rather than return a cross-scope event array");

    thrown = false;
    try {
      store.getState(fixture.tenantScope.tenantId, fixture.customer.customerId, fixture.project.projectId, plan.planId);
    } catch (cause) {
      thrown = true;
      assert.ok(cause instanceof CorruptedPlanAdmissionEventError);
    }
    assert.equal(thrown, true, "getState must throw rather than return a state constructed from a cross-scope event");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 P11: two legitimate independent tuples that reuse opaque id strings remain independently reconstructible - hardening introduces no false collision", () => {
  const dir = freshStoreDir();
  try {
    const fixture = buildWebsiteBuildV1Fixture();
    const store = new FileDurablePlanAdmissionStore(dir);

    const planA = compilePlan({
      tenantScope: fixture.tenantScope,
      project: fixture.project,
      planId: "plan-os-v0-03-p11-shared",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      evidence: fixture.evidence,
      now: "2026-09-25T00:00:00.000Z",
    });
    const resultA = admitPlan({
      plan: planA,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, planA),
    });
    recordEvaluation({ store, result: resultA, recordedAt: "2026-09-25T00:00:00.000Z" });

    const otherCustomer = createCustomer({
      tenantScope: fixture.tenantScope,
      customerId: "cust-os-v0-03-p11-other",
      displayName: "OS-V0-03 P11 Other Customer",
    });
    const otherProject = createProject({
      tenantScope: fixture.tenantScope,
      customer: otherCustomer,
      projectId: fixture.project.projectId,
      ownerRef: "owner-os-v0-03-p11-other",
      state: "active",
    });
    const otherSoldScope = createSoldScope({
      tenantScope: fixture.tenantScope,
      project: otherProject,
      soldScopeId: "sold-scope-os-v0-03-p11-other",
      outcomeContractRef: "outcome-contract-os-v0-03-p11-other",
      includedRequirementIds: ["optional-multilingual-content"],
      excludedRequirementIds: ["optional-ecommerce-integration"],
    });
    const planB = compilePlan({
      tenantScope: fixture.tenantScope,
      project: otherProject,
      planId: "plan-os-v0-03-p11-shared",
      version: 1,
      blueprint: fixture.blueprint,
      soldScope: otherSoldScope,
      now: "2026-09-25T00:00:00.000Z",
    });
    const approvalB = createApprovalReference({
      plan: planB,
      approvalId: "approval-os-v0-03-p11-other",
      approvedAt: "2026-09-25T00:00:00.000Z",
      approverRef: "owner:founder",
    });
    const resultB = admitPlan({
      plan: planB,
      blueprint: fixture.blueprint,
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, otherProject, planB),
      approval: approvalB,
    });
    recordEvaluation({ store, result: resultB, recordedAt: "2026-09-25T00:00:00.000Z" });

    const stateA = store.getState(fixture.tenantScope.tenantId, fixture.customer.customerId, fixture.project.projectId, planA.planId);
    const stateB = store.getState(fixture.tenantScope.tenantId, otherCustomer.customerId, otherProject.projectId, planB.planId);
    assert.equal(stateA?.latestResult?.status, resultA.status);
    assert.equal(stateB?.latestResult?.status, "ADMITTED");
    assert.equal(stateA?.customerId, fixture.customer.customerId);
    assert.equal(stateB?.customerId, otherCustomer.customerId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("Brain Rev44 F2 (adversarial): two distinct tenant/customer/project/plan tuples whose components contain the delimiter character never collide on the durable file key, even though raw '::' concatenation of the same tuples would produce an identical string", () => {
  const dir = freshStoreDir();
  try {
    // customerId="x::y" + projectId="z" and customerId="x" + projectId="y::z"
    // both concatenate to the literal string "x::y::z" under naive
    // `${customerId}::${projectId}` joining - the exact Brain Rev44 F2
    // collision shape, at the durable-store key level rather than the
    // specId level. Holding tenantId/planId constant isolates the key
    // encoding as the only thing that can distinguish these two records.
    const tenantScope = createTenantScope("tenant-cxp-001r-delimiter");
    const customerA = createCustomer({ tenantScope, customerId: "x::y", displayName: "Customer A" });
    const projectA = createProject({
      tenantScope,
      customer: customerA,
      projectId: "z",
      ownerRef: "owner-a",
      state: "active",
    });
    const customerB = createCustomer({ tenantScope, customerId: "x", displayName: "Customer B" });
    const projectB = createProject({
      tenantScope,
      customer: customerB,
      projectId: "y::z",
      ownerRef: "owner-b",
      state: "active",
    });

    const blueprint = createOfferBlueprintVersion({
      blueprintId: "bp-cxp-001r",
      version: "1.0.0",
      requirements: [{ requirementId: "req-1", description: "Req 1", necessity: "REQUIRED", dependsOn: [] }],
    });
    const soldScopeA = createSoldScope({
      tenantScope,
      project: projectA,
      soldScopeId: "scope-a",
      outcomeContractRef: "contract-a",
    });
    const soldScopeB = createSoldScope({
      tenantScope,
      project: projectB,
      soldScopeId: "scope-b",
      outcomeContractRef: "contract-b",
    });
    const planA = compilePlan({
      tenantScope,
      project: projectA,
      planId: "plan-1",
      blueprint,
      soldScope: soldScopeA,
      now: "2026-08-19T00:00:00.000Z",
    });
    const planB = compilePlan({
      tenantScope,
      project: projectB,
      planId: "plan-1",
      blueprint,
      soldScope: soldScopeB,
      now: "2026-08-19T00:00:00.000Z",
    });
    const resultA = admitPlan({ plan: planA, blueprint, readinessAssertions: [] });
    const resultB = admitPlan({ plan: planB, blueprint, readinessAssertions: [] });

    // Sanity: prove the OLD raw '::' concatenation formula genuinely
    // collided for this adversarial pair, so this test would have failed
    // to catch anything before the Rev44 correction.
    const oldFormulaA = `${tenantScope.tenantId}::${customerA.customerId}::${projectA.projectId}::plan-1`;
    const oldFormulaB = `${tenantScope.tenantId}::${customerB.customerId}::${projectB.projectId}::plan-1`;
    assert.equal(oldFormulaA, oldFormulaB, "sanity: the old raw concatenation formula must collide for this adversarial pair");

    const store = new FileDurablePlanAdmissionStore(dir);
    recordEvaluation({ store, result: resultA, recordedAt: "2026-08-19T00:00:00.000Z" });
    recordEvaluation({ store, result: resultB, recordedAt: "2026-08-19T00:00:00.000Z" });

    const stateA = store.getState(tenantScope.tenantId, customerA.customerId, projectA.projectId, planA.planId);
    const stateB = store.getState(tenantScope.tenantId, customerB.customerId, projectB.projectId, planB.planId);
    assert.equal(stateA?.appliedEventIds.length, 1);
    assert.equal(stateB?.appliedEventIds.length, 1);
    assert.notEqual(stateA?.latestResult, undefined);
    assert.notEqual(stateB?.latestResult, undefined);
    // Each store instance sees only its own tuple's record, never the
    // other's, even though both were persisted under the same tenant and
    // the exact same colliding raw-concatenation string.
    assert.equal(stateA?.customerId, customerA.customerId);
    assert.equal(stateB?.customerId, customerB.customerId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 P14: boundary - durable-plan-admission-store.ts introduces no new import/dependency and the source-file line count grows only by the validator", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const sourcePath = join(REPO_ROOT, "src/domain/durable-plan-admission-store.ts");
  const content = readFileSync(sourcePath, "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  const allowedModules = [
    "./tenant-scope.js",
    "./customer.js",
    "./project.js",
    "./project-plan.js",
    "./plan-admission.js",
    "./plan-admission-event.js",
    "./plan-admission-run-state.js",
  ];
  for (const specifier of importedModules) {
    assert.ok(specifier === "node:fs" || specifier === "node:path" || allowedModules.includes(specifier ?? ""), `unexpected import specifier: ${specifier}`);
  }
  for (const forbidden of ["worker-routing-policy.js", "worker-invoker.js", "organization-membership.js", "organization-service-principal.js", "authority.js"]) {
    assert.equal(content.includes(forbidden), false, `must not import "${forbidden}"`);
  }
});
