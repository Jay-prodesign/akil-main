/**
 * D12 (delegated-access half): the HTML controls for minting and revoking a
 * `DelegatedAccessGrant` from `/os/admin` - mirrors
 * `internal-os-offboarding-decision-controls.ts`'s own "forms live in their
 * own reviewable module" discipline exactly.
 *
 * Mint has no `delegationId` to attach a hidden field to (the server mints
 * a fresh one per submission), so unlike every other `/os` mutation form
 * here it is rendered unconditionally whenever the route is wired - any
 * authenticated staff member may delegate a bounded subset of their OWN
 * current authority (never more than they hold; `createDelegatedAccessGrant`
 * fails closed on an over-broad request). There is no durable list of
 * existing delegations to drive a per-row revoke form from, so revoke takes
 * `delegationId` as a plain text field the caller pastes in - the id a
 * successful mint confirmation page displays.
 */

/** Duplicated locally, matching this repository's per-module `escapeHtml` convention. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const DELEGATED_ACCESS_MINT_PATH = "/os/admin/delegations";
export const DELEGATED_ACCESS_REVOKE_PATH = "/os/admin/delegations/revoke";

/**
 * Rendered unconditionally once the route is wired (see this module's own
 * doc comment for why no `can...` gate is needed here - the domain
 * function itself is the gate).
 */
export function renderDelegatedAccessMintForm(): string {
  return `<form method="post" action="${DELEGATED_ACCESS_MINT_PATH}" class="decision-form">
        <label for="delegate-principal-ref">Delegate principal ref</label>
        <input type="text" id="delegate-principal-ref" name="delegatePrincipalRef" required>
        <fieldset>
          <legend>Permissions to delegate (never more than you currently hold)</legend>
          <label><input type="checkbox" name="permissions" value="READ"> READ</label>
          <label><input type="checkbox" name="permissions" value="WRITE"> WRITE</label>
          <label><input type="checkbox" name="permissions" value="EXECUTE"> EXECUTE</label>
        </fieldset>
        <label><input type="checkbox" name="canPerformProtectedActions" value="true"> Also delegate protected-action authority</label>
        <label for="delegation-project-id">Project id (optional - scopes the delegation to one project)</label>
        <input type="text" id="delegation-project-id" name="projectId">
        <label for="delegation-expires-at">Expires at (ISO 8601 timestamp)</label>
        <input type="text" id="delegation-expires-at" name="expiresAt" placeholder="2026-12-01T00:00:00.000Z" required>
        <button type="submit">Create delegation</button>
      </form>`;
}

export function renderDelegatedAccessRevokeForm(): string {
  return `<form method="post" action="${DELEGATED_ACCESS_REVOKE_PATH}" class="decision-form">
        <label for="revoke-delegation-id">Delegation id</label>
        <input type="text" id="revoke-delegation-id" name="delegationId" required>
        <label for="revoke-reason">Revocation reason</label>
        <input type="text" id="revoke-reason" name="reason" required>
        <button type="submit">Revoke delegation</button>
      </form>`;
}

/** The one-time confirmation a successful mint renders - the only place the new delegationId is ever shown. */
export function renderDelegatedAccessMintConfirmation(delegationId: string): string {
  return `
  <section aria-labelledby="delegation-created-heading" class="card">
    <h2 id="delegation-created-heading">Delegation created</h2>
    <p>Share this id with the delegate and keep it to revoke the delegation later - it is not shown again.</p>
    <p><code>${escapeHtml(delegationId)}</code></p>
    <p><a href="/os/admin">Back to Admin</a></p>
  </section>`;
}
