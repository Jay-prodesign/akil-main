import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthorityContext, type AuthorityContext } from "../src/domain/authority.js";
import {
  authorizedTransitionOutcomeJob,
  authorizedVerifyOutcomeJob,
  MissingExecutionRoutingRequirementError,
} from "../src/application/authorized-outcome-job-operations.js";
import { createExecutionRoutingRequirementRegistry } from "../src/domain/outcome-job-routing-execution.js";
import { enterExceptionState, recoverFromExceptionState, type OutcomeJob } from "../src/domain/outcome-job.js";
import type { OutcomeJobSpec } from "../src/domain/outcome-job-spec.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult } from "../src/domain/verification-result.js";
import { resolveServiceCapabilityRoute } from "../src/domain/service-capability-routing.js";
import {
  createExecutionEconomicsLineage,
  recordExecutionEconomicsEvent,
  EMPTY_EXECUTION_ECONOMICS_LEDGER,
  appendExecutionEconomicsEvent,
  selectExecutionEconomicsEvents,
  resolveTotalDeliveryCost,
} from "../src/domain/execution-economics-attribution.js";
import { buildClientProjectSnapshot } from "../src/domain/client-project-snapshot.js";
import { buildAdvisorResult } from "../src/domain/delivery-advisor.js";
import {
  WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START,
  WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
  WEBSITE_BUILD_V1_RECIPE_ADMISSION,
  WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS,
  WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING,
  WEBSITE_BUILD_V1_BOUND_JOBS,
  WEBSITE_BUILD_V1_RECIPE_BINDING_CAPABILITY_ADMISSION,
  WEBSITE_BUILD_V1_RECIPE_BINDING_CONNECTION_BINDING,
} from "../src/fixtures/website-build-v1-recipe-binding.js";
import { WEBSITE_BUILD_V1_RECIPE } from "../src/fixtures/website-build-v1-recipe.js";

/**
 * Brain PR #66 F2/F3 correction: a deterministic composed WEBSITE_BUILD_v1
 * proof crossing capability-eligibility/execution-authority separation,
 * authorized execute -> governed BLOCKED/RECOVERING evidence continuity ->
 * PASSED verification, same-lineage/foreign-lineage MET isolation, and
 * runtime customer-safety leakage assertions - all on the ONE real
 * cold-start lineage the CXP-001A composition contract locked (AA-005
 * Rev22/Rev23), not synthetic identities.
 */
const coldStart = WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START;

function authority(): AuthorityContext {
  return createAuthorityContext({
    tenantScope: coldStart.tenantScope,
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: true,
  });
}

function findSpec(requirementId: string): OutcomeJobSpec {
  const spec = WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS.find((s) => s.requirementId === requirementId);
  assert.ok(spec !== undefined, `expected a spec for requirement "${requirementId}"`);
  return spec as OutcomeJobSpec;
}

function findJob(jobs: ReadonlyArray<OutcomeJob>, jobId: string): OutcomeJob {
  const job = jobs.find((j) => (j.jobId as string) === jobId);
  assert.ok(job !== undefined, `expected a job with jobId "${jobId}"`);
  return job as OutcomeJob;
}

