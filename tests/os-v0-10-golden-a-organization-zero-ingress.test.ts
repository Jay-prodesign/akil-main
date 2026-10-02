import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership, createAssignmentReference } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { requireInternalOsAccess, requireInternalOsProjectAccess, type StaffAccessGrant } from "../src/web/internal-os-access.js";
import {
  bootstrapOrganizationResourceBinding,
  FileDurableOrganizationResourceBindingStore,
} from "../src/domain/durable-organization-resource-binding-store.js";
import { resolveOrganizationResourceBindingStatus } from "../src/domain/organization-resource-binding.js";
import { transitionOutcomeJob, verifyOutcomeJob } from "../src/domain/outcome-job.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult, type VerificationResult } from "../src/domain/verification-result.js";
import type { WorkerInvoker } from "../src/domain/worker-invoker.js";
import { createOutcomeJobExecutionEvent, type OutcomeJobExecutionEvent } from "../src/domain/outcome-job-execution-event.js";
import { applyOutcomeJobExecutionEvent, type OutcomeJobExecutionRunState } from "../src/domain/outcome-job-execution-run-state.js";
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  admitQuotaReservation,
  commitQuotaUsage,
  releaseQuotaReservation,
  findCanonicalLatestForIdempotencyKey,
  EMPTY_QUOTA_LEDGER,
  type QuotaEnvelope,
  type QuotaReservationIdentity,
  type QuotaLedger,
} from "../src/domain/execution-quota-admission.js";
import {
  appendExecutionEconomicsEventAllowingCapturedAtDrift,
  EMPTY_EXECUTION_ECONOMICS_LEDGER,
  type ExecutionEconomicsEvent,
  type ExecutionEconomicsLedger,
} from "../src/domain/execution-economics-attribution.js";
import {
  dispatchOutcomeJobExecutionRun,
  recordExecutionResult,
  advanceOutcomeJobAfterExecutionSuccess,
  type ExecutionEventStore,
  type QuotaAdmissionPort,
  type ExecutionEconomicsPort,
  type CurrentQuotaEnvelopeResolver,
  type QuotaSettlementPeek,
} from "../src/application/outcome-job-execution-runtime.js";
import {
  composeTaskPacketForOutcomeJob,
  resolveNextRunnableGoldenPathAction,
} from "../src/domain/outcome-job-golden-path-composition.js";
import {
  compileGoldenPathActivation,
  GOLDEN_PATH_TENANT_SCOPE,
  GOLDEN_PATH_CUSTOMER,
  GOLDEN_PATH_PROJECT,
  GOLDEN_PATH_OWNERSHIP,
} from "./helpers/golden-path-fixture.js";

/**
 * OS-V0-10 Rev186 F1 (Founder implementation clarification, same scope):
 * Golden A must begin at an authorized principal -> org_akilta -> bounded
 * outcome/project, not a synthetic tenant/customer/project with a bare
 * caller-constructed `AuthorityContext`, and the authenticated-human proof
 * must reuse the already-accepted staff ingress chain
 * (`StaffSessionProvider` -> `requireInternalOsAccess` ->
 * `resolveEffectiveOrganizationAccess`) rather than calling
 * `resolveEffectiveOrganizationAccess` directly - a production IdP/session
 * is intentionally not fabricated here (`createProductionStaffSessionProvider()`
 * remains fail-closed/unauthenticated until separately admitted), so this
 * test uses `createDevFixtureStaffSessionProvider`, the same dev-only
 * mechanical guard `tests/web-internal-os-access.test.ts` already uses,
 * never a production provider. A real `Organization`, a real
 * `OrganizationMembership` with real assignment evidence, a real staff
 * session resolved through `requireInternalOsAccess` (GRANTED), a real
 * `bootstrapOrganizationResourceBinding`/`resolveOrganizationResourceBindingStatus`
 * (READY) - before the already-proven activation/recipe/plan/OutcomeJob
 * -> TaskPacket -> execution -> evidence -> verification -> next-action
 * lineage is exercised on the SAME tenant/customer/project identity. No
 * AKILTA-only bypass, isSystem flag, or second IAM/context system - this
 * is the ordinary OS-V0-01/02/08/09 kernel, consumed exactly as any other
 * Organization would consume it.
 */

