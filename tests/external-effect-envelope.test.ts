import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createAuthorityContext, CrossTenantAuthorityError, ProtectedActionNotAuthorizedError } from "../src/domain/authority.js";
import {
  createExternalEffectIntent,
  startExternalEffectAttempt,
  reportExternalEffectOutcome,
  verifyExternalEffectReadback,
  retryExternalEffectAttempt,
  rollbackExternalEffectAttempt,
  isRecognizedExternalEffectAttemptState,
  InvalidExternalEffectError,
  InvalidExternalEffectRecoveryError,
} from "../src/domain/external-effect-envelope.js";

const tenantScope = createTenantScope("tenant-eff-1");

function grantedAuthority() {
  return createAuthorityContext({ tenantScope, permissions: ["WRITE"], canPerformProtectedActions: true });
}

function readOnlyAuthority() {
  return createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });
}

function crossTenantAuthority() {
  return createAuthorityContext({
    tenantScope: createTenantScope("tenant-eff-other"),
    permissions: ["WRITE"],
    canPerformProtectedActions: true,
  });
}

function noApprovalIntent(overrides?: Partial<{ retryClassification: string }>) {
  return createExternalEffectIntent({
    tenantScope,
    effectIntentId: "intent-1",
    actionRef: "connector:create-record",
    retryClassification: overrides?.retryClassification ?? "SAFE_TO_RETRY",
    requiresApproval: false,
  });
}

test("E1: createExternalEffectIntent produces a valid intent, no approval required", () => {
  const intent = noApprovalIntent();
  assert.equal(intent.actionRef, "connector:create-record");
  assert.equal(intent.requiresApproval, false);
});

test("E2: createExternalEffectIntent fails closed on an unrecognized retryClassification", () => {
  assert.throws(
    () =>
      createExternalEffectIntent({
        tenantScope,
        effectIntentId: "intent-bad",
        actionRef: "connector:x",
        retryClassification: "MAYBE",
        requiresApproval: false,
      }),
    InvalidExternalEffectError,
  );
});

test("E3: startExternalEffectAttempt starts at NOT_STARTED with no approval evidence when requiresApproval is false", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-1" });
  assert.equal(attempt.state, "NOT_STARTED");
  assert.equal(attempt.approvalEvidenceRef, undefined);
});

test("E4: an approval-required intent cannot start an attempt without an authority/evidenceRef", () => {
  const intent = createExternalEffectIntent({
    tenantScope,
    effectIntentId: "intent-approval",
    actionRef: "connector:destructive-op",
    retryClassification: "NOT_SAFE_TO_RETRY",
    requiresApproval: true,
  });
  assert.throws(() => startExternalEffectAttempt({ intent, attemptId: "attempt-2" }), InvalidExternalEffectError);
});

test("E5: an approval-required intent starts successfully with a granted authority and evidenceRef, carrying it forward", () => {
  const intent = createExternalEffectIntent({
    tenantScope,
    effectIntentId: "intent-approval-2",
    actionRef: "connector:destructive-op",
    retryClassification: "NOT_SAFE_TO_RETRY",
    requiresApproval: true,
  });
  const attempt = startExternalEffectAttempt({
    intent,
    attemptId: "attempt-3",
    approval: { authority: grantedAuthority(), evidenceRef: "evidence:approved-by-ops" },
  });
  assert.equal(attempt.state, "NOT_STARTED");
  assert.equal(attempt.approvalEvidenceRef, "evidence:approved-by-ops");
});

test("E6: an approval-required intent rejects a read-only (non-protected-action) authority", () => {
  const intent = createExternalEffectIntent({
    tenantScope,
    effectIntentId: "intent-approval-3",
    actionRef: "connector:x",
    retryClassification: "SAFE_TO_RETRY",
    requiresApproval: true,
  });
  assert.throws(
    () =>
      startExternalEffectAttempt({
        intent,
        attemptId: "attempt-4",
        approval: { authority: readOnlyAuthority(), evidenceRef: "evidence:x" },
      }),
    ProtectedActionNotAuthorizedError,
  );
});

test("E7: an approval-required intent rejects a cross-tenant authority", () => {
  const intent = createExternalEffectIntent({
    tenantScope,
    effectIntentId: "intent-approval-4",
    actionRef: "connector:x",
    retryClassification: "SAFE_TO_RETRY",
    requiresApproval: true,
  });
  assert.throws(
    () =>
      startExternalEffectAttempt({
        intent,
        attemptId: "attempt-5",
        approval: { authority: crossTenantAuthority(), evidenceRef: "evidence:x" },
      }),
    CrossTenantAuthorityError,
  );
});

