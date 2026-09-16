import type { TenantScope } from "./tenant-scope.js";

/**
 * MET-001A — Execution-Economics Attribution Floor (Rev8/Rev9 selection,
 * Master Roadmap MET-001 "Execution Economics & Model Performance
 * Telemetry"). Bounded dark/internal slice only: attribution-safe
 * per-Project/PlanVersion/Job/Task/Run/Attempt cost, usage, time and
 * rework/independent-QA event capture, idempotent replay protection, and
 * a comparable-verified-cohort guard.
 *
 * Deliberately does not touch customer billing, payment/invoice/charge
 * state, quotes/prices, or any provider/live effect - this module never
 * calls a real provider, never reads the system clock, and never invents
 * a value the caller did not supply. "Missing vs zero" and "computed,
 * never stored" discipline mirror `observability-telemetry.ts`; opaque,
 * never-interpreted refs mirror `connection-authority.ts`/`integration-
 * connector-catalog.ts`. Worker/provider/model/route identity is captured
 * only when the caller exposes it - absence is explicit, never a
 * fabricated identity.
 */

export class InvalidExecutionEconomicsError extends Error {
  constructor(reason: string) {
    super(`Invalid execution-economics operation: ${reason}`);
    this.name = "InvalidExecutionEconomicsError";
  }
}

export class DuplicateIdempotencyKeyConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(
      `idempotencyKey "${idempotencyKey}" was already recorded with materially different event content - a duplicate idempotency key may only replay the identical event, never overwrite it`,
    );
    this.name = "DuplicateIdempotencyKeyConflictError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidExecutionEconomicsError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidExecutionEconomicsError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidExecutionEconomicsError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidExecutionEconomicsError(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(raw))) {
    throw new InvalidExecutionEconomicsError(`${field} must be a valid ISO timestamp`);
  }
  return raw;
}

function requireFiniteNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InvalidExecutionEconomicsError(`${field} must be a finite number >= 0`);
  }
  return value;
}

/**
 * Exact hierarchy binding required by MET-001A's own acceptance contract:
 * "Every execution-economics event must bind unambiguously to tenant +
 * project + ProjectPlanVersion + OutcomeJob + task/step + run + attempt."
 * `taskRef`/`runRef`/`attemptRef` are opaque caller-supplied identifiers
 * (this repository has no first-class Task/Run/Attempt type to reuse) -
 * this module never interprets them, only carries and compares them for
 * identity, matching this codebase's established opaque-ref discipline.
 */
export interface ExecutionEconomicsLineage {
  readonly tenantId: TenantScope["tenantId"];
  readonly projectId: string;
  readonly planId: string;
  readonly jobId: string;
  readonly taskRef: string;
  readonly runRef: string;
  readonly attemptRef: string;
}

export function createExecutionEconomicsLineage(input: {
  tenantScope: TenantScope;
  projectId: unknown;
  planId: unknown;
  jobId: unknown;
  taskRef: unknown;
  runRef: unknown;
  attemptRef: unknown;
}): ExecutionEconomicsLineage {
  return {
    tenantId: input.tenantScope.tenantId,
    projectId: requireNonEmptyString(input.projectId, "projectId"),
    planId: requireNonEmptyString(input.planId, "planId"),
    jobId: requireNonEmptyString(input.jobId, "jobId"),
    taskRef: requireNonEmptyString(input.taskRef, "taskRef"),
    runRef: requireNonEmptyString(input.runRef, "runRef"),
    attemptRef: requireNonEmptyString(input.attemptRef, "attemptRef"),
  };
}

function lineagesMatch(a: ExecutionEconomicsLineage, b: ExecutionEconomicsLineage): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.projectId === b.projectId &&
    a.planId === b.planId &&
    a.jobId === b.jobId &&
    a.taskRef === b.taskRef &&
    a.runRef === b.runRef &&
    a.attemptRef === b.attemptRef
  );
}

/** "Subscription-vs-API/PAYG surface": honest usage-source declaration, never inferred. */
export type UsageSource = "API_PAYG" | "SUBSCRIPTION_SHARED" | "OTHER_ADMITTED";

const RECOGNIZED_USAGE_SOURCES: ReadonlySet<UsageSource> = new Set([
  "API_PAYG",
  "SUBSCRIPTION_SHARED",
  "OTHER_ADMITTED",
]);

export function isRecognizedUsageSource(value: unknown): value is UsageSource {
  return typeof value === "string" && RECOGNIZED_USAGE_SOURCES.has(value as UsageSource);
}

