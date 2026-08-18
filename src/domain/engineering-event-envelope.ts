import type { Dec138Provenance } from "./dec-138-provenance.js";

export class InvalidEngineeringEventEnvelopeError extends Error {
  constructor(reason: string) {
    super(`Invalid EngineeringEventEnvelope: ${reason}`);
    this.name = "InvalidEngineeringEventEnvelopeError";
  }
}

export type EventId = string & { readonly __brand: "EngineeringEventId" };
export type TaskId = string & { readonly __brand: "EngineeringTaskId" };
export type RunId = string & { readonly __brand: "EngineeringRunId" };

export type EngineeringRole = "WORKER" | "BRAIN" | "OWNER";

/**
 * ENG-ORCH-001 "First bounded vertical slice" #1: the bounded set of
 * event types this slice's reducer (`applyEvent` in
 * `engineering-run-state.ts`) understands. Each corresponds to one
 * explicit, deterministic transition in the state machine - no event type
 * exists here that the reducer does not handle.
 */
export type EngineeringEventType =
  | "CHECKPOINT"
  | "BEGIN_VERIFICATION"
  | "FLAG_REVIEW"
  | "RESOLVE"
  | "ASK_QUESTION"
  | "ANSWER"
  | "OWNER_GATE"
  | "OWNER_GATE_CLEARED"
  | "TIMEOUT"
  | "RECONCILIATION_REQUIRED"
  | "RECONCILED"
  | "COMPLETE";

/**
 * ENG-ORCH-001 "First bounded vertical slice" #1. Carries identity,
 * correlation/causation, role routing, branch/SHA references,
 * idempotency/attempt/lease-fencing metadata, and DEC-138 provenance on
 * every event - the unit the durable store persists and the reducer
 * consumes. `fencingToken` is the sole authority for rejecting a stale
 * writer (see `engineering-run-state.ts`); event arrival/append order is
 * explicitly NOT authoritative (deterministic invariant: "Event arrival
 * order is evidence, never authority").
 */
export interface EngineeringEventEnvelope {
  readonly eventId: EventId;
  readonly projectRef: string;
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly fromRole: EngineeringRole;
  readonly targetRole: EngineeringRole;
  readonly eventType: EngineeringEventType;
  readonly status?: string;
  readonly branch?: string;
  readonly baseSha?: string;
  readonly checkpointSha?: string;
  readonly authorityRef?: string;
  readonly evidenceRef?: string;
  readonly responseTo?: EventId;
  readonly waitReason?: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly leaseToken?: string;
  readonly fencingToken: number;
  readonly timestamp: string;
  readonly provenance: Dec138Provenance;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<EngineeringEventType>([
  "CHECKPOINT",
  "BEGIN_VERIFICATION",
  "FLAG_REVIEW",
  "RESOLVE",
  "ASK_QUESTION",
  "ANSWER",
  "OWNER_GATE",
  "OWNER_GATE_CLEARED",
  "TIMEOUT",
  "RECONCILIATION_REQUIRED",
  "RECONCILED",
  "COMPLETE",
]);

const ROLES: ReadonlySet<string> = new Set<EngineeringRole>(["WORKER", "BRAIN", "OWNER"]);

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidEngineeringEventEnvelopeError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidEngineeringEventEnvelopeError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidEngineeringEventEnvelopeError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidEngineeringEventEnvelopeError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, field);
}

export function createEngineeringEventEnvelope(input: {
  eventId: unknown;
  projectRef: unknown;
  taskId: unknown;
  runId: unknown;
  correlationId: unknown;
  causationId?: unknown;
  fromRole: unknown;
  targetRole: unknown;
  eventType: unknown;
  status?: unknown;
  branch?: unknown;
  baseSha?: unknown;
  checkpointSha?: unknown;
  authorityRef?: unknown;
  evidenceRef?: unknown;
  responseTo?: unknown;
  waitReason?: unknown;
  idempotencyKey: unknown;
  attempt: unknown;
  leaseToken?: unknown;
  fencingToken: unknown;
  timestamp: unknown;
  provenance: Dec138Provenance;
}): EngineeringEventEnvelope {
  const eventId = requireNonEmptyString(input.eventId, "eventId");
  const projectRef = requireNonEmptyString(input.projectRef, "projectRef");
  const taskId = requireNonEmptyString(input.taskId, "taskId");
  const runId = requireNonEmptyString(input.runId, "runId");
  const correlationId = requireNonEmptyString(input.correlationId, "correlationId");
  const causationId = optionalNonEmptyString(input.causationId, "causationId");

  if (typeof input.fromRole !== "string" || !ROLES.has(input.fromRole)) {
    throw new InvalidEngineeringEventEnvelopeError('fromRole must be "WORKER", "BRAIN", or "OWNER"');
  }
  if (typeof input.targetRole !== "string" || !ROLES.has(input.targetRole)) {
    throw new InvalidEngineeringEventEnvelopeError('targetRole must be "WORKER", "BRAIN", or "OWNER"');
  }
  if (typeof input.eventType !== "string" || !EVENT_TYPES.has(input.eventType)) {
    throw new InvalidEngineeringEventEnvelopeError(`eventType must be one of ${[...EVENT_TYPES].join(", ")}`);
  }

  const status = optionalNonEmptyString(input.status, "status");
  const branch = optionalNonEmptyString(input.branch, "branch");
  const baseSha = optionalNonEmptyString(input.baseSha, "baseSha");
  const checkpointSha = optionalNonEmptyString(input.checkpointSha, "checkpointSha");
  const authorityRef = optionalNonEmptyString(input.authorityRef, "authorityRef");
  const evidenceRef = optionalNonEmptyString(input.evidenceRef, "evidenceRef");
  const responseTo = optionalNonEmptyString(input.responseTo, "responseTo");
  const waitReason = optionalNonEmptyString(input.waitReason, "waitReason");
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const leaseToken = optionalNonEmptyString(input.leaseToken, "leaseToken");
  const timestamp = requireNonEmptyString(input.timestamp, "timestamp");

  if (typeof input.attempt !== "number" || !Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new InvalidEngineeringEventEnvelopeError("attempt must be a positive integer");
  }
  if (typeof input.fencingToken !== "number" || !Number.isInteger(input.fencingToken) || input.fencingToken < 1) {
    throw new InvalidEngineeringEventEnvelopeError("fencingToken must be a positive integer");
  }

  return {
    eventId: eventId as EventId,
    projectRef,
    taskId: taskId as TaskId,
    runId: runId as RunId,
    correlationId,
    ...(causationId !== undefined ? { causationId } : {}),
    fromRole: input.fromRole as EngineeringRole,
    targetRole: input.targetRole as EngineeringRole,
    eventType: input.eventType as EngineeringEventType,
    ...(status !== undefined ? { status } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(baseSha !== undefined ? { baseSha } : {}),
    ...(checkpointSha !== undefined ? { checkpointSha } : {}),
    ...(authorityRef !== undefined ? { authorityRef } : {}),
    ...(evidenceRef !== undefined ? { evidenceRef } : {}),
    ...(responseTo !== undefined ? { responseTo: responseTo as EventId } : {}),
    ...(waitReason !== undefined ? { waitReason } : {}),
    idempotencyKey,
    attempt: input.attempt,
    ...(leaseToken !== undefined ? { leaseToken } : {}),
    fencingToken: input.fencingToken,
    timestamp,
    provenance: input.provenance,
  };
}
