import type {
  ClientProjectSnapshot,
  WorkingArtifactState,
} from "../domain/client-project-snapshot.js";
import type { DeliveryTimeline } from "../domain/delivery-timeline.js";
import type { ProjectCommunicationRecord } from "../domain/project-communication.js";
import { buildAdvisorResult, type AdvisorResult } from "../domain/delivery-advisor.js";
import type { TeamAttentionViewState } from "./team-attention-view-state.js";
import type { TeamAttentionProjection } from "../domain/team-attention-projection.js";
import type { Locale } from "./locale.js";
import { resolveShellCopy, type ShellCopy } from "./shell-copy.js";

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
  | { readonly kind: "BLOCKED"; readonly snapshot: ClientProjectSnapshot; readonly teamAttention?: TeamAttentionViewState }
  | { readonly kind: "ERROR"; readonly reason: string }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "UNAUTHENTICATED" }
  | { readonly kind: "FORBIDDEN_TENANT_SCOPE" }
  | { readonly kind: "READY"; readonly snapshot: ClientProjectSnapshot; readonly teamAttention?: TeamAttentionViewState };

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
 *
 * APP-I18N-001: `locale` drives the document's own `lang` attribute -
 * the one structural signal every downstream assistive technology and
 * browser feature (spell-check, translation offers, hyphenation, screen
 * readers) relies on - and `copy` supplies every fixed string on this
 * shared frame. Tenant/customer/project/resource identity, authorization,
 * routing and state semantics are entirely untouched by this parameter;
 * it only ever selects which fixed strings are shown.
 */
