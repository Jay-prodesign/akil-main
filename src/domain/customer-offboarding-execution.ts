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
 * inventory of the customer-scoped resource kinds that genuinely exist in
 * this repository today.
 *
 * Inventory correction (PR #170 comment `6354570236` reclassification,
 * 2026-10-23): the original inventory's claim of "exactly three" domain
 * types carrying `customerId` was false — re-verified by direct grep
 * against current `main`, roughly thirty domain types carry `customerId`,
 * including `OutcomeJob`, `OutcomeJobExecutionRunState`, plan-admission
 * records, `EvidenceReference`, `AuditEvent`, and `BillingReferenceRecord`.
 * The inventory below is widened to name the durable data classes that
 * genuinely carry customer-scoped state at rest on `main` today (see the
 * decision packet at `docs/exec-plans/active/CUS-OFFBOARD-002-DECISION-
 * PACKET.md` for the full accounting) — still not exhaustive of every
 * `customerId`-bearing type, but no longer falsely claiming completeness
 * either. `PROJECT`, `CUSTOMER_EVIDENCE`, and `COMMERCIAL_ORDER` remain the
 * original three; `OUTCOME_JOB`, `OUTCOME_JOB_EXECUTION`, `PLAN_ADMISSION`,
 * `EVIDENCE_REFERENCE`, `AUDIT_EVENT`, and `BILLING_REFERENCE` are added.
 * None of the underlying modules exports a delete, redact, or purge
 * function for the resource it defines. (`organization-lifecycle-
 * archive.ts` has an export/restore pair, but that is Organization-scoped,
 * not Customer-scoped, and belongs to `OS-V1-04`.)
 *
 * `CustomerResourceDispositionStatus` declares two reachable literals:
 * `"BLOCKED_UNSUPPORTED"` (the truthful default for every kind - no real
 * delete/export/anonymization capability exists for it yet, mirroring this
 * repository's own established "NOT_ACTIVATED capability, never
 * fabricated" discipline) and `"EXPORTED"`, reachable ONLY for the
 * `"PROJECT"` kind and only when the caller supplies real, already-
 * produced export evidence from `customer-lifecycle-backup.ts`'s
 * `exportCustomerProjectsSnapshot` (CUS-BACKUP-001) - this module never
 * imports `project.ts`/`durable-project-store.ts` itself (preserved
 * boundary-scan discipline below), so it cannot perform the export; it can
 * only record, via a caller-supplied evidence pointer, that a real one
 * already happened elsewhere. No guessed retention period is introduced
 * anywhere in this module - there is no field that could hold one. No
 * delete or anonymization effect is performed against any customer-scoped
 * resource; this module's own genuine contribution is the durable,
 * idempotent EXECUTION RECORD around these truthful dispositions - the
 * part that, unlike the dispositions themselves, is not yet fabricated-
 * free if left unbuilt: without it, a caller retrying a crashed offboarding
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
 * The verified inventory of customer-scoped resource kinds named in this
 * module's own doc comment (widened 2026-10-23, see the inventory
 * correction above). Widen it only when a genuinely new customer-scoped
 * resource type is added to `src/domain`, never speculatively.
 */
export type CustomerScopedResourceKind =
  | "PROJECT"
  | "CUSTOMER_EVIDENCE"
  | "COMMERCIAL_ORDER"
  | "OUTCOME_JOB"
  | "OUTCOME_JOB_EXECUTION"
  | "PLAN_ADMISSION"
  | "EVIDENCE_REFERENCE"
  | "AUDIT_EVENT"
  | "BILLING_REFERENCE";

const ALL_CUSTOMER_SCOPED_RESOURCE_KINDS: ReadonlyArray<CustomerScopedResourceKind> = [
  "PROJECT",
  "CUSTOMER_EVIDENCE",
  "COMMERCIAL_ORDER",
  "OUTCOME_JOB",
  "OUTCOME_JOB_EXECUTION",
  "PLAN_ADMISSION",
  "EVIDENCE_REFERENCE",
  "AUDIT_EVENT",
  "BILLING_REFERENCE",
];

/**
 * `"BLOCKED_UNSUPPORTED"` is the truthful default for every kind - no real
 * delete/export/anonymization capability exists for it yet, never a
 * fabricated numeric/boolean success. `"EXPORTED"` is reachable ONLY for
 * `"PROJECT"` (see `advanceCustomerOffboardingExecution`'s own structural
 * enforcement below) - widen this union further only when a real
 * capability is introduced for a specific kind, and only for that kind.
 */
export type CustomerResourceDispositionStatus = "BLOCKED_UNSUPPORTED" | "EXPORTED";

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
 * RESOURCE_KINDS`. Every kind is truthfully `"BLOCKED_UNSUPPORTED"`,
 * except `"PROJECT"` becomes `"EXPORTED"` when (and only when) the caller
 * supplies `projectExportEvidenceRef` - a non-empty evidence pointer
 * proving a real `exportCustomerProjectsSnapshot` (CUS-BACKUP-001) export
 * already happened elsewhere. This module never imports `project.ts`
 * itself (preserved boundary-scan discipline), so it cannot perform or
 * verify the export's content - it only records that the caller already
 * did, exactly as `evidenceRef` already works for the rest of this module.
 *
 * Structural enforcement that `"EXPORTED"` is reachable for `"PROJECT"`
 * ONLY: the ternary below is the single call site in this file that can
 * ever produce the `"EXPORTED"` literal, and its condition is `kind ===
 * "PROJECT"` literally - no other kind's branch in this map can reach it,
 * regardless of what `projectExportEvidenceRef` is supplied. (Proven by
 * this checkpoint's own guard-disable sanity check - see the exec-plan.)
 *
 * Idempotent and restart-safe: calling this again on an already-
 * `COMPLETED` state is an exact no-op (the original state, including its
 * original dispositions and evidence, is returned unchanged) rather than
 * re-computing a second, possibly differently-evidenced disposition set
 * for the same request.
 */
export function advanceCustomerOffboardingExecution(input: {
  state: CustomerOffboardingExecutionState;
  evidenceRef: unknown;
  projectExportEvidenceRef?: unknown;
}): CustomerOffboardingExecutionState {
  if (input.state.status === "COMPLETED") {
    return input.state;
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  const projectExportEvidenceRef =
    input.projectExportEvidenceRef === undefined
      ? undefined
      : requireNonEmptyString(input.projectExportEvidenceRef, "projectExportEvidenceRef");
  const resourceDispositions: ReadonlyArray<CustomerResourceDisposition> = ALL_CUSTOMER_SCOPED_RESOURCE_KINDS.map(
    (kind) =>
      kind === "PROJECT" && projectExportEvidenceRef !== undefined
        ? {
            kind,
            status: "EXPORTED",
            reason:
              "a real, caller-supplied PROJECT export snapshot (exportCustomerProjectsSnapshot, CUS-BACKUP-001) was produced for this customer",
            evidenceRef: projectExportEvidenceRef,
          }
        : {
            kind,
            status: "BLOCKED_UNSUPPORTED",
            reason: `no delete/export/anonymization capability exists for ${kind} resources in this repository yet`,
            evidenceRef,
          },
  );
  return {
    ...input.state,
    status: "COMPLETED",
    resourceDispositions,
  };
}
