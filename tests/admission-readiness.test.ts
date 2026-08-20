import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createCustomerEvidenceItem } from "../src/domain/customer-evidence.js";
import { compilePlan } from "../src/domain/project-plan.js";
import {
  evaluateReadiness,
  InvalidAdmissionReadinessError,
} from "../src/domain/admission-readiness.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";

function compiledPlan() {
  const fixture = buildWebsiteBuildV1Fixture();
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-readiness-unit",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  return { ...fixture, plan };
}

test("F1: a full set of current-version FACT assertions, each structurally SATISFIED, is READY with zero gaps", () => {
  const { tenantScope, project, plan } = compiledPlan();
  const requiredRequirementIds = plan.nodes
    .filter((n) => n.disposition === "REQUIRED")
    .map((n) => n.requirementId);
  const result = evaluateReadiness({
    plan,
    requiredRequirementIds,
    assertions: buildFullReadinessAssertions(tenantScope, project, plan),
  });
  assert.equal(result.status, "READY");
  assert.deepEqual(result.gaps, []);
});

test("F1 round-2: a current FACT that structurally reports UNSATISFIED is a fail-closed UNSATISFIED gap, not READY", () => {
  const { tenantScope, project, plan } = compiledPlan();
  const requiredRequirementIds = plan.nodes
    .filter((n) => n.disposition === "REQUIRED")
    .map((n) => n.requirementId);
  const assertions = buildFullReadinessAssertions(tenantScope, project, plan).map((a) =>
    a.evidence.relatedRequirementId === "design-build"
      ? {
          ...a,
          evidence: createCustomerEvidenceItem({
            tenantScope,
            project,
            evidenceRef: "ev-design-build-unavailable",
            kind: "FACT",
            subject: "Required design-build access is confirmed unavailable",
            sourceLocator: "internal://test-fixtures/readiness/design-build-unsatisfied",
            relatedRequirementId: "design-build",
          }),
          readinessOutcome: "UNSATISFIED" as const,
        }
      : a,
  );
  const result = evaluateReadiness({ plan, requiredRequirementIds, assertions });
  assert.equal(result.status, "NOT_READY");
  const gap = result.gaps.find((g) => g.requirementId === "design-build");
  assert.ok(gap !== undefined);
  assert.equal(gap!.kind, "UNSATISFIED");
  assert.match(gap!.reason, /unavailable\/unsatisfied/);
});

test("F1 round-2: a negative FACT cannot be outweighed by kind alone - UNSATISFIED still blocks even though kind is FACT", () => {
  const { tenantScope, project, plan } = compiledPlan();
  const requiredRequirementIds = plan.nodes
    .filter((n) => n.disposition === "REQUIRED")
    .map((n) => n.requirementId);
  const assertions = buildFullReadinessAssertions(tenantScope, project, plan).map((a) =>
    a.evidence.relatedRequirementId === "handover"
      ? { ...a, readinessOutcome: "UNSATISFIED" as const }
      : a,
  );
  const result = evaluateReadiness({ plan, requiredRequirementIds, assertions });
  assert.equal(result.status, "NOT_READY");
  const gap = result.gaps.find((g) => g.requirementId === "handover");
  assert.ok(gap !== undefined);
  assert.equal(gap!.kind, "UNSATISFIED");
});

test("F1 round-2: two current FACT assertions for the same requirement with conflicting readinessOutcome fail closed as AMBIGUOUS", () => {
  const { tenantScope, project, plan } = compiledPlan();
  const requiredRequirementIds = plan.nodes
    .filter((n) => n.disposition === "REQUIRED")
    .map((n) => n.requirementId);
  const base = buildFullReadinessAssertions(tenantScope, project, plan);
  const conflictingAdditional = {
    evidence: createCustomerEvidenceItem({
      tenantScope,
      project,
      evidenceRef: "ev-handover-conflicting-unsatisfied",
      kind: "FACT" as const,
      subject: "A second, disagreeing handover readiness assertion",
      sourceLocator: "internal://test-fixtures/readiness/handover-conflicting",
      relatedRequirementId: "handover",
    }),
    assertedForPlanVersion: plan.version,
    readinessOutcome: "UNSATISFIED" as const,
  };
  const assertions = [...base, conflictingAdditional];
  const result = evaluateReadiness({ plan, requiredRequirementIds, assertions });
  assert.equal(result.status, "NOT_READY");
  const gap = result.gaps.find((g) => g.requirementId === "handover");
  assert.ok(gap !== undefined);
  assert.equal(gap!.kind, "AMBIGUOUS");
  assert.match(gap!.reason, /conflicting readiness outcomes/);
});

