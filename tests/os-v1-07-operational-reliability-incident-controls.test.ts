import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob, type OutcomeJob } from "../src/domain/outcome-job.js";
import {
  createOutcomeJobExecutionEvent,
  type OutcomeJobExecutionEvent,
} from "../src/domain/outcome-job-execution-event.js";
import {
  applyOutcomeJobExecutionEvent,
  reconstructOutcomeJobExecutionRunState,
  type OutcomeJobExecutionRunState,
} from "../src/domain/outcome-job-execution-run-state.js";
import {
  resolveRetryContainmentDisposition,
  type RetryContainmentPolicy,
} from "../src/domain/outcome-job-retry-containment.js";
import { composeOperationalObservabilityView } from "../src/domain/operational-observability-view.js";
import {
  createLocalExecutionKillSwitch,
  engageLocalExecutionKillSwitch,
  disengageLocalExecutionKillSwitch,
  resolveEligibleLocalWorkersUnderKillSwitch,
} from "../src/domain/local-execution-hardening.js";
import { createExecutionPolicy } from "../src/domain/local-execution.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
} from "../src/domain/connection-authority.js";
import { createAuthorityContext, ProtectedActionNotAuthorizedError } from "../src/domain/authority.js";
import { FileDurableConfigurationPolicyDecisionStore } from "../src/domain/durable-configuration-policy-decision-store.js";
import {
  resolveAndProjectConfigurationPolicyDecision,
  rollbackConfigurationPolicyDecision,
} from "../src/domain/resolve-and-project-configuration-policy-decision.js";

const tenantScope = createTenantScope("tenant-os-v1-07");
const customer = createCustomer({ tenantScope, customerId: "cust-os-v1-07", displayName: "OS-V1-07 Customer" });
const project = createProject({
  tenantScope,
  customer,
  projectId: "project-os-v1-07",
  ownerRef: "owner-os-v1-07",
  state: "active",
});
const job: OutcomeJob = createOutcomeJob({
  tenantScope,
  customer,
  project,
  jobId: "job-os-v1-07",
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
    occurredAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  });
}

function defaultPolicy(overrides: Partial<RetryContainmentPolicy> = {}): RetryContainmentPolicy {
  return {
    maxAttempts: 5,
    minAttemptIntervalMs: 1_000,
    crashLoopWindowMs: 60_000,
    maxAttemptsWithinCrashLoopWindow: 3,
    ...overrides,
  };
}

function runStateAfterAttempts(attemptStartedAts: ReadonlyArray<string>): OutcomeJobExecutionRunState {
  const events: OutcomeJobExecutionEvent[] = [ev({ type: "ACCEPTED", attempt: 1, sequence: 1, occurredAt: attemptStartedAts[0] })];
  attemptStartedAts.forEach((startedAt, index) => {
    const attempt = index + 1;
    events.push(ev({ type: "ATTEMPT_STARTED", attempt, sequence: 1, occurredAt: startedAt }));
    if (index < attemptStartedAts.length - 1) {
      events.push(ev({ type: "FAILED", attempt, sequence: 2, occurredAt: startedAt, reason: "transient failure" }));
    }
  });
  const state = reconstructOutcomeJobExecutionRunState(events);
  if (state === undefined) {
    throw new Error("test fixture produced no run state");
  }
  return state;
}

test("RC1: resolveRetryContainmentDisposition ADMITs the next attempt when well under both the absolute cap and the crash-loop thresholds", () => {
  const runState = runStateAfterAttempts(["2026-10-09T00:00:00.000Z"]);
  const disposition = resolveRetryContainmentDisposition({
    runState,
    policy: defaultPolicy(),
    now: "2026-10-09T00:05:00.000Z",
  });
  assert.equal(disposition.outcome, "ADMIT");
});