test("E8: reportExternalEffectOutcome records APPLIED with a mandatory external correlation ref", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-6" });
  const reported = reportExternalEffectOutcome({
    attempt,
    outcome: "APPLIED",
    externalCorrelationRef: "provider-ref-123",
  });
  assert.equal(reported.state, "APPLIED");
  assert.equal(reported.externalCorrelationRef, "provider-ref-123");
});

test("E9: reportExternalEffectOutcome requires a non-empty externalCorrelationRef even for an UNKNOWN outcome", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-7" });
  assert.throws(
    () => reportExternalEffectOutcome({ attempt, outcome: "UNKNOWN", externalCorrelationRef: "" }),
    InvalidExternalEffectError,
  );
});

test("E10: reportExternalEffectOutcome rejects an unrecognized outcome literal", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-8" });
  assert.throws(
    () => reportExternalEffectOutcome({ attempt, outcome: "MAYBE_APPLIED", externalCorrelationRef: "x" }),
    InvalidExternalEffectError,
  );
});

test("E11: reportExternalEffectOutcome cannot be called twice on the same attempt (already-reported outcome fails closed)", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-9" });
  const reported = reportExternalEffectOutcome({ attempt, outcome: "APPLIED", externalCorrelationRef: "x" });
  assert.throws(
    () => reportExternalEffectOutcome({ attempt: reported, outcome: "FAILED", externalCorrelationRef: "y" }),
    InvalidExternalEffectError,
  );
});

test("E12: verifyExternalEffectReadback moves an APPLIED attempt to VERIFIED when the readback confirms it", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-10" });
  const applied = reportExternalEffectOutcome({ attempt, outcome: "APPLIED", externalCorrelationRef: "x" });
  const verified = verifyExternalEffectReadback({
    attempt: applied,
    readbackConfirmsApplied: true,
    evidenceRef: "evidence:readback-confirmed",
  });
  assert.equal(verified.state, "VERIFIED");
});

test("E13 (readback authoritative over claimed outcome): a readback that disproves an APPLIED claim corrects the attempt to FAILED, not left falsely APPLIED", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-11" });
  const applied = reportExternalEffectOutcome({ attempt, outcome: "APPLIED", externalCorrelationRef: "x" });
  const corrected = verifyExternalEffectReadback({
    attempt: applied,
    readbackConfirmsApplied: false,
    evidenceRef: "evidence:readback-disproved",
  });
  assert.equal(corrected.state, "FAILED");
});

test("E14: verifyExternalEffectReadback fails closed on a non-APPLIED attempt (e.g. still NOT_STARTED)", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-12" });
  assert.throws(
    () => verifyExternalEffectReadback({ attempt, readbackConfirmsApplied: true, evidenceRef: "x" }),
    InvalidExternalEffectError,
  );
});

test("E15 (§4 'UNKNOWN fail-closed / no blind retry'): retryExternalEffectAttempt is required to exit UNKNOWN - it is never silently retried", () => {
  const intent = noApprovalIntent({ retryClassification: "SAFE_TO_RETRY" });
  const attempt = startExternalEffectAttempt({ intent, attemptId: "attempt-13" });
  const unknown = reportExternalEffectOutcome({ attempt, outcome: "UNKNOWN", externalCorrelationRef: "x" });
  assert.equal(unknown.state, "UNKNOWN");
  const retried = retryExternalEffectAttempt({
    attempt: unknown,
    intent,
    authority: grantedAuthority(),
    newAttemptId: "attempt-13-retry",
    evidenceRef: "evidence:governed-retry",
  });
  assert.equal(retried.state, "NOT_STARTED");
  assert.equal(retried.attemptId, "attempt-13-retry");
});

test("E16: retryExternalEffectAttempt fails closed on a NOT_SAFE_TO_RETRY intent, regardless of authority", () => {
  const intent = createExternalEffectIntent({
    tenantScope,
    effectIntentId: "intent-unsafe",
    actionRef: "connector:charge-card",
    retryClassification: "NOT_SAFE_TO_RETRY",
    requiresApproval: false,
  });
  const attempt = startExternalEffectAttempt({ intent, attemptId: "attempt-14" });
  const failed = reportExternalEffectOutcome({ attempt, outcome: "FAILED", externalCorrelationRef: "x" });
  assert.throws(
    () =>
      retryExternalEffectAttempt({
        attempt: failed,
        intent,
        authority: grantedAuthority(),
        newAttemptId: "attempt-14-retry",
        evidenceRef: "evidence:x",
      }),
    InvalidExternalEffectRecoveryError,
  );
});

