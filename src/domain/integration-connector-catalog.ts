import type { RequirementId } from "./offer-blueprint.js";
import type { ConnectionRequirement, ConnectionBinding, ConnectionState, SecretRef } from "./connection-authority.js";
import { createConnectionBinding, transitionConnectionBinding, verifyConnectionBinding } from "./connection-authority.js";

export class InvalidConnectorCatalogError extends Error {
  constructor(reason: string) {
    super(`Invalid connector catalog input: ${reason}`);
    this.name = "InvalidConnectorCatalogError";
  }
}

export class InvalidConnectorConnectionError extends Error {
  constructor(reason: string) {
    super(`Invalid connector connection input: ${reason}`);
    this.name = "InvalidConnectorConnectionError";
  }
}

/**
 * CONN-001 (Integration & Credential Control Plane), architecture/domain-
 * contract slice. Composes directly on top of the already-merged,
 * already-verified `connection-authority.ts` (`V2-CDO-004`:
 * `ConnectionRequirement` -> `ConnectionBinding` -> `SecretRef`) rather than
 * modifying it - that module is closed/`VERIFIED` and this task is a
 * distinct, larger continuation, not a correction to it. Everything below
 * is a thin, additive layer: a connector catalog (what integrations exist
 * and how they may be authenticated) plus a small set of connection-
 * lifecycle operations this task's spec explicitly names
 * ("test/health/reconnect/rotate/revoke") that `connection-authority.ts`
 * does not itself provide.
 *
 * REQUIRED vs REQUESTED: CONN-001's named lifecycle is
 * "REQUIRED/REQUESTED/CONNECTED_UNVERIFIED/VERIFIED/DEGRADED/REVOKED".
 * `connection-authority.ts` already models exactly this REQUIRED/REQUESTED
 * split structurally, via two separate types rather than one enum: a
 * `ConnectionRequirement` existing with no corresponding `ConnectionBinding`
 * yet *is* "REQUIRED" (declared, not yet connected); a `ConnectionBinding`
 * always starts at `ConnectionState: "REQUESTED"`. This module therefore
 * does not invent a redundant `REQUIRED` status field - doing so would
 * duplicate an already-correct existing distinction rather than close a
 * real gap.
 *
 * PROTECTED GATES DELIBERATELY NOT IMPLEMENTED HERE (per this task's own
 * authorization boundary): real credential entry, real OAuth authorization-
 * code exchange, any live HTTP/network call to a provider, account
 * authorization, spend, DNS mutation, or any other customer-impacting
 * production side effect. This module is a pure, in-memory domain
 * contract only - exactly like every other module in `src/domain/` - and
 * a caller-supplied `SecretRef`/evidence/timestamp is the only way any of
 * those real-world facts ever enters it.
 */

// ---------------------------------------------------------------------------
// Connector catalog
// ---------------------------------------------------------------------------

/**
 * CONN-001 mandates a Generic Custom API Connector "with multiple auth
 * modes" and a separate Generic Custom OAuth Connector - `ConnectorAuthMode`
 * is the closed set both draw from. `OAUTH2` is reserved exclusively for
 * `GENERIC_CUSTOM_OAUTH` and any prebuilt connector that itself requires an
 * OAuth redirect (see `createConnectorDescriptor`'s cross-field checks
 * below) - a Generic Custom API Connector is, by construction, never an
 * OAuth connector under a different name.
 */
export type ConnectorAuthMode = "API_KEY" | "OAUTH2" | "BASIC" | "BEARER_TOKEN" | "CUSTOM_HEADER";

/**
 * CONN-001's explicit named prebuilt connector list. Closed on purpose -
 * "avoiding speculative provider breadth (an 'available' connector must
 * actually work against its declared contract)" is this task's own
 * instruction; a connector kind not on this list, or not present in a
 * caller-registered `ConnectorCatalog`, can never be resolved (see
 * `resolveConnectorDescriptor`), so nothing can be silently declared
 * "available" without an actual registered descriptor for it.
 */
