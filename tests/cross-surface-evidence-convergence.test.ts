import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createCustomerEvidenceItem } from "../src/domain/customer-evidence.js";
import { buildCrossDomainIntelligenceSnapshot } from "../src/domain/cross-domain-intelligence.js";
import { createExternalEffectIntent, startExternalEffectAttempt, reportExternalEffectOutcome, verifyExternalEffectReadback } from "../src/domain/external-effect-envelope.js";
import {
  createMetricDefinition,
  createMetricMonitoringRegistration,
  recordMetricObservation,
  createMetricWindow,
  projectMetricReadModel,
} from "../src/domain/observability-telemetry.js";
import {
  convergeCustomerEvidenceItem,
  convergeIntelligenceInsight,
  convergeExternalEffectAttempt,
  convergeMetricReadModel,
  buildConvergedEvidenceSnapshot,
  projectCustomerSafeEvidenceSummary,
  InvalidCrossSurfaceEvidenceError,
} from "../src/domain/cross-surface-evidence-convergence.js";

const tenantScope = createTenantScope("tenant-conv-1");
const customer = createCustomer({ tenantScope, customerId: "cust-1", displayName: "Acme" });
const project = createProject({ tenantScope, customer, projectId: "project-1", ownerRef: "owner-1", state: "ACTIVE" });

// --- convergeCustomerEvidenceItem ---

test("X1: a FACT customer evidence item converges to CONFIRMED", () => {
  const item = createCustomerEvidenceItem({
    tenantScope,
    project,
    evidenceRef: "evidence-1",
    kind: "FACT",
    subject: "site is live",
    sourceLocator: "https://example.com",
  });
  const converged = convergeCustomerEvidenceItem(item);
  assert.equal(converged.sourceSurface, "CUSTOMER_EVIDENCE");
  assert.equal(converged.disposition, "CONFIRMED");
  assert.equal(converged.originalStatus, "FACT");
  assert.equal(converged.sourceRef, "evidence-1");
  assert.equal(converged.tenantId, tenantScope.tenantId);
});

test("X2: a HYPOTHESIS customer evidence item converges to UNCERTAIN", () => {
  const item = createCustomerEvidenceItem({
    tenantScope,
    project,
    evidenceRef: "evidence-2",
    kind: "HYPOTHESIS",
    subject: "traffic may be growing",
    sourceLocator: "internal-note",
  });
  assert.equal(convergeCustomerEvidenceItem(item).disposition, "UNCERTAIN");
});

test("X3: an UNKNOWN customer evidence item converges to UNAVAILABLE, never a guessed CONFIRMED", () => {
  const item = createCustomerEvidenceItem({
    tenantScope,
    project,
    evidenceRef: "evidence-3",
    kind: "UNKNOWN",
    subject: "status unclear",
    sourceLocator: "internal-note",
  });
  assert.equal(convergeCustomerEvidenceItem(item).disposition, "UNAVAILABLE");
});

// --- convergeIntelligenceInsight ---

