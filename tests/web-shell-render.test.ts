import { test } from "node:test";
import assert from "node:assert/strict";
import { renderShellPage, type ShellPageContent } from "../src/web/shell-render.js";
import { WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT } from "../src/fixtures/website-build-v1-snapshot.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { createOutcomeJob, enterExceptionState } from "../src/domain/outcome-job.js";
import { buildClientProjectSnapshot } from "../src/domain/client-project-snapshot.js";
import type { TeamAttentionViewState } from "../src/web/team-attention-view-state.js";
import { WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION } from "../src/fixtures/website-build-v1-team-attention.js";
import type { CustomerCommercialStatusViewState } from "../src/web/customer-commercial-view-state.js";
import type { BillingReferenceStatusViewState } from "../src/web/billing-reference-view-state.js";
import type { CustomerLifecycleReadinessViewState } from "../src/web/customer-lifecycle-readiness-view-state.js";
import type { SubscriptionUsageStatus } from "../src/domain/subscription-usage-status.js";
import type { BillingReferenceRecord } from "../src/domain/billing-reference.js";
import type { CustomerLifecycleReadinessProjection } from "../src/domain/customer-lifecycle-readiness.js";

const READY_SNAPSHOT = WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT;

function buildBlockedSnapshot() {
  const fixture = buildWebsiteBuildV1Fixture();
  const job = createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId: "job-render-blocker-test",
    jobFamily: "website-build-v1",
    businessObjective: "test",
  });
  const { job: blockedJob, auditEvent } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-render-blocker-1",
    actorRef: "system",
    timestamp: "2026-08-24T00:00:00Z",
    reason: "internal engineering reason, not customer-safe",
  });
  return buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: [blockedJob],
    auditEvents: [auditEvent],
  });
}

const BLOCKED_SNAPSHOT = buildBlockedSnapshot();

const ALL_CONTENTS: ReadonlyArray<{ content: ShellPageContent; expectedStatus: number }> = [
  { content: { kind: "LOADING" }, expectedStatus: 200 },
  { content: { kind: "EMPTY" }, expectedStatus: 200 },
  { content: { kind: "UNAVAILABLE", reason: "simulated unavailable" }, expectedStatus: 503 },
  { content: { kind: "UNSUPPORTED", reason: "simulated unsupported" }, expectedStatus: 501 },
  { content: { kind: "BLOCKED", snapshot: BLOCKED_SNAPSHOT }, expectedStatus: 200 },
  { content: { kind: "ERROR", reason: "simulated error reason" }, expectedStatus: 500 },
  { content: { kind: "NOT_FOUND" }, expectedStatus: 404 },
  { content: { kind: "UNAUTHENTICATED" }, expectedStatus: 401 },
  { content: { kind: "FORBIDDEN_TENANT_SCOPE" }, expectedStatus: 403 },
  { content: { kind: "READY", snapshot: READY_SNAPSHOT }, expectedStatus: 200 },
];

test("U5: every ShellPageContent kind renders its own distinct, deterministic HTTP status - never masquerading as success", () => {
  for (const { content, expectedStatus } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    assert.equal(rendered.status, expectedStatus, `kind ${content.kind} expected status ${expectedStatus}`);
    assert.equal(rendered.contentType, "text/html; charset=utf-8");
  }
});

test("U9: only READY and BLOCKED ever render project-identity content - no other kind exposes any snapshot field", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    if (content.kind === "READY" || content.kind === "BLOCKED") {
      assert.match(rendered.html, /<h2 id="project-identity-heading">Project<\/h2>/);
    } else {
      assert.doesNotMatch(rendered.html, /project-identity-heading/);
    }
  }
});

test("U2/U6: every rendered page contains a skip link, semantic landmarks, and a responsive viewport meta tag", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    assert.match(rendered.html, /class="skip-link" href="#main-content"/);
    assert.match(rendered.html, /<header>/);
    assert.match(rendered.html, /<main id="main-content">/);
    assert.match(rendered.html, /<footer>/);
    assert.match(rendered.html, /name="viewport" content="width=device-width, initial-scale=1"/);
  }
});

