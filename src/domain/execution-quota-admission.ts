import type { TenantScope } from "./tenant-scope.js";
import { createCostAmount, type CostAmount } from "./execution-economics-attribution.js";

/**
 * OS-V0-07 "Usage, Cost & Quota Guardrails" (Rev174 dispatch, pre-admission
 * packet Drive `1i-cN2aHfEFEj2pbzIaWAXFM61uf39tK2qvTMf7ich5w`). Closes gaps
 * G1-G3/G5-G7: a material AI/provider/tool/action effect must have a
 * source-proven current reservation against a bounded allowance BEFORE
 * effect, concurrency/retry must never silently double-spend that
 * allowance, and UNKNOWN cost/usage must never be treated as zero.
 *
 * Deliberately reuses `execution-economics-attribution.ts`'s own
 * `CostAmount`/`createCostAmount` REPORTED-vs-UNKNOWN discipline rather than
 * inventing a second cost-amount shape (Controlling Design A) - this module
 * is the pre-effect admission/reservation lifecycle that attribution module
 * does not yet have, not a replacement or parallel ledger for it. This
 * module never calls a real provider, never reads the system clock, and
 * never invents a canonical numeric limit - every `QuotaEnvelope` is
 * caller-supplied, current-fingerprint-gated policy, exactly like
 * `outcome-job-execution-runtime.ts`'s own `assertCurrentActivation`
 * discipline for `ProjectActivationProfile` currentness.
 */

export class InvalidQuotaAdmissionError extends Error {
  constructor(reason: string) {
    super(`Invalid quota admission operation: ${reason}`);
    this.name = "InvalidQuotaAdmissionError";
  }
}

/** G1/Package Contract I parity: "stale envelope/policy cannot authorize." */
export class StaleQuotaEnvelopeError extends Error {
  constructor(expected: string, current: string) {
    super(
      `quota envelope is stale (expected sourceFingerprint "${expected}", current is "${current}") - admission blocked before any reservation`,
    );
    this.name = "StaleQuotaEnvelopeError";
  }
}

/**
 * G3/Minimum Adversarial Evidence #11 parity: a reservation identity whose
 * own scope does not exactly match the envelope it is presented against can
 * never be admitted - closes the same "foreign/substituted state" class of
 * bug `verifyAndRefreshExecutionState` closes for execution-run state.
 */
export class CrossScopeQuotaSubstitutionError extends Error {
  constructor() {
    super("reservation identity's scope does not exactly match the given envelope's scope - cross-scope substitution");
    this.name = "CrossScopeQuotaSubstitutionError";
  }
}

/**
 * Minimum Adversarial Evidence #3/#13 parity (mirrors
 * `DuplicateIdempotencyKeyConflictError` in `execution-economics-attribution.ts`):
 * a duplicate idempotency key may only ever replay the IDENTICAL request: a
 * conflicting replay (same key, materially different content) fails closed
 * rather than silently proceeding against ambiguous intent.
 */
export class QuotaReservationConflictError extends Error {
  constructor(idempotencyKey: string, reason: string) {
    super(
      `idempotencyKey "${idempotencyKey}" was already recorded with materially different content (${reason}) - a duplicate idempotency key may only replay the identical request, never overwrite it`,
    );
    this.name = "QuotaReservationConflictError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || value.trim() !== value) {
    throw new InvalidQuotaAdmissionError(`${field} must be a non-empty string with no leading/trailing whitespace`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(raw))) {
    throw new InvalidQuotaAdmissionError(`${field} must be a valid ISO timestamp`);
  }
  return raw;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidQuotaAdmissionError(`${field} must be a positive integer`);
  }
  return value;
}

/**
 * G4: the budget "bucket" identity - deliberately the SAME top-level
 * tenant/customer/project/plan hierarchy `ExecutionEconomicsLineage` already
 * binds to (Controlling Design A: reuse the existing economics attribution
 * owner's identity rather than inventing a parallel scope shape). A single
 * envelope bounds every job/run/attempt sharing this exact tuple.
 */
export interface QuotaAdmissionScope {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: string;
  readonly projectId: string;
  readonly planId: string;
  readonly planVersion: number;
}

