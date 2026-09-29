import type { NavDestination, DestinationKey, HomeViewState, WorkViewState, WorkProjectDetailViewState, PeopleViewState, ProductsViewState, AdminViewState, ProjectSummary, JobsViewState, AccessSummary, OrganizationSummary } from "./internal-os-view-state.js";

export interface RenderedInternalOsPage {
  readonly status: number;
  readonly contentType: string;
  readonly html: string;
}

/**
 * Duplicated locally rather than imported, matching `shell-render.ts`'s own
 * established per-module `escapeHtml` convention in this repository.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PageChrome {
  readonly nav: ReadonlyArray<NavDestination>;
  readonly activeKey: DestinationKey | undefined;
  readonly organizationName?: string;
}

/**
 * Rev168 "STABLE APP FRAME": branded application chrome (not marketing-site
 * layout), durable desktop navigation with responsive mobile behavior
 * (one `@media` breakpoint collapses the sidebar into a top nav, mirroring
 * `shell-render.ts`'s own single-breakpoint discipline), visible current
 * Organization/context, a content canvas with page heading + status area,
 * and reusable primitives (nav item, status chip, card, list/table,
 * empty/unavailable state) expressed as plain CSS classes - no CSS-in-JS,
 * no external stylesheet, no framework, matching `shell-render.ts`'s exact
 * zero-dependency template-literal pattern.
 */
function renderPage(input: {
  chrome: PageChrome;
  title: string;
  statusLabel: string;
  statusTone: "neutral" | "warning" | "danger" | "success";
  bodyHtml: string;
}): string {
  const navItems = input.chrome.nav
    .map((destination) => {
      const isActive = destination.key === input.chrome.activeKey;
      return `<li><a class="nav-item${isActive ? " nav-item-active" : ""}" href="${escapeHtml(destination.path)}"${isActive ? ' aria-current="page"' : ""}>${escapeHtml(destination.label)}</a></li>`;
    })
    .join("\n      ");
  const orgLine =
    input.chrome.organizationName !== undefined
      ? `<p class="org-context">Organization: <strong>${escapeHtml(input.chrome.organizationName)}</strong></p>`
      : "";
  const navHtml =
    input.chrome.nav.length > 0
      ? `
  <nav aria-label="Internal OS primary" class="app-nav">
    <ul>
      ${navItems}
    </ul>
  </nav>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} — AKILTA OS</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; max-width: 100%; }
  .skip-link { position: absolute; left: -9999px; top: 0; background: #fff; color: #000; padding: 0.5rem 1rem; z-index: 10; }
  .skip-link:focus { left: 0; }
  a:focus-visible, button:focus-visible, [tabindex]:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; }
  .app-shell { display: grid; grid-template-columns: 14rem 1fr; grid-template-rows: auto 1fr; min-height: 100vh; align-content: start; }
  .app-header { grid-column: 1 / -1; padding: 0.75rem 1rem; border-bottom: 1px solid currentColor; display: flex; align-items: center; justify-content: space-between; }
  .app-nav { border-right: 1px solid currentColor; padding: 1rem 0; }
  .app-nav ul { list-style: none; margin: 0; padding: 0; }
  .nav-item { display: block; padding: 0.5rem 1rem; text-decoration: none; color: inherit; }
  .nav-item-active { font-weight: bold; border-left: 3px solid #1a73e8; }
  main { padding: 1rem 1.5rem; max-width: 60rem; }
  .org-context { margin: 0; font-size: 0.9rem; }
  .status { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.75rem; border-radius: 0.25rem; border: 1px solid currentColor; }
  .status-neutral { color: #444; }
  .status-warning { color: #8a6100; }
  .status-danger { color: #8a1c1c; }
  .status-success { color: #1c6b2e; }
  .card { border: 1px solid currentColor; border-radius: 0.5rem; padding: 1rem; margin: 0.75rem 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid currentColor; }
  @media (max-width: 640px) {
    /*
     * Single-column stacking moves .app-nav into its own grid row (it
     * shares a row with main only in the 2-column desktop layout above),
     * so the row template needs a THIRD track here - otherwise the "1fr"
     * leftover-space track lands on .app-nav instead of main, stretching
     * the nav bar to fill the viewport and leaving a large visible gap
     * before the page content (a real defect found via rendered mobile
     * screenshot inspection, not merely inferred from CSS).
     */
    .app-shell { grid-template-columns: 1fr; grid-template-rows: auto auto 1fr; }
    .app-header { flex-direction: column; align-items: flex-start; gap: 0.35rem; }
    .app-nav { border-right: none; border-bottom: 1px solid currentColor; padding: 0.5rem 0; }
    .app-nav ul { display: flex; flex-wrap: wrap; }
    main { padding: 0.75rem; }
  }
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to main content</a>
<div class="app-shell">
  <header class="app-header">
    <p><strong>AKILTA</strong> — Company OS (internal)</p>
    ${orgLine}
  </header>${navHtml}
  <main id="main-content">
    <p class="status status-${input.statusTone}" role="status">${escapeHtml(input.statusLabel)}</p>
    <h1>${escapeHtml(input.title)}</h1>
    ${input.bodyHtml}
  </main>
</div>
</body>
</html>`;
}

