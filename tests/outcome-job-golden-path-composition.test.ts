import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileGoldenPathActivation,
  buildGoldenPathSoldScope,
  buildGoldenPathServiceAdmission,
  GOLDEN_PATH_TENANT_SCOPE,
  GOLDEN_PATH_CUSTOMER,
  GOLDEN_PATH_PROJECT,
  GOLDEN_PATH_OWNERSHIP,
  GOLDEN_PATH_BLUEPRINT,
  GOLDEN_PATH_RECIPE,
} from "./helpers/golden-path-fixture.js";
import { compileProjectActivationProfile, createAcceptedCommercialReference } from "../src/domain/project-activation-profile.js";
import {
  composeTaskPacketForOutcomeJob,
  resolveNextRunnableGoldenPathAction,
  InvalidGoldenPathCompositionError,
} from "../src/domain/outcome-job-golden-path-composition.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult } from "../src/domain/verification-result.js";
import { transitionOutcomeJob } from "../src/domain/outcome-job.js";
import { createOutcomeJobExecutionEvent } from "../src/domain/outcome-job-execution-event.js";
import { reconstructOutcomeJobExecutionRunState } from "../src/domain/outcome-job-execution-run-state.js";

function smokeCompilation() {
  const compilation = compileGoldenPathActivation("plan-gpc-smoke", "sold-gpc-smoke");
  assert.equal(compilation.profile.state, "READY");
  assert.equal(compilation.jobs.length, 1);
  return compilation;
}

test("sanity: the shared Golden-Path fixture compiles to one READY job/spec pair", () => {
  smokeCompilation();
});

test("resolveNextRunnableGoldenPathAction: an ACTION_REQUIRED activation is the highest-priority blocker, before any job-state inspection", () => {
  // Real compile with no approval supplied: plan-approval is required and
  // unresolved, so compileProjectActivationProfile itself reports
  // ACTION_REQUIRED/HUMAN_REVIEW - never a literal-constructed fixture.
  const soldScope = buildGoldenPathSoldScope("sold-gpc-1-no-approval");
  const compilation = compileProjectActivationProfile({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    ownership: GOLDEN_PATH_OWNERSHIP,
    acceptedCommercialReference: createAcceptedCommercialReference({
      acceptanceRef: "acceptance-sold-gpc-1-no-approval",
      sourceBlueprintId: GOLDEN_PATH_BLUEPRINT.blueprintId,
      sourceBlueprintVersion: GOLDEN_PATH_BLUEPRINT.version,
      soldScopeId: soldScope.soldScopeId,
      outcomeContractRef: soldScope.outcomeContractRef,
    }),
    blueprint: GOLDEN_PATH_BLUEPRINT,
    soldScope,
    recipe: GOLDEN_PATH_RECIPE,
    serviceAdmission: buildGoldenPathServiceAdmission(),
    effectiveConfigRefs: [],
    effectivePolicyRefs: [],
    planId: "plan-gpc-1-no-approval",
    now: "2026-10-02T00:00:00.000Z",
  });
  assert.equal(compilation.profile.state, "ACTION_REQUIRED");
  assert.equal(compilation.jobs.length, 0);

  // resolveNextRunnableGoldenPathAction only needs a job belonging to the
  // same tenant/customer/project - reuse the READY smoke job purely as a
  // same-scope OutcomeJob identity carrier, since no job was wired here.
  const readyCompilation = smokeCompilation();
  const sameScopeJob = { ...readyCompilation.jobs[0]!, state: "DRAFT" as const };
  const action = resolveNextRunnableGoldenPathAction({ job: sameScopeJob, activation: compilation.profile });
  assert.equal(action.actor, compilation.profile.nextRequiredActor);
  assert.equal(action.code, compilation.profile.nextRequiredAction?.code);
});