test("U1: every rendered page defines a visible :focus-visible outline rule - keyboard focus is never invisible", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    assert.match(rendered.html, /:focus-visible \{ outline: 3px solid/);
  }
});

test("U2: status is never color-only - a visible text label always accompanies the tone class", () => {
  const rendered = renderShellPage({ kind: "FORBIDDEN_TENANT_SCOPE" });
  assert.match(rendered.html, /class="status status-danger" role="status">Access denied</);
});

test("U11: reason text is HTML-escaped, never injected as raw markup", () => {
  const rendered = renderShellPage({ kind: "UNAVAILABLE", reason: "<script>alert(1)</script>" });
  assert.doesNotMatch(rendered.html, /<script>/);
  assert.match(rendered.html, /&lt;script&gt;/);
});

test("U5: the ERROR state never leaks its internal reason string into the customer-facing page", () => {
  const rendered = renderShellPage({ kind: "ERROR", reason: "internal stack trace detail" });
  assert.doesNotMatch(rendered.html, /internal stack trace detail/);
});

test("IA: READY renders next action, timeline, working artifact, capabilities, and recent updates from the snapshot", () => {
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT });
  assert.match(rendered.html, /<h2 id="next-action-heading">Next action<\/h2>/);
  assert.match(rendered.html, /<h2 id="timeline-heading">Timeline<\/h2>/);
  assert.match(rendered.html, /<h2 id="working-artifact-heading">Working artifact<\/h2>/);
  assert.match(rendered.html, /<h2 id="capabilities-heading">Connections &amp; capabilities<\/h2>/);
  assert.match(rendered.html, /required-access-connections: Ready/);
  assert.match(rendered.html, /<h2 id="communications-heading">Recent updates<\/h2>/);
});

test("U6/U13: a preview (not-yet-approved) working artifact never renders the Approved label", () => {
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT });
  if (READY_SNAPSHOT.workingArtifact?.isCurrentVersionApproved === false) {
    assert.match(rendered.html, /Preview — not yet approved/);
    assert.doesNotMatch(rendered.html, />Approved</);
  }
});

test("U6: BLOCKED renders a customer-safe blocker card sourced only from the timeline's BLOCKER category, never the raw internal reason", () => {
  const rendered = renderShellPage({ kind: "BLOCKED", snapshot: BLOCKED_SNAPSHOT });
  assert.match(rendered.html, /<h2 id="blocker-heading">Blocked<\/h2>/);
  assert.match(rendered.html, /Blocked since/);
  assert.doesNotMatch(rendered.html, /internal engineering reason, not customer-safe/);
});

test("U6: the next-action badge is a distinct, always-visible text label for each owner - never color alone", () => {
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT });
  assert.match(rendered.html, /class="status status-\w+" role="status">[A-Z ]+<\/p>/);
});

test("V2-CDO-008 A12: only READY and BLOCKED render the advisor section - it is exactly as scoped as the rest of the customer-safe body", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    if (content.kind === "READY" || content.kind === "BLOCKED") {
      assert.match(rendered.html, /<h2 id="advisor-heading">Delivery advisor<\/h2>/);
    } else {
      assert.doesNotMatch(rendered.html, /advisor-heading/);
    }
  }
});

test("V2-CDO-008 A5/A12: READY with an eligible (VERIFIED_AVAILABLE) capability renders an L1_RECOMMEND advisor badge and a labelled, non-authoritative recommendation", () => {
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT });
  assert.match(rendered.html, />ADVISOR: RECOMMEND</);
  assert.match(rendered.html, /Advisor recommendation — not verified evidence, not an approval/);
  assert.match(rendered.html, /required-access-connections/);
});

