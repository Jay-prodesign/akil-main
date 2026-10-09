import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createAuthorityContext, type AuthorityContext } from "../src/domain/authority.js";
import {
  createOutcomeJob,
  transitionOutcomeJob,
  enterExceptionState,
  recoverFromExceptionState,
  verifyOutcomeJob,
  InvalidExceptionRecoveryError,
  type OutcomeJob,
} from "../src/domain/outcome-job.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult } from "../src/domain/verification-result.js";
import { ProtectedActionNotAuthorizedError, CrossTenantAuthorityError } from "../src/domain/authority.js";

function fixture(tenantSuffix = "a") {
  const tenantScope = createTenantScope(`tenant-recovery-${tenantSuffix}`);
  const customer = createCustomer({
    tenantScope,
    customerId: `cust-recovery-${tenantSuffix}`,
    displayName: "Recovery Customer",
  });
  const project = createProject({
    tenantScope,
    customer,
    projectId: `proj-recovery-${tenantSuffix}`,
    ownerRef: "owner-recovery",
    state: "active",
  });
  return { tenantScope, customer, project };
}

function grantedAuthority(tenantScope: ReturnType<typeof createTenantScope>): AuthorityContext {
  return createAuthorityContext({
    tenantScope,
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: true,
  });
}

function jobInExecuting(): { tenantScope: ReturnType<typeof createTenantScope>; job: OutcomeJob } {
  const { tenantScope, customer, project } = fixture();
  const draft = createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId: "job-recovery-1",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });
  const executing = transitionOutcomeJob(transitionOutcomeJob(transitionOutcomeJob(draft, "QUALIFIED"), "READY"), "EXECUTING");
  return { tenantScope, job: executing };
}

test("recovery1: a job in BLOCKED can recover into EXECUTING with granted authority and evidence, producing a new AuditEvent that preserves (does not erase) the prior exception-entry AuditEvent", () => {
  const { tenantScope, job } = jobInExecuting();
  const authority = grantedAuthority(tenantScope);
  const { job: blockedJob, auditEvent: entryEvent } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-enter-1",
    actorRef: "provider:webhook",
    timestamp: "2026-09-11T00:00:00.000Z",
    reason: "provider timeout",
  });
  assert.equal(blockedJob.state, "BLOCKED");

  const { job: recoveredJob, auditEvent: recoveryEvent } = recoverFromExceptionState({
    job: blockedJob,
    authority,
    to: "EXECUTING",
    eventId: "evt-recover-1",
    actorRef: "provider:webhook",
    timestamp: "2026-09-11T00:05:00.000Z",
    reason: "provider recovered, retry succeeded",
    evidenceRef: "evidence:retry-success-200",
  });
  assert.equal(recoveredJob.state, "EXECUTING");
  assert.equal(recoveryEvent.eventType, "EXCEPTION_STATE_RECOVERED:BLOCKED->EXECUTING");
  assert.deepEqual(recoveryEvent.relatedRefs, ["evidence:retry-success-200"]);

  // Both audit events remain distinct, independently valid records - the
  // recovery never mutates or erases the entry event.
  assert.notEqual(entryEvent.eventId, recoveryEvent.eventId);
  assert.equal(entryEvent.eventType, "EXCEPTION_STATE_ENTERED:BLOCKED");
});

test("recovery2 (adversarial): recovery without canPerformProtectedActions authority is rejected", () => {
  const { tenantScope, job } = jobInExecuting();
  const { job: blockedJob } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-enter-2",
    actorRef: "provider:webhook",
    timestamp: "2026-09-11T00:00:00.000Z",
    reason: "provider timeout",
  });
  const unauthorized = createAuthorityContext({
    tenantScope,
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: false,
  });

  assert.throws(
    () =>
      recoverFromExceptionState({
        job: blockedJob,
        authority: unauthorized,
        to: "EXECUTING",
        eventId: "evt-recover-2",
        actorRef: "provider:webhook",
        timestamp: "2026-09-11T00:05:00.000Z",
        reason: "attempted recovery without protected-action authority",
        evidenceRef: "evidence:retry-success-200",
      }),
    ProtectedActionNotAuthorizedError,
  );
});