test("composeTaskPacketForOutcomeJob + resolveNextRunnableGoldenPathAction: a freshly READY job with no execution yet dispatches, and the TaskPacket's own nextAuthorizedAction agrees exactly", () => {
  const compilation = smokeCompilation();
  const wiredJob = compilation.jobs[0]!;
  const job = transitionOutcomeJob(transitionOutcomeJob(wiredJob, "QUALIFIED"), "READY");
  const spec = compilation.specs.find((s) => (s.specId as unknown as string) === (job.jobId as unknown as string))!;

  const action = resolveNextRunnableGoldenPathAction({ job, activation: compilation.profile });
  assert.deepEqual(action, { actor: "AKILTA", code: "DISPATCH_EXECUTION", reason: "job is READY - dispatch execution" });

  const packet = composeTaskPacketForOutcomeJob({
    job,
    spec,
    activation: compilation.profile,
    projectOwnership: GOLDEN_PATH_OWNERSHIP,
    baseIdentity: "sha-abc123",
    acceptanceCriteria: ["the golden path requirement is satisfied"],
  });
  assert.equal(packet.taskId, job.jobId);
  assert.equal(packet.goal, spec.intendedOutcome);
  assert.equal(packet.nextAuthorizedAction, `AKILTA:DISPATCH_EXECUTION:${action.reason}`);
  assert.deepEqual(packet.blockers, []);
  assert.deepEqual(packet.remainingWork, ["AKILTA:DISPATCH_EXECUTION"]);
});

test("composeTaskPacketForOutcomeJob rejects a spec that was not the exact spec this job was wired from", () => {
  const compilation = smokeCompilation();
  const job = compilation.jobs[0]!;
  const foreignCompilation = compileGoldenPathActivation("plan-gpc-foreign", "sold-gpc-foreign");
  const foreignSpec = foreignCompilation.specs[0]!;
  assert.throws(
    () =>
      composeTaskPacketForOutcomeJob({
        job,
        spec: foreignSpec,
        activation: compilation.profile,
        projectOwnership: GOLDEN_PATH_OWNERSHIP,
        baseIdentity: "sha-abc123",
        acceptanceCriteria: ["x"],
      }),
    InvalidGoldenPathCompositionError,
  );
});

test("composeTaskPacketForOutcomeJob rejects an activation that does not belong to the given job's tenant/customer/project", () => {
  const compilation = smokeCompilation();
  const job = compilation.jobs[0]!;
  const spec = compilation.specs[0]!;
  const foreignScopedActivation = { ...compilation.profile, projectId: "proj-foreign" as typeof compilation.profile.projectId };
  assert.throws(
    () =>
      composeTaskPacketForOutcomeJob({
        job,
        spec,
        activation: foreignScopedActivation,
        projectOwnership: GOLDEN_PATH_OWNERSHIP,
        baseIdentity: "sha-abc123",
        acceptanceCriteria: ["x"],
      }),
    InvalidGoldenPathCompositionError,
  );
});

test("resolveNextRunnableGoldenPathAction: EXECUTING with no execution run yet asks to dispatch execution", () => {
  const compilation = smokeCompilation();
  const job = transitionOutcomeJob(transitionOutcomeJob(compilation.jobs[0]!, "QUALIFIED"), "READY");
  const executing = transitionOutcomeJob(job, "EXECUTING");
  const action = resolveNextRunnableGoldenPathAction({ job: executing, activation: compilation.profile });
  assert.equal(action.code, "DISPATCH_EXECUTION");
});