test("RC2 (retry storm): resolveRetryContainmentDisposition BLOCKS with RETRY_STORM once the next attempt would exceed the absolute cap", () => {
  const runState = runStateAfterAttempts([
    "2026-10-09T00:00:00.000Z",
    "2026-10-09T00:10:00.000Z",
    "2026-10-09T00:20:00.000Z",
    "2026-10-09T00:30:00.000Z",
    "2026-10-09T00:40:00.000Z",
  ]);
  assert.equal(runState.currentAttempt, 5);
  const disposition = resolveRetryContainmentDisposition({
    runState,
    policy: defaultPolicy({ maxAttempts: 5 }),
    now: "2026-10-09T00:50:00.000Z",
  });
  assert.equal(disposition.outcome, "BLOCKED");
  assert.ok(disposition.outcome === "BLOCKED");
  assert.equal(disposition.classification, "RETRY_STORM");
});

test("RC3 (crash loop, density): resolveRetryContainmentDisposition BLOCKS with CRASH_LOOP once enough prior attempts already landed within the sliding window", () => {
  const runState = runStateAfterAttempts([
    "2026-10-09T00:00:00.000Z",
    "2026-10-09T00:00:05.000Z",
    "2026-10-09T00:00:10.000Z",
  ]);
  const disposition = resolveRetryContainmentDisposition({
    runState,
    policy: defaultPolicy({ maxAttempts: 10, minAttemptIntervalMs: 1, crashLoopWindowMs: 60_000, maxAttemptsWithinCrashLoopWindow: 3 }),
    now: "2026-10-09T00:00:15.000Z",
  });
  assert.equal(disposition.outcome, "BLOCKED");
  assert.ok(disposition.outcome === "BLOCKED");
  assert.equal(disposition.classification, "CRASH_LOOP");
});

test("RC4 (crash loop, interval): resolveRetryContainmentDisposition BLOCKS with CRASH_LOOP when the next attempt would start sooner than the minimum inter-attempt interval", () => {
  const runState = runStateAfterAttempts(["2026-10-09T00:00:00.000Z"]);
  const disposition = resolveRetryContainmentDisposition({
    runState,
    policy: defaultPolicy({ minAttemptIntervalMs: 30_000 }),
    now: "2026-10-09T00:00:05.000Z",
  });
  assert.equal(disposition.outcome, "BLOCKED");
  assert.ok(disposition.outcome === "BLOCKED");
  assert.equal(disposition.classification, "CRASH_LOOP");
});

test("RC5: resolveRetryContainmentDisposition always ADMITs a run's first attempt (currentAttempt 0), regardless of policy", () => {
  const events: OutcomeJobExecutionEvent[] = [ev({ type: "ACCEPTED", attempt: 1, sequence: 1 })];
  const runState = reconstructOutcomeJobExecutionRunState(events);
  if (runState === undefined) throw new Error("fixture error");
  assert.equal(runState.currentAttempt, 0);
  const disposition = resolveRetryContainmentDisposition({
    runState,
    policy: defaultPolicy({ maxAttempts: 1, minAttemptIntervalMs: 999_999, crashLoopWindowMs: 999_999, maxAttemptsWithinCrashLoopWindow: 1 }),
    now: "2026-10-09T00:00:00.001Z",
  });
  assert.equal(disposition.outcome, "ADMIT");
});

test("HLT1 (health vs. task state, cited/re-demonstrated): a STALLED attempt reports workerHealth UNKNOWN while runStatus/currentAttemptStatus truthfully stay STALLED", () => {
  const events: OutcomeJobExecutionEvent[] = [
    ev({ type: "ACCEPTED", attempt: 1, sequence: 1 }),
    ev({ type: "ATTEMPT_STARTED", attempt: 1, sequence: 1 }),
    ev({ type: "STALLED", attempt: 1, sequence: 2, reason: "no progress reported" }),
  ];
  const runState = reconstructOutcomeJobExecutionRunState(events);
  if (runState === undefined) throw new Error("fixture error");
  const view = composeOperationalObservabilityView({ runState });
  assert.equal(view.task?.runStatus, "STALLED");
  assert.equal(view.task?.currentAttemptStatus, "STALLED");
  assert.equal(view.task?.workerHealth, "UNKNOWN", "an ambiguous attempt status must never be reported as a healthy worker");
});

