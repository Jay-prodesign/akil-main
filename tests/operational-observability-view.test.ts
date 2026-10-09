import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob, type OutcomeJob } from "../src/domain/outcome-job.js";
import { createOutcomeJobExecutionEvent, type OutcomeJobExecutionEvent } from "../src/domain/outcome-job-execution-event.js";
import { reconstructOutcomeJobExecutionRunState, type OutcomeJobExecutionRunState } from "../src/domain/outcome-job-execution-run-state.js";
import { createConnectionRequirement, createConnectionBinding, transitionConnectionBinding, verifyConnectionBinding, type ConnectionBinding } from "../src/domain/connection-authority.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult } from "../src/domain/verification-result.js";
import type { ProtectedDecisionWaitRequest, ProtectedDecisionResumeAuthorization } from "../src/domain/protected-decision-wait-gate.js";
import type { QuotaReadModel } from "../src/domain/execution-quota-admission.js";
import { composeOperationalObservabilityView } from "../src/domain/operational-observability-view.js";

const tenantScope = createTenantScope("tenant-os-v0-12");
const customer = createCustomer({ tenantScope, customerId: "cust-os-v0-12", displayName: "OS-V0-12 Customer" });
const project = createProject({
  tenantScope,
  customer,
  projectId: "project-os-v0-12",
  ownerRef: "owner-os-v0-12",
  state: "active",
});
const job: OutcomeJob = createOutcomeJob({
  tenantScope,
  customer,
  project,
  jobId: "job-os-v0-12",
  jobFamily: "WEBSITE_BUILD",
  businessObjective: "Deliver website",
});

function ev(overrides: Partial<Parameters<typeof createOutcomeJobExecutionEvent>[0]> = {}): OutcomeJobExecutionEvent {
  return createOutcomeJobExecutionEvent({
    tenantScope,
    customer,
    project,
    job,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 1,
    type: "ACCEPTED",
    occurredAt: "2026-10-06T00:00:00.000Z",
    ...overrides,
  });
}

function runStateFrom(events: ReadonlyArray<OutcomeJobExecutionEvent>): OutcomeJobExecutionRunState {
  const state = reconstructOutcomeJobExecutionRunState(events);
  if (state === undefined) {
    throw new Error("unreachable: events must reconstruct a state in this test suite");
  }
  return state;
}

const ownership = createProjectOwnershipRef({
  tenantId: tenantScope.tenantId,
  customerId: customer.customerId,
  projectId: project.projectId,
});

function connectionAt(state: ConnectionBinding["connectionState"]): ConnectionBinding {
  const requirement = createConnectionRequirement({
    connectionRequirementId: "conn-req-1",
    ownership,
    requiredCapabilityRef: "required-access-connections",
    purpose: "test",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "oauth",
    validationRequirement: "none",
  });
  let binding = createConnectionBinding({
    connectionBindingId: "conn-bind-1",
    requirement,
    ownership,
    providerRef: "provider-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
  });
  if (state === "REQUESTED") {
    return binding;
  }
  binding = transitionConnectionBinding(binding, "CONNECTED_UNVERIFIED");
  if (state === "CONNECTED_UNVERIFIED") {
    return binding;
  }
  if (state === "REVOKED") {
    return transitionConnectionBinding(binding, "REVOKED");
  }
  binding = verifyConnectionBinding(binding, "evidence-ref-1");
  if (state === "VERIFIED") {
    return binding;
  }
  return transitionConnectionBinding(binding, state);
}

test("P1: composeOperationalObservabilityView with no inputs composes an honest all-empty view - no task/quota, empty arrays, never fabricated", () => {
  const view = composeOperationalObservabilityView({});
  assert.equal(view.task, undefined);
  assert.equal(view.quota, undefined);
  assert.deepEqual(view.connections, []);
  assert.deepEqual(view.pendingApprovals, []);
  assert.deepEqual(view.auditEvidence, []);
});

