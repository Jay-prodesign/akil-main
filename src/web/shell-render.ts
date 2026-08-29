import type {
  ClientProjectSnapshot,
  CustomerSafeCapabilitySummary,
  NextAction,
  WorkingArtifactState,
} from "../domain/client-project-snapshot.js";
import type { DeliveryTimeline, DeliveryTimelineEntry } from "../domain/delivery-timeline.js";
import type { ProjectCommunicationRecord } from "../domain/project-communication.js";
import { buildAdvisorResult, type AdvisorResult } from "../domain/delivery-advisor.js";

/**
 * V2-APP-001 (IN SCOPE H) / V2-CDO-006: the deterministic, closed set of
 * page content this shell can render. `LOADING`/`UNAVAILABLE`/
 * `UNSUPPORTED` still have no live trigger in this synchronous, in-memory
 * bootstrap (there is no async snapshot source yet and no
 * capability-unsupported concept at the shell level) - they remain
 * prepared render primitives per "PREPARED != IMPLEMENTED" (DEC-153
 * Activation Discipline). Every other kind, including `BLOCKED`, is live:
 * `request-handler.ts` reaches it from a real `ClientProjectSnapshot`.
 */
export type ShellPageContent =
  | { readonly kind: "LOADING" }
  | { readonly kind: "EMPTY" }
  | { readonly kind: "UNAVAILABLE"; readonly reason: string }
  | { readonly kind: "UNSUPPORTED"; readonly reason: string }
  | { readonly kind: "BLOCKED"; readonly snapshot: ClientProjectSnapshot }
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
  <p>This is an internal engineering checkpoint (V2-APP-001/V2-CDO-006), not a released customer product.</p>
