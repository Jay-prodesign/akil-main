import type { TenantScope } from "./tenant-scope.js";
import type { DeviceRegistration, DevicePolicy, LocalTaskLease, LocalTaskCheckpoint } from "./local-execution.js";
import { markDeviceOnline, isWorkspaceRootAllowed } from "./local-execution.js";

export class InvalidBridgeProtocolError extends Error {
  constructor(reason: string) {
    super(`Invalid bridge protocol operation: ${reason}`);
    this.name = "InvalidBridgeProtocolError";
  }
}

export class InvalidBridgeReplayError extends Error {
  constructor(reason: string) {
    super(`Invalid bridge replay: ${reason}`);
    this.name = "InvalidBridgeReplayError";
  }
}

export class InvalidBridgeEnrollmentError extends Error {
  constructor(reason: string) {
    super(`Invalid bridge enrollment: ${reason}`);
    this.name = "InvalidBridgeEnrollmentError";
  }
}

export class InvalidBridgeConnectionTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid bridge connection transition: ${reason}`);
    this.name = "InvalidBridgeConnectionTransitionError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidBridgeProtocolError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): { raw: string; ms: number } {
  const raw = requireNonEmptyString(value, field);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new InvalidBridgeProtocolError(`${field} must be a valid ISO timestamp`);
  }
  return { raw, ms };
}

/**
 * LOCAL-EXEC-002 (Rev99/100/101, Local Execution / Device Worker
 * capability, Phase L1 — Device Bridge MVP), §17 "CONTROL CHANNEL /
 * PROTOCOL": "Define a small versioned protocol, transport-independent
 * at domain level." This module never opens a real socket/network
 * connection anywhere - it is the pure protocol/domain contract layer
 * only, exactly matching LOCAL-EXEC-001's own "no live PC connection ...
 * required" discipline extended one phase further. The real streaming-
 * socket-over-TLS transport §17 suggests is future runtime wiring behind
 * the `BridgeControlChannel` port defined below, never implemented here.
 */
export const SUPPORTED_BRIDGE_PROTOCOL_VERSIONS: ReadonlySet<number> = new Set([1]);

/**
 * §17 "Minimum message families" - every family named in the packet,
 * verbatim, and no others (the boundary-scan test pins this exact set).
 */
export type BridgeProtocolMessageKind =
  | "ENROLL_CHALLENGE"
  | "ENROLL_PROOF"
  | "DEVICE_HELLO"
  | "CAPABILITY_SNAPSHOT"
  | "HEARTBEAT"
  | "LEASE_OFFER"
  | "LEASE_ACCEPT"
  | "LEASE_REJECT"
  | "RUN_STARTED"
  | "RUN_EVENT"
  | "PERMISSION_REQUEST"
  | "PERMISSION_DECISION"
  | "CHECKPOINT"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "RUN_BLOCKED"
  | "CANCEL"
  | "DEVICE_POLICY_REFRESH"
  | "REVOKE";

const RECOGNIZED_BRIDGE_MESSAGE_KINDS: ReadonlySet<BridgeProtocolMessageKind> = new Set([
  "ENROLL_CHALLENGE",
  "ENROLL_PROOF",
  "DEVICE_HELLO",
  "CAPABILITY_SNAPSHOT",
  "HEARTBEAT",
  "LEASE_OFFER",
  "LEASE_ACCEPT",
  "LEASE_REJECT",
  "RUN_STARTED",
  "RUN_EVENT",
  "PERMISSION_REQUEST",
  "PERMISSION_DECISION",
  "CHECKPOINT",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "RUN_BLOCKED",
  "CANCEL",
  "DEVICE_POLICY_REFRESH",
  "REVOKE",
]);

export function isRecognizedBridgeMessageKind(value: unknown): value is BridgeProtocolMessageKind {
  return typeof value === "string" && RECOGNIZED_BRIDGE_MESSAGE_KINDS.has(value as BridgeProtocolMessageKind);
}

/**
 * §17: "Every material message carries protocolVersion + organization/
 * project/task/run/device/worker identity as applicable + monotonic/
 * event identity + replay/idempotency protection." `eventSeq` is the
 * monotonic identity (strictly increasing per device - see
 * `validateBridgeMessageReplay`); `messageId` is the idempotency key (a
 * message replayed verbatim, e.g. after a reconnect, is recognized and
 * not double-applied).
 */
export interface BridgeProtocolEnvelope {
  readonly protocolVersion: number;
  readonly kind: BridgeProtocolMessageKind;
  readonly tenantId: TenantScope["tenantId"];
  readonly deviceId: DeviceRegistration["deviceId"];
  readonly workerId?: string;
  readonly taskRef?: string;
  readonly runRef?: string;
  readonly eventSeq: number;
  readonly messageId: string;
}

/**
 * §16 "Bridge version/protocol capability negotiation prevents
 * incompatible clients from silently running": fail closed on an
 * unrecognized `kind`, an unsupported `protocolVersion`, a non-integer or
 * negative `eventSeq`, or a malformed identity field - a structurally
 * invalid envelope is never allowed to reach replay/business validation.
 */
export function validateBridgeProtocolEnvelope(input: {
  protocolVersion: unknown;
  kind: unknown;
  tenantScope: TenantScope;
  deviceId: unknown;
  workerId?: unknown;
  taskRef?: unknown;
  runRef?: unknown;
  eventSeq: unknown;
  messageId: unknown;
}): BridgeProtocolEnvelope {
  if (typeof input.protocolVersion !== "number" || !SUPPORTED_BRIDGE_PROTOCOL_VERSIONS.has(input.protocolVersion)) {
    throw new InvalidBridgeProtocolError(
      `protocolVersion must be one of ${Array.from(SUPPORTED_BRIDGE_PROTOCOL_VERSIONS).join(", ")}`,
    );
  }
  if (!isRecognizedBridgeMessageKind(input.kind)) {
    throw new InvalidBridgeProtocolError(
      `kind must be one of ${Array.from(RECOGNIZED_BRIDGE_MESSAGE_KINDS).join(", ")}`,
    );
  }
  const deviceId = requireNonEmptyString(input.deviceId, "deviceId") as DeviceRegistration["deviceId"];
  const messageId = requireNonEmptyString(input.messageId, "messageId");
  if (typeof input.eventSeq !== "number" || !Number.isInteger(input.eventSeq) || input.eventSeq < 0) {
    throw new InvalidBridgeProtocolError("eventSeq must be a non-negative integer");
  }
  const envelope: {
    protocolVersion: number;
    kind: BridgeProtocolMessageKind;
    tenantId: TenantScope["tenantId"];
    deviceId: DeviceRegistration["deviceId"];
    workerId?: string;
    taskRef?: string;
    runRef?: string;
    eventSeq: number;
    messageId: string;
  } = {
    protocolVersion: input.protocolVersion,
    kind: input.kind,
    tenantId: input.tenantScope.tenantId,
    deviceId,
    eventSeq: input.eventSeq,
    messageId,
  };
  if (input.workerId !== undefined) {
    envelope.workerId = requireNonEmptyString(input.workerId, "workerId");
  }
  if (input.taskRef !== undefined) {
    envelope.taskRef = requireNonEmptyString(input.taskRef, "taskRef");
  }
  if (input.runRef !== undefined) {
    envelope.runRef = requireNonEmptyString(input.runRef, "runRef");
  }
  return envelope;
}

/**
 * §17 "Persisted server state must be replay-validated fail-closed,
 * following existing AKILTA durability lessons" - the same fail-closed-
 * replay-validation discipline `postgres-outcome-job-store.ts` and
 * `file-durable-connector-connection-store.ts` already established for
 * persisted rows, applied here to the control channel's own event
 * stream. A device's very first message bootstraps its replay state (no
 * prior state exists yet); every subsequent message must carry a
 * strictly greater `eventSeq` than the last accepted one, and an exact
 * `messageId` repeat (a genuine at-least-once redelivery, e.g. after a
 * reconnect) is recognized as an idempotent no-op rather than either a
 * silent double-apply or a hard failure.
 */
export interface BridgeDeviceReplayState {
  readonly deviceId: DeviceRegistration["deviceId"];
  readonly lastAcceptedEventSeq: number;
  readonly seenMessageIds: ReadonlySet<string>;
}

export type BridgeReplayOutcome =
  | { readonly disposition: "ACCEPTED"; readonly nextState: BridgeDeviceReplayState }
  | { readonly disposition: "DUPLICATE"; readonly nextState: BridgeDeviceReplayState };

export function validateBridgeMessageReplay(input: {
  envelope: BridgeProtocolEnvelope;
  priorState: BridgeDeviceReplayState | undefined;
}): BridgeReplayOutcome {
  const { envelope, priorState } = input;
  if (priorState !== undefined && priorState.deviceId !== envelope.deviceId) {
    throw new InvalidBridgeReplayError("priorState belongs to a different deviceId than the given envelope");
  }
  if (priorState !== undefined && priorState.seenMessageIds.has(envelope.messageId)) {
    return { disposition: "DUPLICATE", nextState: priorState };
  }
  if (priorState !== undefined && envelope.eventSeq <= priorState.lastAcceptedEventSeq) {
    throw new InvalidBridgeReplayError(
      `eventSeq ${envelope.eventSeq} is not strictly greater than the last accepted eventSeq ${priorState.lastAcceptedEventSeq} for device ${envelope.deviceId}`,
    );
  }
  const seenMessageIds = new Set<string>(priorState?.seenMessageIds ?? []);
  seenMessageIds.add(envelope.messageId);
  return {
    disposition: "ACCEPTED",
    nextState: {
      deviceId: envelope.deviceId,
      lastAcceptedEventSeq: envelope.eventSeq,
      seenMessageIds,
    },
  };
}

/**
 * §17 "ENROLL_CHALLENGE / ENROLL_PROOF": one-time device enrollment. This
 * module never verifies a real cryptographic signature (that is the
 * actual bridge daemon's job in a later phase, requiring a live private
 * key - explicitly out of this floor's "no live PC connection ...
 * required" scope) - it enforces only the structural admission gate: a
 * proof must reference the exact challenge issued to this exact device,
 * must arrive before that challenge expires, and can only ever succeed
 * against a still-`PENDING` device (mirroring `local-execution.ts`'s own
 * "never born admitted" discipline - an already-`ONLINE`/`REVOKED`/
 * `QUARANTINED` device cannot be re-enrolled through this floor).
 */
export interface EnrollmentChallenge {
  readonly deviceId: DeviceRegistration["deviceId"];
  readonly challengeId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export function createEnrollmentChallenge(input: {
  device: DeviceRegistration;
  challengeId: unknown;
  issuedAt: unknown;
  expiresAt: unknown;
}): EnrollmentChallenge {
  if (input.device.status !== "PENDING") {
    throw new InvalidBridgeEnrollmentError(
      `an enrollment challenge can only be issued to a PENDING device (current status: ${input.device.status})`,
    );
  }
  const challengeId = requireNonEmptyString(input.challengeId, "challengeId");
  const issuedAt = requireValidTimestamp(input.issuedAt, "issuedAt");
  const expiresAt = requireValidTimestamp(input.expiresAt, "expiresAt");
  if (expiresAt.ms <= issuedAt.ms) {
    throw new InvalidBridgeEnrollmentError("expiresAt must be strictly after issuedAt");
  }
  return {
    deviceId: input.device.deviceId,
    challengeId,
    issuedAt: issuedAt.raw,
    expiresAt: expiresAt.raw,
  };
}

/**
 * Completes enrollment by composing the existing, unmodified
 * `markDeviceOnline` transition - this module invents no second device-
 * status graph. Fails closed on: a proof referencing a different device
 * or a different (e.g. stale/foreign) `challengeId` than the one issued;
 * a proof arriving strictly after `challenge.expiresAt`; an empty
 * `proofRef`; or a device that is not `PENDING` (including one already
 * enrolled by a prior proof for the same challenge - a challenge can
 * only ever be redeemed once, since a successfully enrolled device is no
 * longer `PENDING`).
 */
export function completeDeviceEnrollment(input: {
  device: DeviceRegistration;
  challenge: EnrollmentChallenge;
  proofChallengeId: unknown;
  proofRef: unknown;
  provedAt: unknown;
}): DeviceRegistration {
  if (input.device.deviceId !== input.challenge.deviceId) {
    throw new InvalidBridgeEnrollmentError("challenge was not issued to the given device");
  }
  if (input.device.status !== "PENDING") {
    throw new InvalidBridgeEnrollmentError(
      `enrollment can only be completed for a PENDING device (current status: ${input.device.status})`,
    );
  }
  const proofChallengeId = requireNonEmptyString(input.proofChallengeId, "proofChallengeId");
  if (proofChallengeId !== input.challenge.challengeId) {
    throw new InvalidBridgeEnrollmentError("proof does not reference the exact challenge issued to this device");
  }
  requireNonEmptyString(input.proofRef, "proofRef");
  const provedAt = requireValidTimestamp(input.provedAt, "provedAt");
  if (provedAt.ms > Date.parse(input.challenge.expiresAt)) {
    throw new InvalidBridgeEnrollmentError("proof arrived after the challenge's expiresAt");
  }
  return markDeviceOnline(input.device);
}

/**
 * §21 "disconnect/reconnect ... tests": a strictly closed connection-
 * lifecycle graph. `DISCONNECTED` can only ever move forward through
 * `CONNECTING`; a lost `CONNECTED` session moves to `RECONNECTING`
 * (never straight back to `CONNECTING`, which is reserved for a genuinely
 * fresh session) and either resumes to `CONNECTED` or gives up to
 * `DISCONNECTED`.
 */
export type BridgeConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING";

const BRIDGE_CONNECTION_TRANSITIONS: ReadonlyMap<BridgeConnectionState, ReadonlySet<BridgeConnectionState>> = new Map([
  ["DISCONNECTED", new Set<BridgeConnectionState>(["CONNECTING"])],
  ["CONNECTING", new Set<BridgeConnectionState>(["CONNECTED", "DISCONNECTED"])],
  ["CONNECTED", new Set<BridgeConnectionState>(["RECONNECTING", "DISCONNECTED"])],
  ["RECONNECTING", new Set<BridgeConnectionState>(["CONNECTED", "DISCONNECTED"])],
]);

export function transitionBridgeConnectionState(
  from: BridgeConnectionState,
  to: unknown,
): BridgeConnectionState {
  const allowed = BRIDGE_CONNECTION_TRANSITIONS.get(from);
  if (allowed === undefined || !allowed.has(to as BridgeConnectionState)) {
    throw new InvalidBridgeConnectionTransitionError(`cannot transition bridge connection from ${from} to ${String(to)}`);
  }
  return to as BridgeConnectionState;
}

/**
 * §17 HEARTBEAT + §16 "Revoked membership/device/worker fails closed":
 * a heartbeat is only ever accepted from a device that is currently
 * `ONLINE` (a `REVOKED`/`QUARANTINED`/`OFFLINE`/`PENDING` device's
 * heartbeat is rejected outright, before replay validation even runs),
 * and it is still subject to the same replay/idempotency discipline as
 * every other message.
 */
export interface BridgeHeartbeatState {
  readonly deviceId: DeviceRegistration["deviceId"];
  readonly lastHeartbeatAt: string;
  readonly lastEventSeq: number;
}

export function processBridgeHeartbeat(input: {
  device: DeviceRegistration;
  envelope: BridgeProtocolEnvelope;
  observedAt: unknown;
  priorReplayState: BridgeDeviceReplayState | undefined;
}): { replay: BridgeReplayOutcome; heartbeatState: BridgeHeartbeatState } {
  if (input.envelope.kind !== "HEARTBEAT") {
    throw new InvalidBridgeProtocolError(`processBridgeHeartbeat requires a HEARTBEAT envelope (got: ${input.envelope.kind})`);
  }
  if (input.envelope.deviceId !== input.device.deviceId) {
    throw new InvalidBridgeProtocolError("envelope.deviceId does not match the given device's own deviceId");
  }
  if (input.device.status !== "ONLINE") {
    throw new InvalidBridgeProtocolError(
      `a heartbeat can only be accepted from an ONLINE device (current status: ${input.device.status})`,
    );
  }
  const observedAt = requireValidTimestamp(input.observedAt, "observedAt");
  const replay = validateBridgeMessageReplay({ envelope: input.envelope, priorState: input.priorReplayState });
  return {
    replay,
    heartbeatState: {
      deviceId: input.device.deviceId,
      lastHeartbeatAt: observedAt.raw,
      lastEventSeq: input.envelope.eventSeq,
    },
  };
}

/**
 * §16 "Allowed workspace roots are explicit; never default to the user's
 * entire home drive" and §21 "allowlisted workspace manager": composes
 * `local-execution.ts`'s own unmodified `isWorkspaceRootAllowed` (no
 * second allowlist check invented) and additionally fails closed on a
 * relative-path traversal attempt (`..` segment) or an absolute-path
 * escape (a leading `/`) in the requested path *within* an otherwise-
 * allowed root - an allowed root never implies the caller may walk back
 * out of it. This module never touches the real filesystem; it only
 * computes the resulting logical path string.
 */
export function resolveAllowedWorkspacePath(input: {
  policy: DevicePolicy;
  requestedRootRef: unknown;
  relativePath: unknown;
}): string {
  if (!isWorkspaceRootAllowed(input.policy, input.requestedRootRef)) {
    throw new InvalidBridgeProtocolError(
      `workspace root "${String(input.requestedRootRef)}" is not allowed by this device's policy`,
    );
  }
  const relativePath = requireNonEmptyString(input.relativePath, "relativePath");
  if (relativePath.startsWith("/")) {
    throw new InvalidBridgeProtocolError("relativePath must not be an absolute path");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new InvalidBridgeProtocolError("relativePath must not contain a \"..\" traversal segment");
  }
  return `${input.requestedRootRef as string}/${relativePath}`;
}