test("P2: a run with no attempt started composes task state ACCEPTED, currentAttempt 0, and workerHealth IDLE - nothing is running yet", () => {
  const runState = runStateFrom([ev()]);
  const view = composeOperationalObservabilityView({ runState });
  assert.deepEqual(view.task, { runStatus: "ACCEPTED", currentAttempt: 0, workerHealth: "IDLE" });
});

test("P3: a RUNNING attempt with no pending control request composes workerHealth ACTIVE", () => {
  const runState = runStateFrom([ev(), ev({ type: "ATTEMPT_STARTED", sequence: 1 })]);
  const view = composeOperationalObservabilityView({ runState });
  assert.equal(view.task?.runStatus, "RUNNING");
  assert.equal(view.task?.currentAttemptStatus, "RUNNING");
  assert.equal(view.task?.workerHealth, "ACTIVE");
  assert.equal(view.task?.pendingControlRequest, undefined);
});

test("P4: a RUNNING attempt with an outstanding CANCEL_REQUESTED composes workerHealth AWAITING_CONTROL_ACK and surfaces the pending control request", () => {
  const runState = runStateFrom([
    ev(),
    ev({ type: "ATTEMPT_STARTED", sequence: 1 }),
    ev({ type: "CANCEL_REQUESTED", sequence: 2, reason: "operator requested cancel" }),
  ]);
  const view = composeOperationalObservabilityView({ runState });
  assert.equal(view.task?.workerHealth, "AWAITING_CONTROL_ACK");
  assert.equal(view.task?.pendingControlRequest?.kind, "CANCEL_REQUESTED");
  assert.equal(view.task?.pendingControlRequest?.reason, "operator requested cancel");
});

for (const terminal of ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"] as const) {
  test(`P5 (${terminal}): an ordinary terminal attempt outcome composes workerHealth IDLE - the worker is no longer active on this attempt`, () => {
    const runState = runStateFrom([
      ev(),
      ev({ type: "ATTEMPT_STARTED", sequence: 1 }),
      ev({ type: terminal, sequence: 2, ...(terminal !== "SUCCEEDED" ? { reason: "test reason" } : {}) }),
    ]);
    const view = composeOperationalObservabilityView({ runState });
    assert.equal(view.task?.currentAttemptStatus, terminal);
    assert.equal(view.task?.workerHealth, "IDLE");
  });
}

for (const ambiguous of ["STALLED", "DEGRADED", "BLOCKED", "UNKNOWN", "UNSUPPORTED"] as const) {
  test(`P6 (${ambiguous}): an ambiguous attempt outcome composes workerHealth UNKNOWN - honestly unresolved, never guessed as IDLE or ACTIVE`, () => {
    const runState = runStateFrom([ev(), ev({ type: "ATTEMPT_STARTED", sequence: 1 }), ev({ type: ambiguous, sequence: 2, reason: "test reason" })]);
    const view = composeOperationalObservabilityView({ runState });
    assert.equal(view.task?.currentAttemptStatus, ambiguous);
    assert.equal(view.task?.workerHealth, "UNKNOWN");
  });
}

test("P7a: a REQUESTED/CONNECTED_UNVERIFIED connection composes killSwitchEngaged=false and degraded=false", () => {
  const view = composeOperationalObservabilityView({ connections: [connectionAt("REQUESTED"), connectionAt("CONNECTED_UNVERIFIED")] });
  assert.deepEqual(
    view.connections.map((c) => [c.connectionState, c.killSwitchEngaged, c.degraded]),
    [
      ["REQUESTED", false, false],
      ["CONNECTED_UNVERIFIED", false, false],
    ],
  );
});

test("P7b: a DEGRADED connection composes degraded=true, killSwitchEngaged=false", () => {
  const view = composeOperationalObservabilityView({ connections: [connectionAt("DEGRADED")] });
  assert.equal(view.connections[0]?.degraded, true);
  assert.equal(view.connections[0]?.killSwitchEngaged, false);
});

test("P7c: a REVOKED connection composes killSwitchEngaged=true - the only real scoped kill-switch signal this repository has today", () => {
  const view = composeOperationalObservabilityView({ connections: [connectionAt("REVOKED")] });
  assert.equal(view.connections[0]?.killSwitchEngaged, true);
  assert.equal(view.connections[0]?.degraded, false);
});