class InMemoryExecutionEventStore implements ExecutionEventStore {
  private readonly byRun = new Map<string, OutcomeJobExecutionRunState>();
  private readonly seenEventIds = new Set<string>();

  appendEvent(event: OutcomeJobExecutionEvent): boolean {
    if (this.seenEventIds.has(event.eventId)) {
      return false;
    }
    this.seenEventIds.add(event.eventId);
    const key = JSON.stringify([event.tenantId, event.customerId, event.projectId, event.jobId, event.runId]);
    const current = this.byRun.get(key);
    this.byRun.set(key, applyOutcomeJobExecutionEvent(current, event));
    return true;
  }

  getState(tenantId: string, customerId: string, projectId: string, jobId: string, runId: string): OutcomeJobExecutionRunState | undefined {
    return this.byRun.get(JSON.stringify([tenantId, customerId, projectId, jobId, runId]));
  }
}

class InMemoryQuotaAdmissionStore implements QuotaAdmissionPort {
  private ledger: QuotaLedger = EMPTY_QUOTA_LEDGER;

  admit(input: Parameters<QuotaAdmissionPort["admit"]>[0]) {
    const { ledger, outcome } = admitQuotaReservation({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }

  commit(input: Parameters<QuotaAdmissionPort["commit"]>[0]) {
    const { ledger, outcome } = commitQuotaUsage({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }

  release(input: Parameters<QuotaAdmissionPort["release"]>[0]) {
    const { ledger, outcome } = releaseQuotaReservation({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }

  peekSettlement(input: { identity: QuotaReservationIdentity; idempotencyKey: unknown }): QuotaSettlementPeek {
    if (typeof input.idempotencyKey !== "string") {
      throw new Error("idempotencyKey must be a string");
    }
    const latest = findCanonicalLatestForIdempotencyKey(this.ledger, input.identity.scope.tenantId, input.idempotencyKey);
    if (latest !== undefined && (latest.type === "COMMITTED" || latest.type === "RECONCILIATION_REQUIRED")) {
      return { settled: true, event: latest };
    }
    return { settled: false };
  }
}

class InMemoryExecutionEconomicsStore implements ExecutionEconomicsPort {
  private ledger: ExecutionEconomicsLedger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  recordSettledAttempt(event: ExecutionEconomicsEvent): void {
    this.ledger = appendExecutionEconomicsEventAllowingCapturedAtDrift(this.ledger, event);
  }
}

function acceptingInvoker(callLog: unknown[]): WorkerInvoker {
  return {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async (input) => {
      callLog.push(input.outcomeJobExecution);
      return { accepted: true };
    },
  };
}

function foundingPrincipalContext() {
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: "org-akilta-golden-a",
      tenantScope: GOLDEN_PATH_TENANT_SCOPE,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });

  const membership = createOrganizationMembership({
    membershipId: "membership-golden-a-founder",
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    principalRef: "principal-golden-a-founder",
    role: "STAFF",
  });

  const assignment = createAssignmentReference({
    assignmentId: "assignment-golden-a-founder",
    membership,
    customerId: GOLDEN_PATH_CUSTOMER.customerId,
    projectId: GOLDEN_PATH_PROJECT.projectId,
  });

  const authority = createAuthorityContext({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    permissions: ["EXECUTE", "WRITE", "READ"],
    canPerformProtectedActions: true,
  });

  const principal = createAuthenticatedStaffPrincipal({
    principalId: "principal-golden-a-founder",
    displayName: "Golden A Founding Principal",
  });
  const sessionToken = "token-golden-a-founder";
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-02T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const grant: StaffAccessGrant = { membership, authority, assignments: [assignment] };

  const internalOsAccess = requireInternalOsAccess({
    provider,
    sessionToken,
    organization,
    grants: [grant],
  });

  return { organization, membership, authority, access: internalOsAccess.access, internalOsAccess };
}

test("Rev186 F1: Golden A begins at authorized principal -> org_akilta -> bounded project through resolveEffectiveOrganizationAccess (GRANTED)", () => {
  const { access } = foundingPrincipalContext();
  assert.equal(access.decision, "GRANTED");
  assert.equal(access.role, "MEMBER");
  assert.equal(access.canPerformProtectedActions, true);
});

test("Rev186 F1: Golden A's authorized principal is bound through a real bootstrapped OrganizationResourceBinding resolving READY, not a synthetic/bare context", () => {
  const { organization, membership } = foundingPrincipalContext();
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-golden-a-org-zero-"));
  const store = new FileDurableOrganizationResourceBindingStore(baseDir);

  const bootstrap = bootstrapOrganizationResourceBinding({
    store,
    organization,
    memberships: [membership],
    project: GOLDEN_PATH_PROJECT,
    ownership: GOLDEN_PATH_OWNERSHIP,
    boundAt: "2026-10-02T00:00:02.000Z",
  });
  assert.equal(bootstrap.created, true);

  const status = resolveOrganizationResourceBindingStatus({
    binding: bootstrap.binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: GOLDEN_PATH_PROJECT,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(status.state, "READY");
});

test("Rev186 F1 end-to-end: authorized org_akilta principal + resource binding -> real activation/plan/OutcomeJob -> TaskPacket -> dispatch -> SUCCEEDED -> VERIFYING -> independent verification -> VERIFIED -> CLOSE_JOB", async () => {
  const { organization, membership, authority, internalOsAccess } = foundingPrincipalContext();
  assert.equal(internalOsAccess.access.decision, "GRANTED");
  // "Bounded outcome/project": re-check access scoped to the exact project
  // Golden A will operate against, not merely organization-level access.
  const access = requireInternalOsProjectAccess({ organization, context: internalOsAccess, project: GOLDEN_PATH_PROJECT });
  assert.equal(access.decision, "GRANTED");

  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-golden-a-org-zero-e2e-"));
  const store = new FileDurableOrganizationResourceBindingStore(baseDir);
  const bootstrap = bootstrapOrganizationResourceBinding({
    store,
    organization,
    memberships: [membership],
    project: GOLDEN_PATH_PROJECT,
    ownership: GOLDEN_PATH_OWNERSHIP,
    boundAt: "2026-10-02T00:00:02.000Z",
  });
  const bindingStatus = resolveOrganizationResourceBindingStatus({
    binding: bootstrap.binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: GOLDEN_PATH_PROJECT,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(bindingStatus.state, "READY");

  // Only now - with a GRANTED authorized principal and a READY Organization
  // Zero resource binding both independently proven - does Golden A proceed
  // onto the already-proven activation/plan/OutcomeJob composition, reusing
  // the SAME authority that was just verified current, not a fresh one.
  const compilation = compileGoldenPathActivation("plan-gpa-org-zero", "sold-gpa-org-zero");
  assert.equal(compilation.profile.state, "READY");
  const wiredJob = compilation.jobs[0]!;
  const spec = compilation.specs.find((s) => (s.specId as unknown as string) === (wiredJob.jobId as unknown as string))!;
  const readyJob = transitionOutcomeJob(transitionOutcomeJob(wiredJob, "QUALIFIED"), "READY");

  const packet = composeTaskPacketForOutcomeJob({
    job: readyJob,
    spec,
    activation: compilation.profile,
    projectOwnership: GOLDEN_PATH_OWNERSHIP,
    baseIdentity: "sha-org-zero-1",
    acceptanceCriteria: ["the golden path requirement is satisfied"],
  });
  assert.equal(packet.nextAuthorizedAction.startsWith("AKILTA:DISPATCH_EXECUTION"), true);
  // The authority consumed downstream is the exact same one just proven
  // current through resolveEffectiveOrganizationAccess - never a fresh,
  // unverified context.
  assert.deepEqual(access.permissions, authority.permissions);

  // Rev187 F1 runtime residual: Golden A's authorized-principal/resource-
  // binding witness must carry through the REAL dispatch/WorkerInvoker/
  // execution runtime (dispatchOutcomeJobExecutionRun/recordExecutionResult/
  // advanceOutcomeJobAfterExecutionSuccess, unmodified) before evidence/
  // verification/next-action - never a direct transitionOutcomeJob shortcut
  // past the real execution composition.
  const executingJob = transitionOutcomeJob(readyJob, "EXECUTING");
  const quotaScope = createQuotaAdmissionScope({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customerId: GOLDEN_PATH_CUSTOMER.customerId,
    projectId: GOLDEN_PATH_PROJECT.projectId,
    planId: compilation.profile.planId,
    planVersion: compilation.profile.planVersion,
  });
  const quotaEnvelope: QuotaEnvelope = createQuotaEnvelope({
    scope: quotaScope,
    envelopeRef: "envelope-gpa-org-zero",
    sourceFingerprint: "qfp-gpa-org-zero",
    unitLimit: 1_000_000,
  });
  const quotaAdmission = new InMemoryQuotaAdmissionStore();
  const economicsPort = new InMemoryExecutionEconomicsStore();
  const eventStore = new InMemoryExecutionEventStore();
  const quotaEnvelopeResolver: CurrentQuotaEnvelopeResolver = { resolveCurrentQuotaEnvelope: () => quotaEnvelope };
  const dispatchBase = {
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    now: "2026-10-02T00:00:03.000Z",
    executorKind: "INJECTED" as const,
    expectedFingerprint: compilation.profile.sourceFingerprint,
    currentFingerprint: compilation.profile.sourceFingerprint,
    currentActivationPlanId: compilation.profile.planId,
    currentActivationPlanVersion: compilation.profile.planVersion,
    economicsPort,
    economicsTaskRef: "task-ref-gpa-org-zero",
    economicsUsageSource: "OTHER_ADMITTED" as const,
    taskId: "task-gpa-org-zero",
    branch: "claude/os-v0-10-golden-a-org-zero",
    checkpointSha: "sha-org-zero-1",
    quotaAdmission,
    quotaEnvelope,
    currentQuotaSourceFingerprint: "qfp-gpa-org-zero",
    quotaEnvelopeResolver,
    estimatedCost: { presence: "REPORTED" as const, amountMinorUnits: 10, currency: "USD" },
  };
  const callLog: unknown[] = [];
  const invoker = acceptingInvoker(callLog);
  const dispatchResult = await dispatchOutcomeJobExecutionRun({
    ...dispatchBase,
    job: executingJob,
    authority,
    runId: "run-gpa-org-zero",
    correlationId: "corr-gpa-org-zero",
    store: eventStore,
    invoker,
  });
  assert.equal(dispatchResult.invoked, true);
  assert.equal(callLog.length, 1);

  const succeededState = await recordExecutionResult({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job: executingJob,
    currentState: dispatchResult.state,
    now: "2026-10-02T00:00:10.000Z",
    type: "SUCCEEDED",
    store: eventStore,
  });
  const afterSuccessAction = resolveNextRunnableGoldenPathAction({ job: executingJob, activation: compilation.profile, executionState: succeededState });
  assert.equal(afterSuccessAction.code, "ADVANCE_TO_VERIFYING");

  const succeededJob = advanceOutcomeJobAfterExecutionSuccess(executingJob, succeededState);
  assert.equal(succeededJob.state, "VERIFYING");

  const evidence = createEvidenceReference({
    job: succeededJob,
    evidenceId: "ev-org-zero-1",
    evidenceType: "TEST_RESULT",
    sourceLocator: "internal://golden-path/org-zero",
    capturedAt: "2026-10-02T00:00:20.000Z",
  });
  const verification: VerificationResult = createVerificationResult({
    verificationId: "verif-org-zero-1",
    job: succeededJob,
    evidence,
    verificationRequirementRef: "req-golden-path",
    status: "PASSED",
  });
  const verifiedJob = verifyOutcomeJob(succeededJob, verification);
  assert.equal(verifiedJob.state, "VERIFIED");

  const closeAction = resolveNextRunnableGoldenPathAction({ job: verifiedJob, activation: compilation.profile });
  assert.equal(closeAction.code, "CLOSE_JOB");
});
