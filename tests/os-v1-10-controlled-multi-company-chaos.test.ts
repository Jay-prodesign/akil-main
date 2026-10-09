import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import {
  createOrganization,
  activateOrganization,
  suspendOrganization,
  type Organization,
} from "../src/domain/organization.js";
import { resolveEffectiveOrganizationAccess } from "../src/domain/effective-organization-access.js";

import {
  createQuotaAdmissionScope,
  createQuotaReservationIdentity,
  createQuotaEnvelope,
} from "../src/domain/execution-quota-admission.js";
import { FileDurableQuotaReservationStore } from "../src/domain/durable-quota-reservation-store.js";

import {
  resolveAndProjectConfigurationPolicyDecision,
  rollbackConfigurationPolicyDecision,
} from "../src/domain/resolve-and-project-configuration-policy-decision.js";
import { FileDurableConfigurationPolicyDecisionStore } from "../src/domain/durable-configuration-policy-decision-store.js";

import {
  authorizeBreakGlassSupportAccess,
  createBreakGlassAccessGrant,
} from "../src/domain/break-glass-support-access.js";

import { createOutcomeJob } from "../src/domain/outcome-job.js";
import {
  createOutcomeJobExecutionEvent,
  type OutcomeJobExecutionEvent,
} from "../src/domain/outcome-job-execution-event.js";
import { reconstructOutcomeJobExecutionRunState } from "../src/domain/outcome-job-execution-run-state.js";
import {
  resolveRetryContainmentDisposition,
  type RetryContainmentPolicy,
} from "../src/domain/outcome-job-retry-containment.js";

import {
  exportOrganizationLifecycleSnapshot,
  restoreOrganizationLifecycleFromSnapshot,
} from "../src/domain/organization-lifecycle-archive.js";
import { offboardOrganization } from "../src/domain/organization.js";

import {
  createDelegatedAccessGrant,
  isDelegatedAccessGrantActive,
} from "../src/domain/delegated-access-grant.js";

import {
  createLocalExecutionKillSwitch,
  engageLocalExecutionKillSwitch,
  resolveEligibleLocalWorkersUnderKillSwitch,
} from "../src/domain/local-execution-hardening.js";
import { createExecutionPolicy } from "../src/domain/local-execution.js";

import { resolveAmbiguousLocalRunDisposition } from "../src/domain/local-execution-adapter-certification.js";

function freshTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tenantFixture(label: "A" | "B") {
  const tenantScope = createTenantScope(`tenant-os-v1-10-${label.toLowerCase()}`);
  const customer = createCustomer({ tenantScope, customerId: `cust-v1-10-${label}`, displayName: `Customer ${label}` });
  const project = createProject({ tenantScope, customer, projectId: `project-v1-10-${label}`, ownerRef: `owner-v1-10-${label}`, state: "active" });
  const job = createOutcomeJob({ tenantScope, customer, project, jobId: `job-v1-10-${label}`, jobFamily: "WEBSITE_BUILD", businessObjective: "obj" });
  const organization = activateOrganization({
    organization: createOrganization({ organizationId: `org-v1-10-${label}`, tenantScope, displayName: `Org ${label}`, createdAt: "2026-10-09T00:00:00.000Z" }),
    activatedAt: "2026-10-09T00:00:01.000Z",
  });
  const membership = createOrganizationMembership({ membershipId: `membership-v1-10-${label}`, tenantScope, principalRef: `principal-v1-10-${label}`, role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  const access = resolveEffectiveOrganizationAccess({ organization, membership, currentPrincipalRef: membership.principalRef, authority });
  return { tenantScope, customer, project, job, organization, membership, authority, access };
}

test("CHAOS1 (headline, NEW): quota races + config cohorts + foreign-org break-glass denial, two tenants, ONE concurrent Promise.all", async () => {
  const A = tenantFixture("A");
  const B = tenantFixture("B");

  const quotaDir = freshTmpDir("os-v1-10-quota-");
  const configDir = freshTmpDir("os-v1-10-config-");
  try {
    const quotaStore = new FileDurableQuotaReservationStore(quotaDir);
    const configStore = new FileDurableConfigurationPolicyDecisionStore(configDir);

    const scopeA = createQuotaAdmissionScope({ tenantScope: A.tenantScope, customerId: "cust-chaos", projectId: "proj-chaos", planId: "plan-1", planVersion: 1 });
    const scopeB = createQuotaAdmissionScope({ tenantScope: B.tenantScope, customerId: "cust-chaos", projectId: "proj-chaos", planId: "plan-1", planVersion: 1 });
    const envelopeA = createQuotaEnvelope({ scope: scopeA, envelopeRef: "env-chaos-a", sourceFingerprint: "fp-1", unitLimit: 3 });
    const envelopeB = createQuotaEnvelope({ scope: scopeB, envelopeRef: "env-chaos-b", sourceFingerprint: "fp-1", unitLimit: 2 });

    const quotaOpsA = Array.from({ length: 5 }, (_, i) =>
      Promise.resolve(
        quotaStore.admit({
          envelope: envelopeA,
          identity: createQuotaReservationIdentity({ scope: scopeA, jobId: "job-chaos", runId: `run-a-${i}`, attemptRef: "1" }),
          idempotencyKey: `chaos-a-${i}`,
          requestedAmount: { presence: "UNKNOWN" },
          occurredAt: "2026-10-09T00:00:00.000Z",
        }),
      ),
    );
    const quotaOpsB = Array.from({ length: 4 }, (_, i) =>
      Promise.resolve(
        quotaStore.admit({
          envelope: envelopeB,
          identity: createQuotaReservationIdentity({ scope: scopeB, jobId: "job-chaos", runId: `run-b-${i}`, attemptRef: "1" }),
          idempotencyKey: `chaos-b-${i}`,
          requestedAmount: { presence: "UNKNOWN" },
          occurredAt: "2026-10-09T00:00:00.000Z",
        }),
      ),
    );

    const platformControl = (overrides: Record<string, unknown> = {}) => ({
      kind: "CONFIG", scope: "PLATFORM", key: "theme", sourceRef: "theme-default", version: "1", identity: {}, ...overrides,
    });
    // Colliding bare identifiers across tenants - identical jobId strings.
    const identityA = { tenantId: A.tenantScope.tenantId, jobId: "job-shared-bare" };
    const identityB = { tenantId: B.tenantScope.tenantId, jobId: "job-shared-bare" };
    const seedA = resolveAndProjectConfigurationPolicyDecision({ store: configStore, identity: identityA, controls: [platformControl()], decisionId: "a-d1", now: "2026-10-09T00:00:00.000Z" });
    const seedB = resolveAndProjectConfigurationPolicyDecision({ store: configStore, identity: identityB, controls: [platformControl()], decisionId: "b-d1", now: "2026-10-09T00:00:00.000Z" });
    resolveAndProjectConfigurationPolicyDecision({ store: configStore, identity: identityA, controls: [platformControl({ sourceRef: "theme-dark", version: "2" })], decisionId: "a-d2", now: "2026-10-09T00:01:00.000Z" });
    resolveAndProjectConfigurationPolicyDecision({ store: configStore, identity: identityB, controls: [platformControl({ sourceRef: "theme-dark", version: "2" })], decisionId: "b-d2", now: "2026-10-09T00:01:00.000Z" });

    const rollbackA = Promise.resolve(
      rollbackConfigurationPolicyDecision({
        store: configStore, identity: identityA, authority: A.authority, rollbackToDecisionId: "a-d1",
        currentControls: [platformControl({ sourceRef: "theme-dark", version: "2" })], decisionId: "a-d3", now: "2026-10-09T00:02:00.000Z",
      }),
    );
    const rollbackB = Promise.resolve(
      rollbackConfigurationPolicyDecision({
        store: configStore, identity: identityB, authority: B.authority, rollbackToDecisionId: "b-d1",
        currentControls: [platformControl({ sourceRef: "theme-dark", version: "2" })], decisionId: "b-d3", now: "2026-10-09T00:02:00.000Z",
      }),
    );

    const breakGlassGrant = createBreakGlassAccessGrant({
      grantId: "grant-chaos", supportTenantScope: A.tenantScope, targetTenantScope: A.tenantScope,
      grantedToRef: "staff-chaos", grantedByRef: "owner-chaos", reason: "incident review",
      scope: ["TASK"], consentRequired: false, expiresAt: "2026-12-31T00:00:00.000Z",
    });
    const foreignAttempt = Promise.resolve(
      authorizeBreakGlassSupportAccess({
        grant: breakGlassGrant, targetTenantScope: B.tenantScope, currentPrincipalRef: "staff-chaos",
        requestedView: "TASK", auditRef: "audit-chaos", now: "2026-10-09T00:03:00.000Z",
      }),
    );

    const [quotaResultsA, quotaResultsB, , , foreignDecision] = await Promise.all([
      Promise.all(quotaOpsA),
      Promise.all(quotaOpsB),
      rollbackA,
      rollbackB,
      foreignAttempt,
    ]);

    const reservedA = quotaResultsA.filter((o) => o.status === "RESERVED").length;
    const reservedB = quotaResultsB.filter((o) => o.status === "RESERVED").length;
    assert.equal(reservedA, 3, "tenant A's own 3-slot ceiling must be respected exactly, even under combined concurrent multi-tenant load");
    assert.equal(reservedB, 2, "tenant B's own 2-slot ceiling must be respected exactly, even under combined concurrent multi-tenant load");

    const historyA = configStore.getDecisionProjectionHistory(A.tenantScope.tenantId, seedA.entry.decisionKey);
    const historyB = configStore.getDecisionProjectionHistory(B.tenantScope.tenantId, seedB.entry.decisionKey);
    assert.equal(historyA.length, 3, "A's own config history must be unaffected by B's concurrent rollback on a colliding bare identity");
    assert.equal(historyB.length, 3, "B's own config history must be unaffected by A's concurrent rollback on a colliding bare identity");
    assert.equal(historyA[2]?.rolledBackToDecisionId, "a-d1");
    assert.equal(historyB[2]?.rolledBackToDecisionId, "b-d1");

    assert.equal(foreignDecision.outcome, "DENIED", "a break-glass grant for A must be denied against B's tenant even while the system is under concurrent multi-tenant chaos");
  } finally {
    rmSync(quotaDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

function policyFor(): RetryContainmentPolicy {
  return { maxAttempts: 10, minAttemptIntervalMs: 1, crashLoopWindowMs: 60_000, maxAttemptsWithinCrashLoopWindow: 2 };
}

function evFor(tenant: ReturnType<typeof tenantFixture>, overrides: Partial<Parameters<typeof createOutcomeJobExecutionEvent>[0]> = {}): OutcomeJobExecutionEvent {
  return createOutcomeJobExecutionEvent({
    tenantScope: tenant.tenantScope, customer: tenant.customer, project: tenant.project, job: tenant.job,
    runId: "run-1", correlationId: "corr-1", attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  });
}

test("CRASHLOOP1 (NEW, concurrent): two tenants' own crash-loop containment decisions, resolved concurrently, remain fully isolated", async () => {
  const A = tenantFixture("A");
  const B = tenantFixture("B");

  function denselyRetriedRunState(tenant: ReturnType<typeof tenantFixture>) {
    const events: OutcomeJobExecutionEvent[] = [evFor(tenant, { type: "ACCEPTED", attempt: 1, sequence: 1, occurredAt: "2026-10-09T00:00:00.000Z" })];
    for (let attempt = 1; attempt <= 2; attempt++) {
      events.push(evFor(tenant, { type: "ATTEMPT_STARTED", attempt, sequence: 1, occurredAt: "2026-10-09T00:00:00.000Z" }));
      if (attempt < 2) events.push(evFor(tenant, { type: "FAILED", attempt, sequence: 2, occurredAt: "2026-10-09T00:00:00.000Z", reason: "fail" }));
    }
    const state = reconstructOutcomeJobExecutionRunState(events);
    if (state === undefined) throw new Error("fixture error");
    return state;
  }

  const [decisionA, decisionB] = await Promise.all([
    Promise.resolve(resolveRetryContainmentDisposition({ runState: denselyRetriedRunState(A), policy: policyFor(), now: "2026-10-09T00:00:05.000Z" })),
    Promise.resolve(resolveRetryContainmentDisposition({ runState: denselyRetriedRunState(B), policy: policyFor(), now: "2026-10-09T00:00:05.000Z" })),
  ]);
  assert.equal(decisionA.outcome, "BLOCKED");
  assert.ok(decisionA.outcome === "BLOCKED");
  assert.equal(decisionA.classification, "CRASH_LOOP");
  assert.equal(decisionB.outcome, "BLOCKED");
  assert.ok(decisionB.outcome === "BLOCKED");
  assert.equal(decisionB.classification, "CRASH_LOOP");
});

test("MIGRATION1 (NEW, concurrent): two tenants' own export/restore/migration/offboarding, resolved concurrently, remain fully isolated", async () => {
  const A = tenantFixture("A");
  const B = tenantFixture("B");

  const snapshotA = exportOrganizationLifecycleSnapshot({ organization: A.organization, currentAccess: A.access, exportedAt: "2026-10-09T05:00:00.000Z" });
  const snapshotB = exportOrganizationLifecycleSnapshot({ organization: B.organization, currentAccess: B.access, exportedAt: "2026-10-09T05:00:00.000Z" });

  const [restoredA, restoredB] = await Promise.all([
    Promise.resolve(restoreOrganizationLifecycleFromSnapshot({ snapshot: snapshotA, targetTenantScope: A.tenantScope, targetOrganizationId: "org-v1-10-a-migrated", currentAccess: A.access })),
    Promise.resolve(restoreOrganizationLifecycleFromSnapshot({ snapshot: snapshotB, targetTenantScope: B.tenantScope, targetOrganizationId: "org-v1-10-b-migrated", currentAccess: B.access })),
  ]);
  assert.equal(restoredA.organization.tenantId, A.tenantScope.tenantId);
  assert.equal(restoredB.organization.tenantId, B.tenantScope.tenantId);
  assert.equal(restoredA.migratedFrom?.organizationId, A.organization.organizationId);
  assert.equal(restoredB.migratedFrom?.organizationId, B.organization.organizationId);

  const offboardedA = offboardOrganization({ organization: suspendOrganization({ organization: A.organization, suspendedAt: "2026-10-09T06:00:00.000Z" }), offboardedAt: "2026-10-09T07:00:00.000Z" });
  const snapshotOffboardedA = exportOrganizationLifecycleSnapshot({ organization: offboardedA, currentAccess: A.access, exportedAt: "2026-10-09T07:00:01.000Z" });
  assert.throws(() =>
    restoreOrganizationLifecycleFromSnapshot({ snapshot: snapshotOffboardedA, targetTenantScope: A.tenantScope, targetOrganizationId: "org-v1-10-a-resurrected", currentAccess: A.access }),
  );
});

test("DELEGATION1 (NEW, concurrent): two tenants' own delegation expiry checks, resolved concurrently, remain fully isolated", async () => {
  const A = tenantFixture("A");
  const B = tenantFixture("B");

  const grantA = createDelegatedAccessGrant({
    tenantScope: A.tenantScope, organization: A.organization, delegatorMembership: A.membership, delegatorAuthority: A.authority,
    delegationId: "delegation-a", delegatePrincipalRef: "delegate-a", permissions: ["EXECUTE"], canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z", expiresAt: "2026-10-09T00:01:00.000Z",
  });
  const grantB = createDelegatedAccessGrant({
    tenantScope: B.tenantScope, organization: B.organization, delegatorMembership: B.membership, delegatorAuthority: B.authority,
    delegationId: "delegation-b", delegatePrincipalRef: "delegate-b", permissions: ["EXECUTE"], canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z", expiresAt: "2026-10-09T01:00:00.000Z",
  });

  const [activeA, activeB] = await Promise.all([
    Promise.resolve(isDelegatedAccessGrantActive(grantA, "2026-10-09T00:30:00.000Z")),
    Promise.resolve(isDelegatedAccessGrantActive(grantB, "2026-10-09T00:30:00.000Z")),
  ]);
  assert.equal(activeA, false, "A's own grant has expired by this point");
  assert.equal(activeB, true, "B's own grant, checked at the exact same moment, is unaffected by A's own expiry");
});

test("DEGRADATION1 (NEW, concurrent): two tenants' own independent kill switches - engaging one never relaxes the other's own worker-eligibility floor", async () => {
  const A = tenantFixture("A");
  const B = tenantFixture("B");

  const killSwitchA = engageLocalExecutionKillSwitch({ killSwitch: createLocalExecutionKillSwitch(A.tenantScope), engagedAt: "2026-10-09T00:00:00.000Z", reason: "incident A" });
  const killSwitchB = createLocalExecutionKillSwitch(B.tenantScope); // B's own switch stays disengaged throughout.

  const ownershipA = createProjectOwnershipRef({ tenantId: A.tenantScope.tenantId, customerId: A.customer.customerId, projectId: A.project.projectId });
  const ownershipB = createProjectOwnershipRef({ tenantId: B.tenantScope.tenantId, customerId: B.customer.customerId, projectId: B.project.projectId });
  const executionPolicyA = createExecutionPolicy({ tenantScope: A.tenantScope, executionMode: "PERSONAL_LOCAL" });
  const executionPolicyB = createExecutionPolicy({ tenantScope: B.tenantScope, executionMode: "PERSONAL_LOCAL" });

  const [eligibleA, eligibleB] = await Promise.all([
    Promise.resolve(
      resolveEligibleLocalWorkersUnderKillSwitch({
        killSwitch: killSwitchA, executionPolicy: executionPolicyA, registrations: [],
        requestingTenantId: A.tenantScope.tenantId, targetOwnership: ownershipA, requestingOwnerMembershipRef: "member-a",
      }),
    ),
    Promise.resolve(
      resolveEligibleLocalWorkersUnderKillSwitch({
        killSwitch: killSwitchB, executionPolicy: executionPolicyB, registrations: [],
        requestingTenantId: B.tenantScope.tenantId, targetOwnership: ownershipB, requestingOwnerMembershipRef: "member-b",
      }),
    ),
  ]);
  assert.deepEqual(eligibleA, [], "A's own engaged kill switch empties its own eligibility");
  assert.deepEqual(eligibleB, [], "B's own result is independently empty here only because no workers were registered - B's switch itself was never engaged");
  assert.equal(killSwitchB.engaged, false, "B's own kill switch remains disengaged - A's incident never relaxed or widened B's own floor, nor the reverse");
});

test("PARTIAL1 (NEW, concurrent): two tenants' own partial-effect/UNKNOWN dispositions, resolved concurrently, are never shown as success for either", async () => {
  const [dispositionA, dispositionB] = await Promise.all([
    Promise.resolve(
      resolveAmbiguousLocalRunDisposition({ leaseStatus: "RUNNING", connectionState: "DISCONNECTED", terminalEventObserved: false, deadlineExceeded: false }),
    ),
    Promise.resolve(
      resolveAmbiguousLocalRunDisposition({ leaseStatus: "CHECKPOINTED", connectionState: "CONNECTED", terminalEventObserved: false, deadlineExceeded: true }),
    ),
  ]);
  assert.equal(dispositionA.disposition, "UNKNOWN");
  assert.equal(dispositionA.allowedLeaseTarget, "BLOCKED");
  assert.equal(dispositionB.disposition, "UNKNOWN");
  assert.equal(dispositionB.allowedLeaseTarget, "BLOCKED");
});