test("P8: quota is passed through verbatim - the composer never re-derives or wraps QuotaReadModel", () => {
  const quota: QuotaReadModel = {
    unitLimit: 100,
    unitReserved: 10,
    unitCommitted: 5,
    unitRemaining: 85,
    monetary: { status: "NOT_CONFIGURED" },
  };
  const view = composeOperationalObservabilityView({ quota });
  assert.deepEqual(view.quota, quota);
});

test("P9a: an unresolved pending-decision wait composes resolved=false with no resolvedAt", () => {
  const request: ProtectedDecisionWaitRequest = {
    waitRequestId: "wait-1",
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: job.jobId,
    runId: "run-1",
    attempt: 1,
    effectRef: "effect-1",
    decisionRef: "decision-1",
    reason: "requires human approval",
    activationFingerprintAtWait: "fp-1",
    raisedAt: "2026-10-06T00:00:00.000Z",
  } as unknown as ProtectedDecisionWaitRequest;
  const view = composeOperationalObservabilityView({ pendingApprovals: [{ request }] });
  assert.deepEqual(view.pendingApprovals, [
    { waitRequestId: "wait-1", effectRef: "effect-1", decisionRef: "decision-1", raisedAt: "2026-10-06T00:00:00.000Z", resolved: false },
  ]);
});

test("P9b: a resolved pending-decision wait composes resolved=true with the real resolvedAt", () => {
  const request: ProtectedDecisionWaitRequest = {
    waitRequestId: "wait-2",
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: job.jobId,
    runId: "run-1",
    attempt: 1,
    effectRef: "effect-2",
    decisionRef: "decision-2",
    reason: "requires human approval",
    activationFingerprintAtWait: "fp-2",
    raisedAt: "2026-10-06T00:00:00.000Z",
  } as unknown as ProtectedDecisionWaitRequest;
  const resume: ProtectedDecisionResumeAuthorization = {
    waitRequestId: "wait-2",
    effectRef: "effect-2",
    resolvedAt: "2026-10-06T01:00:00.000Z",
    resolvedByPrincipalRef: "membership-1",
    decisionRef: "decision-2",
    decisionEvidenceRef: "evidence-decision-2",
  } as unknown as ProtectedDecisionResumeAuthorization;
  const view = composeOperationalObservabilityView({ pendingApprovals: [{ request, resume }] });
  assert.equal(view.pendingApprovals[0]?.resolved, true);
  assert.equal(view.pendingApprovals[0]?.resolvedAt, "2026-10-06T01:00:00.000Z");
});

test("P10a: evidence with no verification composes an entry with no verificationStatus - never fabricated", () => {
  const evidence = createEvidenceReference({
    job,
    evidenceId: "evidence-1",
    evidenceType: "SCREENSHOT",
    sourceLocator: "s3://bucket/evidence-1.png",
    capturedAt: "2026-10-06T00:00:00.000Z",
  });
  const view = composeOperationalObservabilityView({ auditEvidence: [{ evidence }] });
  assert.deepEqual(view.auditEvidence, [
    { evidenceId: "evidence-1", evidenceType: "SCREENSHOT", capturedAt: "2026-10-06T00:00:00.000Z" },
  ]);
});

test("P10b: evidence with a real VerificationResult composes the exact verificationStatus (PASSED or FAILED)", () => {
  const evidence = createEvidenceReference({
    job,
    evidenceId: "evidence-2",
    evidenceType: "SCREENSHOT",
    sourceLocator: "s3://bucket/evidence-2.png",
    capturedAt: "2026-10-06T00:00:00.000Z",
  });
  const verification = createVerificationResult({
    verificationId: "verification-2",
    job,
    evidence,
    verificationRequirementRef: "requirement-1",
    status: "FAILED",
    limitationOrFailureReason: "screenshot missing required element",
  });
  const view = composeOperationalObservabilityView({ auditEvidence: [{ evidence, verification }] });
  assert.equal(view.auditEvidence[0]?.verificationStatus, "FAILED");
});
