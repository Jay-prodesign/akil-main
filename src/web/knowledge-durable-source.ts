import type { Organization } from "../domain/organization.js";
import type { EvidenceReference } from "../domain/evidence.js";
import type { DurableEvidenceReferenceStore } from "../domain/durable-evidence-reference-store.js";
import type { KnowledgeSource } from "./internal-os-view-state.js";

/**
 * C3 Knowledge slice (whole-product gap scan 2026-10-23): the durable source
 * for the dedicated `/os/knowledge` destination. OS-V0-08 left that
 * destination `NOT_ACTIVE` because no backing data source existed yet. One
 * does now: `FileDurableEvidenceReferenceStore.listByTenant`
 * (KNOWLEDGE-EVIDENCE-DURABLE-001). This adapter reads the same single store
 * instance the runtime already gives C1's resource-binding source.
 *
 * It reads `store.listByTenant(organization.tenantId)` fresh on every call
 * (under the store's own per-tenant lock). There is no cache.
 *
 * Like `createDurableConnectionsSource`, it does NOT catch store errors. A
 * read or replay failure (for example `CorruptedEvidenceReferenceFileError`
 * or `EvidenceReferenceLockTimeoutError`) propagates to
 * `resolveKnowledgeView`, which renders the OS ERROR page. Returning `[]`
 * would tell staff "this organization has recorded no evidence", which
 * would be false.
 *
 * It returns the stored evidence references unchanged. Field selection
 * happens in `resolveKnowledgeView`, so the allow-list (which leaves out
 * `sourceLocator`) does not depend on any one source implementation.
 */
export function createDurableKnowledgeSource(store: DurableEvidenceReferenceStore): KnowledgeSource {
  return {
    listEvidenceReferences(organization: Organization): ReadonlyArray<EvidenceReference> {
      return store.listByTenant(organization.tenantId).map((stored) => stored.evidence);
    },
  };
}