export type PrebuiltConnectorKind =
  | "GOOGLE_DRIVE"
  | "GOOGLE_WORKSPACE"
  | "OPENAI"
  | "ANTHROPIC"
  | "GOOGLE_AI"
  | "GITHUB"
  | "META";

export type ConnectorKind = PrebuiltConnectorKind | "GENERIC_CUSTOM_API" | "GENERIC_CUSTOM_OAUTH";

const RECOGNIZED_CONNECTOR_KINDS: ReadonlySet<string> = new Set<ConnectorKind>([
  "GOOGLE_DRIVE",
  "GOOGLE_WORKSPACE",
  "OPENAI",
  "ANTHROPIC",
  "GOOGLE_AI",
  "GITHUB",
  "META",
  "GENERIC_CUSTOM_API",
  "GENERIC_CUSTOM_OAUTH",
]);

const RECOGNIZED_AUTH_MODES: ReadonlySet<string> = new Set<ConnectorAuthMode>([
  "API_KEY",
  "OAUTH2",
  "BASIC",
  "BEARER_TOKEN",
  "CUSTOM_HEADER",
]);

/**
 * CONN-001: "AI provider/model-catalog separation" - `isAiModelProvider` is
 * an explicit, required boolean (no default inferred) so an AI model
 * provider (e.g. `OPENAI`, `ANTHROPIC`, `GOOGLE_AI`) can always be
 * programmatically distinguished from a plain integration connector (e.g.
 * `GITHUB`, `GOOGLE_DRIVE`) - see `listAiModelProviderConnectors`/
 * `listIntegrationConnectors` below. `capabilityRefs` reuses the existing
 * `RequirementId` branded type from `offer-blueprint.ts` (matching
 * `connection-authority.ts`'s own `requiredCapabilityRef` reuse) rather
 * than inventing a parallel capability identifier - a `ConnectionRequirement`
 * can only be satisfied by a connector whose `capabilityRefs` actually
 * declares that same `requiredCapabilityRef` (enforced in
 * `requestConnectorConnection` below).
 */
export interface ConnectorDescriptor {
  readonly connectorKind: ConnectorKind;
  readonly displayName: string;
  readonly supportedAuthModes: ReadonlyArray<ConnectorAuthMode>;
  readonly capabilityRefs: ReadonlyArray<RequirementId>;
  readonly isAiModelProvider: boolean;
  readonly requiresOAuthRedirect: boolean;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidConnectorCatalogError(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new InvalidConnectorCatalogError(`${field} must not be empty/whitespace-only`);
  }
  return value;
}

/**
 * CONN-001: the mandatory Generic Custom API Connector must declare
 * "multiple auth modes" - fail-closed rejected below if
 * `GENERIC_CUSTOM_API` declares fewer than two, or declares `OAUTH2` at
 * all (that is exactly what `GENERIC_CUSTOM_OAUTH` is for - the two
 * generic connectors are never allowed to overlap). `GENERIC_CUSTOM_OAUTH`
 * is fail-closed required to declare `OAUTH2` and nothing else, and
 * `requiresOAuthRedirect: true`; conversely `GENERIC_CUSTOM_API` is
 * fail-closed required to declare `requiresOAuthRedirect: false`. Any
 * connector kind not in `RECOGNIZED_CONNECTOR_KINDS` is rejected outright -
 * this repository does not fabricate an "available" connector for a kind
 * nobody has actually specified a contract for.
 */