/**
 * "Keep Marginal Cash, allocated subscription/shared cost, Human Shadow
 * cost and Total Delivery Cost distinct." Each bucket is captured
 * separately and a job/run may carry at most one entry per kind (a
 * second entry for the same kind must be a new event, not a silent
 * overwrite of this one).
 */
export type CostBucketKind = "MARGINAL_CASH" | "ALLOCATED_SUBSCRIPTION" | "HUMAN_SHADOW";

const RECOGNIZED_COST_BUCKET_KINDS: ReadonlySet<CostBucketKind> = new Set([
  "MARGINAL_CASH",
  "ALLOCATED_SUBSCRIPTION",
  "HUMAN_SHADOW",
]);

/**
 * "Unknown data stays labeled" / "missing-vs-zero": mirrors
 * `observability-telemetry.ts`'s own `MetricValuePresence` discipline. An
 * `UNKNOWN` cost component can never be conflated with a reported `0`.
 */
export type CostPresence = "REPORTED" | "UNKNOWN";

export interface CostAmount {
  readonly presence: CostPresence;
  readonly amountMinorUnits?: number;
  readonly currency?: string;
}

export function createCostAmount(input: {
  presence: unknown;
  amountMinorUnits?: unknown;
  currency?: unknown;
}): CostAmount {
  if (input.presence !== "REPORTED" && input.presence !== "UNKNOWN") {
    throw new InvalidExecutionEconomicsError('presence must be "REPORTED" or "UNKNOWN"');
  }
  if (input.presence === "UNKNOWN") {
    if (input.amountMinorUnits !== undefined || input.currency !== undefined) {
      throw new InvalidExecutionEconomicsError("amountMinorUnits/currency must not be supplied when presence is UNKNOWN");
    }
    return { presence: "UNKNOWN" };
  }
  return {
    presence: "REPORTED",
    amountMinorUnits: requireFiniteNonNegativeNumber(input.amountMinorUnits, "amountMinorUnits"),
    currency: requireNonEmptyString(input.currency, "currency"),
  };
}

export interface CostBucketEntry {
  readonly kind: CostBucketKind;
  readonly amount: CostAmount;
}

function createCostBucketEntry(input: { kind: unknown; amount: unknown }): CostBucketEntry {
  if (!RECOGNIZED_COST_BUCKET_KINDS.has(input.kind as CostBucketKind)) {
    throw new InvalidExecutionEconomicsError(`kind must be one of ${Array.from(RECOGNIZED_COST_BUCKET_KINDS).join(", ")}`);
  }
  return { kind: input.kind as CostBucketKind, amount: input.amount as CostAmount };
}

/**
 * "Capture worker/provider/model/route only when exposed by real
 * execution facts; absence is explicit and does not invent model/provider
 * identity." Every field is optional and, if present, an opaque non-empty
 * string - this module never fabricates a value for an absent field.
 */
export interface ProviderAttribution {
  readonly workerRef?: string;
  readonly providerRef?: string;
  readonly modelRef?: string;
  readonly routeRef?: string;
}