test("KILL1 (existing kill-switch control, cited/re-demonstrated): engaging empties local-worker routing eligibility; disengaging requires protected-action authority", () => {
  const killSwitch = createLocalExecutionKillSwitch(tenantScope);
  const engaged = engageLocalExecutionKillSwitch({ killSwitch, engagedAt: "2026-10-09T00:00:00.000Z", reason: "incident containment" });
  assert.equal(engaged.engaged, true);

  const executionPolicy = createExecutionPolicy({ tenantScope, executionMode: "TEAM_LOCAL" });
  const eligible = resolveEligibleLocalWorkersUnderKillSwitch({
    killSwitch: engaged,
    executionPolicy,
    registrations: [],
    requestingTenantId: tenantScope.tenantId,
    targetOwnership: { tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId },
    requestingOwnerMembershipRef: "member-owner-1",
  });
  assert.deepEqual(eligible, []);

  assert.throws(
    () =>
      disengageLocalExecutionKillSwitch({
        killSwitch: engaged,
        authority: createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: false }),
        disengagedAt: "2026-10-09T00:10:00.000Z",
        disengagedByRef: "staff-1",
        reason: "incident resolved",
      }),
    ProtectedActionNotAuthorizedError,
  );
});

test("OUT1 (outage witness, composition): a REVOKED connection composes killSwitchEngaged:true; a DEGRADED one composes degraded:true - never silently AVAILABLE", () => {
  const ownership = { tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId };
  const requirement = createConnectionRequirement({
    connectionRequirementId: "req-out1",
    ownership,
    requiredCapabilityRef: "cap-out1",
    purpose: "outage witness",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "oauth",
    validationRequirement: "none",
  });
  const binding = createConnectionBinding({
    connectionBindingId: "binding-out1",
    requirement,
    ownership,
    providerRef: "provider-out1",
    workspaceRef: "workspace-out1",
    integrationInstanceRef: "instance-out1",
    delegatedScope: [],
  });
  const verified = verifyConnectionBinding(transitionConnectionBinding(binding, "CONNECTED_UNVERIFIED"), "evidence-out1");
  const degraded = transitionConnectionBinding(verified, "DEGRADED");
  const revoked = transitionConnectionBinding(degraded, "REVOKED");

  const degradedView = composeOperationalObservabilityView({ connections: [degraded] });
  assert.equal(degradedView.connections[0]?.degraded, true);
  assert.equal(degradedView.connections[0]?.killSwitchEngaged, false);

  const revokedView = composeOperationalObservabilityView({ connections: [revoked] });
  assert.equal(revokedView.connections[0]?.killSwitchEngaged, true);
});

function freshConfigStore(): FileDurableConfigurationPolicyDecisionStore {
  return new FileDurableConfigurationPolicyDecisionStore(mkdtempSync(join(tmpdir(), "os-v1-07-")));
}

function platformControl(overrides: Record<string, unknown> = {}) {
  return {
    kind: "CONFIG",
    scope: "PLATFORM",
    key: "theme",
    sourceRef: "platform-theme-default",
    version: "1",
    identity: {},
    ...overrides,
  };
}

