import type { ClientProjectSnapshot } from "../domain/client-project-snapshot.js";

/**
 * V2-APP-001 (IN SCOPE H): the deterministic, closed set of page content
 * this shell can render. This is intentionally broader than the states
 * `http-server.ts` currently wires from a live request (`LOADING`,
 * `UNAVAILABLE`, `UNSUPPORTED` have no live trigger in this bootstrap -
 * there is no async snapshot source yet and no capability-unsupported
 * concept at the shell level) - they are prepared render primitives for
 * V2-CDO-006 to reach, per "PREPARED != IMPLEMENTED" (DEC-153 Activation
 * Discipline): existing and directly unit-tested here, not fabricated as
 * live behavior this task does not actually produce.
 */
export type ShellPageContent =
  | { readonly kind: "LOADING" }
  | { readonly kind: "EMPTY" }
  | { readonly kind: "UNAVAILABLE"; readonly reason: string }
  | { readonly kind: "UNSUPPORTED"; readonly reason: string }
  | { readonly kind: "BLOCKED"; readonly reason?: string }
  | { readonly kind: "ERROR"; readonly reason: string }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "UNAUTHENTICATED" }
  | { readonly kind: "FORBIDDEN_TENANT_SCOPE" }
  | { readonly kind: "READY"; readonly snapshot: ClientProjectSnapshot };

export interface RenderedShellPage {
  readonly status: number;
  readonly contentType: string;
  readonly html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * V2-APP-001 A12: every page shares one accessible layout - a skip link
 * to `#main-content`, semantic `<header>`/`<main>`/`<footer>` landmarks,
 * a responsive viewport meta tag, and a visible `:focus-visible` outline.
 * `statusLabel` is always rendered as visible text (never color alone -
 * "no color-only security/action status"), and `statusTone` only adds a
 * CSS class for color, never changes what text is shown.
 */
function renderPage(input: {
  title: string;
  statusLabel: string;
  statusTone: "neutral" | "warning" | "danger" | "success";
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} — AKILTA</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; max-width: 100%; }
  .skip-link { position: absolute; left: -9999px; top: 0; background: #fff; color: #000; padding: 0.5rem 1rem; z-index: 10; }
  .skip-link:focus { left: 0; }
  a:focus-visible, button:focus-visible, [tabindex]:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; }
  header, footer { padding: 1rem; }
  main { padding: 1rem; max-width: 60rem; margin: 0 auto; }
  .status { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.75rem; border-radius: 0.25rem; border: 1px solid currentColor; }
  .status-neutral { color: #444; }
  .status-warning { color: #8a6100; }
  .status-danger { color: #8a1c1c; }
  .status-success { color: #1c6b2e; }
  @media (max-width: 480px) { main, header, footer { padding: 0.75rem; } }
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to main content</a>
<header>
  <p><strong>AKILTA</strong> — Client Portal Shell</p>
</header>
<main id="main-content">
  <p class="status status-${input.statusTone}" role="status">${escapeHtml(input.statusLabel)}</p>
  ${input.bodyHtml}
</main>
<footer>
  <p>This is an internal engineering shell checkpoint (V2-APP-001), not a released customer product.</p>
</footer>
</body>
</html>`;
}

function renderSnapshotBody(snapshot: ClientProjectSnapshot): string {
  const nextActionLabel = snapshot.nextAction.owner.replace(/_/g, " ");
  return `
  <section aria-labelledby="delivery-status-heading">
    <h2 id="delivery-status-heading">Delivery status</h2>
    <p>Overall status: <strong>${escapeHtml(snapshot.deliveryStatus.overallStatus)}</strong></p>
  </section>
  <section aria-labelledby="next-action-heading">
    <h2 id="next-action-heading">Next action</h2>
    <p>${escapeHtml(nextActionLabel)}</p>
  </section>
  <section aria-labelledby="verified-work-heading">
    <h2 id="verified-work-heading">Verified completed work</h2>
    <p>${snapshot.verifiedCompletedJobIds.length} item(s) verified complete.</p>
  </section>`;
}

/**
 * V2-APP-001 A11: every branch here is a distinct, deterministic
 * rendering - none of them can be mistaken for `READY` because only the
 * `READY` branch ever calls `renderSnapshotBody`, and only `READY` ever
 * receives a `ClientProjectSnapshot` at all.
 */
export function renderShellPage(content: ShellPageContent): RenderedShellPage {
  switch (content.kind) {
    case "LOADING":
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          title: "Loading",
          statusLabel: "Loading — please wait",
          statusTone: "neutral",
          bodyHtml: "<p>This page is loading. It is not yet showing your project status.</p>",
        }),
      };
    case "EMPTY":
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          title: "Not started",
          statusLabel: "Not started yet",
          statusTone: "neutral",
          bodyHtml: "<p>This project does not have any recorded work yet.</p>",
        }),
      };
    case "UNAVAILABLE":
      return {
        status: 503,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          title: "Temporarily unavailable",
          statusLabel: "Temporarily unavailable",
          statusTone: "warning",
          bodyHtml: `<p>${escapeHtml(content.reason)}</p>`,
        }),
      };
    case "UNSUPPORTED":
      return {
        status: 501,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          title: "Not supported",
          statusLabel: "Not supported yet",
          statusTone: "neutral",
          bodyHtml: `<p>${escapeHtml(content.reason)}</p>`,
        }),
      };
    case "BLOCKED":
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          title: "Blocked",
          statusLabel: "Blocked — attention needed",
          statusTone: "warning",
          bodyHtml: `<p>${content.reason !== undefined ? escapeHtml(content.reason) : "This project currently has a blocking issue."}</p>`,
        }),
      };
    case "ERROR":
      return {
        status: 500,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          title: "Something went wrong",
          statusLabel: "Something went wrong",
          statusTone: "danger",
          bodyHtml: "<p>We could not load this page. No project data is shown.</p>",
        }),
      };
    case "NOT_FOUND":
      return {
        status: 404,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          title: "Not found",
          statusLabel: "Not found",
          statusTone: "neutral",
          bodyHtml: "<p>We could not find this project.</p>",
        }),
      };
    case "UNAUTHENTICATED":
      return {
        status: 401,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          title: "Sign-in required",
          statusLabel: "Sign-in required",
          statusTone: "warning",
          bodyHtml: "<p>You must be signed in to view this page.</p>",
        }),
      };
    case "FORBIDDEN_TENANT_SCOPE":
      return {
        status: 403,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          title: "Access denied",
          statusLabel: "Access denied",
          statusTone: "danger",
          bodyHtml: "<p>You do not have access to this project.</p>",
        }),
      };
    case "READY":
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          title: "Project status",
          statusLabel: "Signed in",
          statusTone: "success",
          bodyHtml: renderSnapshotBody(content.snapshot),
        }),
      };
  }
}