/**
 * §17/§21 "lease/checkpoint/event persistence": a wire message can never
 * silently reference a lease it does not structurally match - this is a
 * pure consistency guard, not new lease semantics (the actual lease
 * state machine remains exclusively `local-execution.ts`'s own
 * `LocalTaskLease`/`transitionLocalTaskLease`).
 */
export function validateLeaseMessageEnvelope(input: {
  envelope: BridgeProtocolEnvelope;
  lease: LocalTaskLease;
}): void {
  const { envelope, lease } = input;
  if (envelope.kind !== "LEASE_OFFER" && envelope.kind !== "LEASE_ACCEPT" && envelope.kind !== "LEASE_REJECT") {
    throw new InvalidBridgeProtocolError(
      `validateLeaseMessageEnvelope requires a LEASE_OFFER/LEASE_ACCEPT/LEASE_REJECT envelope (got: ${envelope.kind})`,
    );
  }
  if (envelope.deviceId !== lease.deviceId) {
    throw new InvalidBridgeProtocolError("envelope.deviceId does not match the referenced lease's own deviceId");
  }
  if (envelope.workerId !== lease.workerId) {
    throw new InvalidBridgeProtocolError("envelope.workerId does not match the referenced lease's own workerId");
  }
  if (envelope.taskRef !== lease.taskRef) {
    throw new InvalidBridgeProtocolError("envelope.taskRef does not match the referenced lease's own taskRef");
  }
}