test("F1: a REQUIRED requirement with no readiness assertion at all is a MISSING gap with an exact reason", () => {
  const { tenantScope, project, plan } = compiledPlan();
  const requiredRequirementIds = plan.nodes
    .filter((n) => n.disposition === "REQUIRED")
    .map((n) => n.requirementId);
  const assertions = buildFullReadinessAssertions(tenantScope, project, plan).filter(
    (a) => a.evidence.relatedRequirementId !== "seo-runtime-qa",
  );
  const result = evaluateReadiness({ plan, requiredRequirementIds, assertions });
  assert.equal(result.status, "NOT_READY");
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0]!.requirementId, "seo-runtime-qa");
  assert.equal(result.gaps[0]!.kind, "MISSING");
  assert.match(result.gaps[0]!.reason, /seo-runtime-qa/);
});

test("F1: a readiness assertion made against an earlier plan version is a STALE gap, not READY", () => {
  const { tenantScope, project, plan } = compiledPlan();
  const requiredRequirementIds = plan.nodes
    .filter((n) => n.disposition === "REQUIRED")
    .map((n) => n.requirementId);
  // Force the "handover" assertion to a version that cannot possibly equal
  // the current plan version, regardless of what that version happens to be.
  const assertions = buildFullReadinessAssertions(tenantScope, project, plan).map((a) =>
    a.evidence.relatedRequirementId === "handover"
      ? { ...a, assertedForPlanVersion: plan.version + 1000 }
      : a,
  );
  const result = evaluateReadiness({ plan, requiredRequirementIds, assertions });
  assert.equal(result.status, "NOT_READY");
  const gap = result.gaps.find((g) => g.requirementId === "handover");
  assert.ok(gap !== undefined);
  assert.equal(gap!.kind, "STALE");
});

test("F1: a HYPOTHESIS or UNKNOWN (or conflicting-kind) current-version assertion is an AMBIGUOUS gap, not READY", () => {
  const { tenantScope, project, plan } = compiledPlan();
  const requiredRequirementIds = plan.nodes
    .filter((n) => n.disposition === "REQUIRED")
    .map((n) => n.requirementId);
  const assertions = buildFullReadinessAssertions(tenantScope, project, plan).map((a) =>
    a.evidence.relatedRequirementId === "design-build"
      ? {
          ...a,
          evidence: createCustomerEvidenceItem({
            tenantScope,
            project,
            evidenceRef: "ev-design-build-hypothesis",
            kind: "HYPOTHESIS",
            subject: "Design direction is not yet confirmed",
            sourceLocator: "internal://test-fixtures/readiness/design-build-ambiguous",
            relatedRequirementId: "design-build",
          }),
        }
      : a,
  );
  const result = evaluateReadiness({ plan, requiredRequirementIds, assertions });
  assert.equal(result.status, "NOT_READY");
  const gap = result.gaps.find((g) => g.requirementId === "design-build");
  assert.ok(gap !== undefined);
  assert.equal(gap!.kind, "AMBIGUOUS");
});

test("F1: a readiness assertion for a different tenant/project fails closed rather than being silently ignored or accepted", () => {
  const { plan } = compiledPlan();
  const otherTenantScope = createTenantScope("tenant-readiness-other");
  const otherCustomer = createCustomer({
    tenantScope: otherTenantScope,
    customerId: "cust-readiness-other",
    displayName: "Other Customer",
  });
  const otherProject = createProject({
    tenantScope: otherTenantScope,
    customer: otherCustomer,
    projectId: "proj-readiness-other",
    ownerRef: "owner-readiness-other",
    state: "active",
  });
  const foreignAssertion = {
    evidence: createCustomerEvidenceItem({
      tenantScope: otherTenantScope,
      project: otherProject,
      evidenceRef: "ev-foreign",
      kind: "FACT" as const,
      subject: "Belongs to a different tenant/project entirely",
      sourceLocator: "internal://test-fixtures/readiness/foreign",
      relatedRequirementId: "discovery-evidence-intake",
    }),
    assertedForPlanVersion: plan.version,
    readinessOutcome: "SATISFIED" as const,
  };
  const requiredRequirementIds = plan.nodes
    .filter((n) => n.disposition === "REQUIRED")
    .map((n) => n.requirementId);
  assert.throws(
    () =>
      evaluateReadiness({
        plan,
        requiredRequirementIds,
        assertions: [foreignAssertion],
      }),
    InvalidAdmissionReadinessError,
  );
});
