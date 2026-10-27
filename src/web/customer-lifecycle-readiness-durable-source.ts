import type { CustomerRepository } from "../ports/customer-repository.js";
import type {
  DurableCustomerOffboardingRequestStore,
  StoredCustomerOffboardingRequest,
} from "../domain/durable-customer-offboarding-request-store.js";
import type { CustomerOffboardingRequest } from "../domain/customer-offboarding.js";
import { projectCustomerLifecycleReadiness } from "../domain/customer-lifecycle-readiness.js";
import type { CustomerLifecycleReadinessSource } from "./customer-lifecycle-readiness-view-state.js";

/**
 * Gap scan N1 (`WHOLE-PRODUCT-GAP-SCAN-2026-10-23.md` C9, "Resolution
 * (2026-10-27, fresh gap-scan re-triage)"): the thin web-layer adapter that
 * satisfies `CustomerLifecycleReadinessSource`
 * (`customer-lifecycle-readiness-view-state.ts`, `V2-CUST-SURFACE-001`) from
 * the two real durable stores already composed in the runtime for the
 * offboarding-decision path - `FileDurableCustomerRepository` and
 * `FileDurableCustomerOffboardingRequestStore` - no new store, no new
 * mutation surface. Mirrors `customer-offboarding-admin-source.ts`'s own
 * established "thin web-layer adapter, deliberately trivial" discipline: no
 * defensive re-validation beyond what's needed here, since
 * `resolveProtectedCustomerLifecycleReadinessView` already independently
 * re-verifies tenant/customer ownership of whatever this source returns
 * before ever rendering it (the Rev28 bounded-correction discipline this
 * corridor applies at the view-state boundary, not the source boundary).
 *
 * Never passes `offboardingExecution` to `projectCustomerLifecycleReadiness`
 * - that field is behind the separate CUS-OFFBOARD-002 owner gate and is out
 * of scope for this task.
 *
 * **Picking one request to show.** `DurableCustomerOffboardingRequestStore`
 * does not limit a customer to one request over its lifetime - a `DENIED`
 * request can be followed later by a fresh `REQUESTED` one, and so on - but
 * `projectCustomerLifecycleReadiness` accepts at most one. This adapter
 * reads `offboardingRequestStore.list(tenantId)`, filters to records whose
 * own `customerId` matches, and picks deterministically:
 *
 * 1. If any filtered record has `status === "REQUESTED"`, show it. In
 *    practice there is never more than one (nothing lets a second
 *    `REQUESTED` record coexist meaningfully, per `createRequested`'s
 *    collision-safe keying and `transitionToTerminal`'s terminal-only-once
 *    discipline) - but if more than one is somehow present, the tie is
 *    broken by the latest `requestedAt`, then the lexicographically
 *    greatest `requestId`, for full determinism.
 * 2. Otherwise, if at least one terminal (`COMPLETED`/`DENIED`) record
 *    exists, show the most recent one by `requestedAt` descending (a
 *    customer's own most recent completed/denied decision is the most
 *    relevant one to show), with the same tie-break.
 * 3. Otherwise, no `offboardingRequest` is passed at all -
 *    `projectCustomerLifecycleReadiness` already defaults
 *    `offboardingStatus` to `"NOT_REQUESTED"` in that case.
 */
function compareByRequestedAtThenRequestIdDescending(
  a: StoredCustomerOffboardingRequest,
  b: StoredCustomerOffboardingRequest,
): number {
  if (a.request.requestedAt !== b.request.requestedAt) {
    return a.request.requestedAt < b.request.requestedAt ? 1 : -1;
  }
  if (a.request.requestId !== b.request.requestId) {
    return a.request.requestId < b.request.requestId ? 1 : -1;
  }
  return 0;
}

function selectOffboardingRequestToShow(
  stored: ReadonlyArray<StoredCustomerOffboardingRequest>,
): CustomerOffboardingRequest | undefined {
  const pending = stored.filter((entry) => entry.request.status === "REQUESTED");
  if (pending.length > 0) {
    return [...pending].sort(compareByRequestedAtThenRequestIdDescending)[0]?.request;
  }

  const terminal = stored.filter((entry) => entry.request.status === "COMPLETED" || entry.request.status === "DENIED");
  if (terminal.length > 0) {
    return [...terminal].sort(compareByRequestedAtThenRequestIdDescending)[0]?.request;
  }

  return undefined;
}

export function createDurableCustomerLifecycleReadinessSource(
  customerRepository: CustomerRepository,
  offboardingRequestStore: DurableCustomerOffboardingRequestStore,
): CustomerLifecycleReadinessSource {
  return {
    getLifecycleReadiness(ownership) {
      const customer = customerRepository.findByTenantAndId({ tenantId: ownership.tenantId }, ownership.customerId);
      if (customer === undefined) {
        return undefined;
      }

      const stored = offboardingRequestStore
        .list(ownership.tenantId)
        .filter((entry) => entry.request.customerId === ownership.customerId);
      const offboardingRequest = selectOffboardingRequestToShow(stored);

      return projectCustomerLifecycleReadiness(
        offboardingRequest !== undefined ? { customer, offboardingRequest } : { customer },
      );
    },
  };
}
