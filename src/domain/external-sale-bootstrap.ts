import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { SoldScope } from "./sold-scope.js";
import type { OutcomeJob } from "./outcome-job.js";
import type { AuditEvent } from "./audit-event.js";
import type { ConnectionBinding } from "./connection-authority.js";
import { createProject } from "./project.js";
import { createSoldScope } from "./sold-scope.js";
import { createAuditEvent } from "./audit-event.js";
import { createOutcomeJob, enterExceptionState, InvalidExceptionStateEntryError } from "./outcome-job.js";

export class InvalidExternalSaleBootstrapError extends Error {
  constructor(reason: string) {
    super(`Invalid external sale bootstrap input: ${reason}`);
    this.name = "InvalidExternalSaleBootstrapError";
  }
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
 * Rev94 F1: "a VERIFIED ConnectionBinding proves a connection has been
 * admitted/validated. It does NOT prove that an arbitrary caller-provided
 * order actually happened." This is the distinct verified external-
 * commerce fact/ingress envelope that closes that gap: the ONLY way to
 * construct one is `createVerifiedExternalCommerceFact`, which itself
 * performs the fail-closed tenant/verification checks above against the
 * real `ConnectionBinding` - a bare caller string can never become a
 * `VerifiedExternalCommerceFact` on its own. `bootstrapExternalSaleOutcome`
 * (below) accepts only this type, never a raw `externalSaleRef` string
 * plus a separately-supplied connection.
 *
 * Provenance fields deliberately reuse the connection's own existing
 * identity rather than inventing parallel ones: `providerRef` and
 * `accountRef` mirror `ConnectionBinding.providerRef`/`workspaceRef`
 * exactly (CONN-001's own established connector-identity/account fields),
 * so this module never has to guess what "provider" or "account" means.
 */
export interface VerifiedExternalCommerceFact {
  readonly tenantId: TenantScope["tenantId"];
  readonly connectionBindingId: ConnectionBinding["connectionBindingId"];
  readonly providerRef: string;
  readonly accountRef: string;
  readonly externalOrderRef: string;
  readonly evidenceRef: string;
}

export function createVerifiedExternalCommerceFact(input: {
  tenantScope: TenantScope;
  connection: ConnectionBinding;
  externalOrderRef: unknown;
  evidenceRef: unknown;
}): VerifiedExternalCommerceFact {
  requireVerifiedSameTenantConnection({ connection: input.connection, tenantScope: input.tenantScope });
  const externalOrderRef = requireNonEmptyString(input.externalOrderRef, "externalOrderRef");
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  return {
    tenantId: input.tenantScope.tenantId,
    connectionBindingId: input.connection.connectionBindingId,
    providerRef: input.connection.providerRef,
    accountRef: input.connection.workspaceRef,
    externalOrderRef,
    evidenceRef,
  };
}

/**
 * Rev94 F2: "same external order id from different providers/accounts/
 * connections/tenants must not collide." The canonical sale identity
 * incorporates the fact's full source namespace - provider, account,
 * connection binding, and the provider's own order/event id - not just
 * the bare order id. Exported so the durable store layer
 * (`durable-external-sale-bootstrap-store.ts`) and callers key
 * idempotency/replay off the exact same identity this module derives
 * internally, rather than risking two independently-computed ids
 * silently diverging.
 */
export function deriveCanonicalSaleId(fact: VerifiedExternalCommerceFact): string {
  return [fact.providerRef, fact.accountRef, fact.connectionBindingId, fact.externalOrderRef].join("::");
}

/**
 * SALE-TO-CLOSE E2E acceptance floor (Rev91/92/93/94 CONN-001 addendum):
 * "accept a VERIFIED external commerce/order fact through the admitted
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
 * *deterministically derived* from `deriveCanonicalSaleId(fact)`, never
 * freshly generated. This is the same idempotency primitive
 * `outcome-job-wiring.ts` already uses for `jobId` (derived from
 * `spec.specId`, never generated) - replaying this function with the same
 * verified fact always produces byte-for-byte identical `Project`/
 * `SoldScope`/`OutcomeJob` objects.
 *
 * NOT A PAYMENT/SETTLEMENT ENGINE: this module accepts only an already-
 * governed fact that a sale occurred (a `VerifiedExternalCommerceFact` -
 * see the fail-closed checks in `createVerifiedExternalCommerceFact`
 * above) and a caller-supplied `businessObjective`/`jobFamily` describing
 * what was sold. It never computes price, tax, currency, settlement, or
 * payout - those remain the provider's/AI Commerce's own domain,
 * consistent with CONN-001's own "commerce ownership boundary"
 * requirement.
 */
export interface ExternalSaleBootstrapResult {
  readonly project: Project;
  readonly soldScope: SoldScope;
  readonly job: OutcomeJob;
}

export function bootstrapExternalSaleOutcome(input: {
  tenantScope: TenantScope;
  customer: Customer;
  fact: VerifiedExternalCommerceFact;
  jobFamily: unknown;
  businessObjective: unknown;
}): ExternalSaleBootstrapResult {
  if (input.fact.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidExternalSaleBootstrapError(
      "fact does not belong to the given tenantScope - cross-tenant sale-fact injection is not permitted",
    );
  }
  if (input.customer.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidExternalSaleBootstrapError("customer does not belong to the given tenantScope");
  }
  const jobFamily = requireNonEmptyString(input.jobFamily, "jobFamily");
  const businessObjective = requireNonEmptyString(input.businessObjective, "businessObjective");
  const saleId = deriveCanonicalSaleId(input.fact);

  const project = createProject({
    tenantScope: input.tenantScope,
    customer: input.customer,
    projectId: `sale-project:${saleId}`,
    ownerRef: `connection:${input.fact.connectionBindingId}`,
    state: "active",
  });
  const soldScope = createSoldScope({
    tenantScope: input.tenantScope,
    project,
    soldScopeId: `sale-scope:${saleId}`,
    outcomeContractRef: `external-sale:${saleId}`,
  });
  const job = createOutcomeJob({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project,
    jobId: `sale-job:${saleId}`,
    jobFamily,
    businessObjective,
  });

  return { project, soldScope, job };
}

/**
 * SALE-TO-CLOSE Rev94 F5: "AKILTA must never silently discard the fact"
 * even when the job has already advanced past the point where
 * `enterExceptionState(to: "STOPPED")` can apply (it is already `CLOSED`,
 * or already in ANY exception state - `BLOCKED`/`RECOVERING`/`ESCALATED`/
 * `STOPPED` - `outcome-job.ts`'s own `enterExceptionState` rejects
 * re-entry into an exception state just as it rejects entry from
 * `CLOSED`). This function tries the normal governed-stop path first；
 * only when `outcome-job.ts`'s own `InvalidExceptionStateEntryError`
 * proves that path is unavailable does it fall back to recording the
 * disposition as a pure audit/evidence event against the job's current,
 * UNCHANGED state - never a lifecycle rollback, never a fabricated
 * "undo," and never a silently dropped fact. `recordedAsEscalationOnly`
 * tells the caller which path was actually taken.
 */
export type SaleDispositionKind = "CANCELLATION" | "REFUND" | "CHARGEBACK";

const RECOGNIZED_SALE_DISPOSITION_KINDS: ReadonlySet<string> = new Set<SaleDispositionKind>([
  "CANCELLATION",
  "REFUND",
  "CHARGEBACK",
]);

export interface ExternalSaleDispositionResult {
  readonly job: OutcomeJob;
  readonly auditEvent: AuditEvent;
  readonly recordedAsEscalationOnly: boolean;
}

export function applyExternalSaleDisposition(input: {
  job: OutcomeJob;
  kind: unknown;
  externalSaleRef: unknown;
  eventId: unknown;
  actorRef: unknown;
  timestamp: unknown;
}): ExternalSaleDispositionResult {
  if (typeof input.kind !== "string" || !RECOGNIZED_SALE_DISPOSITION_KINDS.has(input.kind)) {
    throw new InvalidExternalSaleBootstrapError(
      "kind must be one of CANCELLATION, REFUND, CHARGEBACK",
    );
  }
  const kind = input.kind;
  const externalSaleRef = requireNonEmptyString(input.externalSaleRef, "externalSaleRef");

  try {
    const { job, auditEvent } = enterExceptionState({
      job: input.job,
      to: "STOPPED",
      eventId: input.eventId,
      actorRef: input.actorRef,
      timestamp: input.timestamp,
      reason: `${kind} for external sale ${externalSaleRef}`,
    });
    return { job, auditEvent, recordedAsEscalationOnly: false };
  } catch (cause) {
    if (!(cause instanceof InvalidExceptionStateEntryError)) {
      throw cause;
    }
    // The job is already CLOSED, or already in an exception state
    // (BLOCKED/RECOVERING/ESCALATED/STOPPED) - a lifecycle rollback or
    // forced re-entry is never attempted here. The external financial
    // fact is still durably recorded, verbatim, as an audit-only
    // disposition against the job's current, unmodified state.
    const auditEvent = createAuditEvent({
      job: input.job,
      eventId: input.eventId,
      actorRef: input.actorRef,
      eventType: `POST_LIFECYCLE_DISPOSITION_RECORDED:${kind}`,
      timestamp: input.timestamp,
      reason: `${kind} for external sale ${externalSaleRef} (job already ${input.job.state}; recorded as audit-only disposition, no lifecycle rollback)`,
    });
    return { job: input.job, auditEvent, recordedAsEscalationOnly: true };
  }
}
