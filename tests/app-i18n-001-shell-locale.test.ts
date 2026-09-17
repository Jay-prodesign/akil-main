import { test } from "node:test";
import assert from "node:assert/strict";
import { renderShellPage } from "../src/web/shell-render.js";
import { WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT } from "../src/fixtures/website-build-v1-snapshot.js";

const READY_SNAPSHOT = WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT;

test("I12: renderShellPage defaults to English when no locale is supplied - the exact pre-localization behavior, unaffected by APP-I18N-001", () => {
  const rendered = renderShellPage({ kind: "NOT_FOUND" });
  assert.match(rendered.html, /<html lang="en">/);
  assert.match(rendered.html, />Not found</);
});

test("I13: an explicit 'en' locale renders English fixed copy and <html lang=\"en\">", () => {
  const rendered = renderShellPage({ kind: "FORBIDDEN_TENANT_SCOPE" }, "en");
  assert.match(rendered.html, /<html lang="en">/);
  assert.match(rendered.html, /class="status status-danger" role="status">Access denied</);
});

test("I14 (Turkish default rendering): an explicit 'tr' locale renders Turkish fixed copy and <html lang=\"tr\">, on the identical FORBIDDEN_TENANT_SCOPE state I13 proved in English", () => {
  const rendered = renderShellPage({ kind: "FORBIDDEN_TENANT_SCOPE" }, "tr");
  assert.match(rendered.html, /<html lang="tr">/);
  assert.match(rendered.html, /class="status status-danger" role="status">Erişim reddedildi</);
  assert.doesNotMatch(rendered.html, />Access denied</);
});

test("I15 (representative fixed-label parity across shell states): NOT_FOUND, UNAUTHENTICATED, and LOADING each render distinct correct Turkish copy, not a shared/fallback string", () => {
  const notFound = renderShellPage({ kind: "NOT_FOUND" }, "tr");
  assert.match(notFound.html, />Bulunamadı</);
  assert.match(notFound.html, /Bu projeyi bulamadık\./);

  const unauthenticated = renderShellPage({ kind: "UNAUTHENTICATED" }, "tr");
  assert.match(unauthenticated.html, />Giriş gerekli</);
  assert.match(unauthenticated.html, /Bu sayfayı görüntülemek için giriş yapmalısınız\./);

  const loading = renderShellPage({ kind: "LOADING" }, "tr");
  assert.match(loading.html, />Yükleniyor — lütfen bekleyin</);
});

test("I16 (representative fixed-label parity, READY state): the READY snapshot body renders Turkish section headings and the next-action badge, with tenant/customer/project identity data passed through unchanged", () => {
  const rendered = renderShellPage({ kind: "READY", snapshot: READY_SNAPSHOT }, "tr");
  assert.match(rendered.html, /<h2 id="next-action-heading">Sıradaki adım<\/h2>/);
  assert.match(rendered.html, /<h2 id="timeline-heading">Zaman çizelgesi<\/h2>/);
  assert.match(rendered.html, /<h2 id="working-artifact-heading">Çalışma çıktısı<\/h2>/);
  assert.match(rendered.html, /<h2 id="capabilities-heading">Bağlantılar ve yetkinlikler<\/h2>/);
  assert.match(rendered.html, /<h2 id="communications-heading">Son güncellemeler<\/h2>/);
  // Identity/resource data is domain data, not fixed copy - it must render unchanged in either locale.
  assert.match(rendered.html, new RegExp(`Müşteri: ${READY_SNAPSHOT.ownership.customerId}`));
  assert.match(rendered.html, new RegExp(`Proje: ${READY_SNAPSHOT.ownership.projectId}`));
});

test("I17: HTML-escaping still applies identically in the Turkish locale - a raw reason string can never inject markup", () => {
  const rendered = renderShellPage({ kind: "UNAVAILABLE", reason: "<script>alert(1)</script>" }, "tr");
  assert.doesNotMatch(rendered.html, /<script>/);
  assert.match(rendered.html, /&lt;script&gt;/);
});

test("I18: every ShellPageContent kind renders its own distinct, deterministic HTTP status in the Turkish locale too - locale never changes status-code semantics", () => {
  const cases: ReadonlyArray<{ content: Parameters<typeof renderShellPage>[0]; expectedStatus: number }> = [
    { content: { kind: "LOADING" }, expectedStatus: 200 },
    { content: { kind: "EMPTY" }, expectedStatus: 200 },
    { content: { kind: "UNAVAILABLE", reason: "x" }, expectedStatus: 503 },
    { content: { kind: "UNSUPPORTED", reason: "x" }, expectedStatus: 501 },
    { content: { kind: "ERROR", reason: "x" }, expectedStatus: 500 },
    { content: { kind: "NOT_FOUND" }, expectedStatus: 404 },
    { content: { kind: "UNAUTHENTICATED" }, expectedStatus: 401 },
    { content: { kind: "FORBIDDEN_TENANT_SCOPE" }, expectedStatus: 403 },
    { content: { kind: "READY", snapshot: READY_SNAPSHOT }, expectedStatus: 200 },
  ];
  for (const { content, expectedStatus } of cases) {
    assert.equal(renderShellPage(content, "tr").status, expectedStatus);
  }
});