test("CXP-001A composed lifecycle: capability eligibility, execution routing, BLOCKED/RECOVERING continuity and verification all cross the same real admitted/wired lineage", () => {
  const spec = findSpec("discovery-evidence-intake");
  const draftJob = findJob(WEBSITE_BUILD_V1_BOUND_JOBS, spec.specId);
  assert.equal(draftJob.state, "DRAFT");

  const auth = authority();
  const qualifiedJob = authorizedTransitionOutcomeJob(auth, draftJob, "QUALIFIED");
  const readyJob = authorizedTransitionOutcomeJob(auth, qualifiedJob, "READY");

  // Capability eligibility (a customer-facing VERIFIED_AVAILABLE fact) is
  // structurally distinct from OutcomeJob execution authority: even though
  // this project's capability is VERIFIED_AVAILABLE, EXECUTING fails closed
  // with no ExecutionRoutingRequirement ever admitted for this exact job.
  assert.equal(WEBSITE_BUILD_V1_RECIPE_BINDING_CAPABILITY_ADMISSION.status, "VERIFIED_AVAILABLE");
  assert.throws(
    () => authorizedTransitionOutcomeJob(auth, readyJob, "EXECUTING"),
    MissingExecutionRoutingRequirementError,
  );

  // ServiceCapabilityRoute (capability-eligibility routing) is a distinct
  // dimension from job-execution authority - it caps out at READ_ONLY and
  // carries no execution-authorization surface of its own.
  const route = resolveServiceCapabilityRoute({
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    serviceFamilyRef: "website-build",
    admission: WEBSITE_BUILD_V1_RECIPE_BINDING_CAPABILITY_ADMISSION,
    connectionBinding: WEBSITE_BUILD_V1_RECIPE_BINDING_CONNECTION_BINDING,
  });
  assert.equal(route.executionMaturity, "READ_ONLY");

  const registry = createExecutionRoutingRequirementRegistry();
  const requirement = registry.admitManualExecutionAllowedFromServiceCatalogAdmission({
    job: readyJob,
    spec,
    admission: WEBSITE_BUILD_V1_RECIPE_ADMISSION,
    admittedAt: "2026-09-16T00:00:00.000Z",
  });
  assert.equal(requirement.policy, "MANUAL_EXECUTION_ALLOWED");

  const executingJob = authorizedTransitionOutcomeJob(auth, readyJob, "EXECUTING", registry);
  assert.equal(executingJob.state, "EXECUTING");

  // Governed BLOCKED/RECOVERING evidence continuity via the existing
  // exception-state primitives (no application-layer wrapper exists for
  // these transitions - the domain functions are the authorized path).
  const { job: blockedJob, auditEvent: blockedEvent } = enterExceptionState({
    job: executingJob,
    to: "BLOCKED",
    eventId: "evt-cxp-001a-blocked-1",
    actorRef: "worker:reference-cxp-001a",
    timestamp: "2026-09-16T00:05:00.000Z",
    reason: "temporary provider outage",
  });
  assert.equal(blockedJob.state, "BLOCKED");
  assert.equal(blockedEvent.eventType, "EXCEPTION_STATE_ENTERED:BLOCKED");

  const { job: recoveredJob, auditEvent: recoveredEvent } = recoverFromExceptionState({
    job: blockedJob,
    authority: auth,
    to: "EXECUTING",
    eventId: "evt-cxp-001a-recovered-1",
    actorRef: "worker:reference-cxp-001a",
    timestamp: "2026-09-16T00:10:00.000Z",
    reason: "provider outage resolved",
    evidenceRef: "evidence:cxp-001a-recovery-1",
  });
  assert.equal(recoveredJob.state, "EXECUTING");
  assert.equal(recoveredEvent.eventType, "EXCEPTION_STATE_RECOVERED:BLOCKED->EXECUTING");
  // recovery never skips verification: recovering back to EXECUTING never
  // itself produces VERIFIED.
  assert.notEqual((recoveredJob as OutcomeJob).state, "VERIFIED");

  const verifyingJob = authorizedTransitionOutcomeJob(auth, recoveredJob, "VERIFYING");
  assert.equal(verifyingJob.state, "VERIFYING");

  const evidence = createEvidenceReference({
    job: verifyingJob,
    evidenceId: "ev-cxp-001a-discovery",
    evidenceType: "discovery-evidence-review",
    sourceLocator: "internal://reference-fixtures/cxp-001a/discovery-evidence-review",
    capturedAt: "2026-09-16T00:15:00.000Z",
  });
  const verificationResult = createVerificationResult({
    verificationId: "verif-cxp-001a-discovery",
    job: verifyingJob,
    evidence,
    verificationRequirementRef: spec.requirementId,
    status: "PASSED",
  });
  const verifiedJob = authorizedVerifyOutcomeJob(auth, verifyingJob, verificationResult);
  assert.equal(verifiedJob.state, "VERIFIED");
});