test("recovery3 (adversarial): recovery with no evidenceRef is rejected even with granted authority", () => {
  const { tenantScope, job } = jobInExecuting();
  const authority = grantedAuthority(tenantScope);
  const { job: blockedJob } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-enter-3",
    actorRef: "provider:webhook",
    timestamp: "2026-09-11T00:00:00.000Z",
    reason: "provider timeout",
  });

  assert.throws(
    () =>
      recoverFromExceptionState({
        job: blockedJob,
        authority,
        to: "EXECUTING",
        eventId: "evt-recover-3",
        actorRef: "provider:webhook",
        timestamp: "2026-09-11T00:05:00.000Z",
        reason: "no evidence provided",
        evidenceRef: "",
      }),
    InvalidExceptionRecoveryError,
  );
});

test("recovery4 (adversarial): recovery from a job that is not BLOCKED/RECOVERING (e.g. EXECUTING, ESCALATED, STOPPED) is rejected", () => {
  const { tenantScope, job } = jobInExecuting();
  const authority = grantedAuthority(tenantScope);

  // Directly EXECUTING (never entered an exception state at all).
  assert.throws(
    () =>
      recoverFromExceptionState({
        job,
        authority,
        to: "EXECUTING",
        eventId: "evt-recover-4a",
        actorRef: "actor",
        timestamp: "2026-09-11T00:05:00.000Z",
        reason: "reason",
        evidenceRef: "evidence:x",
      }),
    InvalidExceptionRecoveryError,
  );

  const { job: escalatedJob } = enterExceptionState({
    job,
    to: "ESCALATED",
    eventId: "evt-enter-4b",
    actorRef: "actor",
    timestamp: "2026-09-11T00:00:00.000Z",
    reason: "needs human escalation",
  });
  assert.throws(
    () =>
      recoverFromExceptionState({
        job: escalatedJob,
        authority,
        to: "EXECUTING",
        eventId: "evt-recover-4b",
        actorRef: "actor",
        timestamp: "2026-09-11T00:05:00.000Z",
        reason: "reason",
        evidenceRef: "evidence:x",
      }),
    InvalidExceptionRecoveryError,
  );

  const { job: stoppedJob } = enterExceptionState({
    job,
    to: "STOPPED",
    eventId: "evt-enter-4c",
    actorRef: "actor",
    timestamp: "2026-09-11T00:00:00.000Z",
    reason: "REFUND for external sale order-x",
  });
  // A STOPPED (governed cancellation/refund/chargeback disposition) job
  // must never be silently un-stopped "as though nothing happened."
  assert.throws(
    () =>
      recoverFromExceptionState({
        job: stoppedJob,
        authority,
        to: "EXECUTING",
        eventId: "evt-recover-4c",
        actorRef: "actor",
        timestamp: "2026-09-11T00:05:00.000Z",
        reason: "attempted resurrection of a stopped disposition",
        evidenceRef: "evidence:x",
      }),
    InvalidExceptionRecoveryError,
  );
});

test("recovery5 (adversarial): recovery target 'to' is restricted to READY/EXECUTING/VERIFYING - VERIFIED, CLOSED and DRAFT/QUALIFIED are all rejected as recovery targets", () => {
  const { tenantScope, job } = jobInExecuting();
  const authority = grantedAuthority(tenantScope);
  const { job: blockedJob } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-enter-5",
    actorRef: "actor",
    timestamp: "2026-09-11T00:00:00.000Z",
    reason: "provider timeout",
  });

  for (const forbiddenTarget of ["VERIFIED", "CLOSED", "DRAFT", "QUALIFIED", "BLOCKED", "NOT_A_STATE"]) {
    assert.throws(
      () =>
        recoverFromExceptionState({
          job: blockedJob,
          authority,
          to: forbiddenTarget,
          eventId: `evt-recover-5-${forbiddenTarget}`,
          actorRef: "actor",
          timestamp: "2026-09-11T00:05:00.000Z",
          reason: "reason",
          evidenceRef: "evidence:x",
        }),
      InvalidExceptionRecoveryError,
      `expected "${forbiddenTarget}" to be rejected as a recovery target`,
    );
  }
});

test("recovery6 (adversarial): cross-tenant authority cannot recover another tenant's job", () => {
  const { job } = jobInExecuting();
  const { job: blockedJob } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-enter-6",
    actorRef: "actor",
    timestamp: "2026-09-11T00:00:00.000Z",
    reason: "provider timeout",
  });
  const foreignAuthority = grantedAuthority(createTenantScope("tenant-recovery-foreign"));

  assert.throws(
    () =>
      recoverFromExceptionState({
        job: blockedJob,
        authority: foreignAuthority,
        to: "EXECUTING",
        eventId: "evt-recover-6",
        actorRef: "actor",
        timestamp: "2026-09-11T00:05:00.000Z",
        reason: "cross-tenant recovery attempt",
        evidenceRef: "evidence:x",
      }),
    CrossTenantAuthorityError,
  );
});