export function createConnectorDescriptor(input: {
  connectorKind: unknown;
  displayName: unknown;
  supportedAuthModes: unknown;
  capabilityRefs: unknown;
  isAiModelProvider: unknown;
  requiresOAuthRedirect: unknown;
}): ConnectorDescriptor {
  if (typeof input.connectorKind !== "string" || !RECOGNIZED_CONNECTOR_KINDS.has(input.connectorKind)) {
    throw new InvalidConnectorCatalogError(
      `connectorKind must be one of the recognized kinds; got ${JSON.stringify(input.connectorKind)}`,
    );
  }
  const connectorKind = input.connectorKind as ConnectorKind;
  const displayName = requireNonEmptyString(input.displayName, "displayName");

  if (!Array.isArray(input.supportedAuthModes) || input.supportedAuthModes.length === 0) {
    throw new InvalidConnectorCatalogError("supportedAuthModes must be a non-empty array");
  }
  const supportedAuthModes: ConnectorAuthMode[] = [];
  const seenAuthModes = new Set<string>();
  for (const [index, mode] of input.supportedAuthModes.entries()) {
    if (typeof mode !== "string" || !RECOGNIZED_AUTH_MODES.has(mode)) {
      throw new InvalidConnectorCatalogError(`supportedAuthModes[${index}] is not a recognized auth mode`);
    }
    if (seenAuthModes.has(mode)) {
      throw new InvalidConnectorCatalogError(`supportedAuthModes contains a duplicate entry: ${mode}`);
    }
    seenAuthModes.add(mode);
    supportedAuthModes.push(mode as ConnectorAuthMode);
  }

  if (!Array.isArray(input.capabilityRefs) || input.capabilityRefs.length === 0) {
    throw new InvalidConnectorCatalogError("capabilityRefs must be a non-empty array");
  }
  const capabilityRefs = input.capabilityRefs.map((ref, index) =>
    requireNonEmptyString(ref, `capabilityRefs[${index}]`),
  ) as unknown as ReadonlyArray<RequirementId>;

  if (typeof input.isAiModelProvider !== "boolean") {
    throw new InvalidConnectorCatalogError("isAiModelProvider must be a boolean - no default is inferred");
  }
  if (typeof input.requiresOAuthRedirect !== "boolean") {
    throw new InvalidConnectorCatalogError("requiresOAuthRedirect must be a boolean - no default is inferred");
  }

  if (connectorKind === "GENERIC_CUSTOM_OAUTH") {
    if (input.requiresOAuthRedirect !== true) {
      throw new InvalidConnectorCatalogError("GENERIC_CUSTOM_OAUTH must declare requiresOAuthRedirect: true");
    }
    if (supportedAuthModes.length !== 1 || supportedAuthModes[0] !== "OAUTH2") {
      throw new InvalidConnectorCatalogError(
        "GENERIC_CUSTOM_OAUTH must declare exactly one supported auth mode: OAUTH2",
      );
    }
  } else if (connectorKind === "GENERIC_CUSTOM_API") {
    if (input.requiresOAuthRedirect !== false) {
      throw new InvalidConnectorCatalogError("GENERIC_CUSTOM_API must declare requiresOAuthRedirect: false");
    }
    if (supportedAuthModes.includes("OAUTH2")) {
      throw new InvalidConnectorCatalogError(
        "GENERIC_CUSTOM_API must not declare OAUTH2 - use GENERIC_CUSTOM_OAUTH for OAuth-based custom connections",
      );
    }
    if (supportedAuthModes.length < 2) {
      throw new InvalidConnectorCatalogError(
        "GENERIC_CUSTOM_API must declare multiple (at least two) auth modes",
      );
    }
  }

  return {
    connectorKind,
    displayName,
    supportedAuthModes,
    capabilityRefs,
    isAiModelProvider: input.isAiModelProvider,
    requiresOAuthRedirect: input.requiresOAuthRedirect,
  };
}

export interface ConnectorCatalog {
  readonly descriptors: ReadonlyMap<ConnectorKind, ConnectorDescriptor>;
}

/**
 * Fail-closed rejects a duplicate `connectorKind` - a catalog can never
 * silently let a second, possibly-conflicting descriptor for the same kind
 * shadow the first.
 */
export function buildConnectorCatalog(
  descriptors: ReadonlyArray<ConnectorDescriptor>,
): ConnectorCatalog {
  const map = new Map<ConnectorKind, ConnectorDescriptor>();
  for (const descriptor of descriptors) {
    if (map.has(descriptor.connectorKind)) {
      throw new InvalidConnectorCatalogError(
        `duplicate connectorKind in catalog: ${descriptor.connectorKind}`,
      );
    }
    map.set(descriptor.connectorKind, descriptor);
  }
  return { descriptors: map };
}