function reconciledInsight(status: "CURRENT" | "STALE" | "CONFLICTING") {
  const asOf = "2026-01-01T00:00:00.000Z";
  if (status === "CURRENT") {
    const snapshot = buildCrossDomainIntelligenceSnapshot({
      tenantScope,
      projectRef: "project-1",
      customerId: customer.customerId,
      asOf,
      freshnessThresholdMs: 60_000,
      insights: [
        {
          tenantScope,
          projectRef: "project-1",
          customerId: customer.customerId,
          domain: "SALES",
          subjectRef: "subject-1",
          kind: "OBSERVED",
          value: "closed-won",
          capturedAt: "2026-01-01T00:00:00.000Z",
          sourceRef: "source-1",
        },
      ],
    });
    return snapshot.reconciled[0]!;
  }
  if (status === "CONFLICTING") {
    const snapshot = buildCrossDomainIntelligenceSnapshot({
      tenantScope,
      projectRef: "project-1",
      customerId: customer.customerId,
      asOf,
      freshnessThresholdMs: 60_000,
      insights: [
        {
          tenantScope,
          projectRef: "project-1",
          customerId: customer.customerId,
          domain: "SALES",
          subjectRef: "subject-2",
          kind: "OBSERVED",
          value: "closed-won",
          capturedAt: "2026-01-01T00:00:00.000Z",
          sourceRef: "source-1",
        },
        {
          tenantScope,
          projectRef: "project-1",
          customerId: customer.customerId,
          domain: "DELIVERY",
          subjectRef: "subject-2",
          kind: "OBSERVED",
          value: "closed-lost",
          capturedAt: "2026-01-01T00:00:00.000Z",
          sourceRef: "source-2",
        },
      ],
    });
    return snapshot.reconciled[0]!;
  }
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef: "project-1",
    customerId: customer.customerId,
    asOf,
    freshnessThresholdMs: 1,
    insights: [
      {
        tenantScope,
        projectRef: "project-1",
        customerId: customer.customerId,
        domain: "SALES",
        subjectRef: "subject-3",
        kind: "OBSERVED",
        value: "closed-won",
        capturedAt: "2025-01-01T00:00:00.000Z",
        sourceRef: "source-1",
      },
    ],
  });
  return snapshot.reconciled[0]!;
}

test("X4: a CURRENT reconciled insight converges to CONFIRMED", () => {
  const converged = convergeIntelligenceInsight(reconciledInsight("CURRENT"));
  assert.equal(converged.sourceSurface, "CROSS_DOMAIN_INTELLIGENCE");
  assert.equal(converged.disposition, "CONFIRMED");
  assert.equal(converged.originalStatus, "CURRENT");
  assert.equal(converged.tenantId, tenantScope.tenantId);
});

test("X5: a STALE reconciled insight converges to UNCERTAIN", () => {
  assert.equal(convergeIntelligenceInsight(reconciledInsight("STALE")).disposition, "UNCERTAIN");
});

test("X6 (adversarial, comparability honesty): a CONFLICTING reconciled insight converges to CONTRADICTED, never CONFIRMED", () => {
  assert.equal(convergeIntelligenceInsight(reconciledInsight("CONFLICTING")).disposition, "CONTRADICTED");
});

// --- convergeExternalEffectAttempt ---

function effectAttempt(state: "NOT_STARTED" | "APPLIED" | "VERIFIED" | "FAILED" | "UNKNOWN" | "ROLLED_BACK") {
  const intent = createExternalEffectIntent({
    tenantScope,
    effectIntentId: `intent-${state}`,
    actionRef: "action:x",
    retryClassification: "SAFE_TO_RETRY",
    requiresApproval: false,
  });
  let attempt = startExternalEffectAttempt({ intent, attemptId: `attempt-${state}` });
  if (state === "NOT_STARTED") {
    return attempt;
  }
  if (state === "APPLIED" || state === "FAILED" || state === "UNKNOWN") {
    return reportExternalEffectOutcome({ attempt, outcome: state, externalCorrelationRef: "correlation-1" });
  }
  attempt = reportExternalEffectOutcome({ attempt, outcome: "APPLIED", externalCorrelationRef: "correlation-1" });
  if (state === "VERIFIED") {
    return verifyExternalEffectReadback({ attempt, readbackConfirmsApplied: true, evidenceRef: "evidence-readback" });
  }
  return { ...attempt, state: "ROLLED_BACK" as const, rollbackCorrelationRef: "rollback-1", rollbackEvidenceRef: "evidence-rollback" };
}

test("X7: a VERIFIED effect attempt converges to CONFIRMED", () => {
  const converged = convergeExternalEffectAttempt(effectAttempt("VERIFIED"));
  assert.equal(converged.disposition, "CONFIRMED");
  assert.equal(converged.tenantId, tenantScope.tenantId);
});

test("X8 (adversarial, readback-authoritative honesty): a merely APPLIED (not yet verified) effect attempt converges to UNCERTAIN, never CONFIRMED", () => {
  assert.equal(convergeExternalEffectAttempt(effectAttempt("APPLIED")).disposition, "UNCERTAIN");
});