test("E17: retryExternalEffectAttempt fails closed on a REQUIRES_MANUAL_REVIEW intent, regardless of authority", () => {
  const intent = createExternalEffectIntent({
    tenantScope,
    effectIntentId: "intent-manual",
    actionRef: "connector:ambiguous-op",
    retryClassification: "REQUIRES_MANUAL_REVIEW",
    requiresApproval: false,
  });
  const attempt = startExternalEffectAttempt({ intent, attemptId: "attempt-15" });
  const unknown = reportExternalEffectOutcome({ attempt, outcome: "UNKNOWN", externalCorrelationRef: "x" });
  assert.throws(
    () =>
      retryExternalEffectAttempt({
        attempt: unknown,
        intent,
        authority: grantedAuthority(),
        newAttemptId: "attempt-15-retry",
        evidenceRef: "evidence:x",
      }),
    InvalidExternalEffectRecoveryError,
  );
});

test("E18: retryExternalEffectAttempt fails closed on a VERIFIED (already-successful) attempt", () => {
  const intent = noApprovalIntent();
  const attempt = startExternalEffectAttempt({ intent, attemptId: "attempt-16" });
  const applied = reportExternalEffectOutcome({ attempt, outcome: "APPLIED", externalCorrelationRef: "x" });
  const verified = verifyExternalEffectReadback({ attempt: applied, readbackConfirmsApplied: true, evidenceRef: "x" });
  assert.throws(
    () =>
      retryExternalEffectAttempt({
        attempt: verified,
        intent,
        authority: grantedAuthority(),
        newAttemptId: "attempt-16-retry",
        evidenceRef: "evidence:x",
      }),
    InvalidExternalEffectRecoveryError,
  );
});

test("E19: retryExternalEffectAttempt requires a same-tenant authority", () => {
  const intent = noApprovalIntent();
  const attempt = startExternalEffectAttempt({ intent, attemptId: "attempt-17" });
  const failed = reportExternalEffectOutcome({ attempt, outcome: "FAILED", externalCorrelationRef: "x" });
  assert.throws(
    () =>
      retryExternalEffectAttempt({
        attempt: failed,
        intent,
        authority: crossTenantAuthority(),
        newAttemptId: "attempt-17-retry",
        evidenceRef: "evidence:x",
      }),
    CrossTenantAuthorityError,
  );
});

test("E20: retryExternalEffectAttempt requires a protected-action-authorized authority, not merely a same-tenant one", () => {
  const intent = noApprovalIntent();
  const attempt = startExternalEffectAttempt({ intent, attemptId: "attempt-18" });
  const failed = reportExternalEffectOutcome({ attempt, outcome: "FAILED", externalCorrelationRef: "x" });
  assert.throws(
    () =>
      retryExternalEffectAttempt({
        attempt: failed,
        intent,
        authority: readOnlyAuthority(),
        newAttemptId: "attempt-18-retry",
        evidenceRef: "evidence:x",
      }),
    ProtectedActionNotAuthorizedError,
  );
});

test("E21: retryExternalEffectAttempt requires a distinct newAttemptId, never reusing the failed/unknown attempt's own id", () => {
  const intent = noApprovalIntent();
  const attempt = startExternalEffectAttempt({ intent, attemptId: "attempt-19" });
  const failed = reportExternalEffectOutcome({ attempt, outcome: "FAILED", externalCorrelationRef: "x" });
  assert.throws(
    () =>
      retryExternalEffectAttempt({
        attempt: failed,
        intent,
        authority: grantedAuthority(),
        newAttemptId: "attempt-19",
        evidenceRef: "evidence:x",
      }),
    InvalidExternalEffectRecoveryError,
  );
});

