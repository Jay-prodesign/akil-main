import type { Organization } from "../domain/organization.js";
import type { OrganizationServicePrincipal } from "../domain/organization-service-principal.js";
import type { DurableOrganizationServicePrincipalStore } from "../domain/durable-organization-service-principal-store.js";
import type { WorkersRosterSource } from "./internal-os-view-state.js";

/**
 * Gap scan N2: the durable source for the `/os/ai-capabilities` service-
 * principal roster. Mirrors `people-directory-durable-source.ts`'s exact
 * pattern - a thin adapter over `FileDurableOrganizationServicePrincipalStore.listByTenant`
 * (ORG-SERVICE-PRINCIPAL-DURABLE-001), already composed in the runtime and
 * already used by `createDurableOrganizationResourceBindingSource`.
 *
 * It reads `store.listByTenant(organization.tenantId)` fresh on every call
 * (under the store's own per-tenant lock). There is no cache.
 *
 * Like `createDurablePeopleDirectorySource`, it does NOT catch store
 * errors. A read or replay failure (for example
 * `CorruptedOrganizationServicePrincipalFileError` or
 * `OrganizationServicePrincipalLockTimeoutError`) propagates to
 * `resolveWorkersRosterView`, which renders the OS ERROR page. Returning
 * `[]` would tell staff "this organization has no service principals",
 * which would be false.
 *
 * It returns the stored service principals unchanged (the version number
 * is dropped). Field selection happens in `resolveWorkersRosterView`, so
 * the allow-list does not depend on any one source implementation.
 */
export function createDurableWorkersRosterSource(
  store: DurableOrganizationServicePrincipalStore,
): WorkersRosterSource {
  return {
    listServicePrincipals(organization: Organization): ReadonlyArray<OrganizationServicePrincipal> {
      return store.listByTenant(organization.tenantId).map((stored) => stored.servicePrincipal);
    },
  };
}