function renderPage(input: {
  locale: Locale;
  copy: ShellCopy;
  title: string;
  statusLabel: string;
  statusTone: "neutral" | "warning" | "danger" | "success";
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html lang="${input.locale}">
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
<a class="skip-link" href="#main-content">${escapeHtml(input.copy.skipLink)}</a>
<header>
  <p><strong>AKILTA</strong> — ${escapeHtml(input.copy.portalHeaderSuffix)}</p>
</header>
<main id="main-content">
  <p class="status status-${input.statusTone}" role="status">${escapeHtml(input.statusLabel)}</p>
  ${input.bodyHtml}
</main>
<footer>
  <p>${escapeHtml(input.copy.footerDisclaimer)}</p>
</footer>
</body>
</html>`;
}

/**
 * V2-CDO-006 (UX/CLAIM RULES): "Customer action is visually distinct from
 * AKILTA internal work and External Wait" and "NO ACTION NEEDED should
 * reduce unnecessary customer interruptions" - each owner gets its own
 * always-visible text badge, never color alone (U2/U6).
 */
function renderNextActionSection(copy: ShellCopy, nextAction: { owner: keyof ShellCopy["nextAction"] }): string {
  const info = copy.nextAction[nextAction.owner];
  const tone = nextAction.owner === "NO_ACTION_NEEDED" ? "success" : nextAction.owner === "CLIENT_ACTION_REQUIRED" ? "warning" : "neutral";
  return `
  <section aria-labelledby="next-action-heading">
    <h2 id="next-action-heading">${escapeHtml(copy.nextActionHeading)}</h2>
    <p class="status status-${tone}" role="status">${escapeHtml(info.badge)}</p>
    <p>${escapeHtml(info.label)}</p>
  </section>`;
}

/**
 * V2-CDO-006 IA: "state-first milestone/timeline summary". Reuses the
 * already customer-safe `DeliveryTimeline` (V2-CDO-001 CR-1) verbatim -
 * no raw `reason`/`actorRef` ever reaches this layer (U11).
 */
function renderTimelineSection(copy: ShellCopy, timeline: DeliveryTimeline): string {
  if (timeline.entries.length === 0) {
    return `
  <section aria-labelledby="timeline-heading">
    <h2 id="timeline-heading">${escapeHtml(copy.timelineHeading)}</h2>
    <p>${escapeHtml(copy.noUpdatesYet)}</p>
  </section>`;
  }
  const items = timeline.entries
    .map(
      (entry) =>
        `<li>${escapeHtml(copy.timelineCategory[entry.category])} — <time datetime="${escapeHtml(entry.timestamp)}">${escapeHtml(entry.timestamp)}</time></li>`,
    )
    .join("\n    ");
  return `
  <section aria-labelledby="timeline-heading">
    <h2 id="timeline-heading">${escapeHtml(copy.timelineHeading)}</h2>
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
function renderBlockerSection(copy: ShellCopy, timeline: DeliveryTimeline): string {
  const mostRecentBlocker = [...timeline.entries].filter((entry) => entry.category === "BLOCKER").at(-1);
  const detail =
    mostRecentBlocker !== undefined
      ? copy.blockedSince(escapeHtml(mostRecentBlocker.timestamp))
      : copy.blockerFallback;
  return `
  <section aria-labelledby="blocker-heading">
    <h2 id="blocker-heading">${escapeHtml(copy.blockerHeading)}</h2>
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
function renderWorkingArtifactSection(copy: ShellCopy, workingArtifact: WorkingArtifactState): string {
  const approvalLine = workingArtifact.isCurrentVersionApproved
    ? `<p class="status status-success" role="status">${escapeHtml(copy.approved)}</p>`
    : `<p class="status status-neutral" role="status">${escapeHtml(copy.previewNotApproved)}</p>`;
  const staleNotice =
    workingArtifact.lastApprovedVersion !== undefined &&
    workingArtifact.lastApprovedVersion !== workingArtifact.currentVersion
      ? `<p>${copy.newerVersionExists(escapeHtml(String(workingArtifact.lastApprovedVersion)), escapeHtml(String(workingArtifact.currentVersion)))}</p>`
      : "";
  return `
  <section aria-labelledby="working-artifact-heading">
    <h2 id="working-artifact-heading">${escapeHtml(copy.workingArtifactHeading)}</h2>
    <p>${escapeHtml(copy.currentVersionLabel(String(workingArtifact.currentVersion)))}</p>
    ${approvalLine}
    ${staleNotice}
  </section>`;
}

/**
 * V2-CDO-006 IA: "connection/capability readiness summary ... without
 * secrets or provider credential detail" (U15). `CustomerSafeCapabilitySummary`
 * already excludes `connectionBindingId`/`evidenceRef`/provider detail
 * (V2-CDO-005 P9) - this renders only `requiredCapabilityRef` + `status`.
 */
function renderCapabilitiesSection(
  copy: ShellCopy,
  capabilities: ReadonlyArray<{ requiredCapabilityRef: string; status: keyof ShellCopy["capabilityStatus"] }>,
): string {
  if (capabilities.length === 0) {
    return "";
  }
  const items = capabilities
    .map(
      (capability) =>
        `<li>${escapeHtml(capability.requiredCapabilityRef)}: ${escapeHtml(copy.capabilityStatus[capability.status])}</li>`,
    )
    .join("\n    ");
  return `
  <section aria-labelledby="capabilities-heading">
    <h2 id="capabilities-heading">${escapeHtml(copy.capabilitiesHeading)}</h2>
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
function renderCommunicationsSection(copy: ShellCopy, records: ReadonlyArray<ProjectCommunicationRecord>): string {
  if (records.length === 0) {
    return "";
  }
  const items = [...records]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    .map((record) => {
      const evidence = record.evidenceRef ?? record.relatedArtifactRef;
      const evidenceLine = evidence !== undefined ? ` — ${escapeHtml(copy.evidenceLabel)}: ${escapeHtml(evidence)}` : "";
      return `<li>${escapeHtml(record.classification)} (${escapeHtml(record.requiredActor)}) — <time datetime="${escapeHtml(record.timestamp)}">${escapeHtml(record.timestamp)}</time>${evidenceLine}</li>`;
    })
    .join("\n    ");
  return `
  <section aria-labelledby="communications-heading">
    <h2 id="communications-heading">${escapeHtml(copy.communicationsHeading)}</h2>
    <ul>
    ${items}
    </ul>
  </section>`;
}

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
function renderAdvisorSection(copy: ShellCopy, snapshot: ClientProjectSnapshot): string {
  let result: AdvisorResult;
  try {
    result = buildAdvisorResult({ ownership: snapshot.ownership, snapshot });
  } catch {
    return `
  <section aria-labelledby="advisor-heading">
    <h2 id="advisor-heading">${escapeHtml(copy.advisorHeading)}</h2>
    <p class="status status-neutral" role="status">${escapeHtml(copy.advisorUnavailableStatus)}</p>
    <p>${escapeHtml(copy.advisorUnavailableBody)}</p>
  </section>`;
  }

  const body =
    result.status === "RECOMMENDATIONS_AVAILABLE"
      ? `
    <p><em>${escapeHtml(copy.advisorRecommendationIntro)}</em></p>
    <ul>
    ${result.recommendations
      .map((option) => `<li>${escapeHtml(option.description)}</li>`)
      .join("\n    ")}
    </ul>`
      : `
    <p>${escapeHtml(result.unavailableReason ?? "No recommendation is available yet.")}</p>`;

  return `
  <section aria-labelledby="advisor-heading">
    <h2 id="advisor-heading">${escapeHtml(copy.advisorHeading)}</h2>
    <p class="status status-neutral" role="status">${escapeHtml(copy.advisorMaturity[result.maturity])}</p>
    ${body}
  </section>`;
}

const OWNER_ROLE_FIELDS: ReadonlyArray<keyof TeamAttentionProjection["owners"]> = [
  "leadOwnerMembershipId",
  "dealOwnerMembershipId",
  "accountOwnerMembershipId",
  "deliveryOwnerMembershipId",
];

/**
 * V3 Full Blueprint §9 (Workstream F floor slice): "acting organization/
 * client context and current role are visible where ambiguity exists" +
 * "LeadOwner/DealOwner/AccountOwner/DeliveryOwner render separately."
 * This section renders only fields already present on the given
 * `TeamAttentionViewState` (built exclusively from merged-main V3 A-D
 * substrate, see `team-attention-projection.ts`) - it never computes or
 * infers a role/owner/attention value itself. `UNAVAILABLE`/
 * `FORBIDDEN_TENANT_SCOPE`/absent all render the identical honest
 * "unavailable" message (A12: truthful unavailable state, never a
 * fabricated default) so no caller can distinguish wiring detail from a
 * genuine access boundary by reading the page.
 *
 * Commercial/commission/discount state is rendered as a fixed literal,
 * not a computed value - Workstream E (commercial-authority read models)
 * is a separate, independently-gated checkpoint; this section must not
 * consume it or invent a competing commercial type (§8: "no role or
 * ownership label silently grants... authority").
 */
function renderTeamAttentionSection(copy: ShellCopy, view: TeamAttentionViewState | undefined): string {
  if (view === undefined || view.kind !== "READY") {
    return `
  <section aria-labelledby="team-attention-heading">
    <h2 id="team-attention-heading">${escapeHtml(copy.teamAttentionHeading)}</h2>
    <p class="status status-neutral" role="status">${escapeHtml(copy.teamUnavailableStatus)}</p>
    <p>${escapeHtml(copy.teamUnavailableBody)}</p>
  </section>`;
  }

  const { projection } = view;
  const roleLine =
    projection.viewerRole !== undefined
      ? `<p>${escapeHtml(copy.yourRole(projection.viewerRole))}</p>`
      : `<p>${escapeHtml(copy.yourRoleNotEstablished)}</p>`;
  const ownerItems = OWNER_ROLE_FIELDS.map((field) => {
    const membershipId = projection.owners[field];
    return `<li>${escapeHtml(copy.ownerLabel[field])}: ${membershipId !== undefined ? escapeHtml(membershipId) : escapeHtml(copy.notAssigned)}</li>`;
  }).join("\n    ");
  const attentionLine =
    projection.attention !== undefined
      ? `<p class="status status-${projection.attention.isActive ? "warning" : "success"}" role="status">${escapeHtml(copy.attentionLabel(projection.attention.internalAttentionLevel, projection.attention.reason))}</p>`
      : `<p class="status status-neutral" role="status">${escapeHtml(copy.attentionNoData)}</p>`;

  return `
  <section aria-labelledby="team-attention-heading">
    <h2 id="team-attention-heading">${escapeHtml(copy.teamAttentionHeading)}</h2>
    ${roleLine}
    <ul>
    ${ownerItems}
    </ul>
    ${attentionLine}
    <p>${escapeHtml(copy.commercialUnavailable)}</p>
  </section>`;
}

/**
 * V2-CDO-006 minimum IA: identity header, next action, (blocker card when
 * blocked), timeline, working artifact, capabilities, recent updates,
 * verified-completed-work count. Every section is driven only by fields
 * already present on the customer-safe `ClientProjectSnapshot` (A9) - no
 * section reaches around it into a private domain shape.
 */
function renderSnapshotBody(
  copy: ShellCopy,
  snapshot: ClientProjectSnapshot,
  options?: { blocked?: boolean; teamAttention?: TeamAttentionViewState },
): string {
  const header = `
  <section aria-labelledby="project-identity-heading">
    <h2 id="project-identity-heading">${escapeHtml(copy.projectHeading)}</h2>
    <p>${escapeHtml(copy.customerLabel(snapshot.ownership.customerId))}</p>
    <p>${escapeHtml(copy.projectLabel(snapshot.ownership.projectId))}</p>
    <p>${copy.overallStatusLabel(escapeHtml(snapshot.deliveryStatus.overallStatus))}</p>
  </section>`;
  const blockerSection = options?.blocked === true ? renderBlockerSection(copy, snapshot.timeline) : "";
  const workingArtifactSection =
    snapshot.workingArtifact !== undefined ? renderWorkingArtifactSection(copy, snapshot.workingArtifact) : "";
  return `
  ${header}
  ${blockerSection}
  ${renderNextActionSection(copy, snapshot.nextAction)}
  ${renderTimelineSection(copy, snapshot.timeline)}
  ${workingArtifactSection}
  ${renderCapabilitiesSection(copy, snapshot.capabilities)}
  ${renderCommunicationsSection(copy, snapshot.recentCommunications)}
  ${renderAdvisorSection(copy, snapshot)}
  ${renderTeamAttentionSection(copy, options?.teamAttention)}
  <section aria-labelledby="verified-work-heading">
    <h2 id="verified-work-heading">${escapeHtml(copy.verifiedWorkHeading)}</h2>
    <p>${escapeHtml(copy.verifiedWorkCount(snapshot.verifiedCompletedJobIds.length))}</p>
  </section>`;
}

/**
 * V2-APP-001 A11: every branch here is a distinct, deterministic
 * rendering - none of them can be mistaken for `READY` because only the
 * `READY` branch ever calls `renderSnapshotBody`, and only `READY` ever
 * receives a `ClientProjectSnapshot` at all.
 *
 * APP-I18N-001: `locale` defaults to `"en"` when omitted - the exact
 * current (pre-localization) rendering behavior - so every existing
 * caller/test that does not yet pass a locale is entirely unaffected.
 * Live requests always pass an explicit, request-resolved locale (see
 * `request-handler.ts`'s `resolveRequestLocale`, whose own default is
 * Turkish per the Türkiye-launch primary requirement); this function's
 * own default is a backward-compatibility convenience, not the live
 * system's actual default.
 */
export function renderShellPage(content: ShellPageContent, locale: Locale = "en"): RenderedShellPage {
  const copy = resolveShellCopy(locale);
  switch (content.kind) {
    case "LOADING":
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          locale,
          copy,
          title: copy.loading.title,
          statusLabel: copy.loading.status,
          statusTone: "neutral",
          bodyHtml: `<p>${escapeHtml(copy.loading.body)}</p>`,
        }),
      };
    case "EMPTY":
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          locale,
          copy,
          title: copy.notStarted.title,
          statusLabel: copy.notStarted.status,
          statusTone: "neutral",
          bodyHtml: `<p>${escapeHtml(copy.notStarted.body)}</p>`,
        }),
      };
    case "UNAVAILABLE":
      return {
        status: 503,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          locale,
          copy,
          title: copy.unavailable.title,
          statusLabel: copy.unavailable.status,
          statusTone: "warning",
          bodyHtml: `<p>${escapeHtml(content.reason)}</p>`,
        }),
      };
    case "UNSUPPORTED":
      return {
        status: 501,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          locale,
          copy,
          title: copy.unsupported.title,
          statusLabel: copy.unsupported.status,
          statusTone: "neutral",
          bodyHtml: `<p>${escapeHtml(content.reason)}</p>`,
        }),
      };
    case "BLOCKED":
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          locale,
          copy,
          title: copy.blockedPage.title,
          statusLabel: copy.blockedPage.status,
          statusTone: "warning",
          bodyHtml: renderSnapshotBody(copy, content.snapshot, {
            blocked: true,
            ...(content.teamAttention !== undefined ? { teamAttention: content.teamAttention } : {}),
          }),
        }),
      };
    case "ERROR":
      return {
        status: 500,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          locale,
          copy,
          title: copy.errorPage.title,
          statusLabel: copy.errorPage.status,
          statusTone: "danger",
          bodyHtml: `<p>${escapeHtml(copy.errorPage.body)}</p>`,
        }),
      };
    case "NOT_FOUND":
      return {
        status: 404,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          locale,
          copy,
          title: copy.notFound.title,
          statusLabel: copy.notFound.status,
          statusTone: "neutral",
          bodyHtml: `<p>${escapeHtml(copy.notFound.body)}</p>`,
        }),
      };
    case "UNAUTHENTICATED":
      return {
        status: 401,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          locale,
          copy,
          title: copy.unauthenticated.title,
          statusLabel: copy.unauthenticated.status,
          statusTone: "warning",
          bodyHtml: `<p>${escapeHtml(copy.unauthenticated.body)}</p>`,
        }),
      };
    case "FORBIDDEN_TENANT_SCOPE":
      return {
        status: 403,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          locale,
          copy,
          title: copy.forbidden.title,
          statusLabel: copy.forbidden.status,
          statusTone: "danger",
          bodyHtml: `<p>${escapeHtml(copy.forbidden.body)}</p>`,
        }),
      };
    case "READY":
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: renderPage({
          locale,
          copy,
          title: copy.ready.title,
          statusLabel: copy.ready.status,
          statusTone: "success",
          bodyHtml: renderSnapshotBody(
            copy,
            content.snapshot,
            content.teamAttention !== undefined ? { teamAttention: content.teamAttention } : undefined,
          ),
        }),
      };
  }
}