/**
 * Fail-closed: an unregistered connector kind throws rather than returning
 * `undefined` - nothing downstream can treat a non-existent connector as
 * silently "not found, proceed anyway." This is what makes "an available
 * connector must actually work against its declared contract" true by
 * construction for this domain layer: there is no path to a
 * `ConnectorConnectionInstance` (below) for a kind that was never actually
 * registered with a real descriptor.
 */
export function resolveConnectorDescriptor(
  catalog: ConnectorCatalog,
  connectorKind: unknown,
): ConnectorDescriptor {
  if (typeof connectorKind !== "string") {
    throw new InvalidConnectorCatalogError("connectorKind must be a string");
  }
  const descriptor = catalog.descriptors.get(connectorKind as ConnectorKind);
  if (descriptor === undefined) {
    throw new InvalidConnectorCatalogError(`connectorKind not registered in this catalog: ${connectorKind}`);
  }
  return descriptor;
}

export function listAiModelProviderConnectors(
  catalog: ConnectorCatalog,
): ReadonlyArray<ConnectorDescriptor> {
  return [...catalog.descriptors.values()].filter((descriptor) => descriptor.isAiModelProvider);
}

export function listIntegrationConnectors(catalog: ConnectorCatalog): ReadonlyArray<ConnectorDescriptor> {
  return [...catalog.descriptors.values()].filter((descriptor) => !descriptor.isAiModelProvider);
}

// ---------------------------------------------------------------------------
// Connection lifecycle (test/health/reconnect/rotate/revoke)
// ---------------------------------------------------------------------------

/**
 * Pairs an underlying `ConnectionBinding` (`connection-authority.ts`,
 * unmodified) with the catalog identity it was actually requested against.
 * `connection-authority.ts`'s `ConnectionBinding.providerRef` is a plain,
 * uninterpreted string; this wrapper is what makes the *catalog* binding
 * explicit and always traceable back to a real `ConnectorDescriptor`
 * (`providerRef` is always set to `connectorKind` verbatim - see
 * `requestConnectorConnection`).
 */
export interface ConnectorConnectionInstance {
  readonly binding: ConnectionBinding;
  readonly connectorKind: ConnectorKind;
  readonly authMode: ConnectorAuthMode;
}

/**
 * CONN-001: "requires evidence/admission... test/health." A health check
 * is observational telemetry, never a lifecycle transition -
 * `recordConnectorHealthCheck` (below) returns this record only and never
 * mutates a `ConnectorConnectionInstance`. Promoting/demoting connection
 * state based on a health finding remains an explicit, separate caller
 * decision via `transitionConnectorConnection`/`verifyConnectorConnection` -
 * this module does not fabricate an automatic state-transition authority
 * from a health signal alone.
 */
export type ConnectorHealthStatus = "HEALTHY" | "DEGRADED" | "UNREACHABLE" | "UNKNOWN";

const RECOGNIZED_HEALTH_STATUSES: ReadonlySet<string> = new Set<ConnectorHealthStatus>([
  "HEALTHY",
  "DEGRADED",
  "UNREACHABLE",
  "UNKNOWN",
]);

export interface ConnectorHealthCheckRecord {
  readonly connectionBindingId: ConnectionBinding["connectionBindingId"];
  readonly connectorKind: ConnectorKind;
  readonly status: ConnectorHealthStatus;
  readonly checkedAt: string;
  readonly evidenceRef?: string;
}

/**
 * A `reconnectConnectorConnection` result: the fresh `ConnectorConnectionInstance`
 * plus an explicit lineage pointer to the revoked binding it replaces.
 * Mirrors this repository's existing "revoked requires an entirely new
 * record, never resurrection" discipline (`partner-capability-admission.ts`'s
 * `REVOKED` claims) - `connection-authority.ts`'s own `ConnectionState`
 * transition table structurally has no edge out of `REVOKED` at all, so
 * reconnecting can only ever mean constructing a brand-new binding, never
 * reviving the old one.
 *
 * Rev93 correction: "reconnect" must preserve the same connector identity
 * as the connection it replaces - `reconnectConnectorConnection` fail-
 * closed rejects a `connectorDescriptor` whose `connectorKind` differs
 * from `previousInstance.connectorKind`, even when both connectors declare
 * the same capability. Without this check, a revoked GitHub connection
 * (say) could be silently "reconnected" as an OpenAI connection sharing
 * the same `requiredCapabilityRef`, making reconnect semantics non-
 * deterministic and weakening provider lineage. Genuine provider
 * switching, if ever needed, must be a separate, explicit rebinding/new-
 * connection operation - never hidden inside `reconnectConnectorConnection`.
 */