</footer>
</body>
</html>`;
}

const NEXT_ACTION_LABELS: Record<NextAction["owner"], { label: string; badge: string; tone: string }> = {
  NO_ACTION_NEEDED: { label: "Nothing needed from you right now.", badge: "NO ACTION NEEDED", tone: "success" },
  CLIENT_ACTION_REQUIRED: { label: "Action is needed from you.", badge: "YOUR ACTION", tone: "warning" },
  AKILTA_ACTION_REQUIRED: { label: "AKILTA is handling the next step.", badge: "AKILTA WORKING", tone: "neutral" },
  EXTERNAL_WAIT: { label: "Waiting on an external factor.", badge: "EXTERNAL WAIT", tone: "neutral" },
};

/**
 * V2-CDO-006 (UX/CLAIM RULES): "Customer action is visually distinct from
 * AKILTA internal work and External Wait" and "NO ACTION NEEDED should
 * reduce unnecessary customer interruptions" - each owner gets its own
 * always-visible text badge, never color alone (U2/U6).
 */
function renderNextActionSection(nextAction: NextAction): string {
  const info = NEXT_ACTION_LABELS[nextAction.owner];
  return `
  <section aria-labelledby="next-action-heading">
    <h2 id="next-action-heading">Next action</h2>
    <p class="status status-${info.tone}" role="status">${escapeHtml(info.badge)}</p>
    <p>${escapeHtml(info.label)}</p>
  </section>`;
}

const TIMELINE_CATEGORY_LABELS: Record<DeliveryTimelineEntry["category"], string> = {
  STATUS_UPDATE: "Status update",
  BLOCKER: "Blocking issue",
  VERIFICATION: "Verified",
  ACTION_REQUIRED: "Action required",
  WORKING_ARTIFACT: "Working artifact update",
  APPROVAL: "Approval",
};

/**
 * V2-CDO-006 IA: "state-first milestone/timeline summary". Reuses the
 * already customer-safe `DeliveryTimeline` (V2-CDO-001 CR-1) verbatim -
 * no raw `reason`/`actorRef` ever reaches this layer (U11).
 */
function renderTimelineSection(timeline: DeliveryTimeline): string {
  if (timeline.entries.length === 0) {
    return `
  <section aria-labelledby="timeline-heading">
    <h2 id="timeline-heading">Timeline</h2>
    <p>No updates recorded yet.</p>
  </section>`;
  }
  const items = timeline.entries
    .map(
      (entry) =>
        `<li>${escapeHtml(TIMELINE_CATEGORY_LABELS[entry.category])} — <time datetime="${escapeHtml(entry.timestamp)}">${escapeHtml(entry.timestamp)}</time></li>`,
    )
    .join("\n    ");
  return `
  <section aria-labelledby="timeline-heading">
    <h2 id="timeline-heading">Timeline</h2>
    <ul>
    ${items}
    </ul>
  </section>`;
}

/**
 * V2-CDO-006 IA: "blocker/external-wait card with customer-safe reason
 * and timestamp when applicable". The only customer-safe blocker signal
 * this repository produces is the timeline's own `BLOCKER` category
 * (V2-CDO-001 CR-1) - never a raw internal `reason` string (U11). Absent
 * such an entry, this states that truthfully rather than fabricating one.
 */
function renderBlockerSection(timeline: DeliveryTimeline): string {
  const mostRecentBlocker = [...timeline.entries].filter((entry) => entry.category === "BLOCKER").at(-1);
  const detail =
    mostRecentBlocker !== undefined
      ? `Blocked since <time datetime="${escapeHtml(mostRecentBlocker.timestamp)}">${escapeHtml(mostRecentBlocker.timestamp)}</time>.`
      : "A blocking issue was detected. No further customer-safe detail is available yet.";
  return `
  <section aria-labelledby="blocker-heading">
    <h2 id="blocker-heading">Blocked</h2>
    <p>${detail}</p>
  </section>`;
}

/**
 * V2-CDO-006 IA: "Working Artifact area, clearly labelled preview/
 * staging/sandbox/dry-run/verified ...; preview must never visually
 * imply DONE/VERIFIED" and "current working version versus last
 * customer-approved version where applicable" (U13/U14). `snapshot.
 * workingArtifact` is only present when a real plan exists (A9) - the
 * approval label always reflects `isCurrentVersionApproved` exactly as
 * `isApprovalValidForPlan` computed it, never inferred separately here.
 */
function renderWorkingArtifactSection(workingArtifact: WorkingArtifactState): string {
  const approvalLine = workingArtifact.isCurrentVersionApproved
    ? `<p class="status status-success" role="status">Approved</p>`
    : `<p class="status status-neutral" role="status">Preview — not yet approved</p>`;
  const staleNotice =
    workingArtifact.lastApprovedVersion !== undefined &&
    workingArtifact.lastApprovedVersion !== workingArtifact.currentVersion
      ? `<p>A newer version exists since the last approval (version ${escapeHtml(String(workingArtifact.lastApprovedVersion))} was approved; current is version ${escapeHtml(String(workingArtifact.currentVersion))}).</p>`
      : "";
  return `
  <section aria-labelledby="working-artifact-heading">
    <h2 id="working-artifact-heading">Working artifact</h2>
    <p>Current version: ${escapeHtml(String(workingArtifact.currentVersion))}</p>
    ${approvalLine}
    ${staleNotice}
  </section>`;
}

const CAPABILITY_STATUS_LABELS: Record<CustomerSafeCapabilitySummary["status"], string> = {
  UNVERIFIED: "Not yet verified",
  VERIFIED_AVAILABLE: "Ready",
  UNSUPPORTED: "Not supported",
  INELIGIBLE: "Not eligible",
};

/**
 * V2-CDO-006 IA: "connection/capability readiness summary ... without
 * secrets or provider credential detail" (U15). `CustomerSafeCapabilitySummary`
 * already excludes `connectionBindingId`/`evidenceRef`/provider detail
 * (V2-CDO-005 P9) - this renders only `requiredCapabilityRef` + `status`.
 */
function renderCapabilitiesSection(capabilities: ReadonlyArray<CustomerSafeCapabilitySummary>): string {
  if (capabilities.length === 0) {
    return "";
  }
  const items = capabilities
    .map(
      (capability) =>
        `<li>${escapeHtml(capability.requiredCapabilityRef)}: ${escapeHtml(CAPABILITY_STATUS_LABELS[capability.status])}</li>`,
    )
    .join("\n    ");
  return `
  <section aria-labelledby="capabilities-heading">
    <h2 id="capabilities-heading">Connections &amp; capabilities</h2>
    <ul>
    ${items}
    </ul>
  </section>`;
}

/**
 * V2-CDO-006 IA: "latest safe update/evidence references". Renders only
 * the already customer-safe `ProjectCommunicationRecord` fields (V2-CDO-003
 * O9) - no message body/content field exists on this type to leak.
 */
function renderCommunicationsSection(records: ReadonlyArray<ProjectCommunicationRecord>): string {
  if (records.length === 0) {
    return "";
  }
  const items = [...records]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    .map((record) => {
      const evidence = record.evidenceRef ?? record.relatedArtifactRef;
      const evidenceLine = evidence !== undefined ? ` — evidence: ${escapeHtml(evidence)}` : "";
      return `<li>${escapeHtml(record.classification)} (${escapeHtml(record.requiredActor)}) — <time datetime="${escapeHtml(record.timestamp)}">${escapeHtml(record.timestamp)}</time>${evidenceLine}</li>`;
    })
    .join("\n    ");
  return `
  <section aria-labelledby="communications-heading">
    <h2 id="communications-heading">Recent updates</h2>
    <ul>
    ${items}
    </ul>
  </section>`;
}

const ADVISOR_MATURITY_LABELS: Record<AdvisorResult["maturity"], string> = {
  L0_OBSERVE: "ADVISOR: OBSERVE",
  L1_RECOMMEND: "ADVISOR: RECOMMEND",
};

/**
 * V2-CDO-008 (In Scope: "Customer-safe presentation integration only if
 * the actual V2 app/portal shell exists") - this is that presentation
 * integration, now that the shell (V2-APP-001/V2-CDO-006) exists.
 * `buildAdvisorResult` is called with only the already-validated
 * `snapshot` and its own `ownership` (never a caller-supplied recipe -
 * this render layer has no `DeliveryRecipe` port/source, so
 * `applicableRecipeRef` is honestly always absent here rather than
 * fabricated).
 *
 * A12: the section has its own heading and is explicitly worded as
 * advisor prose ("not verified evidence, not an approval"), visually
 * subordinate to and clearly separate from the verified project-status
 * sections rendered above it - never styled as verified/approved status.
 *
 * A13: an advisor computation failure renders a deterministic "advisor
 * unavailable" fallback rather than throwing - the only caller,
 * `renderSnapshotBody`, always renders this section last, so an advisor
 * defect can never hide or corrupt the verified project-status sections
 * that already rendered above it.
 */
function renderAdvisorSection(snapshot: ClientProjectSnapshot): string {
  let result: AdvisorResult;
  try {
    result = buildAdvisorResult({ ownership: snapshot.ownership, snapshot });
  } catch {
    return `
  <section aria-labelledby="advisor-heading">
    <h2 id="advisor-heading">Delivery advisor</h2>
    <p class="status status-neutral" role="status">Advisor unavailable</p>
    <p>The delivery advisor could not be computed for this project. This does not affect your project status above.</p>
  </section>`;
  }

  const body =
    result.status === "RECOMMENDATIONS_AVAILABLE"
      ? `
    <p><em>Advisor recommendation — not verified evidence, not an approval:</em></p>
    <ul>
    ${result.recommendations
      .map((option) => `<li>${escapeHtml(option.description)}</li>`)
      .join("\n    ")}
    </ul>`
      : `
    <p>${escapeHtml(result.unavailableReason ?? "No recommendation is available yet.")}</p>`;

  return `
  <section aria-labelledby="advisor-heading">
    <h2 id="advisor-heading">Delivery advisor</h2>
    <p class="status status-neutral" role="status">${escapeHtml(ADVISOR_MATURITY_LABELS[result.maturity])}</p>
    ${body}
  </section>`;
}

/**
 * V2-CDO-006 minimum IA: identity header, next action, (blocker card when
 * blocked), timeline, working artifact, capabilities, recent updates,
 * verified-completed-work count. Every section is driven only by fields
 * already present on the customer-safe `ClientProjectSnapshot` (A9) - no
 * section reaches around it into a private domain shape.
 */
function renderSnapshotBody(snapshot: ClientProjectSnapshot, options?: { blocked?: boolean }): string {
  const header = `
  <section aria-labelledby="project-identity-heading">
    <h2 id="project-identity-heading">Project</h2>
    <p>Customer: ${escapeHtml(snapshot.ownership.customerId)}</p>
    <p>Project: ${escapeHtml(snapshot.ownership.projectId)}</p>
    <p>Overall status: <strong>${escapeHtml(snapshot.deliveryStatus.overallStatus)}</strong></p>
  </section>`;
  const blockerSection = options?.blocked === true ? renderBlockerSection(snapshot.timeline) : "";
  const workingArtifactSection =
    snapshot.workingArtifact !== undefined ? renderWorkingArtifactSection(snapshot.workingArtifact) : "";
  return `
  ${header}
  ${blockerSection}
  ${renderNextActionSection(snapshot.nextAction)}
  ${renderTimelineSection(snapshot.timeline)}
  ${workingArtifactSection}
  ${renderCapabilitiesSection(snapshot.capabilities)}
  ${renderCommunicationsSection(snapshot.recentCommunications)}
  ${renderAdvisorSection(snapshot)}
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
          bodyHtml: renderSnapshotBody(content.snapshot, { blocked: true }),
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
