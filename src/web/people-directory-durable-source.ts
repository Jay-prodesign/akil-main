import type { Organization } from "../domain/organization.js";
import type { OrganizationMembership } from "../domain/organization-membership.js";
import type { DurableOrganizationMembershipStore } from "../domain/durable-organization-membership-store.js";
import type { PeopleDirectorySource } from "./internal-os-view-state.js";

/**
 * C3 People slice (whole-product gap scan 2026-10-23): the durable source
 * for the `/os/people` membership roster. OS-V0-08 showed only the viewer's
 * own membership because no "list all memberships in a tenant" source
 * existed. One does now: `FileDurableOrganizationMembershipStore.listByTenant`
 * (ORG-MEMBERSHIP-DURABLE-001). This adapter reads the same single store
 * instance the runtime already gives C1's resource-binding source and C2's
 * staff access-grant source.
 *
 * It reads `store.listByTenant(organization.tenantId)` fresh on every call
 * (under the store's own per-tenant lock). There is no cache.
 *
 * Like `createDurableConnectionsSource`, it does NOT catch store errors. A
 * read or replay failure (for example `CorruptedOrganizationMembershipFileError`
 * or `OrganizationMembershipLockTimeoutError`) propagates to
 * `resolvePeopleView`, which renders the OS ERROR page. Returning `[]` would
 * tell staff "this organization has no members", which would be false.
 *
 * It returns the stored memberships unchanged (the version number is
 * dropped). Field selection happens in `resolvePeopleView`, so the
 * allow-list does not depend on any one source implementation.
 */
export function createDurablePeopleDirectorySource(store: DurableOrganizationMembershipStore): PeopleDirectorySource {
  return {
    listMemberships(organization: Organization): ReadonlyArray<OrganizationMembership> {
      return store.listByTenant(organization.tenantId).map((stored) => stored.membership);
    },
  };
}