test("X9: a FAILED effect attempt converges to CONTRADICTED", () => {
  assert.equal(convergeExternalEffectAttempt(effectAttempt("FAILED")).disposition, "CONTRADICTED");
});

test("X10: a ROLLED_BACK effect attempt converges to CONTRADICTED", () => {
  assert.equal(convergeExternalEffectAttempt(effectAttempt("ROLLED_BACK")).disposition, "CONTRADICTED");
});

test("X11: an UNKNOWN effect attempt converges to UNCERTAIN, never a guessed FAILED or CONFIRMED", () => {
  assert.equal(convergeExternalEffectAttempt(effectAttempt("UNKNOWN")).disposition, "UNCERTAIN");
});

test("X12: a NOT_STARTED effect attempt converges to UNAVAILABLE", () => {
  assert.equal(convergeExternalEffectAttempt(effectAttempt("NOT_STARTED")).disposition, "UNAVAILABLE");
});

// --- convergeMetricReadModel ---

function metricReadModel(status: "REPORTED_FRESH" | "REPORTED_STALE" | "MISSING" | "NOT_MONITORED") {
  const definition = createMetricDefinition({
    tenantScope,
    metricRef: "metric-1",
    unit: "COUNT",
    displayLabel: "Signups",
  });
  const monitoring = createMetricMonitoringRegistration({ definition, sourceRef: "source-1" });
  if (status === "NOT_MONITORED") {
    return projectMetricReadModel({
      definition,
      monitoring: { ...monitoring, state: "NOT_MONITORED" },
      asOf: "2026-01-01T00:00:00.000Z",
      maxAgeMs: 60_000,
    });
  }
  if (status === "MISSING") {
    return projectMetricReadModel({
      definition,
      monitoring,
      asOf: "2026-01-01T00:00:00.000Z",
      maxAgeMs: 60_000,
    });
  }
  const observation = recordMetricObservation({
    definition,
    sourceRef: "source-1",
    window: createMetricWindow({ windowStart: "2025-12-31T00:00:00.000Z", windowEnd: "2026-01-01T00:00:00.000Z" }),
    presence: "REPORTED",
    value: 42,
    quality: "VERIFIED",
    capturedAt: status === "REPORTED_FRESH" ? "2026-01-01T00:00:00.000Z" : "2020-01-01T00:00:00.000Z",
  });
  return projectMetricReadModel({
    definition,
    monitoring,
    observation,
    asOf: "2026-01-01T00:00:00.000Z",
    maxAgeMs: 60_000,
  });
}

test("X13: a REPORTED_FRESH metric read-model converges to CONFIRMED", () => {
  const converged = convergeMetricReadModel(metricReadModel("REPORTED_FRESH"));
  assert.equal(converged.disposition, "CONFIRMED");
  assert.equal(converged.tenantId, tenantScope.tenantId);
});

test("X14: a REPORTED_STALE metric read-model converges to UNCERTAIN", () => {
  assert.equal(convergeMetricReadModel(metricReadModel("REPORTED_STALE")).disposition, "UNCERTAIN");
});

test("X15: a MISSING metric read-model converges to UNAVAILABLE", () => {
  assert.equal(convergeMetricReadModel(metricReadModel("MISSING")).disposition, "UNAVAILABLE");
});

test("X16: a NOT_MONITORED metric read-model converges to UNAVAILABLE", () => {
  assert.equal(convergeMetricReadModel(metricReadModel("NOT_MONITORED")).disposition, "UNAVAILABLE");
});

// --- buildConvergedEvidenceSnapshot / projectCustomerSafeEvidenceSummary ---

test("X17 (adversarial): buildConvergedEvidenceSnapshot rejects an empty subjectRef", () => {
  assert.throws(
    () => buildConvergedEvidenceSnapshot({ tenantScope, subjectRef: "", items: [] }),
    InvalidCrossSurfaceEvidenceError,
  );
});