/**
 * Same structural-consistency discipline as `validateLeaseMessageEnvelope`,
 * for a `CHECKPOINT` message against both its `LocalTaskCheckpoint` and
 * the `LocalTaskLease` it belongs to.
 */
export function validateCheckpointMessageEnvelope(input: {
  envelope: BridgeProtocolEnvelope;
  checkpoint: LocalTaskCheckpoint;
  lease: LocalTaskLease;
}): void {
  const { envelope, checkpoint, lease } = input;
  if (envelope.kind !== "CHECKPOINT") {
    throw new InvalidBridgeProtocolError(`validateCheckpointMessageEnvelope requires a CHECKPOINT envelope (got: ${envelope.kind})`);
  }
  if (checkpoint.leaseId !== lease.leaseId) {
    throw new InvalidBridgeProtocolError("checkpoint does not belong to the given lease");
  }
  if (envelope.deviceId !== lease.deviceId) {
    throw new InvalidBridgeProtocolError("envelope.deviceId does not match the referenced lease's own deviceId");
  }
  if (envelope.taskRef !== lease.taskRef) {
    throw new InvalidBridgeProtocolError("envelope.taskRef does not match the referenced lease's own taskRef");
  }
}

/**
 * §21 "local device key generation/storage abstraction": the port only -
 * no real key-generation library of any kind is referenced anywhere in
 * this module (boundary-scan test asserts no such import), mirroring
 * `LocalWorkerAdapter`'s own established port-only discipline.
 * A real implementation (backed by the OS keychain, a local encrypted
 * file, etc.) is bridge-runtime concern, never domain code.
 */
export interface DeviceKeyMaterial {
  readonly publicKeyFingerprint: string;
}

export interface DeviceKeyStore {
  generateKeyPair(): DeviceKeyMaterial;
  getPublicKeyFingerprint(): DeviceKeyMaterial["publicKeyFingerprint"] | undefined;
}

/**
 * §17 "transport-independent at domain level": the outbound-authenticated
 * control-channel port. No real streaming-socket implementation lives in
 * this module or anywhere else in this repository yet - a live
 * transport is explicitly deferred (see the exec-plan's "Explicitly
 * deferred" section), matching `LocalWorkerAdapter`'s port-only pattern.
 */
export interface BridgeControlChannel {
  send(envelope: BridgeProtocolEnvelope): void;
  onMessage(handler: (envelope: BridgeProtocolEnvelope) => void): void;
}
