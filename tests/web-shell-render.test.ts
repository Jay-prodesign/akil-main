import { test } from "node:test";
import assert from "node:assert/strict";
import { renderShellPage, type ShellPageContent } from "../src/web/shell-render.js";
import { WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT } from "../src/fixtures/website-build-v1-snapshot.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { createOutcomeJob, enterExceptionState } from "../src/domain/outcome-job.js";
import { buildClientProjectSnapshot } from "../src/domain/client-project-snapshot.js";

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