function runStateAt(job: ReturnType<typeof smokeCompilation>["jobs"][number], terminalType: "SUCCEEDED" | "UNKNOWN" | "FAILED" | "CANCELLED") {
  const accepted = createOutcomeJobExecutionEvent({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 1,
    type: "ACCEPTED",
    occurredAt: "2026-10-02T00:00:00.000Z",
  });
  const started = createOutcomeJobExecutionEvent({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 1,
    type: "ATTEMPT_STARTED",
    occurredAt: "2026-10-02T00:00:01.000Z",
  });
  const terminal = createOutcomeJobExecutionEvent({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 2,
    type: terminalType,
    occurredAt: "2026-10-02T00:00:02.000Z",
    ...(terminalType === "SUCCEEDED" ? {} : { reason: `simulated ${terminalType.toLowerCase()}` }),
  });
  return reconstructOutcomeJobExecutionRunState([accepted, started, terminal])!;
}

test("resolveNextRunnableGoldenPathAction: a SUCCEEDED attempt asks to advance the job to VERIFYING - execution success is never itself verification", () => {
  const compilation = smokeCompilation();
  const job = transitionOutcomeJob(transitionOutcomeJob(transitionOutcomeJob(compilation.jobs[0]!, "QUALIFIED"), "READY"), "EXECUTING");
  const executionState = runStateAt(job, "SUCCEEDED");
  const action = resolveNextRunnableGoldenPathAction({ job, activation: compilation.profile, executionState });
  assert.equal(action.code, "ADVANCE_TO_VERIFYING");
  assert.equal(action.actor, "AKILTA");
});

test("resolveNextRunnableGoldenPathAction: an UNKNOWN attempt requires HUMAN_REVIEW and is never silently retried - Mandatory Evidence #3/#6", () => {
  const compilation = smokeCompilation();
  const job = transitionOutcomeJob(transitionOutcomeJob(transitionOutcomeJob(compilation.jobs[0]!, "QUALIFIED"), "READY"), "EXECUTING");
  const executionState = runStateAt(job, "UNKNOWN");
  const action = resolveNextRunnableGoldenPathAction({ job, activation: compilation.profile, executionState });
  assert.equal(action.code, "UNKNOWN_EFFECT_REQUIRES_REVIEW");
  assert.equal(action.actor, "HUMAN_REVIEW");
});

test("resolveNextRunnableGoldenPathAction: a FAILED attempt asks to retry", () => {
  const compilation = smokeCompilation();
  const job = transitionOutcomeJob(transitionOutcomeJob(transitionOutcomeJob(compilation.jobs[0]!, "QUALIFIED"), "READY"), "EXECUTING");
  const executionState = runStateAt(job, "FAILED");
  const action = resolveNextRunnableGoldenPathAction({ job, activation: compilation.profile, executionState });
  assert.equal(action.code, "RETRY_EXECUTION");
  assert.equal(action.actor, "AKILTA");
});

test("resolveNextRunnableGoldenPathAction: VERIFYING with no VerificationResult yet requires verification evidence", () => {
  const compilation = smokeCompilation();
  const job = transitionOutcomeJob(
    transitionOutcomeJob(transitionOutcomeJob(transitionOutcomeJob(compilation.jobs[0]!, "QUALIFIED"), "READY"), "EXECUTING"),
    "VERIFYING",
  );
  const action = resolveNextRunnableGoldenPathAction({ job, activation: compilation.profile });
  assert.equal(action.code, "VERIFICATION_REQUIRED");
});

test("resolveNextRunnableGoldenPathAction: a FAILED VerificationResult recomputes a safe remaining action rather than Founder 'what next?' - Mandatory Evidence #5", () => {
  const compilation = smokeCompilation();
  const job = transitionOutcomeJob(
    transitionOutcomeJob(transitionOutcomeJob(transitionOutcomeJob(compilation.jobs[0]!, "QUALIFIED"), "READY"), "EXECUTING"),
    "VERIFYING",
  );
  const evidence = createEvidenceReference({
    job,
    evidenceId: "ev-1",
    evidenceType: "TEST_RESULT",
    sourceLocator: "internal://test",
    capturedAt: "2026-10-02T00:00:03.000Z",
  });
  const verification = createVerificationResult({
    verificationId: "verif-1",
    job,
    evidence,
    verificationRequirementRef: "req-golden-path",
    status: "FAILED",
    limitationOrFailureReason: "acceptance criteria not met",
  });
  const action = resolveNextRunnableGoldenPathAction({ job, activation: compilation.profile, verification });
  assert.equal(action.code, "VERIFICATION_FAILED_RECOMPUTE");
  assert.equal(action.reason, "acceptance criteria not met");
});