test("V2-CDO-008 A6: a snapshot with zero eligible capability renders an L0_OBSERVE advisor badge and the deterministic unavailable reason, never a fabricated recommendation", () => {
  const emptySnapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: buildWebsiteBuildV1Fixture().project,
    jobs: [],
  });
  const rendered = renderShellPage({ kind: "READY", snapshot: emptySnapshot });
  assert.match(rendered.html, />ADVISOR: OBSERVE</);
  assert.match(rendered.html, /No policy-eligible \(VERIFIED_AVAILABLE\) capability exists for this project yet\./);
  assert.doesNotMatch(rendered.html, /Advisor recommendation/);
});

test("V2-CDO-008 A13: the advisor section renders after, and never in place of, the verified project-status sections on both READY and BLOCKED", () => {
  for (const content of [
    { kind: "READY" as const, snapshot: READY_SNAPSHOT },
    { kind: "BLOCKED" as const, snapshot: BLOCKED_SNAPSHOT },
  ]) {
    const rendered = renderShellPage(content);
    const projectIndex = rendered.html.indexOf("project-identity-heading");
    const advisorIndex = rendered.html.indexOf("advisor-heading");
    assert.equal(projectIndex >= 0, true);
    assert.equal(advisorIndex >= 0, true);
    assert.equal(projectIndex < advisorIndex, true);
  }
});

test("V3-F-001 A12: only READY and BLOCKED render the team-attention section - it is exactly as scoped as the rest of the customer-safe body", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    if (content.kind === "READY" || content.kind === "BLOCKED") {
      assert.match(rendered.html, /<h2 id="team-attention-heading">Team &amp; attention<\/h2>/);
    } else {
      assert.doesNotMatch(rendered.html, /team-attention-heading/);
    }
  }
});

test("V3-F-001: with no teamAttention supplied at all, the section renders the honest Unavailable state, never a fabricated default", () => {
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT });
  const sectionStart = rendered.html.indexOf("team-attention-heading");
  const sectionHtml = rendered.html.slice(sectionStart, sectionStart + 400);
  assert.match(sectionHtml, />Unavailable</);
});

test("V3-F-001: an UNAVAILABLE teamAttention view renders the same honest Unavailable message as no wiring at all", () => {
  const unavailable: TeamAttentionViewState = { kind: "UNAVAILABLE" };
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT, teamAttention: unavailable });
  const sectionStart = rendered.html.indexOf("team-attention-heading");
  const sectionHtml = rendered.html.slice(sectionStart, sectionStart + 400);
  assert.match(sectionHtml, />Unavailable</);
});

test("V3-F-001: a FORBIDDEN_TENANT_SCOPE teamAttention view never distinguishes itself from Unavailable (no boundary detail leaked into the page)", () => {
  const forbidden: TeamAttentionViewState = { kind: "FORBIDDEN_TENANT_SCOPE" };
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT, teamAttention: forbidden });
  const sectionStart = rendered.html.indexOf("team-attention-heading");
  const sectionHtml = rendered.html.slice(sectionStart, sectionStart + 400);
  assert.match(sectionHtml, />Unavailable</);
});

test("V3-F-001: a READY teamAttention view renders each owner role separately, the viewer role, active attention, and a fixed commercial-unavailable literal", () => {
  const ready: TeamAttentionViewState = { kind: "READY", projection: WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION };
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT, teamAttention: ready });
  assert.match(rendered.html, /Your role: STAFF/);
  assert.match(rendered.html, /Lead Owner: /);
  assert.match(rendered.html, /Deal Owner: /);
  assert.match(rendered.html, /Account Owner: /);
  assert.match(rendered.html, /Delivery Owner: /);
  assert.match(rendered.html, /Attention: EXCEPTION/);
  assert.match(rendered.html, /Commercial: Unavailable/);
});

