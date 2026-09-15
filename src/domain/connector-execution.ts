import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { ConnectorConnectionInstance, ConnectorKind } from "./integration-connector-catalog.js";
import type {
  GenericApiConnectorDefinition,
  GenericOAuthConnectorDefinition,
  GenericConnectorEndpointDefinition,
} from "./generic-connector-definition.js";
import { resolveEndpointForCapability } from "./generic-connector-definition.js";
import type { PrebuiltConnectorDefinition } from "./prebuilt-connector-definitions.js";

export class ConnectorExecutionNotAuthorizedError extends Error {
  constructor(reason: string) {
    super(`Connector execution not authorized: ${reason}`);
    this.name = "ConnectorExecutionNotAuthorizedError";
  }
}

export class UnresolvedConnectorSecretError extends Error {
  constructor(reason: string) {
    super(`Unresolved connector secret: ${reason}`);
    this.name = "UnresolvedConnectorSecretError";
  }
}

export class ConnectorExecutionAuthorizationError extends Error {
  constructor(reason: string) {
    super(`Connector execution authorization failed: ${reason}`);
    this.name = "ConnectorExecutionAuthorizationError";
  }
}

export class ConnectorExecutionTransportError extends Error {
  constructor(reason: string) {
    super(`Connector execution transport error: ${reason}`);
    this.name = "ConnectorExecutionTransportError";
  }
}

/**
 * Rev94 F3: "dark/internal adapter implementation, mock transports,
 * fixtures, health/capability discovery logic and deterministic E2E
 * acceptance are NOT gated" - real credential ACTIVATION is. This module
 * is the mockable/injectable execution boundary that makes that floor
 * concrete: it never performs a real HTTP call, DNS resolution or OAuth
 * exchange itself (matching every other module in `src/domain/`) - a
 * caller-injected `ConnectorTransport` is the ONLY way any request ever
 * "executes," so tests exercise the full authorization/capability/secret-
 * boundary logic against a deterministic mock rather than a live network
 * call, and a real production adapter can implement the exact same
 * `ConnectorTransport` interface against a genuine HTTP client without
 * this module changing at all.
 *
 * Layering (Rev94's own explicit separation): connector definition
 * (`generic-connector-definition.ts`/`prebuilt-connector-definitions.ts`)
 * -> connection binding (`connection-authority.ts`) -> `SecretRef`
 * (opaque reference only) -> runtime secret resolver boundary
 * (`SecretResolver`, below) -> transport/execution adapter
 * (`ConnectorTransport`, below) -> response normalization
 * (`ConnectorExecutionResult`). Each layer is a distinct type; no field
 * anywhere in this module can hold raw secret material except the one
 * short-lived `authSecretValue` handed to the injected transport at the
 * moment of execution - it is never echoed into `ConnectorExecutionResult`,
 * a log, or any other object this module itself constructs.
 */
export interface SecretResolver {
  resolve(secretRefId: string): string;
}

export interface ConnectorTransportRequest {
  readonly connectorKind: ConnectorKind;
  readonly connectionBindingId: ConnectorConnectionInstance["binding"]["connectionBindingId"];
  readonly capabilityRef: GenericConnectorEndpointDefinition["capabilityRef"];
  readonly method: GenericConnectorEndpointDefinition["method"];
  readonly path: string;
  readonly baseUrl?: string;
  readonly authSecretValue: string;
  readonly requestPayload?: unknown;
}

export type ConnectorTransportOutcome = "SUCCESS" | "AUTHORIZATION_FAILED" | "TRANSPORT_ERROR";

export interface ConnectorTransportResponse {
  readonly outcome: ConnectorTransportOutcome;
  readonly data?: unknown;
  readonly errorMessage?: string;
}

/**
 * Caller-injected transport - a real adapter implements this against an
 * actual HTTP client; every test in this repository implements it as a
 * deterministic mock. This module never imports or constructs a real
 * transport itself (verified by the CONN-001 boundary scan's existing
 * "no OAuth/HTTP-client runtime dependency" check).
 */
export interface ConnectorTransport {
  execute(request: ConnectorTransportRequest): ConnectorTransportResponse;
}

export interface ConnectorExecutionResult {
  readonly connectorKind: ConnectorKind;
  readonly connectionBindingId: ConnectorConnectionInstance["binding"]["connectionBindingId"];
  readonly capabilityRef: GenericConnectorEndpointDefinition["capabilityRef"];
  readonly data?: unknown;
}