test("X18: projectCustomerSafeEvidenceSummary on an empty snapshot is honestly UNAVAILABLE, never a fabricated CONFIRMED", () => {
  const snapshot = buildConvergedEvidenceSnapshot({ tenantScope, subjectRef: "subject-1", items: [] });
  const summary = projectCustomerSafeEvidenceSummary(snapshot);
  assert.equal(summary.overallDisposition, "UNAVAILABLE");
  assert.equal(summary.itemCount, 0);
});

test("X19 (the pessimistic-aggregation guard): a single CONTRADICTED item among otherwise-CONFIRMED items dominates the overall disposition", () => {
  const snapshot = buildConvergedEvidenceSnapshot({
    tenantScope,
    subjectRef: "subject-1",
    items: [
      convergeCustomerEvidenceItem(
        createCustomerEvidenceItem({
          tenantScope,
          project,
          evidenceRef: "evidence-fact",
          kind: "FACT",
          subject: "site is live",
          sourceLocator: "https://example.com",
        }),
      ),
      convergeExternalEffectAttempt(effectAttempt("FAILED")),
    ],
  });
  const summary = projectCustomerSafeEvidenceSummary(snapshot);
  assert.equal(summary.overallDisposition, "CONTRADICTED");
  assert.equal(summary.itemCount, 2);
});

test("X20 (customer-safe projection, structural absence): CustomerSafeEvidenceSummary carries no field capable of holding sourceRef or originalStatus", () => {
  const snapshot = buildConvergedEvidenceSnapshot({
    tenantScope,
    subjectRef: "subject-1",
    items: [convergeExternalEffectAttempt(effectAttempt("VERIFIED"))],
  });
  const summary = projectCustomerSafeEvidenceSummary(snapshot);
  const keys = Object.keys(summary).sort();
  assert.deepEqual(keys, ["itemCount", "overallDisposition", "subjectRef"]);
});

// --- CXP-001S: tenant-lineage hardening ---

const tenantB = createTenantScope("tenant-conv-2");
const customerB = createCustomer({ tenantScope: tenantB, customerId: "cust-b", displayName: "Foreign Co" });
const projectB = createProject({
  tenantScope: tenantB,
  customer: customerB,
  projectId: "project-b",
  ownerRef: "owner-b",
  state: "ACTIVE",
});

test("CXP-001S (adversarial): buildConvergedEvidenceSnapshot rejects a genuinely foreign-tenant converged item, even though it converts cleanly through the public converter - this must fail on the pre-correction implementation", () => {
  const foreignItem = createCustomerEvidenceItem({
    tenantScope: tenantB,
    project: projectB,
    evidenceRef: "evidence-foreign",
    kind: "FACT",
    subject: "foreign tenant's own fact",
    sourceLocator: "https://foreign.example.com",
  });
  const foreignConverged = convergeCustomerEvidenceItem(foreignItem);
  assert.equal(foreignConverged.tenantId, tenantB.tenantId);

  assert.throws(
    () =>
      buildConvergedEvidenceSnapshot({
        tenantScope,
        subjectRef: "subject-1",
        items: [foreignConverged],
      }),
    InvalidCrossSurfaceEvidenceError,
  );
});

test("CXP-001S (adversarial): a foreign-tenant item mixed in among genuine same-tenant items is still rejected - not merely skipped or diluted", () => {
  const foreignAttempt = effectAttempt("VERIFIED"); // tenantA copy, then forge a foreign one below
  const foreignConverged = { ...convergeExternalEffectAttempt(foreignAttempt), tenantId: tenantB.tenantId as never };
  const genuineConverged = convergeCustomerEvidenceItem(
    createCustomerEvidenceItem({
      tenantScope,
      project,
      evidenceRef: "evidence-genuine",
      kind: "FACT",
      subject: "genuine tenant-a fact",
      sourceLocator: "https://example.com",
    }),
  );
  assert.throws(
    () =>
      buildConvergedEvidenceSnapshot({
        tenantScope,
        subjectRef: "subject-1",
        items: [genuineConverged, foreignConverged],
      }),
    InvalidCrossSurfaceEvidenceError,
  );
});

