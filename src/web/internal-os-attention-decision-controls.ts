import type { ProtectedDecisionOutcome } from "../domain/protected-decision-record.js";

/**
 * C4 slice 3 (gap scan 2026-10-23, third `/os` mutation): the HTML controls
 * for the third mutation on the staff `/os` surface - create or revise a
 * protected-decision record for one `decisionRef` from `/os/attention`'s
 * "Customer approval required" rows.
 *
 * This module is one of exactly three places in `src/web/` that render a
 * form or a button element, the others being
 * `internal-os-offboarding-decision-controls.ts` (C4 slice 1) and
 * `internal-os-connection-state-controls.ts` (C4 slice 2). Every other
 * module, and every other read-only destination, still renders no write
 * affordance at all (OS-V0-08 "Phase A"'s original discipline) - the
 * allow-list of modules permitted to do otherwise is pinned exactly by
 * `tests/web-internal-os-offboarding-decision.test.ts`'s own containment
 * test, which this slice updates from two entries to three, by name, so the
 * allow-list only ever grows by a deliberate, visible diff.
 *
 * The controls are rendered only when the handler has this route wired AND
 * the viewer's own CURRENT access grants both EXECUTE permission and
 * `canPerformProtectedActions === true` (`canDecide`, computed by
 * `resolveAttentionView`/`canDecideProtectedDecision` from the viewer's
 * live `EffectiveAccessResolution` - mirroring the domain functions' own
 * EXECUTE + protected-action requirement). Hiding the controls is
 * presentation only: the POST route and the domain functions re-check
 * everything on submit.
 *
 * Which control (or none) renders for one row depends on `outcome`, the
 * current decision status for that row's `decisionRef` (`undefined` when
 * no decision record exists yet):
 * - `undefined` (pending): two distinct forms, Approve and Deny, each with
 *   its own required `evidenceRef` text input. This is the one deliberate,
 *   not-fully-specified design choice in this slice: two separate `<form>`
 *   elements (mirroring the offboarding controls' own deny/complete
 *   precedent) rather than one form with a radio/select choice of outcome -
 *   so the two outcomes are two distinct, unambiguous submit actions that
 *   cannot be confused by a mis-selected option.
 * - `"APPROVED"`: one form, Revoke - the only legal further transition
 *   (`reviseProtectedDecisionRecord`'s own `APPROVED -> REVOKED` rule).
 * - `"DENIED"` or `"REVOKED"`: no form. Both are terminal; nothing further
 *   can ever be decided for this `decisionRef`.
 *
 * No `expectedVersion` hidden field exists here, unlike the offboarding
 * controls: the durable protected-decision-record store's own
 * `putIfAbsentDecisionRecord`/`reviseDecisionRecord` are both internally
 * race-safe atomic claims, so there is no caller-supplied version for a
 * form to go stale against (`internal-os-attention-decision-route.ts`'s own
 * top doc comment explains this in full). The `decisionRef` travels in each
 * form's own `action` URL, never as a hidden field, matching
 * `internal-os-connection-state-controls.ts`'s own `connectionBindingId`-in-
 * the-URL convention. The session token is never put in the page.
 */

export const ATTENTION_DECISION_OUTCOMES: ReadonlyArray<ProtectedDecisionOutcome> = ["APPROVED", "DENIED", "REVOKED"];

/** Duplicated locally, matching this repository's per-module `escapeHtml` convention. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The route's own path, built from the exact decisionRef this control is
 * rendered for - the counterpart `parseAttentionDecisionPath` in
 * `internal-os-attention-decision-route.ts` parses back out.
 */
export function attentionDecisionPath(decisionRef: string): string {
  return `/os/attention/decisions/${decisionRef}`;
}

export interface AttentionDecisionControlsInput {
  readonly decisionRef: string;
  /** The current decision status for this row, or `undefined` when no record exists yet (pending). */
  readonly outcome?: ProtectedDecisionOutcome;
  readonly canDecide: boolean;
}

function evidenceField(decisionRef: string, action: string): string {
  const fieldId = `attention-decision-evidence-${action}-${escapeHtml(decisionRef)}`;
  return `<label for="${fieldId}">Evidence reference</label>
        <input type="text" id="${fieldId}" name="evidenceRef" required>`;
}

function decisionForm(decisionRef: string, path: string, action: string, outcome: ProtectedDecisionOutcome, label: string): string {
  return `<form method="post" action="${escapeHtml(path)}" class="decision-form">
        <input type="hidden" name="outcome" value="${escapeHtml(outcome)}">
        ${evidenceField(decisionRef, action)}
        <button type="submit">${escapeHtml(label)}</button>
      </form>`;
}

/**
 * Returns "" when the viewer may take no decision (no route wired, or
 * insufficient authority), or when the current outcome is terminal
 * (`"DENIED"`/`"REVOKED"`) - in either case the row stays exactly the
 * status-only row it would render without a decision boundary.
 */
export function renderAttentionDecisionControls(input: AttentionDecisionControlsInput): string {
  if (!input.canDecide) {
    return "";
  }
  const path = attentionDecisionPath(input.decisionRef);
  if (input.outcome === undefined) {
    return [
      decisionForm(input.decisionRef, path, "approve", "APPROVED", "Approve"),
      decisionForm(input.decisionRef, path, "deny", "DENIED", "Deny"),
    ].join("\n      ");
  }
  if (input.outcome === "APPROVED") {
    return decisionForm(input.decisionRef, path, "revoke", "REVOKED", "Revoke");
  }
  return "";
}