type BoundConnectorDefinition = {
  readonly instance: ConnectorConnectionInstance;
  readonly definition: GenericApiConnectorDefinition | GenericOAuthConnectorDefinition | PrebuiltConnectorDefinition;
};

function ownershipMatches(a: ProjectOwnershipRef, b: ProjectOwnershipRef): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.customerId === b.customerId &&
    a.projectId === b.projectId &&
    a.serviceRef === b.serviceRef
  );
}

function effectiveBaseUrl(
  definition: BoundConnectorDefinition["definition"],
  endpoint: GenericConnectorEndpointDefinition,
): string | undefined {
  if (endpoint.baseUrlOverride !== undefined) {
    return endpoint.baseUrlOverride;
  }
  if ("baseUrl" in definition) {
    return definition.baseUrl;
  }
  return undefined;
}

/**
 * Rev94 F3's mandatory fail-closed list, checked in this exact order
 * before any transport call is made: wrong tenant/project binding
 * (`ownershipMatches`); revoked/degraded/unverified connection state
 * (only `VERIFIED` may execute); undeclared endpoint / capability never
 * admitted (`resolveEndpointForCapability`, which never returns
 * `undefined`); unresolved `SecretRef`. Only after all four pass does this
 * function ever call the injected `transport`, and a transport-reported
 * authorization failure is itself surfaced as a thrown, fail-closed error
 * rather than a silently-returned ambiguous result.
 */
export function executeConnectorCapability(input: {
  bound: BoundConnectorDefinition;
  capabilityRef: unknown;
  requestingOwnership: ProjectOwnershipRef;
  secretResolver: SecretResolver;
  transport: ConnectorTransport;
  requestPayload?: unknown;
}): ConnectorExecutionResult {
  const { instance, definition } = input.bound;

  if (!ownershipMatches(input.requestingOwnership, instance.binding.ownership)) {
    throw new ConnectorExecutionNotAuthorizedError(
      "requestingOwnership does not match this connection's own tenant/customer/project/service scope",
    );
  }
  if (instance.binding.connectionState !== "VERIFIED") {
    throw new ConnectorExecutionNotAuthorizedError(
      `connection must be VERIFIED to execute; current state: ${instance.binding.connectionState}`,
    );
  }

  const endpoint = resolveEndpointForCapability(definition, input.capabilityRef);

  if (instance.binding.secretRef === undefined) {
    throw new UnresolvedConnectorSecretError("connection has no secretRef bound - nothing to resolve");
  }
  let authSecretValue: string;
  try {
    authSecretValue = input.secretResolver.resolve(instance.binding.secretRef);
  } catch (cause) {
    throw new UnresolvedConnectorSecretError(
      `secretResolver could not resolve secretRef "${instance.binding.secretRef}" (${(cause as Error).message})`,
    );
  }
  if (typeof authSecretValue !== "string" || authSecretValue.length === 0) {
    throw new UnresolvedConnectorSecretError(
      `secretResolver returned an empty value for secretRef "${instance.binding.secretRef}"`,
    );
  }

  const baseUrl = effectiveBaseUrl(definition, endpoint);
  const transportRequest: ConnectorTransportRequest = {
    connectorKind: instance.connectorKind,
    connectionBindingId: instance.binding.connectionBindingId,
    capabilityRef: endpoint.capabilityRef,
    method: endpoint.method,
    path: endpoint.path,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    authSecretValue,
    ...(input.requestPayload !== undefined ? { requestPayload: input.requestPayload } : {}),
  };

  const response = input.transport.execute(transportRequest);

  if (response.outcome === "AUTHORIZATION_FAILED") {
    throw new ConnectorExecutionAuthorizationError(
      response.errorMessage ?? "transport reported an authorization failure",
    );
  }
  if (response.outcome === "TRANSPORT_ERROR") {
    throw new ConnectorExecutionTransportError(response.errorMessage ?? "transport reported an error");
  }

  return {
    connectorKind: instance.connectorKind,
    connectionBindingId: instance.binding.connectionBindingId,
    capabilityRef: endpoint.capabilityRef,
    ...(response.data !== undefined ? { data: response.data } : {}),
  };
}
