import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import {
  WEBSITE_BUILD_V1_OWNERSHIP,
} from "../src/fixtures/website-build-v1-communication.js";
import {
  WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT,
  WEBSITE_BUILD_V1_CONNECTION_BINDING,
} from "../src/fixtures/website-build-v1-connection.js";
import { WEBSITE_BUILD_V1_RECIPE } from "../src/fixtures/website-build-v1-recipe.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";
import {
  compileProjectActivationProfile,
  createAcceptedCommercialReference,
  InvalidProjectActivationProfileError,
  type ProjectActivationCompilation,
} from "../src/domain/project-activation-profile.js";
import {
  buildClientProjectSnapshot,
  InvalidClientProjectSnapshotError,
} from "../src/domain/client-project-snapshot.js";
import { renderShellPage } from "../src/web/shell-render.js";

/**
 * DEC175-CONV-001: one real WEBSITE_BUILD_v1 cold-start, composed through
 * every existing repository layer exactly as a live caller would - no
 * parallel fixture, no simplified fake compiler. This file adds no new
 * source behavior; it only proves the already-implemented chain
 * (AcceptedCommercialReference -> compileProjectActivationProfile ->
 * admitted/wired OutcomeJobs -> ClientProjectSnapshot -> renderShellPage)
 * actually converges end-to-end, which the existing ADM-PROJ-001/
 * CXP-ACT-001 test suites - by design - never exercised together (CXP-ACT's
 * own tests hand-build ProjectActivationProfile and never call the real
 * compiler).
 */

const fixture = buildWebsiteBuildV1Fixture();

function compileHappyPath(): {
  result: ProjectActivationCompilation;
  plan: ReturnType<typeof compilePlan>;
  approval: ReturnType<typeof createApprovalReference>;
} {
  const now = "2026-09-24T00:00:00.000Z";
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-dec175-conv-happy",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now,
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-dec175-conv-happy",
    approvedAt: now,
    approverRef: "reviewer-dec175-conv",
  });
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-dec175-conv-happy",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const result = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId: "plan-dec175-conv-happy",
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    approval,
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
    now,
  });
  return { result, plan, approval };
}

// ---------------------------------------------------------------------------
// C1: one actual WEBSITE_BUILD_v1 happy cold-start composes
// commercial ref -> activation compiler -> jobs -> snapshot -> shell.
// ---------------------------------------------------------------------------

test("C1: happy cold-start composes through the entire chain to a READY, customer-safe rendered shell", () => {
  const { result, plan, approval } = compileHappyPath();

  assert.equal(result.profile.state, "READY");
  assert.equal(result.profile.nextRequiredActor, "NONE");
  assert.ok(result.jobs.length > 0, "expected at least one admitted/wired OutcomeJob");
  for (const job of result.jobs) {
    assert.equal(job.state, "DRAFT");
  }

  const snapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: result.jobs,
    plan,
    latestApproval: approval,
    activationProfile: result.profile,
  });
  assert.equal(snapshot.nextAction.owner, "NO_ACTION_NEEDED");
  assert.equal(snapshot.workingArtifact?.isCurrentVersionApproved, true);

  const rendered = renderShellPage({ kind: "READY", snapshot });
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /NO ACTION NEEDED/);
});

// ---------------------------------------------------------------------------
// C2: missing required connection fails closed to CUSTOMER action and zero
// jobs.
// ---------------------------------------------------------------------------

test("C2: omitting the required VERIFIED connection fails the real chain closed to CLIENT_ACTION_REQUIRED with zero jobs", () => {
  const now = "2026-09-24T00:00:00.000Z";
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-dec175-conv-conn-fail",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now,
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-dec175-conv-conn-fail",
    approvedAt: now,
    approverRef: "reviewer-dec175-conv",
  });
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-dec175-conv-conn-fail",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const result = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId: "plan-dec175-conv-conn-fail",
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    approval,
    // Real connection requirement supplied, but the required VERIFIED
    // binding is deliberately omitted.
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [],
    now,
  });

  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "CUSTOMER");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
  assert.equal(result.jobs.length, 0);

  const snapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: result.jobs,
    plan,
    latestApproval: approval,
    activationProfile: result.profile,
  });
  assert.equal(snapshot.nextAction.owner, "CLIENT_ACTION_REQUIRED");
  assert.equal("relatedCommunicationId" in snapshot.nextAction, false);

  const rendered = renderShellPage({ kind: "READY", snapshot });
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /YOUR ACTION/);
  assert.doesNotMatch(rendered.html, /CONNECTION_NOT_VERIFIED/);
});

// ---------------------------------------------------------------------------
// C3: missing/stale approval or readiness fails closed to HUMAN_REVIEW/
// AKILTA action and zero jobs.
// ---------------------------------------------------------------------------

test("C3: missing readiness/approval evidence fails the real chain closed to AKILTA_ACTION_REQUIRED with zero jobs", () => {
  const now = "2026-09-24T00:00:00.000Z";
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-dec175-conv-readiness-fail",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const result = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId: "plan-dec175-conv-readiness-fail",
    // Deliberately no readinessAssertions and no approval - both governing
    // evidence classes are missing/invalid for this cold-start.
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
    now,
  });

  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "HUMAN_REVIEW");
  assert.equal(result.profile.nextRequiredAction?.code, "PLAN_ADMISSION_BLOCKED");
  assert.equal(result.jobs.length, 0, "no execution/tool success may be treated as verification - zero jobs wired");

  const snapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: result.jobs,
    activationProfile: result.profile,
  });
  assert.equal(snapshot.nextAction.owner, "AKILTA_ACTION_REQUIRED");

  const rendered = renderShellPage({ kind: "READY", snapshot });
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /AKILTA WORKING/);
});