test("E22: retryExternalEffectAttempt rejects a mismatched intent/attempt pair", () => {
  const intentA = noApprovalIntent();
  const intentB = createExternalEffectIntent({
    tenantScope,
    effectIntentId: "intent-other",
    actionRef: "connector:y",
    retryClassification: "SAFE_TO_RETRY",
    requiresApproval: false,
  });
  const attempt = startExternalEffectAttempt({ intent: intentA, attemptId: "attempt-20" });
  const failed = reportExternalEffectOutcome({ attempt, outcome: "FAILED", externalCorrelationRef: "x" });
  assert.throws(
    () =>
      retryExternalEffectAttempt({
        attempt: failed,
        intent: intentB,
        authority: grantedAuthority(),
        newAttemptId: "attempt-20-retry",
        evidenceRef: "evidence:x",
      }),
    InvalidExternalEffectRecoveryError,
  );
});

test("E23: rollbackExternalEffectAttempt moves an APPLIED attempt to ROLLED_BACK with a governed authority", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-21" });
  const applied = reportExternalEffectOutcome({ attempt, outcome: "APPLIED", externalCorrelationRef: "x" });
  const rolledBack = rollbackExternalEffectAttempt({
    attempt: applied,
    authority: grantedAuthority(),
    rollbackCorrelationRef: "provider-rollback-ref",
    evidenceRef: "evidence:rollback-approved",
  });
  assert.equal(rolledBack.state, "ROLLED_BACK");
  assert.equal(rolledBack.externalCorrelationRef, "provider-rollback-ref");
});

test("E24: rollbackExternalEffectAttempt also accepts a VERIFIED attempt", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-22" });
  const applied = reportExternalEffectOutcome({ attempt, outcome: "APPLIED", externalCorrelationRef: "x" });
  const verified = verifyExternalEffectReadback({ attempt: applied, readbackConfirmsApplied: true, evidenceRef: "x" });
  const rolledBack = rollbackExternalEffectAttempt({
    attempt: verified,
    authority: grantedAuthority(),
    rollbackCorrelationRef: "provider-rollback-ref-2",
    evidenceRef: "evidence:x",
  });
  assert.equal(rolledBack.state, "ROLLED_BACK");
});

test("E25: rollbackExternalEffectAttempt fails closed on a NOT_STARTED attempt (nothing has applied yet to roll back)", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-23" });
  assert.throws(
    () =>
      rollbackExternalEffectAttempt({
        attempt,
        authority: grantedAuthority(),
        rollbackCorrelationRef: "x",
        evidenceRef: "x",
      }),
    InvalidExternalEffectRecoveryError,
  );
});

test("E26: rollbackExternalEffectAttempt requires a protected-action-authorized authority", () => {
  const attempt = startExternalEffectAttempt({ intent: noApprovalIntent(), attemptId: "attempt-24" });
  const applied = reportExternalEffectOutcome({ attempt, outcome: "APPLIED", externalCorrelationRef: "x" });
  assert.throws(
    () =>
      rollbackExternalEffectAttempt({
        attempt: applied,
        authority: readOnlyAuthority(),
        rollbackCorrelationRef: "x",
        evidenceRef: "x",
      }),
    ProtectedActionNotAuthorizedError,
  );
});

test("E27: isRecognizedExternalEffectAttemptState is a fail-closed type guard over exactly the six declared states", () => {
  for (const state of ["NOT_STARTED", "APPLIED", "VERIFIED", "FAILED", "UNKNOWN", "ROLLED_BACK"]) {
    assert.equal(isRecognizedExternalEffectAttemptState(state), true);
  }
  assert.equal(isRecognizedExternalEffectAttemptState("SOMETHING_ELSE"), false);
  assert.equal(isRecognizedExternalEffectAttemptState(123), false);
  assert.equal(isRecognizedExternalEffectAttemptState(undefined), false);
});

test("E28 (full happy-path chain): PROPOSED->attempt->APPLIED->VERIFIED never regresses to an earlier state and preserves effectIntentId/tenantId throughout", () => {
  const intent = noApprovalIntent();
  const attempt = startExternalEffectAttempt({ intent, attemptId: "attempt-25" });
  const applied = reportExternalEffectOutcome({ attempt, outcome: "APPLIED", externalCorrelationRef: "provider-x" });
  const verified = verifyExternalEffectReadback({ attempt: applied, readbackConfirmsApplied: true, evidenceRef: "x" });
  assert.equal(verified.effectIntentId, intent.effectIntentId);
  assert.equal(verified.tenantId, intent.tenantId);
  assert.equal(verified.externalCorrelationRef, "provider-x");
  assert.equal(verified.state, "VERIFIED");
});