export function createQuotaAdmissionScope(input: {
  tenantScope: TenantScope;
  customerId: unknown;
  projectId: unknown;
  planId: unknown;
  planVersion: unknown;
}): QuotaAdmissionScope {
  return {
    tenantId: input.tenantScope.tenantId,
    customerId: requireNonEmptyString(input.customerId, "customerId"),
    projectId: requireNonEmptyString(input.projectId, "projectId"),
    planId: requireNonEmptyString(input.planId, "planId"),
    planVersion: requirePositiveInteger(input.planVersion, "planVersion"),
  };
}

function scopesEqual(a: QuotaAdmissionScope, b: QuotaAdmissionScope): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.customerId === b.customerId &&
    a.projectId === b.projectId &&
    a.planId === b.planId &&
    a.planVersion === b.planVersion
  );
}

/**
 * Injective over the full scope tuple for any realistic identifier value
 * (mirrors every other `*Key` helper in this codebase, e.g.
 * `executionRunKey`). Deliberately a plain `::`-delimited string rather than
 * `JSON.stringify(...)`, unlike this codebase's other `*Key` helpers - this
 * exact key is also re-derived inside `postgres-quota-reservation-store.ts`'s
 * own SQL text (as a plain `||` string concatenation) to compute `event_id`
 * for its single atomic admission statement, and a delimited string is
 * trivially reproducible there while a JSON array literal is not.
 */
export function quotaScopeKey(scope: QuotaAdmissionScope): string {
  return [scope.tenantId, scope.customerId, scope.projectId, scope.planId, String(scope.planVersion)].join("::");
}

/**
 * G1/POLICY VALUES: "there are no canonical global numeric defaults ...
 * never invent limits." `limit` must always be a REPORTED `CostAmount` - an
 * envelope that does not know its own numeric ceiling cannot be
 * constructed at all, so a caller with no real policy value is structurally
 * unable to admit anything against a fabricated/implied limit (the caller's
 * own integration layer is responsible for treating "no envelope available"
 * as BLOCKED/UNAVAILABLE, never as "unlimited").
 */
export interface QuotaEnvelope {
  readonly scope: QuotaAdmissionScope;
  readonly envelopeRef: string;
  readonly sourceFingerprint: string;
  readonly limit: CostAmount;
}

export function createQuotaEnvelope(input: {
  scope: QuotaAdmissionScope;
  envelopeRef: unknown;
  sourceFingerprint: unknown;
  limit: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
}): QuotaEnvelope {
  const limit = createCostAmount(input.limit);
  if (limit.presence !== "REPORTED") {
    throw new InvalidQuotaAdmissionError(
      "envelope limit must be REPORTED - an envelope with no known numeric ceiling cannot be constructed (never invent a limit)",
    );
  }
  return {
    scope: input.scope,
    envelopeRef: requireNonEmptyString(input.envelopeRef, "envelopeRef"),
    sourceFingerprint: requireNonEmptyString(input.sourceFingerprint, "sourceFingerprint"),
    limit,
  };
}

/**
 * Package Contract I parity, pure comparison - the caller is responsible
 * for actually re-resolving `currentSourceFingerprint` from the current
 * effective policy/envelope source immediately before calling this, never
 * from a cached/queued value (Minimum Adversarial Evidence #7 for OS-V0-07).
 */
export function assertCurrentQuotaEnvelope(envelope: QuotaEnvelope, currentSourceFingerprint: string): void {
  if (envelope.sourceFingerprint !== currentSourceFingerprint) {
    throw new StaleQuotaEnvelopeError(envelope.sourceFingerprint, currentSourceFingerprint);
  }
}

/** One logical reservation slot: one attempt of one run of one job, inside one budget scope. */
export interface QuotaReservationIdentity {
  readonly scope: QuotaAdmissionScope;
  readonly jobId: string;
  readonly runId: string;
  readonly attemptRef: string;
}

export function createQuotaReservationIdentity(input: {
  scope: QuotaAdmissionScope;
  jobId: unknown;
  runId: unknown;
  attemptRef: unknown;
}): QuotaReservationIdentity {
  return {
    scope: input.scope,
    jobId: requireNonEmptyString(input.jobId, "jobId"),
    runId: requireNonEmptyString(input.runId, "runId"),
    attemptRef: requireNonEmptyString(input.attemptRef, "attemptRef"),
  };
}

