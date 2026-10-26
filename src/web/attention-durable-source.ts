import type { Organization } from "../domain/organization.js";
import type { DurableConnectorConnectionStore, StoredConnectorConnection } from "../domain/durable-connector-connection-store.js";
import type {
  DurableProtectedDecisionWaitListing,
  StoredProtectedDecisionWait,
} from "../domain/durable-protected-decision-wait-store.js";
import type { DurableProtectedDecisionRecordStore } from "../domain/durable-protected-decision-record-store.js";
import type { ProtectedDecisionRecord } from "../domain/protected-decision-record.js";
import type { AttentionSource } from "./internal-os-view-state.js";

/**
 * C3 Attention slice (whole-product gap scan 2026-10-23): the durable source
 * for the dedicated `/os/attention` destination. OS-V0-08 left that
 * destination `NOT_ACTIVE` because no backing data source existed. Two of
 * V4-OPS-001's deferred attention families now have one:
 *
 * - credential/access problem: `FileDurableConnectorConnectionStore.list`,
 *   the same single store instance `/os/connections` and `/os/admin`
 *   already read;
 * - customer approval required: `FileDurableProtectedDecisionWaitStore`'s
 *   bounded per-tenant `listByTenant` (`DurableProtectedDecisionWaitListing`).
 *
 * Both are read fresh on every call. There is no cache.
 *
 * Like `createDurableConnectionsSource`, this adapter does NOT catch store
 * errors. A read or replay failure in either store (for example
 * `CorruptedConnectorConnectionFileError` or
 * `CorruptedProtectedDecisionWaitLineError`) propagates to
 * `resolveAttentionView`, which renders the OS ERROR page. Returning `[]`
 * would tell staff "nothing needs attention", which would be false.
 *
 * It returns the stored records unchanged. Family selection (DEGRADED/
 * REVOKED, outstanding waits) and field selection happen in
 * `resolveAttentionView`, so they do not depend on any one source
 * implementation.
 *
 * C4 slice 3: `recordStore`, when given, backs the optional
 * `getProtectedDecisionRecord` method - the SAME
 * `DurableProtectedDecisionRecordStore` instance the attention decision
 * POST route (`internal-os-attention-decision-route.ts`) writes through,
 * so a decision just recorded through that route is immediately visible
 * here on the next read (no cache on either side). Omitting `recordStore`
 * keeps this source's pre-slice-3 shape exactly - every "customer approval
 * required" row then renders with no decision status and no form, per
 * `AttentionSource.getProtectedDecisionRecord`'s own optional-method
 * contract. Like the other two reads, a lookup failure (for example
 * `CorruptedProtectedDecisionRecordLineError`) propagates uncaught.
 */
export function createDurableAttentionSource(
  connectionStore: DurableConnectorConnectionStore,
  waitStore: DurableProtectedDecisionWaitListing,
  recordStore?: DurableProtectedDecisionRecordStore,
): AttentionSource {
  return {
    listConnections(organization: Organization): ReadonlyArray<StoredConnectorConnection> {
      return connectionStore.list(organization.tenantId);
    },
    listProtectedDecisionWaits(organization: Organization): ReadonlyArray<StoredProtectedDecisionWait> {
      return waitStore.listByTenant(organization.tenantId);
    },
    ...(recordStore !== undefined
      ? {
          getProtectedDecisionRecord(organization: Organization, decisionRef: string): ProtectedDecisionRecord | undefined {
            return recordStore.getDecisionRecord(organization.tenantId, decisionRef);
          },
        }
      : {}),
  };
}