export interface ConnectorReconnection {
  readonly instance: ConnectorConnectionInstance;
  readonly supersedesConnectionBindingId: ConnectionBinding["connectionBindingId"];
}

function requireValidTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidConnectorConnectionError(`${field} must be a non-empty string`);
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new InvalidConnectorConnectionError(`${field} must be a valid ISO timestamp`);
  }
  return value;
}

function requireHealthyConnectionForCheck(state: ConnectionState): void {
  if (state !== "CONNECTED_UNVERIFIED" && state !== "VERIFIED" && state !== "DEGRADED") {
    throw new InvalidConnectorConnectionError(
      `a health check requires a live connection (CONNECTED_UNVERIFIED, VERIFIED, or DEGRADED); current state: ${state}`,
    );
  }
}

function ownershipContextMatches(
  a: ConnectionRequirement["ownership"],
  b: ConnectionRequirement["ownership"],
): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.customerId === b.customerId &&
    a.projectId === b.projectId &&
    a.serviceRef === b.serviceRef
  );
}

/**
 * CONN-001: binds a declared `ConnectionRequirement` ("REQUIRED") to an
 * actual catalog connector, producing the first `ConnectionBinding`
 * ("REQUESTED") for it. Fail-closed on two structural checks
 * `connection-authority.ts` itself has no way to express because it does
 * not know about the catalog: (1) the connector must actually declare the
 * requirement's `requiredCapabilityRef` in its own `capabilityRefs` -
 * a requirement can never be "satisfied" by a connector that never claimed
 * to provide that capability; (2) the caller's `authMode` must be one the
 * connector descriptor actually supports. `providerRef` is always set to
 * `connectorDescriptor.connectorKind` (never a caller-supplied free string)
 * so every binding this function produces is traceable to a real,
 * registered catalog entry.
 */
export function requestConnectorConnection(input: {
  requirement: ConnectionRequirement;
  connectorDescriptor: ConnectorDescriptor;
  connectionBindingId: unknown;
  workspaceRef: unknown;
  integrationInstanceRef: unknown;
  delegatedScope: unknown;
  authMode: unknown;
  secretRef?: SecretRef;
}): ConnectorConnectionInstance {
  if (!input.connectorDescriptor.capabilityRefs.includes(input.requirement.requiredCapabilityRef)) {
    throw new InvalidConnectorConnectionError(
      `connector ${input.connectorDescriptor.connectorKind} does not declare capability ${input.requirement.requiredCapabilityRef}`,
    );
  }
  if (
    typeof input.authMode !== "string" ||
    !input.connectorDescriptor.supportedAuthModes.includes(input.authMode as ConnectorAuthMode)
  ) {
    throw new InvalidConnectorConnectionError(
      `authMode must be one of the connector's supported auth modes: ${input.connectorDescriptor.supportedAuthModes.join(", ")}`,
    );
  }
  const authMode = input.authMode as ConnectorAuthMode;

  const binding = createConnectionBinding({
    connectionBindingId: input.connectionBindingId,
    requirement: input.requirement,
    ownership: input.requirement.ownership,
    providerRef: input.connectorDescriptor.connectorKind,
    workspaceRef: input.workspaceRef,
    integrationInstanceRef: input.integrationInstanceRef,
    delegatedScope: input.delegatedScope,
    ...(input.secretRef !== undefined ? { secretRef: input.secretRef } : {}),
  });

  return { binding, connectorKind: input.connectorDescriptor.connectorKind, authMode };
}

