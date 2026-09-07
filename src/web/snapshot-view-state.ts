import type { ProjectOwnershipRef } from "../domain/project-ownership.js";
import type { ClientProjectSnapshot } from "../domain/client-project-snapshot.js";
import type { SessionContext, TenantContext } from "./session-context.js";
import { requireTenantOwnership, TenantScopeMismatchError } from "./route-guard.js";

/**
 * V2-APP-001 (IN SCOPE G): the only port this shell uses to obtain a
 * customer-safe projection. It returns the already-built, already-
 * customer-safe `ClientProjectSnapshot` (V2-CDO-005) or `undefined` -
 * never a raw domain record. No implementation of this port may reach
 * past `ClientProjectSnapshot` into `OutcomeJob`/`ProjectPlanVersion`/
 * `ConnectionBinding` internals to satisfy a rendering convenience (A9).
 */
export interface ClientProjectSnapshotSource {
  getSnapshot(ownership: ProjectOwnershipRef): ClientProjectSnapshot | undefined;
}

/**
 * V2-APP-001 (IN SCOPE H): the deterministic, closed set of states the
 * shell can ever be in for one protected route. `READY` is the only kind
 * that carries a snapshot - every other kind is structurally incapable of
 * being mistaken for successful customer state (A11).
 */
export type ShellViewState =
  | { readonly kind: "FORBIDDEN_TENANT_SCOPE" }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "ERROR"; readonly reason: string }
  | { readonly kind: "READY"; readonly snapshot: ClientProjectSnapshot };

function tenantContextFromOwnership(ownership: ProjectOwnershipRef): TenantContext {
  return {
    tenantId: ownership.tenantId,
    customerId: ownership.customerId,
    ...(ownership.projectId !== undefined ? { projectId: ownership.projectId } : {}),
  };
}

/**
 * V2-APP-001 A10: tenant/project mismatch fails BEFORE the snapshot
 * source is ever queried - `requireTenantOwnership` runs first and this
 * function returns `FORBIDDEN_TENANT_SCOPE` without calling
 * `source.getSnapshot` at all when it throws. A caller that already
 * failed `requireSession` should never reach this function; it is not
 * re-checked here (that failure mode is handled by `requireSession`
 * before this function is invoked - see `request-handler.ts`).
 *
 * Rev62 AUD-V2-02 correction: checking `input.session` against
 * `input.requestedOwnership` proves the caller is allowed to see *that*
 * scope - it proves nothing about what `source.getSnapshot` actually
 * handed back. `resolveProtectedTeamAttentionView` (V3, corrected under
 * Rev28) already independently re-verifies its source's returned
 * projection scope before READY; this port never received the same
 * correction. The returned `snapshot.ownership` is therefore
 * independently verified against `input.requestedOwnership` (including
 * `serviceRef`) before it is ever wrapped in `READY`; any mismatch
 * resolves `NOT_FOUND` (the same honest "no snapshot for this request"
 * outcome already used when the source has nothing at all) rather than
 * leaking a foreign-scope snapshot from a faulty/compromised source.
 */
export function resolveProtectedSnapshotView(input: {
  session: SessionContext;
  requestedOwnership: ProjectOwnershipRef;
  source: ClientProjectSnapshotSource;
}): ShellViewState {
  try {
    requireTenantOwnership(input.session, tenantContextFromOwnership(input.requestedOwnership));
  } catch (error) {
    if (error instanceof TenantScopeMismatchError) {
      return { kind: "FORBIDDEN_TENANT_SCOPE" };
    }
    throw error;
  }

  let snapshot: ClientProjectSnapshot | undefined;
  try {
    snapshot = input.source.getSnapshot(input.requestedOwnership);
  } catch (error) {
    return { kind: "ERROR", reason: error instanceof Error ? error.message : "unknown error" };
  }

  if (snapshot === undefined) {
    return { kind: "NOT_FOUND" };
  }

  if (
    snapshot.ownership.tenantId !== input.requestedOwnership.tenantId ||
    snapshot.ownership.customerId !== input.requestedOwnership.customerId ||
    snapshot.ownership.projectId !== input.requestedOwnership.projectId ||
    snapshot.ownership.serviceRef !== input.requestedOwnership.serviceRef
  ) {
    return { kind: "NOT_FOUND" };
  }

  return { kind: "READY", snapshot };
}
