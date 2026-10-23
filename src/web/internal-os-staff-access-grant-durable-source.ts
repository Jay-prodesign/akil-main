import { createTenantScope, type TenantScope } from "../domain/tenant-scope.js";
import type { OrganizationMembership } from "../domain/organization-membership.js";
import type { DurableStaffAccessGrantStore } from "../domain/durable-staff-access-grant-store.js";
import type { DurableOrganizationMembershipStore } from "../domain/durable-organization-membership-store.js";
import type { StaffAccessGrant } from "./internal-os-access.js";
import { createCurrentOrganizationInternalOsRequestHandler } from "./internal-os-organization-durable-source.js";
import type { InternalOsRequestHandler } from "./internal-os-request-handler.js";
import { renderInternalOsPage } from "./internal-os-render.js";

/**
 * C2 (whole-product gap scan 2026-10-23): the durable source for the
 * `StaffAccessGrant[]` that `requireInternalOsAccess` takes as
 * caller-supplied evidence. `internal-os-access.ts` is unchanged and still
 * has no persistence of its own. This module is the caller that supplies
 * its `grants`, from two durable stores, read fresh on every call.
 *
 * Returns the CURRENT grants each time it is called. A read or replay
 * failure in either store throws. It is never relabeled as "no grants",
 * which is the same rule as `InternalOsOrganizationSource`
 * (CLIENT-SNAPSHOT-DURABLE-001's Brain F1 correction).
 */
export interface InternalOsStaffAccessGrantSource {
  listCurrentGrants(): ReadonlyArray<StaffAccessGrant>;
}

/**
 * Joins `DurableStaffAccessGrantStore` records with the current
 * `DurableOrganizationMembershipStore` records of one tenant (the
 * configured internal-OS organization's tenant).
 *
 * - A membership with no grant record is absent from the result. Nothing
 *   is synthesized for it, and no permission is derived from its `role`
 *   or from anything else.
 * - A grant record whose membership does not exist in the membership store
 *   is also absent. It cannot be bound to any staff session, because
 *   `requireMatchingStaffMembership` only matches the `membership` objects
 *   it is given, and there is none to give.
 * - The membership is passed through as currently stored, including a
 *   `REVOKED` one. This adapter does not re-implement the currentness gate:
 *   `requireMatchingStaffMembership` and `resolveEffectiveOrganizationAccess`
 *   already refuse a revoked membership.
 * - `authority`, `assignments` and `roleContext` are the record's own
 *   explicitly written values, passed through unchanged.
 *
 * Both stores are read on every call, even when one is empty, so a
 * corrupted file in either one always surfaces as an error.
 *
 * `tenantId` is validated through `createTenantScope` at construction, so
 * a malformed configured tenant fails at boot.
 */
export function createDurableInternalOsStaffAccessGrantSource(
  grantStore: DurableStaffAccessGrantStore,
  membershipStore: DurableOrganizationMembershipStore,
  ref: { readonly tenantId: string },
): InternalOsStaffAccessGrantSource {
  const tenantScope: TenantScope = createTenantScope(ref.tenantId);
  return {
    listCurrentGrants(): ReadonlyArray<StaffAccessGrant> {
      const storedGrants = grantStore.listByTenant(tenantScope.tenantId);
      const membershipsById = new Map<OrganizationMembership["membershipId"], OrganizationMembership>(
        membershipStore.listByTenant(tenantScope.tenantId).map((stored) => [stored.membership.membershipId, stored.membership]),
      );
      const grants: StaffAccessGrant[] = [];
      for (const { grant } of storedGrants) {
        const membership = membershipsById.get(grant.membershipId);
        if (membership === undefined) {
          continue;
        }
        grants.push({
          membership,
          authority: grant.authority,
          assignments: grant.assignments,
          ...(grant.roleContext !== undefined ? { roleContext: grant.roleContext } : {}),
        });
      }
      return grants;
    },
  };
}

/**
 * Composes the existing, unmodified
 * `createCurrentOrganizationInternalOsRequestHandler` (which in turn wraps
 * the unmodified `createInternalOsRequestHandler`) with a per-request
 * grant lookup. All of that handler's logic, including
 * `requireInternalOsAccess`, runs unchanged; it is only handed the grants
 * read for this request.
 *
 * - The source throws (for example, a corrupted grant or membership file):
 *   renders the existing `ERROR` page (500, no detail rendered). Never
 *   `FORBIDDEN`, which would present data corruption as "this person has
 *   no access", and never a crash of the whole process.
 * - The source returns grants (possibly none): the request continues with
 *   exactly those grants. With none, every authenticated staff session is
 *   denied by `requireInternalOsAccess` (403).
 *
 * Grants are read before the Organization is resolved, matching how the
 * Organization itself is read before the session is checked: a storage
 * failure surfaces on every `/os` request, authenticated or not.
 */
export function createCurrentStaffAccessGrantsInternalOsRequestHandler(
  deps: Omit<Parameters<typeof createCurrentOrganizationInternalOsRequestHandler>[0], "grants"> & {
    readonly grantSource: InternalOsStaffAccessGrantSource;
  },
): InternalOsRequestHandler {
  const { grantSource, ...handlerDeps } = deps;
  return (request) => {
    let grants: ReadonlyArray<StaffAccessGrant>;
    try {
      grants = grantSource.listCurrentGrants();
    } catch {
      const rendered = renderInternalOsPage({ kind: "ERROR", reason: "internal OS staff access grants could not be read" });
      return { status: rendered.status, headers: { "content-type": rendered.contentType }, body: rendered.html };
    }
    return createCurrentOrganizationInternalOsRequestHandler({ ...handlerDeps, grants })(request);
  };
}
