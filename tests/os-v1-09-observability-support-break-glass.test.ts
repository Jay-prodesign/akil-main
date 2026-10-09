import { test } from "node:test";
import assert from "node:assert/strict";

import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createBreakGlassAccessGrant,
  revokeBreakGlassAccessGrant,
  authorizeBreakGlassSupportAccess,
  InvalidBreakGlassAccessGrantError,
  type BreakGlassAccessGrant,
} from "../src/domain/break-glass-support-access.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  createOutcomeJobExecutionEvent,
  type OutcomeJobExecutionEvent,
} from "../src/domain/outcome-job-execution-event.js";
import { reconstructOutcomeJobExecutionRunState } from "../src/domain/outcome-job-execution-run-state.js";
import { composeOperationalObservabilityView } from "../src/domain/operational-observability-view.js";

const supportTenant = createTenantScope("tenant-os-v1-09-support");
const targetTenant = createTenantScope("tenant-os-v1-09-target");
const otherTenant = createTenantScope("tenant-os-v1-09-other");

function freshGrant(overrides: Partial<Parameters<typeof createBreakGlassAccessGrant>[0]> = {}): BreakGlassAccessGrant {
  return createBreakGlassAccessGrant({
    grantId: "grant-1",
    supportTenantScope: supportTenant,
    targetTenantScope: targetTenant,
    grantedToRef: "staff-1",
    grantedByRef: "owner-target-1",
    reason: "customer-reported incident #123",
    scope: ["TASK", "CONNECTION"],
    consentRequired: false,
    expiresAt: "2026-10-09T23:59:59.000Z",
    ...overrides,
  });
}

test("GRANT1: authorizeBreakGlassSupportAccess succeeds for an active grant, matching principal, in-scope view, no consent required", () => {
  const grant = freshGrant();
  const decision = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: targetTenant,
    currentPrincipalRef: "staff-1",
    requestedView: "TASK",
    auditRef: "audit-1",
    now: "2026-10-09T10:00:00.000Z",
  });
  assert.equal(decision.outcome, "GRANTED");
  assert.ok(decision.outcome === "GRANTED");
  assert.equal(decision.audit.auditRef, "audit-1");
  assert.equal(decision.audit.targetTenantId, targetTenant.tenantId);
  assert.equal(decision.audit.requestedView, "TASK");
});

test("FOREIGN1 (foreign-org visibility): a grant targeting one tenant is denied when the requested view is for a DIFFERENT tenant", () => {
  const grant = freshGrant();
  const decision = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: otherTenant,
    currentPrincipalRef: "staff-1",
    requestedView: "TASK",
    auditRef: "audit-foreign",
    now: "2026-10-09T10:00:00.000Z",
  });
  assert.equal(decision.outcome, "DENIED");
});

test("EXPIRED1 (expired support access): a grant past its own expiresAt is denied", () => {
  const grant = freshGrant({ expiresAt: "2026-10-09T09:00:00.000Z" });
  const decision = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: targetTenant,
    currentPrincipalRef: "staff-1",
    requestedView: "TASK",
    auditRef: "audit-expired",
    now: "2026-10-09T10:00:00.000Z",
  });
  assert.equal(decision.outcome, "DENIED");
});

test("REVOKED1: a REVOKED grant is denied even before expiresAt", () => {
  const grant = revokeBreakGlassAccessGrant({
    grant: freshGrant(),
    revokedAt: "2026-10-09T09:30:00.000Z",
    revokedReason: "incident closed early",
  });
  const decision = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: targetTenant,
    currentPrincipalRef: "staff-1",
    requestedView: "TASK",
    auditRef: "audit-revoked",
    now: "2026-10-09T10:00:00.000Z",
  });
  assert.equal(decision.outcome, "DENIED");
});

test("SCOPE1 (scoped): a requested view outside the grant's own scope is denied", () => {
  const grant = freshGrant({ scope: ["TASK"] });
  const decision = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: targetTenant,
    currentPrincipalRef: "staff-1",
    requestedView: "AUDIT_EVIDENCE",
    auditRef: "audit-scope",
    now: "2026-10-09T10:00:00.000Z",
  });
  assert.equal(decision.outcome, "DENIED");
});

test("IDENTITY1 (stolen grant): a caller presenting someone else's valid grant is denied", () => {
  const grant = freshGrant();
  const decision = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: targetTenant,
    currentPrincipalRef: "staff-2-not-the-grantee",
    requestedView: "TASK",
    auditRef: "audit-identity",
    now: "2026-10-09T10:00:00.000Z",
  });
  assert.equal(decision.outcome, "DENIED");
});

