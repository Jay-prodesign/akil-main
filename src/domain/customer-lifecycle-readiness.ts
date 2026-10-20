import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { CustomerOffboardingRequest } from "./customer-offboarding.js";
import type { CustomerOffboardingExecutionState } from "./customer-offboarding-execution.js";

/**
 * V2-CUST-SURFACE-001 (Brain reconciliation on PR #145, comment
 * `6155840409`): the canonical V2 blueprint requires a customer-facing
 * surface for "customer lifecycle/offboarding/backup readiness". This
 * module composes the already-accepted `CustomerOffboardingRequest`
 * (`CUS-OFFBOARD-001`) and `CustomerOffboardingExecutionState`
 * (`CUS-OFFBOARD-002`) into one customer-safe read-only view, mirroring
 * `subscription-usage-status.ts`'s own "pure composition over already-
 * canonical domain projections, fail closed on cross-scope mismatch, never
 * fabricate" discipline.
 *
 * `backupReadiness` is honestly `"AVAILABLE"` whenever this composition
 * runs at all - `customer-lifecycle-backup.ts` (`CUS-BACKUP-001`) always
 * provides `exportCustomerLifecycleSnapshot`/`restoreCustomerLifecycleFrom
 * Snapshot` for any `Customer`, so there is no reachable `"NOT_CONFIGURED"`
 * state for it today. The literal is still declared as its own closed
 * union (not a bare boolean) so a future genuinely-absent-capability state
 * never requires a breaking type change, mirroring this repository's own
 * "declare the honest literal before you need it" precedent.
 *
 * `offboardingStatus` defaults to `"NOT_REQUESTED"` when no
 * `CustomerOffboardingRequest` is supplied - never inferred, never
 * defaulted to anything else. When a request IS supplied, its own
 * `status` is read through verbatim (`REQUESTED"`/`"COMPLETED"`/
 * `"DENIED"`). `offboardingExecutionStatus` is present only when an
 * execution state is ALSO supplied (which itself requires the request to
 * already be `COMPLETED`, per `CUS-OFFBOARD-002`'s own gate) - never
 * fabricated when no execution has started.
 *
 * Fail-closed ownership check: when both a `customer` and an
 * `offboardingRequest` are supplied, the request's own `(tenantId,
 * customerId)` must exactly match the customer's - a foreign or
 * mismatched request can never compose into this customer's readiness
 * view, mirroring every other composition boundary in this repository.
 * The same check applies between `offboardingRequest` and
 * `offboardingExecution` when both are supplied (the execution state
 * already enforces this internally via its own `offboardingRequestId`,
 * but this module re-verifies it independently rather than trusting the
 * caller wired matching objects).
 */
export class InvalidCustomerLifecycleReadinessError extends Error {
  constructor(reason: string) {
    super(`Invalid customer lifecycle readiness composition: ${reason}`);
    this.name = "InvalidCustomerLifecycleReadinessError";
  }
}

export type CustomerOffboardingReadinessStatus = "NOT_REQUESTED" | "REQUESTED" | "COMPLETED" | "DENIED";

/**
 * Always `"AVAILABLE"` today - see this module's own doc comment. Declared
 * as a closed union, not a bare boolean, so a genuinely-absent-capability
 * state can be added later without a breaking type change.
 */
export type CustomerBackupReadinessStatus = "AVAILABLE";

export interface CustomerLifecycleReadinessProjection {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly offboardingStatus: CustomerOffboardingReadinessStatus;
  readonly offboardingExecutionStatus?: CustomerOffboardingExecutionState["status"];
  readonly backupReadiness: CustomerBackupReadinessStatus;
}

export function projectCustomerLifecycleReadiness(input: {
  customer: Customer;
  offboardingRequest?: CustomerOffboardingRequest;
  offboardingExecution?: CustomerOffboardingExecutionState;
}): CustomerLifecycleReadinessProjection {
  const { customer, offboardingRequest, offboardingExecution } = input;

  if (
    offboardingRequest !== undefined &&
    (offboardingRequest.tenantId !== customer.tenantId || offboardingRequest.customerId !== customer.customerId)
  ) {
    throw new InvalidCustomerLifecycleReadinessError(
      "offboardingRequest must belong to the exact same tenant/customer as the given customer - a foreign or mismatched request can never compose into this customer's readiness view",
    );
  }

  if (offboardingExecution !== undefined) {
    if (offboardingRequest === undefined) {
      throw new InvalidCustomerLifecycleReadinessError(
        "offboardingExecution can only be composed alongside the offboardingRequest it was started from - never on its own",
      );
    }
    if (
      offboardingExecution.tenantId !== customer.tenantId ||
      offboardingExecution.customerId !== customer.customerId ||
      offboardingExecution.offboardingRequestId !== offboardingRequest.requestId
    ) {
      throw new InvalidCustomerLifecycleReadinessError(
        "offboardingExecution must belong to the exact same tenant/customer and reference the exact same offboardingRequest - a foreign or mismatched execution state can never compose into this customer's readiness view",
      );
    }
  }

  return {
    tenantId: customer.tenantId,
    customerId: customer.customerId,
    offboardingStatus: offboardingRequest?.status ?? "NOT_REQUESTED",
    ...(offboardingExecution !== undefined ? { offboardingExecutionStatus: offboardingExecution.status } : {}),
    backupReadiness: "AVAILABLE",
  };
}