function createProviderAttribution(input: {
  workerRef?: unknown;
  providerRef?: unknown;
  modelRef?: unknown;
  routeRef?: unknown;
}): ProviderAttribution {
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

/**
 * "Capture active time, wall time, Human Minutes, rework and
 * independent-QA/verification facts as separately attributable
 * fields/events; wait/blocker time must not be silently counted as
 * active execution." Enforced structurally: `activeTimeMs` can never
 * exceed `wallTimeMs` when both are supplied.
 */
export interface TimeAttribution {
  readonly activeTimeMs?: number;
  readonly wallTimeMs?: number;
  readonly humanMinutes?: number;
  readonly reworkCount?: number;
  readonly independentQaPerformed?: boolean;
}

function createTimeAttribution(input: {
  activeTimeMs?: unknown;
  wallTimeMs?: unknown;
  humanMinutes?: unknown;
  reworkCount?: unknown;
  independentQaPerformed?: unknown;
}): TimeAttribution {
  const time: {
    activeTimeMs?: number;
    wallTimeMs?: number;
    humanMinutes?: number;
    reworkCount?: number;
    independentQaPerformed?: boolean;
  } = {};
  if (input.activeTimeMs !== undefined) time.activeTimeMs = requireFiniteNonNegativeNumber(input.activeTimeMs, "activeTimeMs");
  if (input.wallTimeMs !== undefined) time.wallTimeMs = requireFiniteNonNegativeNumber(input.wallTimeMs, "wallTimeMs");
  if (time.activeTimeMs !== undefined && time.wallTimeMs !== undefined && time.activeTimeMs > time.wallTimeMs) {
    throw new InvalidExecutionEconomicsError(
      "activeTimeMs must not exceed wallTimeMs - wait/blocker time must not be counted as active execution",
    );
  }
  if (input.humanMinutes !== undefined) time.humanMinutes = requireFiniteNonNegativeNumber(input.humanMinutes, "humanMinutes");
  if (input.reworkCount !== undefined) time.reworkCount = requireFiniteNonNegativeNumber(input.reworkCount, "reworkCount");
  if (input.independentQaPerformed !== undefined) {
    if (typeof input.independentQaPerformed !== "boolean") {
      throw new InvalidExecutionEconomicsError("independentQaPerformed must be a boolean");
    }
    time.independentQaPerformed = input.independentQaPerformed;
  }
  return time;
}

export interface ExecutionEconomicsEvent {
  readonly lineage: ExecutionEconomicsLineage;
  readonly idempotencyKey: string;
  readonly usageSource: UsageSource;
  readonly costBuckets: ReadonlyArray<CostBucketEntry>;
  readonly attribution: ProviderAttribution;
  readonly time: TimeAttribution;
  readonly capturedAt: string;
}

export function recordExecutionEconomicsEvent(input: {
  lineage: ExecutionEconomicsLineage;
  idempotencyKey: unknown;
  usageSource: unknown;
  costBuckets: ReadonlyArray<{ kind: unknown; amount: CostAmount }>;
  attribution?: {
    workerRef?: unknown;
    providerRef?: unknown;
    modelRef?: unknown;
    routeRef?: unknown;
  };
  time?: {
    activeTimeMs?: unknown;
    wallTimeMs?: unknown;
    humanMinutes?: unknown;
    reworkCount?: unknown;
    independentQaPerformed?: unknown;
  };
  capturedAt: unknown;
}): ExecutionEconomicsEvent {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  if (!isRecognizedUsageSource(input.usageSource)) {
    throw new InvalidExecutionEconomicsError(`usageSource must be one of ${Array.from(RECOGNIZED_USAGE_SOURCES).join(", ")}`);
  }
  const costBuckets = input.costBuckets.map((entry) => createCostBucketEntry(entry));
  const seenKinds = new Set<CostBucketKind>();
  for (const entry of costBuckets) {
    if (seenKinds.has(entry.kind)) {
      throw new InvalidExecutionEconomicsError(`cost bucket kind "${entry.kind}" was supplied more than once in the same event`);
    }
    seenKinds.add(entry.kind);
  }
  return {
    lineage: input.lineage,
    idempotencyKey,
    usageSource: input.usageSource,
    costBuckets,
    attribution: createProviderAttribution(input.attribution ?? {}),
    time: createTimeAttribution(input.time ?? {}),
    capturedAt: requireValidTimestamp(input.capturedAt, "capturedAt"),
  };
}

function eventsAreIdenticalReplay(a: ExecutionEconomicsEvent, b: ExecutionEconomicsEvent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * "Record events idempotently with durable event/idempotency identity
 * semantics so replay/duplicate delivery cannot double-count usage, time
 * or cost." An identical replay of an already-recorded `idempotencyKey`
 * is a safe no-op; a conflicting replay (same key, different content)
 * fails closed rather than silently overwriting the original.
 */
export interface ExecutionEconomicsLedger {
  readonly events: ReadonlyArray<ExecutionEconomicsEvent>;
}

export const EMPTY_EXECUTION_ECONOMICS_LEDGER: ExecutionEconomicsLedger = { events: [] };

export function appendExecutionEconomicsEvent(
  ledger: ExecutionEconomicsLedger,
  event: ExecutionEconomicsEvent,
): ExecutionEconomicsLedger {
  const existing = ledger.events.find(
    (e) => e.lineage.tenantId === event.lineage.tenantId && e.idempotencyKey === event.idempotencyKey,
  );
  if (existing !== undefined) {
    if (eventsAreIdenticalReplay(existing, event)) {
      return ledger;
    }
    throw new DuplicateIdempotencyKeyConflictError(event.idempotencyKey);
  }
  return { events: [...ledger.events, event] };
}

/**
 * "Aggregation/projection must enforce tenant/project/plan/job/run/
 * attempt isolation and reject mismatched lineage; events from another
 * tenant/project/run cannot leak into totals." An exact-match filter on
 * every supplied scope field is itself the isolation guarantee - an event
 * whose lineage does not match every supplied field is excluded, never
 * partially matched.
 */
export interface ExecutionEconomicsScope {
  readonly tenantId: TenantScope["tenantId"];
  readonly projectId: string;
  readonly planId: string;
  readonly jobId?: string;
}

export function selectExecutionEconomicsEvents(
  ledger: ExecutionEconomicsLedger,
  scope: ExecutionEconomicsScope,
): ReadonlyArray<ExecutionEconomicsEvent> {
  return ledger.events.filter(
    (e) =>
      e.lineage.tenantId === scope.tenantId &&
      e.lineage.projectId === scope.projectId &&
      e.lineage.planId === scope.planId &&
      (scope.jobId === undefined || e.lineage.jobId === scope.jobId),
  );
}

export type CostRollupResult =
  | { readonly status: "COMPUTED"; readonly amountMinorUnits: number; readonly currency: string }
  | { readonly status: "INCOMPLETE"; readonly reason: string };

function rollUpCostAmounts(amounts: ReadonlyArray<CostAmount>): CostRollupResult {
  if (amounts.length === 0) {
    return { status: "INCOMPLETE", reason: "no cost data recorded for this scope" };
  }
  if (amounts.some((a) => a.presence === "UNKNOWN")) {
    return { status: "INCOMPLETE", reason: "an UNKNOWN cost component is present - a total must not fabricate a value for it" };
  }
  const currencies = new Set(amounts.map((a) => a.currency));
  if (currencies.size > 1) {
    return { status: "INCOMPLETE", reason: `mixed/incompatible currencies present: ${Array.from(currencies).join(", ")}` };
  }
  const amountMinorUnits = amounts.reduce((sum, a) => sum + (a.amountMinorUnits as number), 0);
  const firstAmount = amounts[0];
  if (firstAmount === undefined) {
    throw new InvalidExecutionEconomicsError("unreachable: amounts.length was already confirmed > 0");
  }
  return { status: "COMPUTED", amountMinorUnits, currency: firstAmount.currency as string };
}

/** Resolves one cost bucket kind's total across the given events, kept structurally distinct from every other bucket and from the grand total. */
export function resolveCostBucketTotal(
  events: ReadonlyArray<ExecutionEconomicsEvent>,
  kind: CostBucketKind,
): CostRollupResult {
  const amounts = events.flatMap((e) => e.costBuckets.filter((b) => b.kind === kind).map((b) => b.amount));
  return rollUpCostAmounts(amounts);
}

/**
 * "Total may be computed only from compatible known components; mixed
 * currency or incompatible units or required unknown components must
 * fail closed or return an explicit incomplete/unknown disposition
 * rather than fabricate a number." Sums across all three buckets
 * together; any bucket kind absent entirely, `UNKNOWN`, or in a
 * conflicting currency makes the whole total `INCOMPLETE`.
 */
export function resolveTotalDeliveryCost(events: ReadonlyArray<ExecutionEconomicsEvent>): CostRollupResult {
  const amounts = events.flatMap((e) => e.costBuckets.map((b) => b.amount));
  return rollUpCostAmounts(amounts);
}

/**
 * "Add a bounded comparable-cohort guard: model/worker comparisons
 * require verified outcomes and structurally comparable cohort keys;
 * unverified or materially incompatible cohorts return
 * NOT_COMPARABLE/INSUFFICIENT_EVIDENCE rather than a winner/performance
 * claim." Internal measurement semantics only - never a customer/public
 * claim.
 */
export type CohortComparisonResult = "COMPARABLE" | "NOT_COMPARABLE" | "INSUFFICIENT_EVIDENCE";

export interface ExecutionEconomicsCohortKey {
  readonly jobFamily: string;
  readonly taskRef: string;
  readonly verified: boolean;
}

export function resolveCohortComparability(
  a: ExecutionEconomicsCohortKey,
  b: ExecutionEconomicsCohortKey,
): CohortComparisonResult {
  if (a.jobFamily !== b.jobFamily || a.taskRef !== b.taskRef) {
    return "NOT_COMPARABLE";
  }
  if (!a.verified || !b.verified) {
    return "INSUFFICIENT_EVIDENCE";
  }
  return "COMPARABLE";
}
