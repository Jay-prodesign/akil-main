import type { Organization } from "../domain/organization.js";
import type {
  DurableConnectorConnectionStore,
  StoredConnectorConnection,
} from "../domain/durable-connector-connection-store.js";
import type { ConnectionsSource } from "./internal-os-view-state.js";

/**
 * C3 (whole-product gap scan 2026-10-23): the durable source for the
 * dedicated `/os/connections` destination. OS-V0-08 left that destination
 * `NOT_ACTIVE` because no backing data source existed yet. One does now:
 * `FileDurableConnectorConnectionStore` (CONN-001), the same single store
 * instance C1 already wires into `/os/admin`'s observability card.
 *
 * It reads `store.list(organization.tenantId)` fresh on every call. There
 * is no cache.
 *
 * Unlike `createDurableOperationalObservabilitySource`, this adapter does
 * NOT catch store errors. A read or replay failure (for example
 * `CorruptedConnectorConnectionFileError`, or a lock timeout) propagates to
 * `resolveConnectionsView`, which renders the OS ERROR page. That follows
 * the `ConnectionsSource` contract and C1/C2's rule that a storage error is
 * never relabeled as absence. On this page an empty list means "this
 * organization has no connections", so returning `[]` on a failed read
 * would tell staff something false.
 *
 * Secret masking does not happen here. This adapter returns the stored
 * records unchanged, and `resolveConnectionsView` passes them through
 * CONN-001's `buildIntegrationsAdminView` before anything is rendered. That
 * way the masking does not depend on any one source implementation.
 */
export function createDurableConnectionsSource(store: DurableConnectorConnectionStore): ConnectionsSource {
  return {
    listConnections(organization: Organization): ReadonlyArray<StoredConnectorConnection> {
      return store.list(organization.tenantId);
    },
  };
}