test("V3-F-001: a READY teamAttention view with no owner assigned for a role renders 'not assigned', never a guessed identifier", () => {
  const projectionWithNoOwners = { ...WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION, owners: {} };
  const ready: TeamAttentionViewState = { kind: "READY", projection: projectionWithNoOwners };
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT, teamAttention: ready });
  assert.match(rendered.html, /Lead Owner: not assigned/);
  assert.match(rendered.html, /Deal Owner: not assigned/);
  assert.match(rendered.html, /Account Owner: not assigned/);
  assert.match(rendered.html, /Delivery Owner: not assigned/);
});

const FIXTURE_COMMERCIAL_STATUS: SubscriptionUsageStatus = {
  tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
  customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
  subscriptionStatus: "ACTIVE",
  isEntitled: true,
  entitlementRefs: ["feature:advisor"],
  commercialUsage: "NOT_CONFIGURED",
};

test("V2-CUST-SURFACE-001: only READY and BLOCKED render the subscription-status section - it is exactly as scoped as the rest of the customer-safe body", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    if (content.kind === "READY" || content.kind === "BLOCKED") {
      assert.match(rendered.html, /<h2 id="subscription-status-heading">Subscription &amp; entitlement<\/h2>/);
    } else {
      assert.doesNotMatch(rendered.html, /subscription-status-heading/);
    }
  }
});

test("V2-CUST-SURFACE-001: with no commercialStatus supplied at all, the section renders the honest Unavailable state, never a fabricated default", () => {
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT });
  const sectionStart = rendered.html.indexOf("subscription-status-heading");
  const sectionHtml = rendered.html.slice(sectionStart, sectionStart + 400);
  assert.match(sectionHtml, />Unavailable</);
});

test("V2-CUST-SURFACE-001: a FORBIDDEN_TENANT_SCOPE commercialStatus view never distinguishes itself from Unavailable (no boundary detail leaked into the page)", () => {
  const forbidden: CustomerCommercialStatusViewState = { kind: "FORBIDDEN_TENANT_SCOPE" };
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT, commercialStatus: forbidden });
  const sectionStart = rendered.html.indexOf("subscription-status-heading");
  const sectionHtml = rendered.html.slice(sectionStart, sectionStart + 400);
  assert.match(sectionHtml, />Unavailable</);
});

test("V2-CUST-SURFACE-001: a READY commercialStatus view renders subscription status, entitlement, and the truthful commercialUsage literal verbatim", () => {
  const ready: CustomerCommercialStatusViewState = { kind: "READY", status: FIXTURE_COMMERCIAL_STATUS };
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT, commercialStatus: ready });
  assert.match(rendered.html, /Subscription status: <strong>ACTIVE<\/strong>/);
  assert.match(rendered.html, /Entitled: Yes/);
  assert.match(rendered.html, /Usage: NOT_CONFIGURED/);
});

const FIXTURE_BILLING_REFERENCE_RECORD: BillingReferenceRecord = {
  tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
  customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
  subscriptionId: "sub-render-fixture" as BillingReferenceRecord["subscriptionId"],
  externalInvoiceRef: "inv-render-fixture",
  status: "PAID",
  recordedAt: "2026-10-13T00:00:00.000Z",
  evidenceRef: "internal://tests/web-shell-render/billing-reference",
};

test("V2-CUST-SURFACE-001: only READY and BLOCKED render the billing-reference section", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    if (content.kind === "READY" || content.kind === "BLOCKED") {
      assert.match(rendered.html, /<h2 id="billing-reference-heading">Billing reference<\/h2>/);
    } else {
      assert.doesNotMatch(rendered.html, /billing-reference-heading/);
    }
  }
});

test("V2-CUST-SURFACE-001: with no billingReferenceStatus supplied at all, the section renders the honest Unavailable state", () => {
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT });
  const sectionStart = rendered.html.indexOf("billing-reference-heading");
  const sectionHtml = rendered.html.slice(sectionStart, sectionStart + 400);
  assert.match(sectionHtml, />Unavailable</);
});