function identitiesEqual(a: QuotaReservationIdentity, b: QuotaReservationIdentity): boolean {
  return scopesEqual(a.scope, b.scope) && a.jobId === b.jobId && a.runId === b.runId && a.attemptRef === b.attemptRef;
}

function amountsEqual(a: CostAmount | undefined, b: CostAmount | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * "Capture worker/provider/model/route only when exposed by real execution
 * facts; absence is explicit and never a fabricated identity" (Minimum
 * Adversarial Evidence #17) - deliberately a small local mirror of
 * `execution-economics-attribution.ts`'s own (unexported) `ProviderAttribution`
 * validator rather than importing a private symbol across module boundaries.
 */
export interface QuotaProviderAttribution {
  readonly workerRef?: string;
  readonly providerRef?: string;
  readonly modelRef?: string;
  readonly routeRef?: string;
}

function createQuotaProviderAttribution(input: {
  workerRef?: unknown;
  providerRef?: unknown;
  modelRef?: unknown;
  routeRef?: unknown;
}): QuotaProviderAttribution {
  const attribution: {
    workerRef?: string;
    providerRef?: string;
    modelRef?: string;
    routeRef?: string;
  } = {};
  if (input.workerRef !== undefined) attribution.workerRef = requireNonEmptyString(input.workerRef, "workerRef");
  if (input.providerRef !== undefined) attribution.providerRef = requireNonEmptyString(input.providerRef, "providerRef");
  if (input.modelRef !== undefined) attribution.modelRef = requireNonEmptyString(input.modelRef, "modelRef");
  if (input.routeRef !== undefined) attribution.routeRef = requireNonEmptyString(input.routeRef, "routeRef");
  return attribution;
}

export type QuotaReservationEventType = "RESERVED" | "REJECTED" | "COMMITTED" | "RELEASED" | "RECONCILIATION_REQUIRED";

/**
 * G2's minimal explicit lifecycle: REQUESTED/PROPOSED -> RESERVED or
 * REJECTED -> actual usage COMMITTED, or the reservation RELEASED, or (an
 * actual that overruns its reservation's allowed overage) flagged
 * RECONCILIATION_REQUIRED. One event per lifecycle transition, append-only -
 * mirrors `ExecutionEconomicsEvent`/`OutcomeJobExecutionEvent`'s own
 * event-sourced discipline rather than a single mutable record.
 */
export interface QuotaReservationEvent {
  readonly eventId: string;
  readonly identity: QuotaReservationIdentity;
  readonly idempotencyKey: string;
  readonly envelopeRef: string;
  readonly type: QuotaReservationEventType;
  readonly occurredAt: string;
  readonly amount?: CostAmount;
  readonly reason?: string;
  readonly attribution?: QuotaProviderAttribution;
}

/**
 * Stable identity for a single lifecycle transition - a store's own atomic
 * "durably created vs already existed" claim (mirroring
 * `deriveOutcomeJobExecutionEventId`) is keyed on this, never on physical
 * insertion order. Including `type` distinguishes RESERVED/REJECTED (the
 * ADMISSION decision, unique per `idempotencyKey`) from a later COMMITTED/
 * RELEASED/RECONCILIATION_REQUIRED transition of that same reservation.
 */
export function deriveQuotaReservationEventId(identity: QuotaReservationIdentity, idempotencyKey: string, type: QuotaReservationEventType): string {
  return [quotaScopeKey(identity.scope), identity.jobId, identity.runId, identity.attemptRef, idempotencyKey, type].join("::");
}

export interface QuotaLedger {
  readonly events: ReadonlyArray<QuotaReservationEvent>;
}

export const EMPTY_QUOTA_LEDGER: QuotaLedger = { events: [] };

function appendToLedger(ledger: QuotaLedger, event: QuotaReservationEvent): QuotaLedger {
  return { events: [...ledger.events, event] };
}

/**
 * The admission decision for a fresh idempotencyKey, OR the replayed
 * decision for one already recorded (Minimum Adversarial Evidence #2:
 * "identical reservation replay -> no second allowance consumption").
 */
function findAdmissionEvent(ledger: QuotaLedger, tenantId: TenantScope["tenantId"], idempotencyKey: string): QuotaReservationEvent | undefined {
  return ledger.events.find(
    (e) => e.identity.scope.tenantId === tenantId && e.idempotencyKey === idempotencyKey && (e.type === "RESERVED" || e.type === "REJECTED"),
  );
}

function findLatestEvent(
  ledger: QuotaLedger,
  identity: QuotaReservationIdentity,
  idempotencyKey: string,
): QuotaReservationEvent | undefined {
  let latest: QuotaReservationEvent | undefined;
  for (const event of ledger.events) {
    if (identitiesEqual(event.identity, identity) && event.idempotencyKey === idempotencyKey) {
      latest = event;
    }
  }
  return latest;
}

/**
 * G7 projection: current outstanding exposure for one budget scope.
 * `reservedTotal` counts every reservation still in its RESERVED window
 * (not yet committed/released); `committedTotal` counts actual REPORTED
 * usage (COMMITTED and RECONCILIATION_REQUIRED both count - an overage
 * flag does not erase the spend, Minimum Adversarial Evidence #9).
 * `hasUnknownCommitted` is set the moment any committed actual is UNKNOWN.
 *
 * G5/Minimum Adversarial Evidence #8/#16: an UNKNOWN actual is never treated
 * as FREE either - a COMMITTED (or RECONCILIATION_REQUIRED) event whose
 * actual amount is UNKNOWN still contributes its ORIGINAL RESERVED amount
 * (the last known REPORTED bound) to `committedTotal`, conservatively
 * keeping that allowance occupied for future admission decisions rather
 * than silently releasing it the moment the real cost becomes unknown. A
 * reservation whose original requested amount was itself UNKNOWN (already
 * REJECTED at admission time, so it never reaches this projection as
 * RESERVED/COMMITTED at all) cannot occur here by construction.
 */
export interface QuotaScopeUsage {
  readonly reservedTotal: number;
  readonly committedTotal: number;
  readonly hasUnknownCommitted: boolean;
}

export function projectQuotaScopeUsage(ledger: QuotaLedger, scope: QuotaAdmissionScope): QuotaScopeUsage {
  const latestByReservation = new Map<string, QuotaReservationEvent>();
  const reservedAmountByReservation = new Map<string, CostAmount | undefined>();
  for (const event of ledger.events) {
    if (!scopesEqual(event.identity.scope, scope)) continue;
    const key = JSON.stringify([event.identity.jobId, event.identity.runId, event.identity.attemptRef, event.idempotencyKey]);
    latestByReservation.set(key, event);
    if (event.type === "RESERVED") {
      reservedAmountByReservation.set(key, event.amount);
    }
  }
  let reservedTotal = 0;
  let committedTotal = 0;
  let hasUnknownCommitted = false;
  for (const [key, event] of latestByReservation.entries()) {
    if (event.type === "RESERVED" && event.amount?.presence === "REPORTED") {
      reservedTotal += event.amount.amountMinorUnits as number;
    } else if (event.type === "COMMITTED" || event.type === "RECONCILIATION_REQUIRED") {
      if (event.amount?.presence === "REPORTED") {
        committedTotal += event.amount.amountMinorUnits as number;
      } else {
        hasUnknownCommitted = true;
        const originalReserved = reservedAmountByReservation.get(key);
        if (originalReserved?.presence === "REPORTED") {
          committedTotal += originalReserved.amountMinorUnits as number;
        }
      }
    }
  }
  return { reservedTotal, committedTotal, hasUnknownCommitted };
}

export type QuotaAdmissionOutcome =
  | { readonly status: "RESERVED"; readonly event: QuotaReservationEvent }
  | { readonly status: "REJECTED"; readonly event: QuotaReservationEvent };

/**
 * The one atomic decision point (G1/G3). Pure function over an immutable
 * ledger snapshot - real cross-caller atomicity is the STORE's
 * responsibility (see `durable-quota-reservation-store.ts`/
 * `postgres-quota-reservation-store.ts`): whichever caller's store call
 * durably wins the append for this exact `idempotencyKey`'s admission
 * decision is authoritative; every other concurrent caller for a
 * DIFFERENT idempotencyKey against the SAME scope must have its own call
 * see the now-updated ledger before deciding (Minimum Adversarial Evidence
 * #1).
 *
 * Fails closed rather than fabricating admission in three cases fixed
 * before any allowance math runs: (1) identity/envelope scope mismatch
 * (#11), (2) a conflicting replay of an already-decided idempotencyKey
 * (#3), (3) currency mismatch between the request and the envelope. An
 * UNKNOWN requested amount is never treated as zero-cost/auto-admitted
 * (#8) - it is REJECTED, exactly like insufficient allowance.
 */
export function admitQuotaReservation(input: {
  readonly ledger: QuotaLedger;
  readonly envelope: QuotaEnvelope;
  readonly identity: QuotaReservationIdentity;
  readonly idempotencyKey: unknown;
  readonly requestedAmount: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
  readonly occurredAt: unknown;
}): { readonly ledger: QuotaLedger; readonly outcome: QuotaAdmissionOutcome } {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const occurredAt = requireValidTimestamp(input.occurredAt, "occurredAt");
  if (!scopesEqual(input.identity.scope, input.envelope.scope)) {
    throw new CrossScopeQuotaSubstitutionError();
  }
  const requestedAmount = createCostAmount(input.requestedAmount);

  const existing = findAdmissionEvent(input.ledger, input.identity.scope.tenantId, idempotencyKey);
  if (existing !== undefined) {
    if (
      !identitiesEqual(existing.identity, input.identity) ||
      existing.envelopeRef !== input.envelope.envelopeRef ||
      !amountsEqual(existing.amount, requestedAmount)
    ) {
      throw new QuotaReservationConflictError(idempotencyKey, "identity, envelopeRef, or requestedAmount differs from the original request");
    }
    return {
      ledger: input.ledger,
      outcome: existing.type === "RESERVED" ? { status: "RESERVED", event: existing } : { status: "REJECTED", event: existing },
    };
  }

  if (requestedAmount.presence === "UNKNOWN") {
    const event: QuotaReservationEvent = {
      eventId: deriveQuotaReservationEventId(input.identity, idempotencyKey, "REJECTED"),
      identity: input.identity,
      idempotencyKey,
      envelopeRef: input.envelope.envelopeRef,
      type: "REJECTED",
      occurredAt,
      reason: "an UNKNOWN estimated cost cannot be admitted against a monetary ceiling - it is never treated as zero",
    };
    return { ledger: appendToLedger(input.ledger, event), outcome: { status: "REJECTED", event } };
  }
  if (requestedAmount.currency !== input.envelope.limit.currency) {
    throw new InvalidQuotaAdmissionError(
      `requestedAmount currency "${requestedAmount.currency}" does not match envelope limit currency "${input.envelope.limit.currency}"`,
    );
  }

  const usage = projectQuotaScopeUsage(input.ledger, input.envelope.scope);
  const projectedTotal = usage.reservedTotal + usage.committedTotal + (requestedAmount.amountMinorUnits as number);
  if (projectedTotal > (input.envelope.limit.amountMinorUnits as number)) {
    const event: QuotaReservationEvent = {
      eventId: deriveQuotaReservationEventId(input.identity, idempotencyKey, "REJECTED"),
      identity: input.identity,
      idempotencyKey,
      envelopeRef: input.envelope.envelopeRef,
      type: "REJECTED",
      occurredAt,
      amount: requestedAmount,
      reason: "insufficient allowance remaining under the current envelope limit",
    };
    return { ledger: appendToLedger(input.ledger, event), outcome: { status: "REJECTED", event } };
  }

  const event: QuotaReservationEvent = {
    eventId: deriveQuotaReservationEventId(input.identity, idempotencyKey, "RESERVED"),
    identity: input.identity,
    idempotencyKey,
    envelopeRef: input.envelope.envelopeRef,
    type: "RESERVED",
    occurredAt,
    amount: requestedAmount,
  };
  return { ledger: appendToLedger(input.ledger, event), outcome: { status: "RESERVED", event } };
}

export type QuotaCommitOutcome =
  | { readonly status: "COMMITTED"; readonly event: QuotaReservationEvent }
  | { readonly status: "RECONCILIATION_REQUIRED"; readonly event: QuotaReservationEvent };

/**
 * G5/G6: records actual usage against an existing RESERVED reservation.
 * `actualAmount` may itself be UNKNOWN (a failed/unknown provider response
 * may still have consumed real units - Minimum Adversarial Evidence #10)
 * and is recorded exactly as reported, never fabricated or discarded. An
 * actual that exceeds its own reservation by more than `allowedOverage`
 * (default: no overage tolerated) is COMMITTED as `RECONCILIATION_REQUIRED`
 * rather than silently erasing the overage (#9). A repeat commit for the
 * same idempotencyKey is a safe no-op only if content is identical;
 * otherwise it fails closed as a duplicate-callback conflict (#13).
 */
export function commitQuotaUsage(input: {
  readonly ledger: QuotaLedger;
  readonly identity: QuotaReservationIdentity;
  readonly idempotencyKey: unknown;
  readonly actualAmount: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
  readonly occurredAt: unknown;
  readonly attribution?: {
    workerRef?: unknown;
    providerRef?: unknown;
    modelRef?: unknown;
    routeRef?: unknown;
  };
  readonly allowedOverage?: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
}): { readonly ledger: QuotaLedger; readonly outcome: QuotaCommitOutcome } {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const occurredAt = requireValidTimestamp(input.occurredAt, "occurredAt");
  const actualAmount = createCostAmount(input.actualAmount);
  const attribution = createQuotaProviderAttribution(input.attribution ?? {});

  const reservation = findLatestEvent(input.ledger, input.identity, idempotencyKey);
  if (reservation === undefined || reservation.type === "REJECTED") {
    throw new InvalidQuotaAdmissionError(
      `no RESERVED reservation exists for idempotencyKey "${idempotencyKey}" under the given identity - cannot commit usage against a nonexistent or rejected reservation`,
    );
  }

  if (reservation.type === "COMMITTED" || reservation.type === "RECONCILIATION_REQUIRED") {
    if (amountsEqual(reservation.amount, actualAmount) && JSON.stringify(reservation.attribution ?? {}) === JSON.stringify(attribution)) {
      return {
        ledger: input.ledger,
        outcome: reservation.type === "COMMITTED" ? { status: "COMMITTED", event: reservation } : { status: "RECONCILIATION_REQUIRED", event: reservation },
      };
    }
    throw new QuotaReservationConflictError(idempotencyKey, "a duplicate usage report carried a different actualAmount or attribution than the original commit");
  }

  let type: "COMMITTED" | "RECONCILIATION_REQUIRED" = "COMMITTED";
  let reason: string | undefined;
  if (actualAmount.presence === "REPORTED" && reservation.amount?.presence === "REPORTED") {
    const overage = (actualAmount.amountMinorUnits as number) - (reservation.amount.amountMinorUnits as number);
    const allowedOverageAmount =
      input.allowedOverage !== undefined
        ? createCostAmount(input.allowedOverage)
        : ({ presence: "REPORTED", amountMinorUnits: 0, currency: actualAmount.currency } as CostAmount);
    if (allowedOverageAmount.presence === "REPORTED" && overage > (allowedOverageAmount.amountMinorUnits as number)) {
      type = "RECONCILIATION_REQUIRED";
      reason = `actual usage exceeded its reservation by ${overage} minor units, beyond the allowed overage of ${allowedOverageAmount.amountMinorUnits}`;
    }
  }

  const event: QuotaReservationEvent = {
    eventId: deriveQuotaReservationEventId(input.identity, idempotencyKey, type),
    identity: input.identity,
    idempotencyKey,
    envelopeRef: reservation.envelopeRef,
    type,
    occurredAt,
    amount: actualAmount,
    attribution,
    ...(reason !== undefined ? { reason } : {}),
  };
  return {
    ledger: appendToLedger(input.ledger, event),
    outcome: type === "COMMITTED" ? { status: "COMMITTED", event } : { status: "RECONCILIATION_REQUIRED", event },
  };
}

export type QuotaReleaseOutcome =
  | { readonly status: "RELEASED"; readonly event: QuotaReservationEvent }
  | { readonly status: "ALREADY_COMMITTED"; readonly event: QuotaReservationEvent };

/**
 * G2: releases an unused reservation back to the pool. Minimum Adversarial
 * Evidence #14: releasing a reservation that has ALREADY been committed
 * never silently discards the committed usage record - it is a safe,
 * explicit no-op (`ALREADY_COMMITTED`) that leaves the ledger unchanged,
 * never a fail-closed error and never a fabricated second RELEASED event.
 * Releasing an already-RELEASED reservation is likewise an idempotent
 * no-op.
 */
export function releaseQuotaReservation(input: {
  readonly ledger: QuotaLedger;
  readonly identity: QuotaReservationIdentity;
  readonly idempotencyKey: unknown;
  readonly occurredAt: unknown;
  readonly reason?: unknown;
}): { readonly ledger: QuotaLedger; readonly outcome: QuotaReleaseOutcome } {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const occurredAt = requireValidTimestamp(input.occurredAt, "occurredAt");

  const reservation = findLatestEvent(input.ledger, input.identity, idempotencyKey);
  if (reservation === undefined || reservation.type === "REJECTED") {
    throw new InvalidQuotaAdmissionError(
      `no RESERVED reservation exists for idempotencyKey "${idempotencyKey}" under the given identity - cannot release a nonexistent or rejected reservation`,
    );
  }
  if (reservation.type === "RELEASED") {
    return { ledger: input.ledger, outcome: { status: "RELEASED", event: reservation } };
  }
  if (reservation.type === "COMMITTED" || reservation.type === "RECONCILIATION_REQUIRED") {
    return { ledger: input.ledger, outcome: { status: "ALREADY_COMMITTED", event: reservation } };
  }

  const event: QuotaReservationEvent = {
    eventId: deriveQuotaReservationEventId(input.identity, idempotencyKey, "RELEASED"),
    identity: input.identity,
    idempotencyKey,
    envelopeRef: reservation.envelopeRef,
    type: "RELEASED",
    occurredAt,
    ...(reservation.amount !== undefined ? { amount: reservation.amount } : {}),
    ...(input.reason !== undefined ? { reason: requireNonEmptyString(input.reason, "reason") } : {}),
  };
  return { ledger: appendToLedger(input.ledger, event), outcome: { status: "RELEASED", event } };
}

export type QuotaReadModelStatus = "COMPUTED" | "INCOMPLETE";

/**
 * G7: a truthful internal operator projection. Minimum Adversarial Evidence
 * #16: an UNKNOWN committed actual makes `remaining` genuinely
 * unrepresentable - this returns explicit `INCOMPLETE`, never a fabricated
 * numeric `remaining` (and never confuses that with a real `0`).
 */
export type QuotaReadModel =
  | {
      readonly status: "COMPUTED";
      readonly limit: CostAmount;
      readonly reserved: number;
      readonly committed: number;
      readonly remaining: number;
    }
  | { readonly status: "INCOMPLETE"; readonly reason: string };

export function projectQuotaReadModel(ledger: QuotaLedger, envelope: QuotaEnvelope): QuotaReadModel {
  const usage = projectQuotaScopeUsage(ledger, envelope.scope);
  if (usage.hasUnknownCommitted) {
    return {
      status: "INCOMPLETE",
      reason: "at least one committed usage event has an UNKNOWN actual cost - remaining allowance cannot be computed",
    };
  }
  const remaining = (envelope.limit.amountMinorUnits as number) - usage.reservedTotal - usage.committedTotal;
  return { status: "COMPUTED", limit: envelope.limit, reserved: usage.reservedTotal, committed: usage.committedTotal, remaining };
}

const RECOGNIZED_QUOTA_RESERVATION_EVENT_TYPES: ReadonlySet<QuotaReservationEventType> = new Set([
  "RESERVED",
  "REJECTED",
  "COMMITTED",
  "RELEASED",
  "RECONCILIATION_REQUIRED",
]);

function reconstructCostAmount(raw: unknown, field: string): CostAmount | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidQuotaAdmissionError(`${field} must be an object when present`);
  }
  const candidate = raw as { presence?: unknown; amountMinorUnits?: unknown; currency?: unknown };
  return createCostAmount({ presence: candidate.presence, amountMinorUnits: candidate.amountMinorUnits, currency: candidate.currency });
}

