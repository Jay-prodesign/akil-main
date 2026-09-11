import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { SoldScope } from "./sold-scope.js";
import type { OutcomeJob } from "./outcome-job.js";
import type { AuditEvent } from "./audit-event.js";
import type { ConnectionBinding } from "./connection-authority.js";
import { createProject } from "./project.js";
import { createSoldScope } from "./sold-scope.js";
import { createOutcomeJob, enterExceptionState } from "./outcome-job.js";

export class InvalidExternalSaleBootstrapError extends Error {
  constructor(reason: string) {
    super(`Invalid external sale bootstrap input: ${reason}`);
    this.name = "InvalidExternalSaleBootstrapError";
  }
}

/**
 * SALE-TO-CLOSE E2E acceptance floor (Rev91/92/93 CONN-001 addendum):
 * "accept VERIFIED external commerce/order facts through the admitted
 * integration boundary; idempotently/deterministically bootstrap or
 * reconcile the AKILTA Project + SoldScope + OutcomeJob; preserve tenant
 * isolation; survive duplicate delivery, replay and crash." This module
 * is the pure bootstrap/reconciliation function itself - the durable
 * put-once idempotency layer is `durable-external-sale-bootstrap-store.ts`,
 * mirroring `durable-outcome-job-store.ts`'s own already-established
 * pattern rather than inventing a new one.
 *
 * DELIBERATE REUSE, NO SECOND WORKFLOW/STATE SYSTEM: this module invents
 * no new Project/SoldScope/OutcomeJob construction logic - it calls
 * `createProject`/`createSoldScope`/`createOutcomeJob` exactly as any
 * other caller would, with one addition: every identifier is
 * *deterministically derived* from the caller-supplied `externalSaleRef`
 * (the provider's own opaque order/sale identifier), never freshly
 * generated. This is the same idempotency primitive
 * `outcome-job-wiring.ts` already uses for `jobId` (derived from
 * `spec.specId`, never generated) - replaying this function with the same
 * `externalSaleRef` always produces byte-for-byte identical `Project`/
 * `SoldScope`/`OutcomeJob` objects, which is what lets a jobId/externalSaleRef
 * -keyed durable store naturally deduplicate concurrent or crash-replayed
 * deliveries without this function needing to know anything about
 * storage.
 *
 * NOT A PAYMENT/SETTLEMENT ENGINE: this module accepts only an already-
 * governed fact that a sale occurred (vouched for by an admitted,
 * `VERIFIED` `ConnectionBinding` - see the fail-closed checks below) and
 * a caller-supplied `businessObjective`/`jobFamily` describing what was
 * sold. It never computes price, tax, currency, settlement, or payout -
 * those remain the provider's/AI Commerce's own domain, consistent with
 * CONN-001's own "commerce ownership boundary" requirement.
 */