test("CXP-001A MET same-lineage proof: execution-economics events bind to the exact composed tenant/project/planVersion/job/task/run/attempt identity and foreign-job/foreign-planVersion/foreign-attempt events are all excluded from the scoped total", () => {
  const spec = findSpec("discovery-evidence-intake");
  const job = findJob(WEBSITE_BUILD_V1_BOUND_JOBS, spec.specId);
  const otherSpec = findSpec("content-information-architecture");
  const otherJob = findJob(WEBSITE_BUILD_V1_BOUND_JOBS, otherSpec.specId);

  const lineage = createExecutionEconomicsLineage({
    tenantScope: coldStart.tenantScope,
    projectId: coldStart.project.projectId,
    planId: coldStart.plan.planId,
    planVersion: coldStart.plan.version,
    jobId: job.jobId,
    taskRef: spec.requirementId,
    runRef: "run-cxp-001a-1",
    attemptRef: "attempt-1",
  });
  const event = recordExecutionEconomicsEvent({
    lineage,
    idempotencyKey: "cxp-001a-discovery-attempt-1",
    usageSource: "OTHER_ADMITTED",
    costBuckets: [
      { kind: "MARGINAL_CASH", amount: { presence: "REPORTED", amountMinorUnits: 500, currency: "USD" } },
      { kind: "ALLOCATED_SUBSCRIPTION", amount: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" } },
      { kind: "HUMAN_SHADOW", amount: { presence: "REPORTED", amountMinorUnits: 2000, currency: "USD" } },
    ],
    time: { activeTimeMs: 60000, wallTimeMs: 90000, humanMinutes: 5, reworkCount: 0, independentQaPerformed: true },
    capturedAt: "2026-09-16T00:20:00.000Z",
  });
  // no real worker/provider/model/route facts were exposed for this
  // fixture, so attribution stays honestly empty rather than fabricated.
  assert.deepEqual(event.attribution, {});

  const foreignLineage = createExecutionEconomicsLineage({
    tenantScope: coldStart.tenantScope,
    projectId: coldStart.project.projectId,
    planId: coldStart.plan.planId,
    planVersion: coldStart.plan.version,
    jobId: otherJob.jobId,
    taskRef: otherSpec.requirementId,
    runRef: "run-cxp-001a-1",
    attemptRef: "attempt-1",
  });
  const foreignEvent = recordExecutionEconomicsEvent({
    lineage: foreignLineage,
    idempotencyKey: "cxp-001a-foreign-job-attempt-1",
    usageSource: "OTHER_ADMITTED",
    costBuckets: [
      { kind: "MARGINAL_CASH", amount: { presence: "REPORTED", amountMinorUnits: 999_999, currency: "USD" } },
      { kind: "ALLOCATED_SUBSCRIPTION", amount: { presence: "REPORTED", amountMinorUnits: 999_999, currency: "USD" } },
      { kind: "HUMAN_SHADOW", amount: { presence: "REPORTED", amountMinorUnits: 999_999, currency: "USD" } },
    ],
    capturedAt: "2026-09-16T00:20:00.000Z",
  });

  // Differs from the real event ONLY in planVersion - proves this exact
  // composed lineage isolates by ProjectPlanVersion identity {planId,
  // version}, not planId alone (Brain PR #66 F4).
  const foreignVersionLineage = createExecutionEconomicsLineage({
    tenantScope: coldStart.tenantScope,
    projectId: coldStart.project.projectId,
    planId: coldStart.plan.planId,
    planVersion: coldStart.plan.version + 1,
    jobId: job.jobId,
    taskRef: spec.requirementId,
    runRef: "run-cxp-001a-1",
    attemptRef: "attempt-1",
  });
  const foreignVersionEvent = recordExecutionEconomicsEvent({
    lineage: foreignVersionLineage,
    idempotencyKey: "cxp-001a-foreign-plan-version-attempt-1",
    usageSource: "OTHER_ADMITTED",
    costBuckets: [
      { kind: "MARGINAL_CASH", amount: { presence: "REPORTED", amountMinorUnits: 999_999, currency: "USD" } },
      { kind: "ALLOCATED_SUBSCRIPTION", amount: { presence: "REPORTED", amountMinorUnits: 999_999, currency: "USD" } },
      { kind: "HUMAN_SHADOW", amount: { presence: "REPORTED", amountMinorUnits: 999_999, currency: "USD" } },
    ],
    capturedAt: "2026-09-16T00:20:00.000Z",
  });

  // Differs from the real event ONLY in runRef/attemptRef (same job, same
  // taskRef) - proves the composed selector isolates by the full exact
  // task/run/attempt tuple, not merely down to job.
  const foreignAttemptLineage = createExecutionEconomicsLineage({
    tenantScope: coldStart.tenantScope,
    projectId: coldStart.project.projectId,
    planId: coldStart.plan.planId,
    planVersion: coldStart.plan.version,
    jobId: job.jobId,
    taskRef: spec.requirementId,
    runRef: "run-cxp-001a-1",
    attemptRef: "attempt-2",
  });
  const foreignAttemptEvent = recordExecutionEconomicsEvent({
    lineage: foreignAttemptLineage,
    idempotencyKey: "cxp-001a-foreign-attempt-2",
    usageSource: "OTHER_ADMITTED",
    costBuckets: [
      { kind: "MARGINAL_CASH", amount: { presence: "REPORTED", amountMinorUnits: 999_999, currency: "USD" } },
      { kind: "ALLOCATED_SUBSCRIPTION", amount: { presence: "REPORTED", amountMinorUnits: 999_999, currency: "USD" } },
      { kind: "HUMAN_SHADOW", amount: { presence: "REPORTED", amountMinorUnits: 999_999, currency: "USD" } },
    ],
    capturedAt: "2026-09-16T00:20:00.000Z",
  });

  let ledger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  ledger = appendExecutionEconomicsEvent(ledger, event);
  ledger = appendExecutionEconomicsEvent(ledger, foreignEvent);
  ledger = appendExecutionEconomicsEvent(ledger, foreignVersionEvent);
  ledger = appendExecutionEconomicsEvent(ledger, foreignAttemptEvent);

  const scoped = selectExecutionEconomicsEvents(ledger, {
    tenantId: coldStart.tenantScope.tenantId,
    projectId: coldStart.project.projectId,
    planId: coldStart.plan.planId,
    planVersion: coldStart.plan.version,
    jobId: job.jobId,
    taskRef: spec.requirementId,
    runRef: "run-cxp-001a-1",
    attemptRef: "attempt-1",
  });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]?.idempotencyKey, "cxp-001a-discovery-attempt-1");

  const total = resolveTotalDeliveryCost(scoped);
  assert.equal(total.status, "COMPUTED");
  if (total.status === "COMPUTED") {
    assert.equal(total.amountMinorUnits, 2600);
    assert.equal(total.currency, "USD");
  }
});