test("resolveNextRunnableGoldenPathAction: a PASSED VerificationResult advances to VERIFIED, and a CLOSED job needs no further action - Mandatory Evidence #6 (never replay a completed effect)", () => {
  const compilation = smokeCompilation();
  const job = transitionOutcomeJob(
    transitionOutcomeJob(transitionOutcomeJob(transitionOutcomeJob(compilation.jobs[0]!, "QUALIFIED"), "READY"), "EXECUTING"),
    "VERIFYING",
  );
  const evidence = createEvidenceReference({
    job,
    evidenceId: "ev-2",
    evidenceType: "TEST_RESULT",
    sourceLocator: "internal://test",
    capturedAt: "2026-10-02T00:00:03.000Z",
  });
  const verification = createVerificationResult({
    verificationId: "verif-2",
    job,
    evidence,
    verificationRequirementRef: "req-golden-path",
    status: "PASSED",
  });
  const passedAction = resolveNextRunnableGoldenPathAction({ job, activation: compilation.profile, verification });
  assert.equal(passedAction.code, "ADVANCE_TO_VERIFIED");

  const verifiedJob = { ...job, state: "VERIFIED" as const };
  const closeAction = resolveNextRunnableGoldenPathAction({ job: verifiedJob, activation: compilation.profile });
  assert.equal(closeAction.code, "CLOSE_JOB");

  const closedJob = { ...job, state: "CLOSED" as const };
  const closedAction = resolveNextRunnableGoldenPathAction({ job: closedJob, activation: compilation.profile });
  assert.deepEqual(closedAction, { actor: "NONE", code: "CLOSED", reason: "job is already CLOSED - no further action" });
});

test("resolveNextRunnableGoldenPathAction: an exception-state job requires HUMAN_REVIEW", () => {
  const compilation = smokeCompilation();
  const blockedJob = { ...compilation.jobs[0]!, state: "BLOCKED" as const };
  const action = resolveNextRunnableGoldenPathAction({ job: blockedJob, activation: compilation.profile });
  assert.equal(action.actor, "HUMAN_REVIEW");
  assert.equal(action.code, "EXCEPTION_STATE:BLOCKED");
});

test("resolveNextRunnableGoldenPathAction: restart safety - rebuilding the identical durable executionState from scratch reconstructs the identical next action (Mandatory Evidence #1)", () => {
  const compilation = smokeCompilation();
  const job = transitionOutcomeJob(transitionOutcomeJob(transitionOutcomeJob(compilation.jobs[0]!, "QUALIFIED"), "READY"), "EXECUTING");
  const events = [
    createOutcomeJobExecutionEvent({
      tenantScope: GOLDEN_PATH_TENANT_SCOPE,
      customer: GOLDEN_PATH_CUSTOMER,
      project: GOLDEN_PATH_PROJECT,
      job,
      runId: "run-restart",
      correlationId: "corr-restart",
      attempt: 1,
      sequence: 1,
      type: "ACCEPTED" as const,
      occurredAt: "2026-10-02T00:00:00.000Z",
    }),
  ];
  const before = reconstructOutcomeJobExecutionRunState(events)!;
  const afterRestart = reconstructOutcomeJobExecutionRunState([...events])!;
  const actionBefore = resolveNextRunnableGoldenPathAction({ job, activation: compilation.profile, executionState: before });
  const actionAfter = resolveNextRunnableGoldenPathAction({ job, activation: compilation.profile, executionState: afterRestart });
  assert.deepEqual(actionBefore, actionAfter);
});