/**
 * Thin delegation to `connection-authority.ts`'s `transitionConnectionBinding`,
 * preserving `connectorKind`/`authMode` on the wrapper. Exists so a caller
 * working with `ConnectorConnectionInstance` never has to reach into
 * `.binding` and reconstruct the wrapper by hand.
 */
export function transitionConnectorConnection(
  instance: ConnectorConnectionInstance,
  to: ConnectionState,
): ConnectorConnectionInstance {
  return { ...instance, binding: transitionConnectionBinding(instance.binding, to) };
}

/** Thin delegation to `connection-authority.ts`'s `verifyConnectionBinding`. */
export function verifyConnectorConnection(
  instance: ConnectorConnectionInstance,
  evidenceRef: unknown,
): ConnectorConnectionInstance {
  return { ...instance, binding: verifyConnectionBinding(instance.binding, evidenceRef) };
}

/**
 * CONN-001: "rotate." A secret rotation must never leave a binding
 * silently `VERIFIED` against a new, as-yet-unverified credential - the
 * exact class of defect this task's own Rev90 F1 findings (on sibling
 * PRs #35-#37) were about. Fail-closed rules:
 * - Only valid on a binding that already has a secret to rotate
 *   (`CONNECTED_UNVERIFIED`, `VERIFIED`, or `DEGRADED`) - `REQUESTED` has no
 *   secret yet (that is what `secretRef` on `requestConnectorConnection`
 *   is for), and `REVOKED`/`HANDOVER_COMPLETE` are terminal.
 * - `newSecretRef` must genuinely differ from the binding's current
 *   `secretRef` (reusing the same distinctness discipline as
 *   `promoteToReusable`'s `reusableAssetRef` check, `V5-LAB-001`) - a
 *   caller cannot "rotate" a secret to itself.
 * - A currently-`VERIFIED` binding is demoted to `DEGRADED` via the
 *   already-existing, unmodified `VERIFIED -> DEGRADED` transition edge in
 *   `connection-authority.ts` - the new credential must be independently
 *   re-verified (`verifyConnectorConnection`) before this binding can be
 *   `VERIFIED` again. A `CONNECTED_UNVERIFIED`/`DEGRADED` binding was
 *   already not-verified, so its state is unchanged; only the secret
 *   itself is replaced.
 */
export function rotateConnectorSecret(input: {
  instance: ConnectorConnectionInstance;
  newSecretRef: SecretRef;
}): ConnectorConnectionInstance {
  const { instance, newSecretRef } = input;
  const state = instance.binding.connectionState;
  if (state !== "CONNECTED_UNVERIFIED" && state !== "VERIFIED" && state !== "DEGRADED") {
    throw new InvalidConnectorConnectionError(
      `a secret can only be rotated on a CONNECTED_UNVERIFIED, VERIFIED, or DEGRADED binding; current state: ${state}`,
    );
  }
  if (instance.binding.secretRef === newSecretRef.secretRefId) {
    throw new InvalidConnectorConnectionError(
      "newSecretRef must be genuinely different from the binding's current secretRef - rotating a secret to itself is not permitted",
    );
  }

  const rotatedBinding: ConnectionBinding =
    state === "VERIFIED"
      ? { ...transitionConnectionBinding(instance.binding, "DEGRADED"), secretRef: newSecretRef.secretRefId }
      : { ...instance.binding, secretRef: newSecretRef.secretRefId };

  return { ...instance, binding: rotatedBinding };
}

/**
 * CONN-001: "reconnect." Only a genuinely `REVOKED` binding may be
 * reconnected (a `HANDOVER_COMPLETE` binding is permanently terminal -
 * the AKILTA relationship for that binding is over, not paused).
 * Fail-closed cross-tenant check: the caller-supplied `ownershipContext`
 * must exactly match both the (unchanged) `requirement.ownership` and the
 * previous binding's own `ownership` - a caller cannot reconnect a
 * different tenant/customer/project's revoked connection by supplying a
 * mismatched context, even if it somehow held a reference to that
 * `ConnectorConnectionInstance`. Because `connection-authority.ts`'s own
 * transition table has no edge out of `REVOKED`, this necessarily produces
 * a brand-new `ConnectionBinding` (new `connectionBindingId`, fresh
 * `REQUESTED` state) rather than reviving the old one - `previousBinding`'s
 * id is recorded only as `supersedesConnectionBindingId` lineage, never
 * reused as the new binding's own id.
 */