function renderNotActiveCard(label: string): string {
  return `
  <section aria-labelledby="not-active-heading" class="card">
    <h2 id="not-active-heading">${escapeHtml(label)}</h2>
    <p class="status status-neutral" role="status">NOT ACTIVE</p>
    <p>This area is not yet connected to a live data source in this build.</p>
  </section>`;
}

function renderAccessCard(access: AccessSummary): string {
  return `
  <section aria-labelledby="access-heading" class="card">
    <h2 id="access-heading">Your access</h2>
    <p>Role: <strong>${escapeHtml(access.role)}</strong></p>
    <p>Permissions: ${access.permissions.length > 0 ? access.permissions.map(escapeHtml).join(", ") : "none"}</p>
    <p>Protected actions: <span class="status status-${access.canPerformProtectedActions ? "warning" : "neutral"}" role="status">${access.canPerformProtectedActions ? "AUTHORIZED" : "NOT AUTHORIZED"}</span></p>
  </section>`;
}

function renderOrganizationCard(organization: OrganizationSummary): string {
  return `
  <section aria-labelledby="org-heading" class="card">
    <h2 id="org-heading">Organization</h2>
    <p>${escapeHtml(organization.displayName)}</p>
    <p>Status: ${escapeHtml(organization.state)}</p>
  </section>`;
}

function renderJobsTable(jobs: JobsViewState): string {
  if (jobs.kind === "NOT_ACTIVE") {
    return `<p class="status status-neutral" role="status">Job list: NOT ACTIVE</p>`;
  }
  if (jobs.jobs.length === 0) {
    return `<p>No outcome jobs recorded for this project yet.</p>`;
  }
  const rows = jobs.jobs
    .map((job) => `<tr><td>${escapeHtml(job.jobId)}</td><td>${escapeHtml(job.jobFamily)}</td><td>${escapeHtml(job.state)}</td></tr>`)
    .join("\n      ");
  return `
    <table>
      <thead><tr><th>Job</th><th>Family</th><th>State</th></tr></thead>
      <tbody>
      ${rows}
      </tbody>
    </table>`;
}

function renderProjectCard(project: ProjectSummary, options?: { linked?: boolean }): string {
  const heading =
    options?.linked === true
      ? `<a href="/os/work/${escapeHtml(project.customerId)}/${escapeHtml(project.projectId)}">${escapeHtml(project.projectId)}</a>`
      : escapeHtml(project.projectId);
  return `
  <section aria-labelledby="project-${escapeHtml(project.projectId)}-heading" class="card">
    <h3 id="project-${escapeHtml(project.projectId)}-heading">${heading}</h3>
    <p>Customer: ${escapeHtml(project.customerId)}</p>
    <p>State: ${escapeHtml(project.state)}</p>
    ${renderJobsTable(project.jobs)}
  </section>`;
}