// ---------------------------------------------------------------------------
// C4: cross-scope contamination rejects, through the composed chain, before
// a customer-safe READY result.
// ---------------------------------------------------------------------------

test("C4: a structural cross-tenant mismatch fails the compiler closed before any profile/snapshot/shell is ever produced", () => {
  const now = "2026-09-24T00:00:00.000Z";
  const foreignTenantScope = createTenantScope("tenant-dec175-conv-foreign");
  const foreignCustomer = createCustomer({
    tenantScope: foreignTenantScope,
    customerId: "cust-dec175-conv-foreign",
    displayName: "Foreign Customer",
  });
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-dec175-conv-contamination",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        tenantScope: fixture.tenantScope,
        // Real fixture's own project, paired with a customer from a wholly
        // different tenant - a genuine cross-scope contamination witness
        // through the exact same composition this file otherwise exercises
        // cleanly in C1.
        customer: foreignCustomer,
        project: fixture.project,
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        acceptedCommercialReference,
        blueprint: fixture.blueprint,
        soldScope: fixture.soldScope,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
        effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
        evidence: fixture.evidence,
        planId: "plan-dec175-conv-contamination",
        connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
        connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
        now,
      }),
    InvalidProjectActivationProfileError,
  );
});

test("C4: a legitimate READY activation profile cannot be attached to a foreign project's snapshot", () => {
  const { result } = compileHappyPath();
  assert.equal(result.profile.state, "READY");

  const foreignOwnership = createProjectOwnershipRef({
    tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
    customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
    projectId: "proj-dec175-conv-foreign",
  });
  const foreignProject = createProject({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    projectId: "proj-dec175-conv-foreign",
    ownerRef: "owner-dec175-conv-foreign",
    state: "active",
  });

  // jobs: [] rather than result.jobs - the point under test is the
  // activationProfile/ownership boundary itself, independent of the
  // already-separately-proven jobs/project boundary that
  // computeDeliveryStatus enforces earlier in the same function; passing
  // result.jobs here would make the assertion pass for the wrong reason
  // (an InvalidDeliveryStatusError from the jobs check, never reaching the
  // activationProfile check this test exists to witness).
  assert.throws(
    () =>
      buildClientProjectSnapshot({
        ownership: foreignOwnership,
        project: foreignProject,
        jobs: [],
        activationProfile: result.profile,
      }),
    InvalidClientProjectSnapshotError,
  );
});

// ---------------------------------------------------------------------------
// C5: customer-safe snapshot/shell contains no forbidden internal
// activation/provider/secret provenance.
// ---------------------------------------------------------------------------

test("C5: neither the serialized snapshot nor the rendered shell HTML ever exposes internal activation/connection provenance", () => {
  const { result, plan, approval } = compileHappyPath();
  const snapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: result.jobs,
    plan,
    latestApproval: approval,
    activationProfile: result.profile,
  });
  const rendered = renderShellPage({ kind: "READY", snapshot });

  const forbidden = [
    "nextRequiredAction",
    "unresolvedGates",
    "platformDecision",
    "verifiedConnections",
    "consumedRoutes",
    "connectionBindingId",
    "secretRef",
    "sourceFingerprint",
    "acceptedCommercialReference",
    "effectiveConfigRefs",
    "effectivePolicyRefs",
    // real provider/workspace/instance identifiers carried by the
    // WEBSITE_BUILD_V1 connection fixture itself - proving no raw
    // provider/workspace detail crosses either boundary.
    "reference-storefront-provider",
    "reference-storefront-workspace",
    "reference-storefront-instance-1",
  ];
  const serializedSnapshot = JSON.stringify(snapshot);
  for (const term of forbidden) {
    assert.equal(serializedSnapshot.includes(term), false, `snapshot leaked forbidden term "${term}"`);
    assert.equal(rendered.html.includes(term), false, `rendered shell leaked forbidden term "${term}"`);
  }
});

// ---------------------------------------------------------------------------
// C6: identical cold-start inputs are deterministic end-to-end.
// ---------------------------------------------------------------------------

test("C6: identical cold-start inputs produce deep-equal activation/snapshot output and byte-identical rendered HTML", () => {
  const first = compileHappyPath();
  const second = compileHappyPath();
  assert.deepEqual(first.result, second.result);

  const snapshotA = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: first.result.jobs,
    plan: first.plan,
    latestApproval: first.approval,
    activationProfile: first.result.profile,
  });
  const snapshotB = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: second.result.jobs,
    plan: second.plan,
    latestApproval: second.approval,
    activationProfile: second.result.profile,
  });
  assert.deepEqual(snapshotA, snapshotB);
  assert.equal(renderShellPage({ kind: "READY", snapshot: snapshotA }).html, renderShellPage({ kind: "READY", snapshot: snapshotB }).html);
});
