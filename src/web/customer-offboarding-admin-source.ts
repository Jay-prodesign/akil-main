import type { Organization } from "../domain/organization.js";
import type { CustomerOffboardingRequest } from "../domain/customer-offboarding.js";
import type { DurableCustomerOffboardingRequestStore } from "../domain/durable-customer-offboarding-request-store.js";
import type { CustomerOffboardingAdminSource } from "./internal-os-view-state.js";

/**
 * CUS-OFFBOARD-DURABLE-001 (Brain reconciliation on PR #145, comment
 * `6164598498`, "Wire PR #155's CustomerOffboardingAdminSource to this
 * durable truth where dependency-safe, so the queue is no longer only an
 * abstract optional port"): the thin web-layer adapter that satisfies
 * `CustomerOffboardingAdminSource` (`internal-os-view-state.ts`,
 * `V2-ADMIN-SURFACE-001`) from a real `DurableCustomerOffboardingRequestStore`.
 * Deliberately trivial - it does no filtering or re-verification of its
 * own, since `resolvePendingOffboardingRequestsView` already independently
 * re-verifies every returned request's own `tenantId` and `status` before
 * ever rendering it (the Rev28 bounded-correction discipline this whole
 * corridor applies at the view-state boundary, not the source boundary).
 * This module adds no new mutation surface: it only ever reads. (C4's
 * decision routes write through the store directly, via
 * `customer-offboarding-decision-access.ts`, never through this adapter.)
 *
 * C1 update: the deployable runtime's composition root
 * (`node-server-entrypoint.ts`) now wires this adapter into the live
 * `/os/admin` route.
 */
export function createDurableCustomerOffboardingAdminSource(
  store: DurableCustomerOffboardingRequestStore,
): CustomerOffboardingAdminSource {
  return {
    listPendingRequests(organization: Organization): ReadonlyArray<CustomerOffboardingRequest> {
      return store.listPending(organization.tenantId).map((stored) => stored.request);
    },
    /**
     * C4: the same read, keeping each record's durable version so the
     * `/os/admin` decision forms can carry it as their `expectedVersion`.
     */
    listPendingRequestsWithVersion(
      organization: Organization,
    ): ReadonlyArray<{ readonly request: CustomerOffboardingRequest; readonly version: number }> {
      return store.listPending(organization.tenantId).map((stored) => ({ request: stored.request, version: stored.version }));
    },
  };
}
