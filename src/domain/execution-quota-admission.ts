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

/**
 * Rev177 F7: "make first terminal reservation disposition monotonic ...
 * incompatible dual terminals/standalone terminals fail closed." Thrown when
 * an idempotencyKey whose reservation has already reached a genuine terminal
 * disposition (COMMITTED/RELEASED/RECONCILIATION_REQUIRED) is used again in
 * a way that would resurrect it - either a fresh `admitQuotaReservation`
 * call (which must never echo a stale RESERVED/REJECTED for an
 * idempotencyKey that has since settled) or a `commitQuotaUsage` call
 * against a RELEASED reservation (which must never fabricate spend for
 * allowance that was already returned to the pool). A real later retry
 * always uses its own new attempt's distinct identity/idempotencyKey, never
 * this same settled one.
 */
export class QuotaReservationAlreadySettledError extends Error {
  constructor(idempotencyKey: string, settledAs: QuotaReservationEventType) {
    super(
      `idempotencyKey "${idempotencyKey}" has already terminally settled as ${settledAs} - it can never be re-admitted, resurrected, or transitioned to a different terminal state`,
    );
    this.name = "QuotaReservationAlreadySettledError";
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

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidQuotaAdmissionError(`${field} must be a non-negative integer`);
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
 * Injective over the full scope tuple for any realistic identifier value -
 * `JSON.stringify` of the ordered tuple, exactly the same collision-safe
 * convention `deriveOutcomeJobExecutionEventId` already establishes for this
 * codebase (`outcome-job-execution-event.ts`), and every other `*Key` helper
 * (`executionRunKey` et al.) already follows.
 *
 * Rev177 F1: a plain `::`-delimited join (this function's original
 * implementation) is NOT injective - caller-controlled opaque identifiers are
 * legal to contain `::` themselves, so e.g. `(customerId="a::b", projectId="c")`
 * and `(customerId="a", projectId="b::c")` produced the IDENTICAL scope key
 * under the old encoding despite being genuinely distinct scopes, which could
 * merge two different customers'/projects' allowance accounting into one
 * bucket. `JSON.stringify` escapes embedded quote/delimiter characters inside
 * each element, so no legal identifier value can ever produce a colliding
 * encoding for a different tuple. Identifiers themselves remain fully
 * unrestricted (never banned/sanitized/escaped) - only the KEY DERIVATION
 * changed. `postgres-quota-reservation-store.ts` never reconstructs this key
 * itself; it always receives the value this function returns as a plain
 * query parameter, exactly like every other Postgres store in this
 * repository already does for its own eventId (see
 * `PostgresOutcomeJobExecutionStore`).
 */
export function quotaScopeKey(scope: QuotaAdmissionScope): string {
  return JSON.stringify([scope.tenantId, scope.customerId, scope.projectId, scope.planId, scope.planVersion]);
}

/**
 * Rev177 F10: quota is split into a REQUIRED unit floor and an OPTIONAL
 * monetary dimension, rather than one single monetary `limit` field.
 *
 * `unitLimit` is a finite, policy-proven count of admittable reservations
 * for this scope - structurally knowable and enforceable regardless of
 * whether any real monetary cost telemetry exists (the activated
 * `WorkerInvoker` boundary never reports real provider cost, only whether
 * an attempt occurred at all), so it is the one hard ceiling that ALWAYS
 * applies. `monetaryLimit`, when supplied, must always be a REPORTED
 * `CostAmount` (G1/POLICY VALUES: "never invent limits" - an envelope
 * cannot opt into monetary enforcement with no known numeric ceiling); when
 * omitted, this scope simply has no monetary ceiling to protect, and the
 * unit floor alone governs admission. The caller's own integration layer
 * remains responsible for treating "no envelope available at all" as
 * BLOCKED/UNAVAILABLE, never as "unlimited."
 */
export interface QuotaEnvelope {
  readonly scope: QuotaAdmissionScope;
  readonly envelopeRef: string;
  readonly sourceFingerprint: string;
  readonly unitLimit: number;
  readonly monetaryLimit?: CostAmount;
}

export function createQuotaEnvelope(input: {
  scope: QuotaAdmissionScope;
  envelopeRef: unknown;
  sourceFingerprint: unknown;
  unitLimit: unknown;
  monetaryLimit?: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
}): QuotaEnvelope {
  const unitLimit = requireNonNegativeInteger(input.unitLimit, "unitLimit");
  let monetaryLimit: CostAmount | undefined;
  if (input.monetaryLimit !== undefined) {
    monetaryLimit = createCostAmount(input.monetaryLimit);
    if (monetaryLimit.presence !== "REPORTED") {
      throw new InvalidQuotaAdmissionError(
        "envelope monetaryLimit, when supplied, must be REPORTED - an envelope cannot opt into monetary enforcement with no known numeric ceiling (never invent a limit)",
      );
    }
  }
  return {
    scope: input.scope,
    envelopeRef: requireNonEmptyString(input.envelopeRef, "envelopeRef"),
    sourceFingerprint: requireNonEmptyString(input.sourceFingerprint, "sourceFingerprint"),
    unitLimit,
    ...(monetaryLimit !== undefined ? { monetaryLimit } : {}),
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
/**
 * Rev177 F2: `sourceFingerprint` is the exact envelope/policy VERSION this
 * reservation was admitted (or rejected) against - captured once, durably,
 * at admission time, and carried forward unchanged onto every later
 * COMMITTED/RELEASED/RECONCILIATION_REQUIRED transition of the SAME
 * reservation (mirroring how `envelopeRef` already propagates). Rev174
 * required reservation identity/content to bind the exact current envelope
 * version, not merely its `envelopeRef` name - two envelopes can share an
 * `envelopeRef` across a policy edit while genuinely differing in effective
 * limit/terms, and only `sourceFingerprint` proves which exact version was
 * actually in force. A conflicting replay (same idempotencyKey, different
 * sourceFingerprint) fails closed exactly like a differing envelopeRef/
 * amount/identity already does (see `assertReplayMatchesOriginalRequest`).
 */
export interface QuotaReservationEvent {
  readonly eventId: string;
  readonly identity: QuotaReservationIdentity;
  readonly idempotencyKey: string;
  readonly envelopeRef: string;
  readonly sourceFingerprint: string;
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
 *
 * Rev177 F1: `JSON.stringify` of the ordered tuple, not a `::`-delimited
 * join - the same collision-safety fix as `quotaScopeKey` above, for exactly
 * the same reason (`jobId="a::b"`/`runId="c"` colliding with `jobId="a"`/
 * `runId="b::c"` under the old encoding). `quotaScopeKey(identity.scope)`'s
 * own return value is embedded as ONE opaque string element here - nesting a
 * `JSON.stringify` result inside another `JSON.stringify` call remains
 * collision-safe, since the outer call re-escapes the inner string's own
 * quote characters, so no ambiguity is introduced by nesting.
 */
export function deriveQuotaReservationEventId(identity: QuotaReservationIdentity, idempotencyKey: string, type: QuotaReservationEventType): string {
  return JSON.stringify([quotaScopeKey(identity.scope), identity.jobId, identity.runId, identity.attemptRef, idempotencyKey, type]);
}

/**
 * Rev177 F1 (technical refinement): the ONE canonical attempt-identity
 * idempotency key derivation - `[jobId, runId, attemptRef]`, collision-safe
 * via `JSON.stringify` exactly like `quotaScopeKey`/`deriveQuotaReservationEventId`
 * above. Exported so `outcome-job-execution-runtime.ts` reuses this single
 * definition instead of inlining its own separate encoding of the same
 * tuple, which risks the two independently drifting out of sync.
 */
export function deriveQuotaReservationIdempotencyKey(identity: QuotaReservationIdentity): string {
  return JSON.stringify([identity.jobId, identity.runId, identity.attemptRef]);
}

export interface QuotaLedger {
  readonly events: ReadonlyArray<QuotaReservationEvent>;
}

export const EMPTY_QUOTA_LEDGER: QuotaLedger = { events: [] };

function appendToLedger(ledger: QuotaLedger, event: QuotaReservationEvent): QuotaLedger {
  return { events: [...ledger.events, event] };
}

/**
 * Rev177 F7 clarification: the reservation's CANONICAL latest lifecycle
 * event for this exact `(tenantId, idempotencyKey)` - of ANY type, not just
 * RESERVED/REJECTED. A historical-type-only lookup would find a stale
 * RESERVED/REJECTED row and treat it as still current even after the SAME
 * reservation has since moved on to a genuine terminal disposition
 * (COMMITTED/RELEASED/RECONCILIATION_REQUIRED) - incorrectly allowing that
 * terminal reservation to "replay as current RESERVED" or be silently
 * re-decided. `admitQuotaReservation` uses this to fail closed the moment a
 * caller tries to re-admit against an idempotencyKey that has already
 * terminally settled, rather than resurrecting or echoing a stale decision.
 */
/**
 * Rev179 F14: exported so a store's own `peekSettlement` (a pure,
 * non-mutating read of whether a reservation has already reached a genuine
 * terminal disposition) can reuse the SAME canonical-latest lookup
 * `admitQuotaReservation`/`commitQuotaUsage` themselves rely on, rather than
 * risk an independently-reimplemented, possibly-drifted copy.
 */
export function findCanonicalLatestForIdempotencyKey(ledger: QuotaLedger, tenantId: TenantScope["tenantId"], idempotencyKey: string): QuotaReservationEvent | undefined {
  let latest: QuotaReservationEvent | undefined;
  for (const event of ledger.events) {
    if (event.identity.scope.tenantId === tenantId && event.idempotencyKey === idempotencyKey) {
      latest = event;
    }
  }
  return latest;
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
  /**
   * Rev177 F10: unit counts mirror `reservedTotal`/`committedTotal`'s own
   * split, but COUNT reservations (one per distinct reservation) rather
   * than SUM a monetary amount - the count is always knowable regardless of
   * whether the reservation's own monetary amount is REPORTED or UNKNOWN.
   * `unitReservedCount` is RESERVED-only; `unitCommittedCount` is
   * COMMITTED+RECONCILIATION_REQUIRED (the same "still counts against
   * allowance" set `committedTotal` already uses). Unlike `committedTotal`,
   * neither of these is ever "incomplete" - a reservation either occurred
   * or it did not, independent of whether its real dollar cost is known.
   */
  readonly unitReservedCount: number;
  readonly unitCommittedCount: number;
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
  let unitReservedCount = 0;
  let unitCommittedCount = 0;
  for (const [key, event] of latestByReservation.entries()) {
    if (event.type === "RESERVED") {
      unitReservedCount += 1;
      if (event.amount?.presence === "REPORTED") {
        reservedTotal += event.amount.amountMinorUnits as number;
      }
    } else if (event.type === "COMMITTED" || event.type === "RECONCILIATION_REQUIRED") {
      unitCommittedCount += 1;
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
  return { reservedTotal, committedTotal, hasUnknownCommitted, unitReservedCount, unitCommittedCount };
}

export type QuotaAdmissionOutcome =
  | { readonly status: "RESERVED"; readonly event: QuotaReservationEvent }
  | { readonly status: "REJECTED"; readonly event: QuotaReservationEvent };

/**
 * Rev177 F2: the ONE conflicting-replay check, extracted so every adapter
 * that decides admission outside the pure ledger fold (currently only
 * `PostgresQuotaReservationStore.admit()`, which must issue a single atomic
 * SQL statement rather than call this function directly) can enforce the
 * IDENTICAL fail-closed contract `admitQuotaReservation` enforces below,
 * rather than drifting into a weaker, independently-reimplemented check.
 * Throws `QuotaReservationConflictError` the moment a same-idempotencyKey
 * replay's identity, envelopeRef, sourceFingerprint, or requestedAmount
 * differs from what `existing` already durably recorded.
 */
export function assertReplayMatchesOriginalRequest(
  existing: QuotaReservationEvent,
  request: {
    readonly identity: QuotaReservationIdentity;
    readonly envelopeRef: string;
    readonly sourceFingerprint: string;
    readonly requestedAmount: CostAmount;
  },
  idempotencyKey: string,
): void {
  if (
    !identitiesEqual(existing.identity, request.identity) ||
    existing.envelopeRef !== request.envelopeRef ||
    existing.sourceFingerprint !== request.sourceFingerprint ||
    !amountsEqual(existing.amount, request.requestedAmount)
  ) {
    throw new QuotaReservationConflictError(idempotencyKey, "identity, envelopeRef, sourceFingerprint, or requestedAmount differs from the original request");
  }
}

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
 *
 * Rev176 "rejected-then-later-admissible recovery": a RESERVED decision is
 * PERMANENT - it already durably consumed real allowance, so replaying it
 * always returns the exact same event, never re-evaluated. A REJECTED
 * decision consumed no allowance at all, so - unlike RESERVED - it is safe,
 * and required, to re-evaluate fresh against CURRENT usage on a later call
 * with the identical request: circumstances (another reservation committed/
 * released) may have changed since the original rejection, and a caller
 * must not be permanently stuck replaying a stale rejection forever. If the
 * fresh evaluation still does not fit, the ORIGINAL cached REJECTED event is
 * returned unchanged (never a duplicate-eventId second REJECTED entry) -
 * only an actual upgrade to RESERVED (a genuinely new, distinct eventId)
 * ever appends a new event once a REJECTED one already exists.
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

  // Rev177 F7: the CANONICAL latest event for this idempotencyKey, of any
  // type - not merely a RESERVED/REJECTED-only historical lookup, which
  // would otherwise find a now-stale RESERVED/REJECTED row and treat it as
  // still current even after the SAME reservation has since moved on to a
  // genuine terminal disposition.
  const canonicalLatest = findCanonicalLatestForIdempotencyKey(input.ledger, input.identity.scope.tenantId, idempotencyKey);
  if (canonicalLatest !== undefined && canonicalLatest.type !== "RESERVED" && canonicalLatest.type !== "REJECTED") {
    throw new QuotaReservationAlreadySettledError(idempotencyKey, canonicalLatest.type);
  }
  const existing = canonicalLatest;
  if (existing !== undefined) {
    assertReplayMatchesOriginalRequest(
      existing,
      { identity: input.identity, envelopeRef: input.envelope.envelopeRef, sourceFingerprint: input.envelope.sourceFingerprint, requestedAmount },
      idempotencyKey,
    );
    if (existing.type === "RESERVED") {
      return { ledger: input.ledger, outcome: { status: "RESERVED", event: existing } };
    }
    // existing.type === "REJECTED": fall through to a fresh re-evaluation
    // below rather than returning immediately.
  }

  // `existing` (when REJECTED) never contributed to reservedTotal/
  // committedTotal/unitCount, so this projection already reflects true
  // current usage with no double-exclusion bookkeeping needed.
  const usage = projectQuotaScopeUsage(input.ledger, input.envelope.scope);

  function rejectWith(reason: string): { readonly ledger: QuotaLedger; readonly outcome: QuotaAdmissionOutcome } {
    if (existing !== undefined) {
      // Still does not fit - replay the original cached rejection rather
      // than appending an identical-eventId duplicate.
      return { ledger: input.ledger, outcome: { status: "REJECTED", event: existing } };
    }
    const event: QuotaReservationEvent = {
      eventId: deriveQuotaReservationEventId(input.identity, idempotencyKey, "REJECTED"),
      identity: input.identity,
      idempotencyKey,
      envelopeRef: input.envelope.envelopeRef,
      sourceFingerprint: input.envelope.sourceFingerprint,
      type: "REJECTED",
      occurredAt,
      // OS-V0-15 (Rev197 #11 retry-storm witness): always set, mirroring the
      // RESERVED event below - previously omitted for a non-REPORTED
      // (UNKNOWN) requestedAmount, which left `existing.amount` undefined
      // while every later replay's freshly-derived `requestedAmount` was a
      // real `{presence:"UNKNOWN"}` object; `amountsEqual` then disagreed on
      // the very next identical retry, throwing `QuotaReservationConflictError`
      // instead of safely replaying the cached REJECTED outcome.
      amount: requestedAmount,
      reason,
    };
    return { ledger: appendToLedger(input.ledger, event), outcome: { status: "REJECTED", event } };
  }

  // Rev177 F10: the unit floor is the ALWAYS-enforced hard ceiling - a
  // finite, policy-proven count of admittable reservations, structurally
  // knowable regardless of whether real monetary cost telemetry exists.
  // Checked first, before any monetary consideration, and independent of
  // whether the envelope even configured a monetary dimension at all.
  if (usage.unitReservedCount + usage.unitCommittedCount + 1 > input.envelope.unitLimit) {
    return rejectWith("insufficient unit allowance remaining under the current envelope's unit floor");
  }

  if (input.envelope.monetaryLimit !== undefined) {
    // Rev177 F6 (rescoped, unblocked by F10): once any committed usage in
    // this scope has an UNKNOWN actual monetary cost, the scope's remaining
    // MONETARY allowance can no longer be trusted - but this can only ever
    // matter for a scope that actually configured a monetary ceiling to
    // protect. A scope with no monetaryLimit has no monetary allowance to
    // protect, and the unit floor above remains the sole, always-truthful
    // gate - this is exactly what makes F6 implementable at all under the
    // current activated WorkerInvoker, which always honestly commits
    // UNKNOWN actual cost (no real provider telemetry exists).
    if (usage.hasUnknownCommitted) {
      return rejectWith(
        "an UNKNOWN committed monetary usage already exists in this scope - further monetary-ceiling-dependent admission cannot trust the remaining monetary allowance",
      );
    }
    if (requestedAmount.presence === "UNKNOWN") {
      // UNKNOWN is unconditionally inadmissible against a REAL monetary
      // ceiling - it is never treated as zero.
      return rejectWith("an UNKNOWN estimated cost cannot be admitted against a monetary ceiling - it is never treated as zero");
    }
    if (requestedAmount.currency !== input.envelope.monetaryLimit.currency) {
      throw new InvalidQuotaAdmissionError(
        `requestedAmount currency "${requestedAmount.currency}" does not match envelope monetaryLimit currency "${input.envelope.monetaryLimit.currency}"`,
      );
    }
    const projectedTotal = usage.reservedTotal + usage.committedTotal + (requestedAmount.amountMinorUnits as number);
    if (projectedTotal > (input.envelope.monetaryLimit.amountMinorUnits as number)) {
      return rejectWith("insufficient monetary allowance remaining under the current envelope's monetaryLimit");
    }
  }

  const event: QuotaReservationEvent = {
    eventId: deriveQuotaReservationEventId(input.identity, idempotencyKey, "RESERVED"),
    identity: input.identity,
    idempotencyKey,
    envelopeRef: input.envelope.envelopeRef,
    sourceFingerprint: input.envelope.sourceFingerprint,
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

  // Rev177 F7: a RELEASED reservation is a genuine terminal disposition -
  // its allowance has already been returned to the pool. Committing usage
  // against it now would fabricate spend for allowance the scope no longer
  // considers held, silently "resurrecting" a settled reservation.
  if (reservation.type === "RELEASED") {
    throw new QuotaReservationAlreadySettledError(idempotencyKey, "RELEASED");
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
    // Rev177 F7: never perform minor-unit arithmetic across different
    // currencies - a currency mismatch here means the caller supplied an
    // actual denominated differently than the reservation itself, which can
    // never happen for a genuinely correct caller and must fail closed
    // rather than silently subtracting incompatible units.
    // Rev177 F7: never perform minor-unit arithmetic across different
    // currencies - a currency mismatch here means the caller supplied an
    // actual denominated differently than the reservation itself, which can
    // never happen for a genuinely correct caller and must fail closed
    // rather than silently subtracting incompatible units.
    if (actualAmount.currency !== reservation.amount.currency) {
      throw new InvalidQuotaAdmissionError(
        `actualAmount currency "${actualAmount.currency}" does not match the reservation's own currency "${reservation.amount.currency}" - cross-currency overage arithmetic is never performed`,
      );
    }
    const overage = (actualAmount.amountMinorUnits as number) - (reservation.amount.amountMinorUnits as number);
    if (overage > 0) {
      const allowedOverageAmount =
        input.allowedOverage !== undefined
          ? createCostAmount(input.allowedOverage)
          : ({ presence: "REPORTED", amountMinorUnits: 0, currency: actualAmount.currency } as CostAmount);
      // Rev177 F7: "UNKNOWN/mismatched allowedOverage cannot yield a clean
      // COMMITTED." A tolerance that is itself UNKNOWN, or denominated in a
      // different currency than the actual, proves nothing about whether
      // this overage was actually allowed - it must be treated the same as
      // exceeding the tolerance, never silently treated as "no tolerance
      // check applies."
      const provenWithinTolerance =
        allowedOverageAmount.presence === "REPORTED" &&
        allowedOverageAmount.currency === actualAmount.currency &&
        overage <= (allowedOverageAmount.amountMinorUnits as number);
      if (!provenWithinTolerance) {
        type = "RECONCILIATION_REQUIRED";
        reason =
          allowedOverageAmount.presence !== "REPORTED"
            ? `actual usage exceeded its reservation by ${overage} minor units, and the allowed overage tolerance is itself UNKNOWN - an unproven tolerance can never authorize a clean commit`
            : allowedOverageAmount.currency !== actualAmount.currency
              ? `actual usage exceeded its reservation by ${overage} minor units, but the allowed overage tolerance is denominated in a different currency ("${allowedOverageAmount.currency}") and cannot be compared`
              : `actual usage exceeded its reservation by ${overage} minor units, beyond the allowed overage of ${allowedOverageAmount.amountMinorUnits}`;
      }
    }
  }

  const event: QuotaReservationEvent = {
    eventId: deriveQuotaReservationEventId(input.identity, idempotencyKey, type),
    identity: input.identity,
    idempotencyKey,
    envelopeRef: reservation.envelopeRef,
    sourceFingerprint: reservation.sourceFingerprint,
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
    sourceFingerprint: reservation.sourceFingerprint,
    type: "RELEASED",
    occurredAt,
    ...(reservation.amount !== undefined ? { amount: reservation.amount } : {}),
    ...(input.reason !== undefined ? { reason: requireNonEmptyString(input.reason, "reason") } : {}),
  };
  return { ledger: appendToLedger(input.ledger, event), outcome: { status: "RELEASED", event } };
}

/**
 * Rev177 F10: the unit dimension is NEVER "incomplete" - a reservation
 * either occurred or it did not, independent of whether its real dollar
 * cost is known, so `unitLimit`/`unitReserved`/`unitCommitted`/
 * `unitRemaining` are always present and always numeric. The monetary
 * dimension remains its own independently-truthful sub-projection:
 * `NOT_CONFIGURED` when the envelope has no `monetaryLimit` at all (there is
 * no monetary ceiling to report against), `INCOMPLETE` when
 * Minimum Adversarial Evidence #16's UNKNOWN-committed-actual case makes a
 * numeric `remaining` genuinely unrepresentable (never fabricated, never
 * confused with a real `0`), or `COMPUTED` otherwise.
 */
export type QuotaMonetaryReadModel =
  | {
      readonly status: "COMPUTED";
      readonly limit: CostAmount;
      readonly reserved: number;
      readonly committed: number;
      readonly remaining: number;
    }
  | { readonly status: "INCOMPLETE"; readonly reason: string }
  | { readonly status: "NOT_CONFIGURED" };

export interface QuotaReadModel {
  readonly unitLimit: number;
  readonly unitReserved: number;
  readonly unitCommitted: number;
  readonly unitRemaining: number;
  readonly monetary: QuotaMonetaryReadModel;
}

export function projectQuotaReadModel(ledger: QuotaLedger, envelope: QuotaEnvelope): QuotaReadModel {
  const usage = projectQuotaScopeUsage(ledger, envelope.scope);
  const unitRemaining = envelope.unitLimit - usage.unitReservedCount - usage.unitCommittedCount;

  let monetary: QuotaMonetaryReadModel;
  if (envelope.monetaryLimit === undefined) {
    monetary = { status: "NOT_CONFIGURED" };
  } else if (usage.hasUnknownCommitted) {
    monetary = {
      status: "INCOMPLETE",
      reason: "at least one committed usage event has an UNKNOWN actual cost - remaining monetary allowance cannot be computed",
    };
  } else {
    const remaining = (envelope.monetaryLimit.amountMinorUnits as number) - usage.reservedTotal - usage.committedTotal;
    monetary = { status: "COMPUTED", limit: envelope.monetaryLimit, reserved: usage.reservedTotal, committed: usage.committedTotal, remaining };
  }

  return {
    unitLimit: envelope.unitLimit,
    unitReserved: usage.unitReservedCount,
    unitCommitted: usage.unitCommittedCount,
    unitRemaining,
    monetary,
  };
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
    sourceFingerprint?: unknown;
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
  const sourceFingerprint = requireNonEmptyString(candidate.sourceFingerprint, "sourceFingerprint");
  const occurredAt = requireValidTimestamp(candidate.occurredAt, "occurredAt");
  const type = candidate.type as QuotaReservationEventType;
  const expectedEventId = deriveQuotaReservationEventId(identity, idempotencyKey, type);
  if (candidate.eventId !== expectedEventId) {
    throw new InvalidQuotaAdmissionError(
      `eventId does not match its own canonical derivation from identity/idempotencyKey/type (forged or corrupted record)`,
    );
  }
  const amount = reconstructCostAmount(candidate.amount, "amount");
  // Rev177 F7/F10: a RESERVED row can only ever have been constructed by
  // `admitQuotaReservation` with SOME `amount` recorded (REPORTED when a
  // monetary estimate was supplied, or UNKNOWN when the envelope has no
  // `monetaryLimit` to protect and the estimate genuinely was not known) -
  // `admitQuotaReservation` never constructs a RESERVED event without an
  // `amount` field at all, so a persisted RESERVED row with a MISSING
  // amount is structurally impossible truth. Rev177 F10 relaxed this from
  // "must be REPORTED" once an UNKNOWN-amount RESERVED row became a
  // legitimate outcome (a scope with no monetary ceiling never rejects an
  // UNKNOWN estimate).
  if (type === "RESERVED" && amount === undefined) {
    throw new InvalidQuotaAdmissionError("a RESERVED record must carry an amount (REPORTED or UNKNOWN) - a missing amount on a RESERVED row is corrupted/malformed truth");
  }
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
    sourceFingerprint,
    type,
    occurredAt,
    ...(amount !== undefined ? { amount } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(attribution !== undefined ? { attribution } : {}),
  };
}