/**
 * Untrusted-replay-boundary validator shared by both stores (Rev145 F2's
 * established precedent for this codebase: exactly one canonical validator
 * per persisted-record shape, never duplicated/drifted per store). Fails
 * closed on a malformed shape, a recognized-type violation, an eventId that
 * does not re-derive from the record's own tuple (forgery detection), or a
 * record whose scope does not exactly match the tenant/scope this file/row
 * was read for (cross-scope corruption/substitution).
 */
export function validatePersistedQuotaReservationEvent(raw: unknown, expectedScope: QuotaAdmissionScope): QuotaReservationEvent {
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidQuotaAdmissionError("persisted quota reservation record must be an object");
  }
  const candidate = raw as {
    eventId?: unknown;
    identity?: { scope?: unknown; jobId?: unknown; runId?: unknown; attemptRef?: unknown };
    idempotencyKey?: unknown;
    envelopeRef?: unknown;
    type?: unknown;
    occurredAt?: unknown;
    amount?: unknown;
    reason?: unknown;
    attribution?: unknown;
  };
  if (typeof candidate.type !== "string" || !RECOGNIZED_QUOTA_RESERVATION_EVENT_TYPES.has(candidate.type as QuotaReservationEventType)) {
    throw new InvalidQuotaAdmissionError(`type must be one of ${Array.from(RECOGNIZED_QUOTA_RESERVATION_EVENT_TYPES).join(", ")}`);
  }
  const rawIdentity = candidate.identity ?? {};
  const rawScope = (rawIdentity as { scope?: unknown }).scope as
    | { tenantId?: unknown; customerId?: unknown; projectId?: unknown; planId?: unknown; planVersion?: unknown }
    | undefined;
  if (
    rawScope === undefined ||
    rawScope.tenantId !== expectedScope.tenantId ||
    rawScope.customerId !== expectedScope.customerId ||
    rawScope.projectId !== expectedScope.projectId ||
    rawScope.planId !== expectedScope.planId ||
    rawScope.planVersion !== expectedScope.planVersion
  ) {
    throw new InvalidQuotaAdmissionError("persisted record's identity.scope does not match the exact scope it was read for");
  }
  const identity: QuotaReservationIdentity = {
    scope: expectedScope,
    jobId: requireNonEmptyString((rawIdentity as { jobId?: unknown }).jobId, "identity.jobId"),
    runId: requireNonEmptyString((rawIdentity as { runId?: unknown }).runId, "identity.runId"),
    attemptRef: requireNonEmptyString((rawIdentity as { attemptRef?: unknown }).attemptRef, "identity.attemptRef"),
  };
  const idempotencyKey = requireNonEmptyString(candidate.idempotencyKey, "idempotencyKey");
  const envelopeRef = requireNonEmptyString(candidate.envelopeRef, "envelopeRef");
  const occurredAt = requireValidTimestamp(candidate.occurredAt, "occurredAt");
  const type = candidate.type as QuotaReservationEventType;
  const expectedEventId = deriveQuotaReservationEventId(identity, idempotencyKey, type);
  if (candidate.eventId !== expectedEventId) {
    throw new InvalidQuotaAdmissionError(
      `eventId does not match its own canonical derivation from identity/idempotencyKey/type (forged or corrupted record)`,
    );
  }
  const amount = reconstructCostAmount(candidate.amount, "amount");
  const rawAttribution = candidate.attribution as
    | { workerRef?: unknown; providerRef?: unknown; modelRef?: unknown; routeRef?: unknown }
    | undefined;
  const attribution = rawAttribution !== undefined ? createQuotaProviderAttribution(rawAttribution) : undefined;
  const reason = candidate.reason !== undefined ? requireNonEmptyString(candidate.reason, "reason") : undefined;
  return {
    eventId: expectedEventId,
    identity,
    idempotencyKey,
    envelopeRef,
    type,
    occurredAt,
    ...(amount !== undefined ? { amount } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(attribution !== undefined ? { attribution } : {}),
  };
}