export interface ExternalSaleBootstrapResult {
  readonly project: Project;
  readonly soldScope: SoldScope;
  readonly job: OutcomeJob;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidExternalSaleBootstrapError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Fail-closed checks, both independent of anything the caller merely
 * *claims* about the connection - they are checked directly against the
 * `ConnectionBinding` object itself:
 * - CROSS-TENANT REJECTION: `connection.ownership.tenantId` must equal
 *   `tenantScope.tenantId`. A connection admitted for tenant A can never
 *   vouch for a sale bootstrapped under tenant B, even if a caller
 *   supplies a mismatched `tenantScope` by mistake or by malicious
 *   injection.
 * - REVOKED/WRONG-CONNECTION REJECTION: `connection.connectionState` must
 *   be `VERIFIED`. A `REVOKED`, `DEGRADED`, `REQUESTED`, or
 *   `CONNECTED_UNVERIFIED` connection has not (or no longer) proven it
 *   can be trusted to vouch for an external fact, so it fails closed
 *   here regardless of how plausible the supplied sale data looks.
 */
function requireVerifiedSameTenantConnection(input: {
  connection: ConnectionBinding;
  tenantScope: TenantScope;
}): void {
  if (input.connection.ownership.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidExternalSaleBootstrapError(
      "connection does not belong to the given tenantScope - cross-tenant sale-fact injection is not permitted",
    );
  }
  if (input.connection.connectionState !== "VERIFIED") {
    throw new InvalidExternalSaleBootstrapError(
      `connection must be VERIFIED to vouch for an external sale fact; current state: ${input.connection.connectionState}`,
    );
  }
}

/**
 * Deterministic, collision-resistant id derivation from `externalSaleRef`
 * alone - the same external sale/order id always yields the same three
 * ids, on every replay, on every process, with no freshly-generated
 * component. `ownerRef` and `state` for the bootstrapped `Project` are
 * fixed, honest defaults (no fabricated ownership assignment/workflow
 * state system - `project.ts` itself declares `state` as a free-form
 * label with no canonical enum to draw from).
 */
export function bootstrapExternalSaleOutcome(input: {
  tenantScope: TenantScope;
  customer: Customer;
  connection: ConnectionBinding;
  externalSaleRef: unknown;
  jobFamily: unknown;
  businessObjective: unknown;
}): ExternalSaleBootstrapResult {
  requireVerifiedSameTenantConnection({ connection: input.connection, tenantScope: input.tenantScope });
  if (input.customer.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidExternalSaleBootstrapError("customer does not belong to the given tenantScope");
  }
  const externalSaleRef = requireNonEmptyString(input.externalSaleRef, "externalSaleRef");
  const jobFamily = requireNonEmptyString(input.jobFamily, "jobFamily");
  const businessObjective = requireNonEmptyString(input.businessObjective, "businessObjective");

  const project = createProject({
    tenantScope: input.tenantScope,
    customer: input.customer,
    projectId: `sale-project:${externalSaleRef}`,
    ownerRef: `connection:${input.connection.connectionBindingId}`,
    state: "active",
  });
  const soldScope = createSoldScope({
    tenantScope: input.tenantScope,
    project,
    soldScopeId: `sale-scope:${externalSaleRef}`,
    outcomeContractRef: `external-sale:${externalSaleRef}`,
  });
  const job = createOutcomeJob({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project,
    jobId: `sale-job:${externalSaleRef}`,
    jobFamily,
    businessObjective,
  });

  return { project, soldScope, job };
}

/**
 * SALE-TO-CLOSE: "cancellation/refund/chargeback facts must update/stop/
 * escalate internal work consistently, but AKILTA must not itself become
 * the payment/settlement/refund engine." This function does not implement
 * any settlement logic at all - it only records the governed disposition
 * against the already-bootstrapped `OutcomeJob`, reusing
 * `outcome-job.ts`'s own existing, unmodified `enterExceptionState`
 * (`STOPPED`) rather than inventing a second exception/state system. The
 * disposition kind is preserved verbatim in the resulting `AuditEvent`'s
 * reason text for audit/reporting - never silently dropped or blurred
 * into a generic "cancelled" label.
 */
export type SaleDispositionKind = "CANCELLATION" | "REFUND" | "CHARGEBACK";

const RECOGNIZED_SALE_DISPOSITION_KINDS: ReadonlySet<string> = new Set<SaleDispositionKind>([
  "CANCELLATION",
  "REFUND",
  "CHARGEBACK",
]);

export function applyExternalSaleDisposition(input: {
  job: OutcomeJob;
  kind: unknown;
  externalSaleRef: unknown;
  eventId: unknown;
  actorRef: unknown;
  timestamp: unknown;
}): { job: OutcomeJob; auditEvent: AuditEvent } {
  if (typeof input.kind !== "string" || !RECOGNIZED_SALE_DISPOSITION_KINDS.has(input.kind)) {
    throw new InvalidExternalSaleBootstrapError(
      "kind must be one of CANCELLATION, REFUND, CHARGEBACK",
    );
  }
  const externalSaleRef = requireNonEmptyString(input.externalSaleRef, "externalSaleRef");
  return enterExceptionState({
    job: input.job,
    to: "STOPPED",
    eventId: input.eventId,
    actorRef: input.actorRef,
    timestamp: input.timestamp,
    reason: `${input.kind} for external sale ${externalSaleRef}`,
  });
}