test("CONSENT1 (consented where required): a consent-required grant is denied with no consentRef and granted once one is supplied", () => {
  const grant = freshGrant({ consentRequired: true });
  const withoutConsent = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: targetTenant,
    currentPrincipalRef: "staff-1",
    requestedView: "TASK",
    auditRef: "audit-no-consent",
    now: "2026-10-09T10:00:00.000Z",
  });
  assert.equal(withoutConsent.outcome, "DENIED");

  const withConsent = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: targetTenant,
    currentPrincipalRef: "staff-1",
    requestedView: "TASK",
    consentRef: "consent-session-abc",
    auditRef: "audit-with-consent",
    now: "2026-10-09T10:00:00.000Z",
  });
  assert.equal(withConsent.outcome, "GRANTED");
});

test("AUDIT1 (unaudited access impossible): every GRANTED decision carries a complete, non-empty audit record", () => {
  const grant = freshGrant();
  const decision = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: targetTenant,
    currentPrincipalRef: "staff-1",
    requestedView: "CONNECTION",
    auditRef: "audit-complete",
    now: "2026-10-09T10:00:00.000Z",
  });
  assert.equal(decision.outcome, "GRANTED");
  assert.ok(decision.outcome === "GRANTED");
  assert.ok(decision.audit.auditRef.length > 0);
  assert.ok(decision.audit.grantId.length > 0);
  assert.ok(decision.audit.decidedByPrincipalRef.length > 0);
  assert.ok(decision.audit.decidedAt.length > 0);
  assert.equal(decision.audit.supportTenantId, supportTenant.tenantId);

  // auditRef itself is mandatory at the call boundary - an empty one throws
  // rather than ever producing a GRANTED decision with missing evidence.
  assert.throws(
    () =>
      authorizeBreakGlassSupportAccess({
        grant,
        targetTenantScope: targetTenant,
        currentPrincipalRef: "staff-1",
        requestedView: "CONNECTION",
        auditRef: "",
        now: "2026-10-09T10:00:00.000Z",
      }),
    InvalidBreakGlassAccessGrantError,
  );
});

test("REASON1 (reasoned): createBreakGlassAccessGrant rejects an empty/missing reason", () => {
  assert.throws(() => freshGrant({ reason: "" }), InvalidBreakGlassAccessGrantError);
  assert.throws(() => freshGrant({ reason: undefined as unknown as string }), InvalidBreakGlassAccessGrantError);
});

test("TIMEBOUND1 (time-bounded): createBreakGlassAccessGrant rejects a missing/invalid expiresAt", () => {
  assert.throws(() => freshGrant({ expiresAt: undefined as unknown as string }), InvalidBreakGlassAccessGrantError);
  assert.throws(() => freshGrant({ expiresAt: "not-a-timestamp" }), InvalidBreakGlassAccessGrantError);
});

test("UNKNOWN1 (UNKNOWN shown as success, cited/re-demonstrated): after a GRANTED break-glass decision, the existing observability composition still honestly reports an ambiguous attempt as UNKNOWN, never fabricated success", () => {
  const grant = freshGrant({ scope: ["TASK"] });
  const decision = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: targetTenant,
    currentPrincipalRef: "staff-1",
    requestedView: "TASK",
    auditRef: "audit-unknown1",
    now: "2026-10-09T10:00:00.000Z",
  });
  assert.equal(decision.outcome, "GRANTED");

  const customer = createCustomer({ tenantScope: targetTenant, customerId: "cust-os-v1-09", displayName: "Target Customer" });
  const project = createProject({ tenantScope: targetTenant, customer, projectId: "project-os-v1-09", ownerRef: "owner-os-v1-09", state: "active" });
  const job = createOutcomeJob({ tenantScope: targetTenant, customer, project, jobId: "job-os-v1-09", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver website" });
  const events: OutcomeJobExecutionEvent[] = [
    createOutcomeJobExecutionEvent({ tenantScope: targetTenant, customer, project, job, runId: "run-1", correlationId: "corr-1", attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-10-09T09:00:00.000Z" }),
    createOutcomeJobExecutionEvent({ tenantScope: targetTenant, customer, project, job, runId: "run-1", correlationId: "corr-1", attempt: 1, sequence: 1, type: "ATTEMPT_STARTED", occurredAt: "2026-10-09T09:00:01.000Z" }),
    createOutcomeJobExecutionEvent({ tenantScope: targetTenant, customer, project, job, runId: "run-1", correlationId: "corr-1", attempt: 1, sequence: 2, type: "UNKNOWN", occurredAt: "2026-10-09T09:00:02.000Z", reason: "transport ambiguous" }),
  ];
  const runState = reconstructOutcomeJobExecutionRunState(events);
  if (runState === undefined) throw new Error("fixture error");

  const view = composeOperationalObservabilityView({ runState });
  assert.equal(view.task?.runStatus, "UNKNOWN", "the gate authorizing WHO may view this must never change WHAT it honestly shows");
  assert.equal(view.task?.workerHealth, "UNKNOWN");
});
