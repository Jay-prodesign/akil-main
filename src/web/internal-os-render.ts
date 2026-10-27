import type { NavDestination, DestinationKey, HomeViewState, WorkViewState, WorkProjectDetailViewState, PeopleViewState, ProductsViewState, AdminViewState, AdminResourceBindingViewState, OperationalObservabilityViewState, BreakGlassObservabilityViewState, PendingOffboardingRequestsViewState, ConnectionsViewState, KnowledgeViewState, KnowledgeEvidenceEntry, AttentionViewState, AttentionCredentialAccessItem, AttentionCustomerApprovalItem, PeopleDirectoryEntry, ProjectSummary, JobsViewState, AccessSummary, OrganizationSummary, WorkersRosterViewState, WorkersRosterEntry } from "./internal-os-view-state.js";
import type { ConnectionState } from "../domain/connection-authority.js";
import type { IntegrationConnectionSummary } from "../domain/integration-admin-view.js";
import type { ProtectedDecisionOutcome } from "../domain/protected-decision-record.js";
import { renderOffboardingDecisionControls } from "./internal-os-offboarding-decision-controls.js";
import { renderConnectorConnectionStateControls } from "./internal-os-connection-state-controls.js";
import { renderAttentionDecisionControls } from "./internal-os-attention-decision-controls.js";

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

function renderPeopleSelfSection(view: PeopleViewState): string {
  return `
  <section aria-labelledby="people-heading" class="card">
    <h2 id="people-heading">You</h2>
    <p>${escapeHtml(view.self.principalDisplayName)}</p>
    <p>Organization role: ${escapeHtml(view.self.organizationRole)}</p>
    <p>Membership state: ${escapeHtml(view.self.membershipState)}</p>
  </section>`;
}

/**
 * C3 People slice: the visible state text is always rendered next to the
 * tone, so the state never depends on color alone. The `Record` makes a new
 * membership state a compile error here until it is given a tone.
 */
const MEMBERSHIP_STATE_TONE: Record<PeopleDirectoryEntry["membershipState"], "neutral" | "danger"> = {
  ACTIVE: "neutral",
  REVOKED: "danger",
};

function renderPeopleDirectoryRow(entry: PeopleDirectoryEntry): string {
  return `<tr><td>${escapeHtml(entry.principalRef)}</td><td>${escapeHtml(entry.organizationRole)}</td><td><span class="status status-${MEMBERSHIP_STATE_TONE[entry.membershipState]}" role="status">${escapeHtml(entry.membershipState)}</span></td></tr>`;
}

/**
 * C3 People slice: read-only roster. Every field comes from
 * `PeopleDirectoryEntry`'s allow-list, so revocation reasons and timestamps
 * are not available to render. Principals are shown by their stored
 * reference because the membership store records no display name.
 */
function renderPeopleDirectorySection(members: ReadonlyArray<PeopleDirectoryEntry>): string {
  if (members.length === 0) {
    return `
  <section aria-labelledby="people-directory-heading" class="card">
    <h2 id="people-directory-heading">Directory</h2>
    <p>No memberships are recorded for this organization.</p>
  </section>`;
  }
  const rows = members.map(renderPeopleDirectoryRow).join("\n      ");
  return `
  <section aria-labelledby="people-directory-heading" class="card">
    <h2 id="people-directory-heading">Directory</h2>
    <p>Read-only. Members are listed by principal reference; display names are not recorded for memberships.</p>
    <table>
      <thead><tr><th>Principal reference</th><th>Organization role</th><th>Membership state</th></tr></thead>
      <tbody>
      ${rows}
      </tbody>
    </table>
  </section>`;
}

/**
 * Without a roster this returns exactly the pre-C3 People body, byte for
 * byte.
 */
