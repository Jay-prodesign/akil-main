import type { ConnectionState } from "../domain/connection-authority.js";
import type { IntegrationConnectionSummary } from "../domain/integration-admin-view.js";

/**
 * C4 slice 2 (gap scan 2026-10-23, second `/os` mutation): the HTML control
 * for the second mutation on the staff `/os` surface - change one connector
 * connection's lifecycle state from `/os/connections`.
 *
 * This module is one of exactly two places in `src/web/` that render a
 * form or a button element, the other being
 * `internal-os-offboarding-decision-controls.ts` (C4 slice 1). Every other
 * module, and every other read-only destination, still renders no write
 * affordance at all (OS-V0-08 "Phase A"'s original discipline) - the
 * allow-list of modules permitted to do otherwise is pinned exactly by
 * `tests/web-internal-os-offboarding-decision.test.ts`'s own containment
 * test, which this slice updates from one entry to two, by name, so the
 * allow-list only ever grows by a deliberate, visible diff.
 *
 * The control is rendered only when the handler has this route wired AND
 * the viewer's own CURRENT access grants both EXECUTE permission and
 * `canPerformProtectedActions === true` (`canMutateState`, computed by
 * `resolveConnectionsView`/`canMutateConnectorConnectionState` from the
 * viewer's live `EffectiveAccessResolution` - mirroring the domain
 * mutation's own gate, `mutateConnectorConnectionStateAsAdmin`'s EXECUTE +
 * protected-action requirement). Hiding the control is presentation only:
 * the POST route and the domain function re-check everything on submit,
 * including the OWNER/ADMIN curated access role this module cannot see and
 * does not attempt to predict.
 *
 * Unlike the offboarding controls, this form carries no hidden
 * `expectedVersion` field - the wrapped domain function always re-reads
 * the connection's current version fresh immediately before writing, so
 * there is no caller-supplied version for a form to go stale against. The
 * connectionBindingId travels in the form's own `action` URL, never as a
 * hidden field, matching this route's own path convention
 * (`POST /os/connections/<connectionBindingId>/state`). The session token
 * is never put in the page.
 */

export const CONNECTION_STATE_OPTIONS: ReadonlyArray<ConnectionState> = [
  "REQUESTED",
  "CONNECTED_UNVERIFIED",
  "VERIFIED",
  "DEGRADED",
  "REVOKED",
  "HANDOVER_COMPLETE",
];

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
 * The route's own path, built from the exact connectionBindingId this
 * control is rendered for - the counterpart `parseConnectorConnectionStatePath`
 * in `internal-os-connector-connection-decision-route.ts` parses back out.
 */
export function connectorConnectionStatePath(connectionBindingId: string): string {
  return `/os/connections/${connectionBindingId}/state`;
}

export interface ConnectorConnectionStateControlsInput {
  readonly connectionBindingId: IntegrationConnectionSummary["connectionBindingId"];
  readonly canMutateState: boolean;
}

/**
 * Returns "" when the viewer may not take this action, so the row stays
 * exactly the read-only row it was before this slice.
 */
export function renderConnectorConnectionStateControls(input: ConnectorConnectionStateControlsInput): string {
  if (!input.canMutateState) {
    return "";
  }
  const path = connectorConnectionStatePath(input.connectionBindingId);
  const selectId = `connection-state-${escapeHtml(input.connectionBindingId)}`;
  const options = CONNECTION_STATE_OPTIONS.map(
    (state) => `<option value="${escapeHtml(state)}">${escapeHtml(state)}</option>`,
  ).join("\n          ");
  return `<form method="post" action="${escapeHtml(path)}" class="connection-state-form">
        <label for="${selectId}">Change state</label>
        <select id="${selectId}" name="to">
          ${options}
        </select>
        <button type="submit">Update</button>
      </form>`;
}
