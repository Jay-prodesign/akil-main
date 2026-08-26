import { test } from "node:test";
import assert from "node:assert/strict";
import { renderShellPage, type ShellPageContent } from "../src/web/shell-render.js";
import { WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT } from "../src/fixtures/website-build-v1-snapshot.js";

const ALL_CONTENTS: ReadonlyArray<{ content: ShellPageContent; expectedStatus: number }> = [
  { content: { kind: "LOADING" }, expectedStatus: 200 },
  { content: { kind: "EMPTY" }, expectedStatus: 200 },
  { content: { kind: "UNAVAILABLE", reason: "simulated unavailable" }, expectedStatus: 503 },
  { content: { kind: "UNSUPPORTED", reason: "simulated unsupported" }, expectedStatus: 501 },
  { content: { kind: "BLOCKED" }, expectedStatus: 200 },
  { content: { kind: "BLOCKED", reason: "simulated block reason" }, expectedStatus: 200 },
  { content: { kind: "ERROR", reason: "simulated error reason" }, expectedStatus: 500 },
  { content: { kind: "NOT_FOUND" }, expectedStatus: 404 },
  { content: { kind: "UNAUTHENTICATED" }, expectedStatus: 401 },
  { content: { kind: "FORBIDDEN_TENANT_SCOPE" }, expectedStatus: 403 },
  { content: { kind: "READY", snapshot: WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT }, expectedStatus: 200 },
];

test("A11: every ShellPageContent kind renders its own distinct, deterministic HTTP status", () => {
  for (const { content, expectedStatus } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    assert.equal(rendered.status, expectedStatus, `kind ${content.kind} expected status ${expectedStatus}`);
    assert.equal(rendered.contentType, "text/html; charset=utf-8");
  }
});

test("A11: only READY ever renders the snapshot delivery-status body - no other kind can be mistaken for success", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    if (content.kind === "READY") {
      assert.match(rendered.html, /Delivery status/);
    } else {
      assert.doesNotMatch(rendered.html, /Delivery status/);
    }
  }
});

test("A12: every rendered page contains a skip link, semantic landmarks, and a responsive viewport meta tag", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    assert.match(rendered.html, /class="skip-link" href="#main-content"/);
    assert.match(rendered.html, /<header>/);
    assert.match(rendered.html, /<main id="main-content">/);
    assert.match(rendered.html, /<footer>/);
    assert.match(rendered.html, /name="viewport" content="width=device-width, initial-scale=1"/);
  }
});

test("A12: every rendered page defines a visible :focus-visible outline rule - keyboard focus is never invisible", () => {
  for (const { content } of ALL_CONTENTS) {
    const rendered = renderShellPage(content);
    assert.match(rendered.html, /:focus-visible \{ outline: 3px solid/);
  }
});

test("A12: status is never color-only - a visible text label always accompanies the tone class", () => {
  const rendered = renderShellPage({ kind: "FORBIDDEN_TENANT_SCOPE" });
  assert.match(rendered.html, /class="status status-danger" role="status">Access denied</);
});

test("A12: reason text is HTML-escaped, never injected as raw markup", () => {
  const rendered = renderShellPage({ kind: "UNAVAILABLE", reason: "<script>alert(1)</script>" });
  assert.doesNotMatch(rendered.html, /<script>/);
  assert.match(rendered.html, /&lt;script&gt;/);
});

test("A11: the ERROR state never leaks its internal reason string into the customer-facing page", () => {
  const rendered = renderShellPage({ kind: "ERROR", reason: "internal stack trace detail" });
  assert.doesNotMatch(rendered.html, /internal stack trace detail/);
});