test("CXP-001S: a same-tenant valid mixed-surface snapshot (customer evidence + telemetry + intelligence + external effect, all genuinely tenant-A) still converges and aggregates correctly", () => {
  const snapshot = buildConvergedEvidenceSnapshot({
    tenantScope,
    subjectRef: "subject-1",
    items: [
      convergeCustomerEvidenceItem(
        createCustomerEvidenceItem({
          tenantScope,
          project,
          evidenceRef: "evidence-mixed",
          kind: "FACT",
          subject: "site is live",
          sourceLocator: "https://example.com",
        }),
      ),
      convergeExternalEffectAttempt(effectAttempt("VERIFIED")),
      convergeMetricReadModel(metricReadModel("REPORTED_FRESH")),
      convergeIntelligenceInsight(reconciledInsight("CURRENT")),
    ],
  });
  assert.equal(snapshot.items.length, 4);
  assert.ok(snapshot.items.every((item) => item.tenantId === tenantScope.tenantId));
  assert.equal(projectCustomerSafeEvidenceSummary(snapshot).overallDisposition, "CONFIRMED");
});

test("CXP-001S (adversarial): convergeIntelligenceInsight derives tenantId from a genuinely different backing lineage, not a coincidental match with the default test tenant", () => {
  const otherTenantScope = createTenantScope("tenant-conv-reconciled-other");
  const otherCustomer = createCustomer({ tenantScope: otherTenantScope, customerId: "cust-other", displayName: "Other Co" });
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope: otherTenantScope,
    projectRef: "project-other",
    customerId: otherCustomer.customerId,
    asOf: "2026-01-01T00:00:00.000Z",
    freshnessThresholdMs: 60_000,
    insights: [
      {
        tenantScope: otherTenantScope,
        projectRef: "project-other",
        customerId: otherCustomer.customerId,
        domain: "SALES",
        subjectRef: "subject-other",
        kind: "OBSERVED",
        value: "closed-won",
        capturedAt: "2026-01-01T00:00:00.000Z",
        sourceRef: "source-other",
      },
    ],
  });
  const converged = convergeIntelligenceInsight(snapshot.reconciled[0]!);
  assert.equal(converged.tenantId, otherTenantScope.tenantId);
  assert.notEqual(converged.tenantId, tenantScope.tenantId);
});

test("CXP-001S (adversarial): convergeIntelligenceInsight fails closed on an empty insights lineage rather than fabricating a tenant identity", () => {
  assert.throws(
    () =>
      convergeIntelligenceInsight({
        subjectRef: "subject-empty",
        status: "CURRENT",
        insights: [],
        agreedValue: "x",
      }),
    InvalidCrossSurfaceEvidenceError,
  );
});

test("CXP-001S (adversarial): convergeIntelligenceInsight fails closed on an internally incoherent (tenant-disagreeing) insights lineage rather than picking an arbitrary element's tenant", () => {
  const otherTenantScope = createTenantScope("tenant-conv-incoherent-other");
  assert.throws(
    () =>
      convergeIntelligenceInsight({
        subjectRef: "subject-incoherent",
        status: "CURRENT",
        insights: [
          {
            tenantScope,
            projectRef: "project-1",
            customerId: customer.customerId,
            domain: "SALES",
            subjectRef: "subject-incoherent",
            kind: "OBSERVED",
            value: "closed-won",
            capturedAt: "2026-01-01T00:00:00.000Z",
            sourceRef: "source-1",
          },
          {
            tenantScope: otherTenantScope,
            projectRef: "project-1",
            customerId: customer.customerId,
            domain: "SALES",
            subjectRef: "subject-incoherent",
            kind: "OBSERVED",
            value: "closed-won",
            capturedAt: "2026-01-01T00:00:00.000Z",
            sourceRef: "source-1",
          },
        ],
        agreedValue: "closed-won",
      }),
    InvalidCrossSurfaceEvidenceError,
  );
});