function renderPeopleBody(view: PeopleViewState, members: ReadonlyArray<PeopleDirectoryEntry> | undefined): string {
  if (members === undefined) {
    return `${renderPeopleSelfSection(view)}
  <p>A full directory is not yet available in this build.</p>`;
  }
  return `${renderPeopleSelfSection(view)}${renderPeopleDirectorySection(members)}`;
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

const RESOURCE_BINDING_STATE_TONE: Record<"READY" | "ACTION_REQUIRED" | "BLOCKED", "success" | "warning" | "danger"> = {
  READY: "success",
  ACTION_REQUIRED: "warning",
  BLOCKED: "danger",
};

/**
 * Rev183 F3: read-only explainability - what is bound, missing/blocked, and
 * exactly why - never a control. No form, button, or link to change
 * anything appears here.
 */
function renderResourceBindingCard(view: AdminResourceBindingViewState): string {
  if (view.kind === "NOT_ACTIVE") {
    return `
  <section aria-labelledby="admin-resource-binding-heading" class="card">
    <h2 id="admin-resource-binding-heading">Resource binding</h2>
    <p class="status status-neutral" role="status">NOT ACTIVE</p>
    <p>This area is not yet connected to a live data source in this build.</p>
  </section>`;
  }
  if (view.kind === "NOT_BOUND") {
    return `
  <section aria-labelledby="admin-resource-binding-heading" class="card">
    <h2 id="admin-resource-binding-heading">Resource binding</h2>
    <p class="status status-neutral" role="status">NOT BOUND</p>
    <p>This organization has not yet been bootstrapped with a resource binding.</p>
  </section>`;
  }
  const tone = RESOURCE_BINDING_STATE_TONE[view.summary.state];
  const reasonHtml =
    view.summary.nextRequiredActionReason !== undefined
      ? `<p>${escapeHtml(view.summary.nextRequiredActionReason)}</p>`
      : "";
  const gatesHtml =
    view.summary.unresolvedGates.length > 0
      ? `<ul>\n      ${view.summary.unresolvedGates.map((gate) => `<li>${escapeHtml(gate)}</li>`).join("\n      ")}\n    </ul>`
      : "";
  return `
  <section aria-labelledby="admin-resource-binding-heading" class="card">
    <h2 id="admin-resource-binding-heading">Resource binding</h2>
    <p class="status status-${tone}" role="status">${escapeHtml(view.summary.state)} — next: ${escapeHtml(view.summary.nextRequiredActor)}</p>
    ${reasonHtml}
    ${gatesHtml}
  </section>`;
}

/**
 * Rev195 F1: read-only operational observability - task/worker, connection
 * health and the real scoped kill-switch signal, cost/quota, pending
 * approvals, and audit/evidence - all escaped, never a mutation control
 * (same discipline as `renderResourceBindingCard`). `NOT_ACTIVE` stays the
 * honest default when no source is wired.
 */
function renderOperationalObservabilityCard(view: OperationalObservabilityViewState): string {
  if (view.kind === "NOT_ACTIVE") {
    return `
  <section aria-labelledby="admin-observability-heading" class="card">
    <h2 id="admin-observability-heading">Observability, audit &amp; recovery</h2>
    <p class="status status-neutral" role="status">NOT ACTIVE</p>
    <p>This area is not yet connected to a live data source in this build.</p>
  </section>`;
  }
  const v = view.view;
  const taskHtml =
    v.task !== undefined
      ? `<p>Task status: <span class="status status-neutral" role="status">${escapeHtml(v.task.runStatus)}</span> — attempt ${v.task.currentAttempt}${v.task.currentAttemptStatus !== undefined ? ` (${escapeHtml(v.task.currentAttemptStatus)})` : ""}</p>
    <p>Worker health: <span class="status status-neutral" role="status">${escapeHtml(v.task.workerHealth)}</span></p>`
      : `<p>No task currently tracked.</p>`;
  const connectionsHtml =
    v.connections.length > 0
      ? `<ul>\n      ${v.connections
          .map(
            (connection) =>
              `<li>${escapeHtml(connection.connectionBindingId)}: <span class="status status-${connection.killSwitchEngaged ? "danger" : connection.degraded ? "warning" : "neutral"}" role="status">${escapeHtml(connection.connectionState)}</span>${connection.killSwitchEngaged ? " — kill switch engaged" : ""}</li>`,
          )
          .join("\n      ")}\n    </ul>`
      : `<p>No connections tracked.</p>`;
  const quotaHtml =
    v.quota !== undefined
      ? `<p>Quota: ${v.quota.unitReserved}/${v.quota.unitLimit} reserved, ${v.quota.unitCommitted} committed, ${v.quota.unitRemaining} remaining</p>`
      : `<p>No quota data tracked.</p>`;
  const approvalsHtml =
    v.pendingApprovals.length > 0
      ? `<ul>\n      ${v.pendingApprovals
          .map(
            (approval) =>
              `<li>${escapeHtml(approval.waitRequestId)}: <span class="status status-${approval.resolved ? "neutral" : "warning"}" role="status">${approval.resolved ? "RESOLVED" : "PENDING"}</span></li>`,
          )
          .join("\n      ")}\n    </ul>`
      : `<p>No pending approvals tracked.</p>`;
  const evidenceHtml =
    v.auditEvidence.length > 0
      ? `<ul>\n      ${v.auditEvidence
          .map(
            (evidence) =>
              `<li>${escapeHtml(evidence.evidenceId)} (${escapeHtml(evidence.evidenceType)}): <span class="status status-neutral" role="status">${evidence.verificationStatus !== undefined ? escapeHtml(evidence.verificationStatus) : "UNVERIFIED"}</span></li>`,
          )
          .join("\n      ")}\n    </ul>`
      : `<p>No audit/evidence tracked.</p>`;
  return `
  <section aria-labelledby="admin-observability-heading" class="card">
    <h2 id="admin-observability-heading">Observability, audit &amp; recovery</h2>
    ${taskHtml}
    <h3>Connections</h3>
    ${connectionsHtml}
    <h3>Cost / quota</h3>
    ${quotaHtml}
    <h3>Pending approvals</h3>
    ${approvalsHtml}
    <h3>Audit / evidence</h3>
    ${evidenceHtml}
  </section>`;
}

/**
 * V2-ADMIN-SURFACE-001: read-only pending-offboarding-request queue -
 * exactly the same "escaped text only, no mutation control" discipline as
 * `renderResourceBindingCard`/`renderOperationalObservabilityCard`. No
 * decide/complete/deny affordance is rendered anywhere, since no
 * authenticated admin-mutation boundary or durable store for this request
 * type exists yet - see `resolvePendingOffboardingRequestsView`'s own doc
 * comment for why that is deliberate, not an oversight.
 *
 * C4: that boundary now exists and has a POST route. When the view carries
 * `decisionControls` (the handler has the route wired) and a row carries
 * its stored version, the row gets the deny/complete controls from
 * `internal-os-offboarding-decision-controls.ts`, limited to the decisions
 * the viewer's own access permits. This module still renders no form
 * itself. Without `decisionControls` the card is byte-for-byte the
 * pre-C4 read-only list.
 */
function renderPendingOffboardingRequestsCard(view: PendingOffboardingRequestsViewState): string {
  if (view.kind === "NOT_ACTIVE") {
    return `
  <section aria-labelledby="admin-pending-offboarding-heading" class="card">
    <h2 id="admin-pending-offboarding-heading">Pending offboarding requests</h2>
    <p class="status status-neutral" role="status">NOT ACTIVE</p>
    <p>This area is not yet connected to a live data source in this build.</p>
  </section>`;
  }
  const itemsHtml =
    view.requests.length > 0
      ? `<ul>\n      ${view.requests
          .map((request) => {
            const controls =
              view.decisionControls !== undefined && request.version !== undefined
                ? renderOffboardingDecisionControls({
                    requestId: request.requestId,
                    version: request.version,
                    canDeny: view.decisionControls.canDeny,
                    canComplete: view.decisionControls.canComplete,
                  })
                : "";
            const controlsHtml = controls.length > 0 ? `\n      <div class="decision-controls">${controls}</div>\n      ` : "";
            return `<li>${escapeHtml(request.customerId)}: <span class="status status-warning" role="status">REQUESTED</span> by ${escapeHtml(request.requestedByRef)} at ${escapeHtml(request.requestedAt)}${controlsHtml}</li>`;
          })
          .join("\n      ")}\n    </ul>`
      : `<p>No pending offboarding requests.</p>`;
  return `
  <section aria-labelledby="admin-pending-offboarding-heading" class="card">
    <h2 id="admin-pending-offboarding-heading">Pending offboarding requests</h2>
    ${itemsHtml}
  </section>`;
}

function renderAdminBody(view: AdminViewState): string {
  const notActiveItems = view.notActiveConcepts
    .map((concept) => `<li>${escapeHtml(concept)}: <span class="status status-neutral" role="status">NOT ACTIVE</span></li>`)
    .join("\n      ");
  return `
  ${renderOrganizationCard(view.organization)}
  ${renderAccessCard(view.access)}
  ${renderResourceBindingCard(view.resourceBinding)}
  ${renderOperationalObservabilityCard(view.operationalObservability)}
  ${renderPendingOffboardingRequestsCard(view.pendingOffboardingRequests)}
  <section aria-labelledby="admin-not-active-heading" class="card">
    <h2 id="admin-not-active-heading">Not yet active in this build</h2>
    <ul>
    ${notActiveItems}
    </ul>
  </section>`;
}

/**
 * C7: the break-glass support page body. Renders ONLY the sections whose
 * kind is in `view.grantedKinds` - a kind the grant did not admit gets no
 * heading and no "none tracked" line, so the page never even reveals
 * whether that dimension holds data. The per-section markup mirrors
 * `renderOperationalObservabilityCard`'s, written separately here so the
 * existing `/os/admin` card stays byte-for-byte unchanged. Escaped text
 * only: this page is READ-ONLY and renders no form, button or other
 * control of any kind.
 */
function renderBreakGlassObservabilityBody(view: BreakGlassObservabilityViewState): string {
  const intro = `
  <section aria-labelledby="break-glass-notice-heading" class="card">
    <h2 id="break-glass-notice-heading">Break-glass support access</h2>
    <p>Read-only support view under a scoped, time-bounded break-glass grant. Each section below was individually authorized and audited for this request. Sections outside the grant's scope are not shown.</p>
  </section>`;
  if (view.kind === "NOT_ACTIVE") {
    return `${intro}
  <section aria-labelledby="break-glass-observability-heading" class="card">
    <h2 id="break-glass-observability-heading">Observability</h2>
    <p class="status status-neutral" role="status">NOT ACTIVE</p>
    <p>This area is not yet connected to a live data source in this build.</p>
  </section>`;
  }
  const v = view.view;
  const sections = view.grantedKinds.map((kind): string => {
    switch (kind) {
      case "TASK":
        return `<h3>Task / worker health</h3>
    ${
      v.task !== undefined
        ? `<p>Task status: <span class="status status-neutral" role="status">${escapeHtml(v.task.runStatus)}</span> — attempt ${v.task.currentAttempt}${v.task.currentAttemptStatus !== undefined ? ` (${escapeHtml(v.task.currentAttemptStatus)})` : ""}</p>
    <p>Worker health: <span class="status status-neutral" role="status">${escapeHtml(v.task.workerHealth)}</span></p>`
        : `<p>No task currently tracked.</p>`
    }`;
      case "CONNECTION":
        return `<h3>Connections</h3>
    ${
      v.connections.length > 0
        ? `<ul>\n      ${v.connections
            .map(
              (connection) =>
                `<li>${escapeHtml(connection.connectionBindingId)}: <span class="status status-${connection.killSwitchEngaged ? "danger" : connection.degraded ? "warning" : "neutral"}" role="status">${escapeHtml(connection.connectionState)}</span>${connection.killSwitchEngaged ? " — kill switch engaged" : ""}</li>`,
            )
            .join("\n      ")}\n    </ul>`
        : `<p>No connections tracked.</p>`
    }`;
      case "QUOTA":
        return `<h3>Cost / quota</h3>
    ${
      v.quota !== undefined
        ? `<p>Quota: ${v.quota.unitReserved}/${v.quota.unitLimit} reserved, ${v.quota.unitCommitted} committed, ${v.quota.unitRemaining} remaining</p>`
        : `<p>No quota data tracked.</p>`
    }`;
      case "APPROVALS":
        return `<h3>Pending approvals</h3>
    ${
      v.pendingApprovals.length > 0
        ? `<ul>\n      ${v.pendingApprovals
            .map(
              (approval) =>
                `<li>${escapeHtml(approval.waitRequestId)}: <span class="status status-${approval.resolved ? "neutral" : "warning"}" role="status">${approval.resolved ? "RESOLVED" : "PENDING"}</span></li>`,
            )
            .join("\n      ")}\n    </ul>`
        : `<p>No pending approvals tracked.</p>`
    }`;
      case "AUDIT_EVIDENCE":
        return `<h3>Audit / evidence</h3>
    ${
      v.auditEvidence.length > 0
        ? `<ul>\n      ${v.auditEvidence
            .map(
              (evidence) =>
                `<li>${escapeHtml(evidence.evidenceId)} (${escapeHtml(evidence.evidenceType)}): <span class="status status-neutral" role="status">${evidence.verificationStatus !== undefined ? escapeHtml(evidence.verificationStatus) : "UNVERIFIED"}</span></li>`,
            )
            .join("\n      ")}\n    </ul>`
        : `<p>No audit/evidence tracked.</p>`
    }`;
    }
  });
  return `${intro}
  <section aria-labelledby="break-glass-observability-heading" class="card">
    <h2 id="break-glass-observability-heading">Observability</h2>
    ${sections.join("\n    ")}
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
  /**
   * C4: outcomes of the offboarding decision POST route. Like `ERROR`,
   * neither renders the underlying error's message or any request data.
   * Both say that nothing was changed, which is true for every path that
   * reaches them (each one fails before the store's write).
   */
  | { readonly kind: "BAD_REQUEST" }
  | { readonly kind: "CONFLICT" }
  /**
   * C7: the read-only break-glass support page for `/os/admin`. Never
   * carries `nav`: a break-glass caller is not a member browsing the OS,
   * so it is shown no destination list (like `UNAUTHENTICATED`/`NOT_FOUND`).
   */
  | {
      readonly kind: "BREAK_GLASS_OBSERVABILITY";
      readonly organizationName: string;
      readonly view: BreakGlassObservabilityViewState;
    }
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

/**
 * C3: the visible state text is always rendered next to the tone, so the
 * state never depends on color alone. The `Record` over `ConnectionState`
 * makes a new connection state a compile error here until it is given a
 * tone.
 */
const CONNECTION_STATE_TONE: Record<ConnectionState, "neutral" | "warning" | "danger" | "success"> = {
  REQUESTED: "neutral",
  CONNECTED_UNVERIFIED: "neutral",
  VERIFIED: "success",
  DEGRADED: "warning",
  REVOKED: "danger",
  HANDOVER_COMPLETE: "neutral",
};

function renderConnectionRow(connection: IntegrationConnectionSummary, canMutateState: boolean): string {
  const ownership = `${escapeHtml(connection.ownership.customerId)} / ${escapeHtml(connection.ownership.projectId)}${
    connection.ownership.serviceRef !== undefined ? ` / ${escapeHtml(connection.ownership.serviceRef)}` : ""
  }`;
  const evidence =
    connection.verificationEvidenceRef !== undefined ? escapeHtml(connection.verificationEvidenceRef) : "none";
  const control = renderConnectorConnectionStateControls({
    connectionBindingId: connection.connectionBindingId,
    canMutateState,
  });
  const actionsCell = control.length > 0 ? `<td>${control}</td>` : "<td></td>";
  return `<tr><td>${escapeHtml(connection.connectionBindingId)}</td><td>${escapeHtml(connection.connectorKind)}</td><td>${escapeHtml(connection.authMode)}</td><td><span class="status status-${CONNECTION_STATE_TONE[connection.connectionState]}" role="status">${escapeHtml(connection.connectionState)}</span></td><td>${ownership}</td><td>${escapeHtml(connection.workspaceRef)}</td><td>${escapeHtml(connection.integrationInstanceRef)}</td><td>${evidence}</td>${actionsCell}</tr>`;
}

/**
 * C3: read-only Connections destination. Every field comes from
 * `IntegrationConnectionSummary` (CONN-001's secret-masked read model), so
 * there is no secret reference here to escape or omit. Like every other
 * card in this module, it renders escaped text only and no mutation
 * control of its own.
 *
 * C4 slice 2 exception, one only: when `view.canMutateState` is `true`
 * (the handler has the state-mutation route wired AND the viewer's own
 * current access permits it - see `canMutateConnectorConnectionState`),
 * each row additionally carries the state-mutation control from
 * `internal-os-connection-state-controls.ts`. This module still renders no
 * form itself. Without `canMutateState`, the table is byte-for-byte the
 * pre-slice-2 read-only table (the extra "Actions" column header stays,
 * but every cell in it is empty).
 */
function renderConnectionsBody(view: Exclude<ConnectionsViewState, { kind: "NOT_ACTIVE" } | { kind: "ERROR" }>): string {
  if (view.kind === "EMPTY") {
    return `
  <section aria-labelledby="connections-heading" class="card">
    <h2 id="connections-heading">Connections</h2>
    <p>No connections are configured for this organization yet.</p>
  </section>`;
  }
  const canMutateState = view.canMutateState === true;
  const rows = view.connections.map((connection) => renderConnectionRow(connection, canMutateState)).join("\n      ");
  return `
  <section aria-labelledby="connections-heading" class="card">
    <h2 id="connections-heading">Connections</h2>
    <p>Read-only. Credentials are never shown on this page.</p>
    <table>
      <thead><tr><th>Connection</th><th>Connector</th><th>Auth mode</th><th>State</th><th>Customer / project</th><th>Workspace</th><th>Instance</th><th>Verification evidence</th><th>Actions</th></tr></thead>
      <tbody>
      ${rows}
      </tbody>
    </table>
  </section>`;
}

/**
 * C3: `NOT_ACTIVE` returns exactly what `notActiveDestinationPageContent`
 * returned for `connections` before C3, so an unwired caller's page is
 * unchanged. `ERROR` becomes the OS ERROR page (500, no data and no detail
 * shown), never an EMPTY list.
 */
export function connectionsPageContent(
  nav: ReadonlyArray<NavDestination>,
  organizationName: string,
  view: ConnectionsViewState,
): InternalOsPageContent {
  switch (view.kind) {
    case "NOT_ACTIVE":
      return notActiveDestinationPageContent(nav, organizationName, "connections");
    case "ERROR":
      return { kind: "ERROR", reason: "connections could not be read" };
    case "EMPTY":
    case "READY":
      return destinationContent({
        nav,
        activeKey: "connections",
        organizationName,
        title: "Connections",
        bodyHtml: renderConnectionsBody(view),
      });
  }
}

function renderWorkersRosterRow(entry: WorkersRosterEntry): string {
  return `<tr><td>${escapeHtml(entry.servicePrincipalId)}</td><td>${escapeHtml(entry.workerRef)}</td><td><span class="status status-${entry.lifecycleState === "ACTIVE" ? "success" : "neutral"}" role="status">${escapeHtml(entry.lifecycleState)}</span></td></tr>`;
}

/**
 * Gap scan N2: read-only AI & Capabilities destination. Every field comes
 * from `WorkersRosterEntry`, the allow-list `resolveWorkersRosterView`
 * builds, so an `OrganizationServicePrincipal`'s `revokedAt`/`revokedReason`
 * never reach this function - and, structurally, neither could a
 * capability/trust/routing field, since that allow-list has none.
 *
 * The disclosure paragraph below is mandatory on every READY render, not
 * incidental copy: this table could otherwise be mistaken for a roster of
 * admitted/routable AI workers. `worker-routing-policy.ts`'s own `ADMITTED`
 * and `ELEVATED` trust-tier concepts are a genuinely separate, unresolved
 * OS-V0-06/07/13 question (see that module's doc comment) that this
 * read-only identity/lifecycle roster must never be read as answering -
 * hence the plain-language disclosure, kept deliberately non-technical so
 * it is legible to any staff reader, not just one who already knows that
 * module's vocabulary.
 */
function renderWorkersRosterBody(view: Exclude<WorkersRosterViewState, { kind: "NOT_ACTIVE" } | { kind: "ERROR" }>): string {
  if (view.kind === "EMPTY") {
    return `
  <section aria-labelledby="ai-capabilities-heading" class="card">
    <h2 id="ai-capabilities-heading">AI &amp; Capabilities</h2>
    <p>No AI/automation service principals are registered for this organization yet.</p>
  </section>`;
  }
  const rows = view.servicePrincipals.map(renderWorkersRosterRow).join("\n      ");
  return `
  <section aria-labelledby="ai-capabilities-heading" class="card">
    <h2 id="ai-capabilities-heading">AI &amp; Capabilities</h2>
    <p>Read-only. Identity and lifecycle state only.</p>
    <table>
      <thead><tr><th>Service principal</th><th>Worker reference</th><th>Lifecycle state</th></tr></thead>
      <tbody>
      ${rows}
      </tbody>
    </table>
  </section>
  <section aria-labelledby="ai-capabilities-disclosure-heading" class="card">
    <h2 id="ai-capabilities-disclosure-heading">What this roster does not show</h2>
    <p>This roster shows identity and lifecycle state only. Capability, maturity, trust, and AI-worker routing authority are not shown here and remain NOT_ACTIVE — a service principal appearing here is not an admitted or routable AI worker.</p>
  </section>`;
}

/**
 * Gap scan N2: `NOT_ACTIVE` returns exactly what
 * `notActiveDestinationPageContent` returned for `ai-capabilities` before
 * this slice, so an unwired caller's page is unchanged. `ERROR` becomes the
 * OS ERROR page (500, no data and no detail shown), never an EMPTY list.
 */
export function workersRosterPageContent(
  nav: ReadonlyArray<NavDestination>,
  organizationName: string,
  view: WorkersRosterViewState,
): InternalOsPageContent {
  switch (view.kind) {
    case "NOT_ACTIVE":
      return notActiveDestinationPageContent(nav, organizationName, "ai-capabilities");
    case "ERROR":
      return { kind: "ERROR", reason: "AI & Capabilities roster could not be read" };
    case "EMPTY":
    case "READY":
      return destinationContent({
        nav,
        activeKey: "ai-capabilities",
        organizationName,
        title: "AI & Capabilities",
        bodyHtml: renderWorkersRosterBody(view),
      });
  }
}

function renderKnowledgeRow(entry: KnowledgeEvidenceEntry): string {
  return `<tr><td>${escapeHtml(entry.evidenceId)}</td><td>${escapeHtml(entry.evidenceType)}</td><td>${escapeHtml(entry.customerId)} / ${escapeHtml(entry.projectId)}</td><td>${escapeHtml(entry.jobId)}</td><td>${escapeHtml(entry.capturedAt)}</td></tr>`;
}

/**
 * C3 Knowledge slice: read-only Knowledge destination. Every field comes
 * from `KnowledgeEvidenceEntry`, the allow-list `resolveKnowledgeView`
 * builds, so an evidence reference's `sourceLocator` never reaches this
 * function. Escaped text only, no mutation control.
 */
function renderKnowledgeBody(view: Exclude<KnowledgeViewState, { kind: "NOT_ACTIVE" } | { kind: "ERROR" }>): string {
  if (view.kind === "EMPTY") {
    return `
  <section aria-labelledby="knowledge-heading" class="card">
    <h2 id="knowledge-heading">Knowledge</h2>
    <p>No evidence references have been recorded for this organization yet.</p>
  </section>`;
  }
  const rows = view.evidence.map(renderKnowledgeRow).join("\n      ");
  return `
  <section aria-labelledby="knowledge-heading" class="card">
    <h2 id="knowledge-heading">Knowledge</h2>
    <p>Read-only. Recorded evidence references, most recently captured first. Source locations are not shown on this page.</p>
    <table>
      <thead><tr><th>Evidence</th><th>Type</th><th>Customer / project</th><th>Job</th><th>Captured</th></tr></thead>
      <tbody>
      ${rows}
      </tbody>
    </table>
  </section>`;
}

/**
 * C3 Knowledge slice: `NOT_ACTIVE` returns exactly what
 * `notActiveDestinationPageContent` returned for `knowledge` before C3, so
 * an unwired caller's page is unchanged. `ERROR` becomes the OS ERROR page
 * (500, no data and no detail shown), never an EMPTY list.
 */
export function knowledgePageContent(
  nav: ReadonlyArray<NavDestination>,
  organizationName: string,
  view: KnowledgeViewState,
): InternalOsPageContent {
  switch (view.kind) {
    case "NOT_ACTIVE":
      return notActiveDestinationPageContent(nav, organizationName, "knowledge");
    case "ERROR":
      return { kind: "ERROR", reason: "knowledge evidence could not be read" };
    case "EMPTY":
    case "READY":
      return destinationContent({
        nav,
        activeKey: "knowledge",
        organizationName,
        title: "Knowledge",
        bodyHtml: renderKnowledgeBody(view),
      });
  }
}

function renderCredentialAccessRow(item: AttentionCredentialAccessItem): string {
  const ownership = `${escapeHtml(item.customerId)} / ${escapeHtml(item.projectId)}${
    item.serviceRef !== undefined ? ` / ${escapeHtml(item.serviceRef)}` : ""
  }`;
  return `<tr><td>${escapeHtml(item.connectionBindingId)}</td><td>${escapeHtml(item.connectorKind)}</td><td><span class="status status-${CONNECTION_STATE_TONE[item.connectionState]}" role="status">${escapeHtml(item.connectionState)}</span></td><td>${ownership}</td></tr>`;
}

/**
 * C4 slice 3: status tone for a recorded decision outcome. `APPROVED` is
 * `success`, `DENIED` is `danger`, `REVOKED` is `neutral` (it is a
 * deliberate withdrawal of a prior approval, not itself a failure state).
 */
const DECISION_OUTCOME_TONE: Record<ProtectedDecisionOutcome, "neutral" | "warning" | "danger" | "success"> = {
  APPROVED: "success",
  DENIED: "danger",
  REVOKED: "neutral",
};

/**
 * C4 slice 3: `canDecide` mirrors `renderConnectionRow`'s own
 * `canMutateState` parameter exactly - `true` only when the handler has the
 * attention decision route wired AND the viewer's own current access
 * permits it (`canDecideProtectedDecision`). `item.decisionStatus` is
 * `undefined` when no `AttentionSource.getProtectedDecisionRecord` is
 * wired, or when it is wired but genuinely has no record yet - both read
 * as "Pending decision", since neither tells staff anything false (every
 * row in this family is, by construction, a wait with no resume yet).
 */
function renderCustomerApprovalRow(item: AttentionCustomerApprovalItem, canDecide: boolean): string {
  const statusCell =
    item.decisionStatus === undefined
      ? `<span class="status status-neutral" role="status">Pending decision</span>`
      : `<span class="status status-${DECISION_OUTCOME_TONE[item.decisionStatus.outcome]}" role="status">${escapeHtml(item.decisionStatus.outcome)}</span>`;
  const control = renderAttentionDecisionControls({
    decisionRef: item.decisionRef,
    canDecide,
    ...(item.decisionStatus !== undefined ? { outcome: item.decisionStatus.outcome } : {}),
  });
  const controlsCell = control.length > 0 ? `<td>${control}</td>` : "<td></td>";
  return `<tr><td>${escapeHtml(item.waitRequestId)}</td><td>${escapeHtml(item.customerId)} / ${escapeHtml(item.projectId)}</td><td>${escapeHtml(item.jobId)}</td><td>${escapeHtml(item.decisionRef)}</td><td>${escapeHtml(item.effectRef)}</td><td>${escapeHtml(item.raisedAt)}</td><td>${statusCell}</td>${controlsCell}</tr>`;
}

/**
 * Says exactly which attention families this page covers, so an empty
 * page can never read as "nothing in this organization needs attention"
 * for families it does not track.
 */
const ATTENTION_SCOPE_NOTE =
  "Read-only. This page covers two kinds of attention: connections with a credential or access problem (DEGRADED or REVOKED), and protected decisions waiting for approval. Other kinds of attention are not tracked here yet.";

/**
 * C3 Attention slice: read-only Attention destination. Every field comes
 * from `AttentionCredentialAccessItem` / `AttentionCustomerApprovalItem`,
 * the allow-lists `resolveAttentionView` builds, so no secret reference and
 * no wait `reason` reaches this function. Escaped text only, no mutation
 * control.
 */
function renderAttentionBody(view: Exclude<AttentionViewState, { kind: "NOT_ACTIVE" } | { kind: "ERROR" }>): string {
  if (view.kind === "EMPTY") {
    return `
  <section aria-labelledby="attention-heading" class="card">
    <h2 id="attention-heading">Attention</h2>
    <p>${ATTENTION_SCOPE_NOTE}</p>
    <p>No connection has a credential or access problem, and no protected decision is waiting for approval.</p>
  </section>`;
  }
  const credentialSection =
    view.credentialAccessProblems.length === 0
      ? `<p>No connection has a credential or access problem.</p>`
      : `<p>No state-change time is recorded for connections, so this list cannot show how long each has been in this state.</p>
    <table>
      <thead><tr><th>Connection</th><th>Connector</th><th>State</th><th>Customer / project</th></tr></thead>
      <tbody>
      ${view.credentialAccessProblems.map(renderCredentialAccessRow).join("\n      ")}
      </tbody>
    </table>`;
  const canDecide = view.canDecide === true;
  const approvalSection =
    view.customerApprovalsRequired.length === 0
      ? `<p>No protected decision is waiting for approval.</p>`
      : `<p>Longest waiting first.</p>
    <table>
      <thead><tr><th>Wait request</th><th>Customer / project</th><th>Job</th><th>Decision</th><th>Effect</th><th>Waiting since</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
      ${view.customerApprovalsRequired.map((item) => renderCustomerApprovalRow(item, canDecide)).join("\n      ")}
      </tbody>
    </table>`;
  return `
  <section aria-labelledby="attention-heading" class="card">
    <h2 id="attention-heading">Attention</h2>
    <p>${ATTENTION_SCOPE_NOTE}</p>
  </section>
  <section aria-labelledby="attention-credential-heading" class="card">
    <h2 id="attention-credential-heading">Credential or access problem</h2>
    ${credentialSection}
  </section>
  <section aria-labelledby="attention-approval-heading" class="card">
    <h2 id="attention-approval-heading">Customer approval required</h2>
    ${approvalSection}
  </section>`;
}

/**
 * C3 Attention slice: `NOT_ACTIVE` returns exactly what
 * `notActiveDestinationPageContent` returned for `attention` before C3, so
 * an unwired caller's page (and a viewer without WRITE) is unchanged.
 * `ERROR` becomes the OS ERROR page (500, no data and no detail shown),
 * never an EMPTY list.
 */
export function attentionPageContent(
  nav: ReadonlyArray<NavDestination>,
  organizationName: string,
  view: AttentionViewState,
): InternalOsPageContent {
  switch (view.kind) {
    case "NOT_ACTIVE":
      return notActiveDestinationPageContent(nav, organizationName, "attention");
    case "ERROR":
      return { kind: "ERROR", reason: "attention items could not be read" };
    case "EMPTY":
    case "READY":
      return destinationContent({
        nav,
        activeKey: "attention",
        organizationName,
        title: "Attention",
        bodyHtml: renderAttentionBody(view),
      });
  }
}

/**
 * C3 People slice: a roster `ERROR` becomes the OS ERROR page (500, no data
 * and no detail shown), never an empty directory. No roster renders the
 * pre-C3 self-only page unchanged.
 */
export function peoplePageContent(nav: ReadonlyArray<NavDestination>, organizationName: string, view: PeopleViewState): InternalOsPageContent {
  if (view.roster?.kind === "ERROR") {
    return { kind: "ERROR", reason: "people directory could not be read" };
  }
  return destinationContent({
    nav,
    activeKey: "people",
    organizationName,
    title: "People",
    bodyHtml: renderPeopleBody(view, view.roster?.members),
  });
}

export function productsPageContent(nav: ReadonlyArray<NavDestination>, organizationName: string, view: ProductsViewState): InternalOsPageContent {
  return destinationContent({ nav, activeKey: "products", organizationName, title: "Products", bodyHtml: renderProductsBody(view) });
}

export function adminPageContent(nav: ReadonlyArray<NavDestination>, organizationName: string, view: AdminViewState): InternalOsPageContent {
  return destinationContent({ nav, activeKey: "admin", organizationName, title: "Admin", bodyHtml: renderAdminBody(view) });
}

/** C7: the break-glass support page - see the `BREAK_GLASS_OBSERVABILITY` variant. */
export function breakGlassObservabilityPageContent(organizationName: string, view: BreakGlassObservabilityViewState): InternalOsPageContent {
  return { kind: "BREAK_GLASS_OBSERVABILITY", organizationName, view };
}

/**
 * Rev168 A12-equivalent discipline (reused from `shell-render.ts`): every
 * branch here is a distinct, deterministic rendering, `statusLabel` is
 * always visible text (never color alone), and only `DESTINATION` (and,
 * since C7, the read-only `BREAK_GLASS_OBSERVABILITY`) ever renders
 * application content - none of the error/denial branches can be mistaken
 * for a successful render.
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
    case "BAD_REQUEST":
      return {
        status: 400,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          chrome: { nav: [], activeKey: undefined },
          title: "Invalid submission",
          statusLabel: "Invalid submission",
          statusTone: "warning",
          bodyHtml: "<p>The submitted form was incomplete or malformed. Nothing was changed.</p>",
        }),
      };
    case "CONFLICT":
      return {
        status: 409,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          chrome: { nav: [], activeKey: undefined },
          title: "Decision not applied",
          statusLabel: "Decision not applied",
          statusTone: "warning",
          bodyHtml:
            "<p>This decision could not be applied. The request may already have been decided or changed since the page was loaded. Nothing was changed. Reload the admin page and try again.</p>",
        }),
      };
    case "BREAK_GLASS_OBSERVABILITY":
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          chrome: { nav: [], activeKey: undefined, organizationName: content.organizationName },
          title: "Support access",
          statusLabel: "Break-glass support access (read-only, audited)",
          statusTone: "warning",
          bodyHtml: renderBreakGlassObservabilityBody(content.view),
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