test("V2-CUST-SURFACE-001: a READY billingReferenceStatus view renders the reference status, never a monetary amount (the underlying record has no amount field)", () => {
  const ready: BillingReferenceStatusViewState = { kind: "READY", record: FIXTURE_BILLING_REFERENCE_RECORD };
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT, billingReferenceStatus: ready });
  assert.match(rendered.html, /Reference status: <strong>PAID<\/strong>/);
});

const FIXTURE_LIFECYCLE_READINESS: CustomerLifecycleReadinessProjection = {
  tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
  customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
  offboardingStatus: "COMPLETED",
  offboardingExecutionStatus: "COMPLETED",
  backupReadiness: "AVAILABLE",
};

test("V2-CUST-SURFACE-001: only READY and BLOCKED render the account-lifecycle section", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    if (content.kind === "READY" || content.kind === "BLOCKED") {
      assert.match(rendered.html, /<h2 id="lifecycle-readiness-heading">Account lifecycle<\/h2>/);
    } else {
      assert.doesNotMatch(rendered.html, /lifecycle-readiness-heading/);
    }
  }
});

test("V2-CUST-SURFACE-001: with no lifecycleReadiness supplied at all, the section renders the honest Unavailable state", () => {
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT });
  const sectionStart = rendered.html.indexOf("lifecycle-readiness-heading");
  const sectionHtml = rendered.html.slice(sectionStart, sectionStart + 400);
  assert.match(sectionHtml, />Unavailable</);
});

test("V2-CUST-SURFACE-001: a READY lifecycleReadiness view renders offboarding status, execution status when present, and backup readiness", () => {
  const ready: CustomerLifecycleReadinessViewState = { kind: "READY", projection: FIXTURE_LIFECYCLE_READINESS };
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT, lifecycleReadiness: ready });
  assert.match(rendered.html, /Offboarding status: <strong>COMPLETED<\/strong>/);
  assert.match(rendered.html, /Offboarding execution: COMPLETED/);
  assert.match(rendered.html, /Backup\/export readiness: AVAILABLE/);
});

test("V2-CUST-SURFACE-001: a READY lifecycleReadiness view with NOT_REQUESTED offboarding renders no offboarding-execution line at all, never a fabricated one", () => {
  const notRequested: CustomerLifecycleReadinessProjection = {
    tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
    customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
    offboardingStatus: "NOT_REQUESTED",
    backupReadiness: "AVAILABLE",
  };
  const ready: CustomerLifecycleReadinessViewState = { kind: "READY", projection: notRequested };
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT, lifecycleReadiness: ready });
  assert.doesNotMatch(rendered.html, /Offboarding execution:/);
});

test("V2-CUST-SURFACE-001: no mutating upgrade/cancel/offboard control (button, form, or link) is ever rendered by this checkpoint's own new sections", () => {
  const ready: CustomerCommercialStatusViewState = { kind: "READY", status: FIXTURE_COMMERCIAL_STATUS };
  const readyLifecycle: CustomerLifecycleReadinessViewState = { kind: "READY", projection: FIXTURE_LIFECYCLE_READINESS };
  const rendered = renderShellPage({
    kind: "READY",
    snapshot: READY_SNAPSHOT,
    commercialStatus: ready,
    lifecycleReadiness: readyLifecycle,
  });
  const sectionStart = rendered.html.indexOf("subscription-status-heading");
  const sectionEnd = rendered.html.indexOf("verified-work-heading");
  const newSectionsHtml = rendered.html.slice(sectionStart, sectionEnd);
  assert.doesNotMatch(newSectionsHtml, /<button/);
  assert.doesNotMatch(newSectionsHtml, /<form/);
  assert.doesNotMatch(newSectionsHtml, /<input/);
  assert.doesNotMatch(newSectionsHtml, /href="[^"]*(upgrade|downgrade|cancel|offboard)/i);
});