test("recovery7: a recovered job still requires the normal verification gate - it cannot skip straight to VERIFIED/CLOSED, and a FAILED verification still cannot close it", () => {
  const { tenantScope, job } = jobInExecuting();
  const authority = grantedAuthority(tenantScope);
  const { job: blockedJob } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-enter-7",
    actorRef: "actor",
    timestamp: "2026-09-11T00:00:00.000Z",
    reason: "provider timeout",
  });
  const { job: recoveredJob } = recoverFromExceptionState({
    job: blockedJob,
    authority,
    to: "VERIFYING",
    eventId: "evt-recover-7",
    actorRef: "actor",
    timestamp: "2026-09-11T00:05:00.000Z",
    reason: "provider recovered mid-verification-attempt",
    evidenceRef: "evidence:retry-success-200",
  });
  assert.equal(recoveredJob.state, "VERIFYING");

  // Bare execution success (recovery itself) can never directly reach CLOSED.
  assert.throws(() => transitionOutcomeJob(recoveredJob, "CLOSED"));

  const evidence = createEvidenceReference({
    job: recoveredJob,
    evidenceId: "evidence-recovery-7",
    evidenceType: "DELIVERY_PROOF",
    sourceLocator: "https://example.com/evidence",
    capturedAt: "2026-09-11T00:10:00.000Z",
  });
  const failedVerification = createVerificationResult({
    verificationId: "verification-recovery-7-failed",
    job: recoveredJob,
    evidence,
    verificationRequirementRef: "delivery-verified",
    status: "FAILED",
    limitationOrFailureReason: "incomplete",
  });
  assert.throws(() => verifyOutcomeJob(recoveredJob, failedVerification));

  const passedVerification = createVerificationResult({
    verificationId: "verification-recovery-7-passed",
    job: recoveredJob,
    evidence,
    verificationRequirementRef: "delivery-verified",
    status: "PASSED",
  });
  const verifiedJob = verifyOutcomeJob(recoveredJob, passedVerification);
  assert.equal(verifiedJob.state, "VERIFIED");
  const closedJob = transitionOutcomeJob(verifiedJob, "CLOSED");
  assert.equal(closedJob.state, "CLOSED");
});

test("recovery8: full sale-to-close path with a mid-flight temporary failure - execute, fail, recover, verify, close - reaches CLOSED only through the legal path", () => {
  const { tenantScope, job } = jobInExecuting();
  const authority = grantedAuthority(tenantScope);

  const { job: recoveringJob } = enterExceptionState({
    job,
    to: "RECOVERING",
    eventId: "evt-enter-8",
    actorRef: "system:retry-scheduler",
    timestamp: "2026-09-11T00:00:00.000Z",
    reason: "transient provider 503, scheduled retry",
  });
  assert.equal(recoveringJob.state, "RECOVERING");

  const { job: recoveredJob } = recoverFromExceptionState({
    job: recoveringJob,
    authority,
    to: "EXECUTING",
    eventId: "evt-recover-8",
    actorRef: "system:retry-scheduler",
    timestamp: "2026-09-11T00:02:00.000Z",
    reason: "retry succeeded",
    evidenceRef: "evidence:retry-attempt-2-200",
  });
  const verifyingJob = transitionOutcomeJob(recoveredJob, "VERIFYING");
  const evidence = createEvidenceReference({
    job: verifyingJob,
    evidenceId: "evidence-recovery-8",
    evidenceType: "DELIVERY_PROOF",
    sourceLocator: "https://example.com/evidence",
    capturedAt: "2026-09-11T00:10:00.000Z",
  });
  const passedVerification = createVerificationResult({
    verificationId: "verification-recovery-8",
    job: verifyingJob,
    evidence,
    verificationRequirementRef: "delivery-verified",
    status: "PASSED",
  });
  const verifiedJob = verifyOutcomeJob(verifyingJob, passedVerification);
  const closedJob = transitionOutcomeJob(verifiedJob, "CLOSED");
  assert.equal(closedJob.state, "CLOSED");
});