export function reconnectConnectorConnection(input: {
  requirement: ConnectionRequirement;
  connectorDescriptor: ConnectorDescriptor;
  previousInstance: ConnectorConnectionInstance;
  ownershipContext: ConnectionRequirement["ownership"];
  connectionBindingId: unknown;
  workspaceRef: unknown;
  integrationInstanceRef: unknown;
  delegatedScope: unknown;
  authMode: unknown;
  secretRef?: SecretRef;
}): ConnectorReconnection {
  const previousBinding = input.previousInstance.binding;
  if (previousBinding.connectionState !== "REVOKED") {
    throw new InvalidConnectorConnectionError(
      `only a REVOKED connection may be reconnected; current state: ${previousBinding.connectionState}`,
    );
  }
  if (previousBinding.connectionRequirementId !== input.requirement.connectionRequirementId) {
    throw new InvalidConnectorConnectionError(
      "previousInstance was not bound to the given requirement - cannot reconnect against a different requirement",
    );
  }
  if (input.previousInstance.connectorKind !== input.connectorDescriptor.connectorKind) {
    throw new InvalidConnectorConnectionError(
      `reconnection must preserve the same connector identity - previousInstance is ${input.previousInstance.connectorKind}, connectorDescriptor is ${input.connectorDescriptor.connectorKind}; provider switching requires a separate, explicit rebinding operation`,
    );
  }
  if (
    !ownershipContextMatches(input.ownershipContext, input.requirement.ownership) ||
    !ownershipContextMatches(input.ownershipContext, previousBinding.ownership)
  ) {
    throw new InvalidConnectorConnectionError(
      "ownershipContext does not match this requirement/binding's own tenant/customer/project scope (cross-tenant reconnection is not permitted)",
    );
  }
  if (previousBinding.connectionBindingId === input.connectionBindingId) {
    throw new InvalidConnectorConnectionError(
      "a reconnection must use a genuinely new connectionBindingId - a revoked binding is never resurrected under its own id",
    );
  }

  const instance = requestConnectorConnection({
    requirement: input.requirement,
    connectorDescriptor: input.connectorDescriptor,
    connectionBindingId: input.connectionBindingId,
    workspaceRef: input.workspaceRef,
    integrationInstanceRef: input.integrationInstanceRef,
    delegatedScope: input.delegatedScope,
    authMode: input.authMode,
    ...(input.secretRef !== undefined ? { secretRef: input.secretRef } : {}),
  });

  return { instance, supersedesConnectionBindingId: previousBinding.connectionBindingId };
}

/**
 * CONN-001: "test/health." Pure recording only - see the `ConnectorHealthStatus`
 * doc comment above for why this never mutates connection state. Rejects a
 * health check against a binding with no live connection to check
 * (`REQUESTED`, `REVOKED`, `HANDOVER_COMPLETE`).
 */
export function recordConnectorHealthCheck(input: {
  instance: ConnectorConnectionInstance;
  status: unknown;
  checkedAt: unknown;
  evidenceRef?: unknown;
}): ConnectorHealthCheckRecord {
  requireHealthyConnectionForCheck(input.instance.binding.connectionState);
  if (typeof input.status !== "string" || !RECOGNIZED_HEALTH_STATUSES.has(input.status)) {
    throw new InvalidConnectorConnectionError(
      `status must be one of HEALTHY, DEGRADED, UNREACHABLE, UNKNOWN; got ${JSON.stringify(input.status)}`,
    );
  }
  const checkedAt = requireValidTimestamp(input.checkedAt, "checkedAt");

  const base = {
    connectionBindingId: input.instance.binding.connectionBindingId,
    connectorKind: input.instance.connectorKind,
    status: input.status as ConnectorHealthStatus,
    checkedAt,
  };
  if (input.evidenceRef === undefined) {
    return base;
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  return { ...base, evidenceRef };
}
