import type { CustomerOffboardingRequestId } from "../domain/customer-offboarding.js";

/**
 * C4 (whole-product gap scan 2026-10-23, first slice): the HTML controls
 * for the first mutation on the staff `/os` surface - deny or complete one
 * pending customer-offboarding request from `/os/admin`.
 *
 * This module is the only place in `src/web/` that renders a form or a
 * button element. Until C4 the internal OS rendered no write affordance at all
 * (OS-V0-08 "Phase A"). That rule still holds for `internal-os-render.ts`
 * and every read-only destination. The one exception is these two forms,
 * kept in their own module so the exception is in one reviewable place
 * (pinned by `tests/web-internal-os-offboarding-decision.test.ts`).
 *
 * The forms are rendered only when all three hold:
 * - the handler has a decision boundary wired (`customerOffboardingDecision`);
 * - the row carries the stored version it was read at;
 * - the viewer's own current access permits that decision (`canDeny` is
 *   WRITE, `canComplete` is WRITE plus protected-action authority).
 * Hiding a control is presentation only. The POST route and the domain
 * functions re-check everything on submit.
 *
 * Each form carries the request id and the version the page was rendered
 * from as hidden fields. The session token is never put in the page. The
 * store rejects a stale version (`CustomerOffboardingRequestVersionConflictError`),
 * so a form left open while someone else decides the request fails closed
 * with 409 instead of overwriting.
 */

export const OFFBOARDING_COMPLETE_PATH = "/os/admin/offboarding/complete";
export const OFFBOARDING_DENY_PATH = "/os/admin/offboarding/deny";

/** Duplicated locally, matching this repository's per-module `escapeHtml` convention. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface OffboardingDecisionControlsInput {
  readonly requestId: CustomerOffboardingRequestId;
  readonly version: number;
  readonly canDeny: boolean;
  readonly canComplete: boolean;
}

function hiddenFields(requestId: string, version: number): string {
  return `<input type="hidden" name="requestId" value="${escapeHtml(requestId)}">
        <input type="hidden" name="expectedVersion" value="${escapeHtml(String(version))}">`;
}

/**
 * Returns "" when the viewer may take neither decision, so the row stays
 * exactly the read-only row it was before C4.
 */
export function renderOffboardingDecisionControls(input: OffboardingDecisionControlsInput): string {
  const controls: string[] = [];
  if (input.canComplete) {
    controls.push(`<form method="post" action="${OFFBOARDING_COMPLETE_PATH}" class="decision-form">
        ${hiddenFields(input.requestId, input.version)}
        <button type="submit">Complete offboarding</button>
      </form>`);
  }
  if (input.canDeny) {
    const reasonId = `deny-reason-${escapeHtml(input.requestId)}`;
    controls.push(`<form method="post" action="${OFFBOARDING_DENY_PATH}" class="decision-form">
        ${hiddenFields(input.requestId, input.version)}
        <label for="${reasonId}">Denial reason</label>
        <input type="text" id="${reasonId}" name="reason" required>
        <button type="submit">Deny offboarding</button>
      </form>`);
  }
  return controls.join("\n      ");
}