test("LKG1 (last-known-good rollback, cited/re-demonstrated): rollbackConfigurationPolicyDecision succeeds to a prior entry with no protected-floor conflict", () => {
  const store = freshConfigStore();
  const identity = { tenantId: tenantScope.tenantId };
  const first = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl()],
    decisionId: "d1",
    now: "2026-10-09T00:00:00.000Z",
  });
  resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "d2",
    now: "2026-10-09T00:01:00.000Z",
  });
  const authority = createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  const result = rollbackConfigurationPolicyDecision({
    store,
    identity,
    authority,
    rollbackToDecisionId: "d1",
    currentControls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "d3",
    now: "2026-10-09T00:02:00.000Z",
  });
  assert.equal(result.kind, "ROLLED_BACK");
  assert.ok(result.kind === "ROLLED_BACK");
  assert.deepEqual(result.entry.resolution, first.resolution);
});

test("LKG2 (rollback blocked by newer protected floor, cited): BLOCKED_PROTECTED_FLOOR_CONFLICT with zero mutation", () => {
  const store = freshConfigStore();
  const identity = { tenantId: tenantScope.tenantId };
  resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl({ protectedFloor: false })],
    decisionId: "d1",
    now: "2026-10-09T00:00:00.000Z",
  });
  const authority = createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  const result = rollbackConfigurationPolicyDecision({
    store,
    identity,
    authority,
    rollbackToDecisionId: "d1",
    currentControls: [platformControl({ sourceRef: "platform-theme-protected", version: "99", protectedFloor: true })],
    decisionId: "d2",
    now: "2026-10-09T00:01:00.000Z",
  });
  assert.equal(result.kind, "BLOCKED_PROTECTED_FLOOR_CONFLICT");
  const history = store.getDecisionProjectionHistory(tenantScope.tenantId, encodeKey(identity));
  assert.equal(history.length, 1, "a blocked rollback must append nothing");
});

function encodeKey(identity: { tenantId: string }): string {
  return JSON.stringify([identity.tenantId, null, null, null, null]);
}

test("RIF1 (rollback during in-flight work, NEW composition): config rollback succeeds while a same-scope OutcomeJob run is actively RUNNING, and that run's own event log is unchanged afterward", () => {
  const store = freshConfigStore();
  const identity = { tenantId: tenantScope.tenantId, jobId: job.jobId };
  resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl()],
    decisionId: "d1",
    now: "2026-10-09T00:00:00.000Z",
  });
  resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "d2",
    now: "2026-10-09T00:01:00.000Z",
  });

  const events: OutcomeJobExecutionEvent[] = [
    ev({ type: "ACCEPTED", attempt: 1, sequence: 1 }),
    ev({ type: "ATTEMPT_STARTED", attempt: 1, sequence: 1 }),
    ev({ type: "PROGRESS", attempt: 1, sequence: 2, progressRef: "progress-1" }),
  ];
  const runStateBefore = reconstructOutcomeJobExecutionRunState(events);
  if (runStateBefore === undefined) throw new Error("fixture error");
  assert.equal(runStateBefore.status, "RUNNING");

  const authority = createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  const rollbackResult = rollbackConfigurationPolicyDecision({
    store,
    identity,
    authority,
    rollbackToDecisionId: "d1",
    currentControls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "d3",
    now: "2026-10-09T00:05:00.000Z",
  });
  assert.equal(rollbackResult.kind, "ROLLED_BACK");

  // Re-fold the SAME event log after the rollback - the run's own durable
  // truth is untouched by a wholly separate (config/policy) domain's mutation.
  const runStateAfter = reconstructOutcomeJobExecutionRunState(events);
  assert.deepEqual(runStateAfter, runStateBefore);
});

test("STALE1 (stale config, cited/re-demonstrated): resolveAndProjectConfigurationPolicyDecision reports stale:true + drift when controls changed", () => {
  const store = freshConfigStore();
  const identity = { tenantId: tenantScope.tenantId };
  resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl()],
    decisionId: "d1",
    now: "2026-10-09T00:00:00.000Z",
  });
  const second = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "d2",
    now: "2026-10-09T00:01:00.000Z",
  });
  assert.equal(second.stale, true);
  assert.equal(second.drift.length, 1);
  assert.equal(second.drift[0]?.key, "theme");
});