test("CXP-001A customer-safety proof: the composed customer-safe snapshot/advisor never leaks internal cost, secrets, prompts, provider internals, raw recovery reasons or fabricated ETA/savings/autonomy claims", () => {
  const snapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    project: coldStart.project,
    jobs: WEBSITE_BUILD_V1_BOUND_JOBS,
    plan: coldStart.plan,
    capabilityAdmissions: [WEBSITE_BUILD_V1_RECIPE_BINDING_CAPABILITY_ADMISSION],
  });
  const result = buildAdvisorResult({
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    snapshot,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    binding: WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING,
  });

  assert.equal(result.status, "RECOMMENDATIONS_AVAILABLE");
  assert.deepEqual(result.observation.eta, { status: "UNKNOWN" });
  assert.deepEqual(result.observation.applicableRecipeRef, {
    recipeId: WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING.boundRecipeId,
    version: WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING.consumedRecipeVersion,
  });

  const serialized = (JSON.stringify(snapshot) + JSON.stringify(result)).toLowerCase();
  const forbidden = [
    "secret",
    "credential",
    "token",
    "password",
    "margin",
    "cost",
    "prompt",
    "amountminorunits",
    "provider outage",
    "autonomy",
    "saving",
  ];
  for (const term of forbidden) {
    assert.equal(serialized.includes(term), false, `found forbidden term "${term}" in customer-safe surface`);
  }
});