function renderWorkBody(view: WorkViewState): string {
  if (view.kind === "NOT_ACTIVE") {
    return renderNotActiveCard("Work");
  }
  if (view.kind === "EMPTY") {
    return `<p>You have no assigned projects yet.</p>`;
  }
  return view.projects.map((project) => renderProjectCard(project, { linked: true })).join("\n");
}

function renderHomeBody(view: HomeViewState): string {
  return `
  ${renderOrganizationCard(view.organization)}
  ${renderAccessCard(view.access)}
  <section aria-labelledby="home-work-heading" class="card">
    <h2 id="home-work-heading">Your work</h2>
    ${renderWorkBody(view.work)}
  </section>`;
}

function renderPeopleBody(view: PeopleViewState): string {
  return `
  <section aria-labelledby="people-heading" class="card">
    <h2 id="people-heading">You</h2>
    <p>${escapeHtml(view.self.principalDisplayName)}</p>
    <p>Organization role: ${escapeHtml(view.self.organizationRole)}</p>
    <p>Membership state: ${escapeHtml(view.self.membershipState)}</p>
  </section>
  <p>A full directory is not yet available in this build.</p>`;
}

function renderProductsBody(view: ProductsViewState): string {
  const rows = view.products
    .map(
      (product) =>
        `<tr><td>${escapeHtml(product.name)}</td><td><span class="status status-${product.status === "ACTIVE" ? "success" : "neutral"}" role="status">${escapeHtml(product.status.replace("_", " "))}</span></td></tr>`,
    )
    .join("\n      ");
  return `
  <table>
    <thead><tr><th>Product</th><th>Status</th></tr></thead>
    <tbody>
    ${rows}
    </tbody>
  </table>`;
}

function renderAdminBody(view: AdminViewState): string {
  const notActiveItems = view.notActiveConcepts
    .map((concept) => `<li>${escapeHtml(concept)}: <span class="status status-neutral" role="status">NOT ACTIVE</span></li>`)
    .join("\n      ");
  return `
  ${renderOrganizationCard(view.organization)}
  ${renderAccessCard(view.access)}
  <section aria-labelledby="admin-not-active-heading" class="card">
    <h2 id="admin-not-active-heading">Not yet active in this build</h2>
    <ul>
    ${notActiveItems}
    </ul>
  </section>`;
}

function renderWorkProjectDetailBody(view: WorkProjectDetailViewState): string {
  switch (view.kind) {
    case "NOT_ACTIVE":
      return renderNotActiveCard("Project detail");
    case "NOT_FOUND":
      return `<p>We could not find this project.</p>`;
    case "FORBIDDEN":
      return `<p>You do not have access to this project.</p>`;
    case "READY":
      return renderProjectCard(view.project);
  }
}

export type InternalOsPageContent =
  | { readonly kind: "UNAUTHENTICATED" }
  | { readonly kind: "FORBIDDEN"; readonly nav?: ReadonlyArray<NavDestination> }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "ERROR"; readonly reason: string }
  | { readonly kind: "UNSUPPORTED"; readonly reason: string }
  | {
      readonly kind: "DESTINATION";
      readonly nav: ReadonlyArray<NavDestination>;
      readonly activeKey: DestinationKey;
      readonly organizationName: string;
      readonly title: string;
      readonly bodyHtml: string;
    };

function destinationContent(input: {
  nav: ReadonlyArray<NavDestination>;
  activeKey: DestinationKey;
  organizationName: string;
  title: string;
  bodyHtml: string;
}): InternalOsPageContent {
  return { kind: "DESTINATION", ...input };
}

export function homePageContent(nav: ReadonlyArray<NavDestination>, organizationName: string, view: HomeViewState): InternalOsPageContent {
  return destinationContent({ nav, activeKey: "home", organizationName, title: "Home", bodyHtml: renderHomeBody(view) });
}

export function workPageContent(nav: ReadonlyArray<NavDestination>, organizationName: string, view: WorkViewState): InternalOsPageContent {
  return destinationContent({ nav, activeKey: "work", organizationName, title: "Work", bodyHtml: renderWorkBody(view) });
}

