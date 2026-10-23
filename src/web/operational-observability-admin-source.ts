import type { Organization } from "../domain/organization.js";
import type { ConnectionBinding } from "../domain/connection-authority.js";
import type { DurableConnectorConnectionStore } from "../domain/durable-connector-connection-store.js";
import { composeOperationalObservabilityView } from "../domain/operational-observability-view.js";
import type { OperationalObservabilitySource } from "./internal-os-view-state.js";

/**
 * OBS-ADMIN-SOURCE-001 (fresh current-branch + canonical-blueprint scan,
 * REV215): `OS-V0-12`'s `OperationalObservabilitySource` port and
 * `Rev195 F1`'s own threading into the real `/os/admin` route have existed
 * since those checkpoints, but no production-shaped source has ever
 * implemented the port anywhere in this repository (confirmed by
 * repo-wide inspection) - every caller leaves it unwired and the route
 * always renders `NOT_ACTIVE`. This closes that gap for exactly the one
 * dimension this repository already has a real, tenant-scoped,
 * already-validated enumeration primitive for: `ConnectionBinding`, via
 * `DurableConnectorConnectionStore.list(tenantId)`.
 *
 * Deliberately NOT a full `OperationalObservabilityView`: `task`/`quota`/
 * `pendingApprovals`/`auditEvidence` each require a per-job, per-wait, or
 * per-evidence-item CALLER-known identity to resolve (see
 * `composeOperationalObservabilityView`'s own doc comment - "every input is
 * an already-resolved... primitive the caller obtained from its own
 * accepted owner"), not an "all of them for this Organization" enumeration
 * this repository has anywhere yet. Inventing one here would repeat
 * exactly the "list customers for a tenant" problem `V2-ADMIN-SURFACE-001`
 * and `CUS-OFFBOARD-DURABLE-001` both deliberately declined to invent.
 * Leaving those four dimensions empty is not fabrication: the composer's
 * own contract already treats every dimension as independently
 * optional/empty by construction (OS-V0-12's own doc comment - "there is
 * no separate 'never bootstrapped' state here").
 *
 * No additional cross-tenant re-verification is layered on top of
 * `list(tenantId)` here, unlike `customer-offboarding-admin-source.ts`'s
 * sibling adapter: `FileDurableConnectorConnectionStore`'s own
 * `validatePersistedConnectorConnection` already fails closed on
 * "cross-tenant record contamination" on every read (a persisted record
 * whose own `binding.ownership.tenantId` disagrees with the tenant file it
 * was read from), so a second filter here would be dead, non-load-bearing
 * code - this corridor's own discipline is to add a guard only when it is
 * the one that would actually catch something.
 *
 * The one genuinely novel guard this adapter does add: a store read
 * failure (e.g. `CorruptedConnectorConnectionFileError` from a damaged
 * tenant file) must never crash the entire `/os/admin` render for every
 * Organization - `resolveOperationalObservabilityView` does not itself
 * catch exceptions from a wired source, so `resolveView` catches
 * internally and degrades to an empty-but-valid view, mirroring
 * `resolvePendingOffboardingRequestsView`'s own established "a throwing
 * source degrades to the safe default rather than propagating" precedent.
 *
 * C1 update: the deployable runtime's composition root
 * (`node-server-entrypoint.ts`) now wires this adapter, over the runtime's
 * one `FileDurableConnectorConnectionStore`, into the live `/os/admin`
 * route. The "every caller leaves it unwired" statement above describes
 * the state before C1.
 */
export function createDurableOperationalObservabilitySource(
  store: DurableConnectorConnectionStore,
): OperationalObservabilitySource {
  return {
    resolveView(organization: Organization) {
      let connections: ReadonlyArray<ConnectionBinding>;
      try {
        connections = store.list(organization.tenantId).map((stored) => stored.instance.binding);
      } catch {
        connections = [];
      }
      return composeOperationalObservabilityView({ connections });
    },
  };
}
