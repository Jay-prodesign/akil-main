import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { CustomerOffboardingRequest } from "./customer-offboarding.js";

/**
 * CUS-OFFBOARD-002 (Brain reconciliation on PR #145, comment `6152530150`:
 * "V2 is not exhausted" — `CUS-OFFBOARD-001`'s request/decision + export
 * snapshot floor does not itself close the canonical blueprint's full
 * export/delete/offboarding/retention requirement). This module is the
 * smallest coherent dark/internal lifecycle-ENFORCEMENT package on top of
 * that decision: given an already-`COMPLETED` `CustomerOffboardingRequest`,
 * it drives a durable, idempotent, restart-safe execution record across an
 * exact inventory of the customer-scoped resource kinds that genuinely
 * exist in this repository today.
 *
 * Resource inventory (verified by direct grep against current `main`
 * before writing this module, not assumed): exactly three domain types
 * carry a `customerId` field - `project.ts`'s `Project`, `customer-
 * evidence.ts`'s `CustomerEvidenceItem`, and `commercial-order.ts`'s
 * `CommercialOrder`. None of those three modules exports a delete, redact,
 * purge, or export function for the resource it defines - each exports
 * only its own `create*` constructor. (`organization-lifecycle-archive.ts`
 * has an export/restore pair, but that is Organization-scoped, not
 * Customer-scoped, and belongs to `OS-V1-04`.)
 *
 * Given that honest finding, `CustomerResourceDispositionStatus` declares
 * exactly one reachable literal, `"BLOCKED_UNSUPPORTED"` - mirroring this
 * repository's own established "NOT_ACTIVATED capability, never fabricated"
 * discipline (OS-V1-11's RC evidence index; `CommissionLedgerStatus`'s own
 * single-literal `"UNKNOWN"`). No guessed retention period is introduced
 * anywhere in this module - there is no field that could hold one. No
 * actual delete/export/anonymization effect is performed against any
 * customer-scoped resource; this module's own genuine contribution is the
 * durable, idempotent EXECUTION RECORD around that truthful disposition -
 * the part that, unlike the disposition itself, is not yet fabricated-free
 * if left unbuilt: without it, a caller retrying a crashed offboarding
 * execution could not tell whether the first attempt's disposition record
 * (and its evidence) was ever actually produced, or double-produce a
 * second, differently-evidenced one for the same request.
 *
 * Fail-closed guard: `startCustomerOffboardingExecution` accepts only a
 * `CustomerOffboardingRequest` whose own `status` is already `"COMPLETED"`
 * - the decision gate (`completeCustomerOffboarding`, `CUS-OFFBOARD-001`)
 * is this module's sole upstream dependency, never bypassed or
 * re-implemented here.
 *
 * Idempotent/restart-safe guard: `advanceCustomerOffboardingExecution`
 * applied to an already-`"COMPLETED"` execution state is a pure, exact
 * no-op - it returns the SAME state object unchanged, including its
 * original `evidenceRef`, even if a caller (e.g. a retried crashed
 * process) supplies a different `evidenceRef` on the replay. A completed
 * execution's own evidence trail can never be silently replaced or
 * duplicated by a restart.
 */

export class InvalidCustomerOffboardingExecutionError extends Error {
  constructor(reason: string) {
    super(`Invalid CustomerOffboardingExecution operation: ${reason}`);
    this.name = "InvalidCustomerOffboardingExecutionError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidCustomerOffboardingExecutionError(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new InvalidCustomerOffboardingExecutionError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidCustomerOffboardingExecutionError(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

/**
 * The exact, verified inventory of customer-scoped resource kinds that
 * exist in this repository today - see this module's own doc comment for
 * how this list was derived. Widen it only when a genuinely new
 * customer-scoped resource type is added to `src/domain`, never
 * speculatively.
 */
export type CustomerScopedResourceKind = "PROJECT" | "CUSTOMER_EVIDENCE" | "COMMERCIAL_ORDER";

const ALL_CUSTOMER_SCOPED_RESOURCE_KINDS: ReadonlyArray<CustomerScopedResourceKind> = [
  "PROJECT",
  "CUSTOMER_EVIDENCE",
  "COMMERCIAL_ORDER",
];

/**
 * No real delete/export/anonymization capability exists for any customer-
 * scoped resource kind in this repository yet - this is the only
 * reachable literal, never a fabricated numeric/boolean success. Widen
 * this union only when a real capability is introduced for a specific
 * kind, and only for that kind.
 */
export type CustomerResourceDispositionStatus = "BLOCKED_UNSUPPORTED";

export interface CustomerResourceDisposition {
  readonly kind: CustomerScopedResourceKind;
  readonly status: CustomerResourceDispositionStatus;
  readonly reason: string;
  readonly evidenceRef: string;
}

export type CustomerOffboardingExecutionStatus = "NOT_STARTED" | "COMPLETED";

export interface CustomerOffboardingExecutionState {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly offboardingRequestId: CustomerOffboardingRequest["requestId"];
  readonly status: CustomerOffboardingExecutionStatus;
  readonly resourceDispositions: ReadonlyArray<CustomerResourceDisposition>;
}

/**
 * The only construction path for a `CustomerOffboardingExecutionState`.
 * Fails closed unless `completedRequest.status === "COMPLETED"` - this
 * module never re-derives or bypasses `CUS-OFFBOARD-001`'s own decision
 * gate.
 */
export function startCustomerOffboardingExecution(input: {
  completedRequest: CustomerOffboardingRequest;
}): CustomerOffboardingExecutionState {
  if (input.completedRequest.status !== "COMPLETED") {
    throw new InvalidCustomerOffboardingExecutionError(
      `offboarding execution can only start from a COMPLETED request (got status "${input.completedRequest.status}") - the decision gate is never bypassed or re-derived here`,
    );
  }
  return {
    tenantId: input.completedRequest.tenantId,
    customerId: input.completedRequest.customerId,
    offboardingRequestId: input.completedRequest.requestId,
    status: "NOT_STARTED",
    resourceDispositions: [],
  };
}

/**
 * Advances a `NOT_STARTED` execution to `COMPLETED`, producing one
 * `CustomerResourceDisposition` per entry in `ALL_CUSTOMER_SCOPED_
 * RESOURCE_KINDS`, each truthfully `"BLOCKED_UNSUPPORTED"`. Idempotent and
 * restart-safe: calling this again on an already-`COMPLETED` state is an
 * exact no-op (the original state, including its original `evidenceRef`,
 * is returned unchanged) rather than re-computing a second, possibly
 * differently-evidenced disposition set for the same request.
 */
export function advanceCustomerOffboardingExecution(input: {
  state: CustomerOffboardingExecutionState;
  evidenceRef: unknown;
}): CustomerOffboardingExecutionState {
  if (input.state.status === "COMPLETED") {
    return input.state;
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  const resourceDispositions: ReadonlyArray<CustomerResourceDisposition> = ALL_CUSTOMER_SCOPED_RESOURCE_KINDS.map(
    (kind) => ({
      kind,
      status: "BLOCKED_UNSUPPORTED",
      reason: `no delete/export/anonymization capability exists for ${kind} resources in this repository yet`,
      evidenceRef,
    }),
  );
  return {
    ...input.state,
    status: "COMPLETED",
    resourceDispositions,
  };
}