export function workProjectDetailPageContent(
  nav: ReadonlyArray<NavDestination>,
  organizationName: string,
  view: WorkProjectDetailViewState,
): InternalOsPageContent {
  return destinationContent({
    nav,
    activeKey: "work",
    organizationName,
    title: "Project",
    bodyHtml: renderWorkProjectDetailBody(view),
  });
}

const NOT_ACTIVE_DESTINATION_LABELS: Record<"attention" | "ai-capabilities" | "connections" | "knowledge", string> = {
  attention: "Attention",
  "ai-capabilities": "AI & Capabilities",
  connections: "Connections",
  knowledge: "Knowledge",
};

export function notActiveDestinationPageContent(
  nav: ReadonlyArray<NavDestination>,
  organizationName: string,
  key: "attention" | "ai-capabilities" | "connections" | "knowledge",
): InternalOsPageContent {
  const label = NOT_ACTIVE_DESTINATION_LABELS[key];
  return destinationContent({ nav, activeKey: key, organizationName, title: label, bodyHtml: renderNotActiveCard(label) });
}

export function peoplePageContent(nav: ReadonlyArray<NavDestination>, organizationName: string, view: PeopleViewState): InternalOsPageContent {
  return destinationContent({ nav, activeKey: "people", organizationName, title: "People", bodyHtml: renderPeopleBody(view) });
}

export function productsPageContent(nav: ReadonlyArray<NavDestination>, organizationName: string, view: ProductsViewState): InternalOsPageContent {
  return destinationContent({ nav, activeKey: "products", organizationName, title: "Products", bodyHtml: renderProductsBody(view) });
}

export function adminPageContent(nav: ReadonlyArray<NavDestination>, organizationName: string, view: AdminViewState): InternalOsPageContent {
  return destinationContent({ nav, activeKey: "admin", organizationName, title: "Admin", bodyHtml: renderAdminBody(view) });
}

/**
 * Rev168 A12-equivalent discipline (reused from `shell-render.ts`): every
 * branch here is a distinct, deterministic rendering, `statusLabel` is
 * always visible text (never color alone), and only `DESTINATION` ever
 * renders application content - none of the error/denial branches can be
 * mistaken for a successful render.
 */
export function renderInternalOsPage(content: InternalOsPageContent): RenderedInternalOsPage {
  switch (content.kind) {
    case "UNAUTHENTICATED":
      return {
        status: 401,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          chrome: { nav: [], activeKey: undefined },
          title: "Sign-in required",
          statusLabel: "Sign-in required",
          statusTone: "warning",
          bodyHtml: "<p>You must be signed in with a staff session to view the internal OS.</p>",
        }),
      };
    case "FORBIDDEN":
      return {
        status: 403,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          chrome: { nav: content.nav ?? [], activeKey: undefined },
          title: "Access denied",
          statusLabel: "Access denied",
          statusTone: "danger",
          bodyHtml: "<p>You do not have access to this area.</p>",
        }),
      };
    case "NOT_FOUND":
      return {
        status: 404,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          chrome: { nav: [], activeKey: undefined },
          title: "Not found",
          statusLabel: "Not found",
          statusTone: "neutral",
          bodyHtml: "<p>We could not find this page.</p>",
        }),
      };
    case "ERROR":
      return {
        status: 500,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          chrome: { nav: [], activeKey: undefined },
          title: "Something went wrong",
          statusLabel: "Something went wrong",
          statusTone: "danger",
          bodyHtml: "<p>We could not load this page. No data is shown.</p>",
        }),
      };
    case "UNSUPPORTED":
      return {
        status: 501,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          chrome: { nav: [], activeKey: undefined },
          title: "Not supported",
          statusLabel: "Not supported",
          statusTone: "neutral",
          bodyHtml: `<p>${escapeHtml(content.reason)}</p>`,
        }),
      };
    case "DESTINATION":
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          chrome: { nav: content.nav, activeKey: content.activeKey, organizationName: content.organizationName },
          title: content.title,
          statusLabel: "Signed in",
          statusTone: "success",
          bodyHtml: content.bodyHtml,
        }),
      };
  }
}
