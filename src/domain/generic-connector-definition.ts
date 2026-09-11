import type { RequirementId } from "./offer-blueprint.js";
import type { ConnectorAuthMode, ConnectorConnectionInstance } from "./integration-connector-catalog.js";

export class InvalidGenericConnectorDefinitionError extends Error {
  constructor(reason: string) {
    super(`Invalid generic connector definition: ${reason}`);
    this.name = "InvalidGenericConnectorDefinitionError";
  }
}

/**
 * CONN-001 slice 4: the mandatory Generic Custom API Connector and Generic
 * Custom OAuth Connector's own declarative definition shape - "model base
 * URL, endpoints/methods, capability definitions, request/response
 * mapping, validation/test endpoint, health state, rate-limit/retry
 * metadata." Matching every other module in `src/domain/`, this is a
 * pure, in-memory data contract with fail-closed validation only - it
 * makes no real HTTP call, resolves no DNS, and never executes a request.
 * A definition is "declared, not yet producible" in exactly the sense
 * this repository already uses elsewhere (e.g. `service-capability-
 * routing.ts`'s `ExecutionMaturity`): the shape a real adapter would need
 * to actually call an endpoint exists here, but calling it remains a
 * genuinely separate, credential-gated concern this module does not
 * fabricate.
 *
 * `requestMapping`/`responseMapping` are opaque, uninterpreted pointers -
 * exactly like `connection-authority.ts`'s `providerRef`/`workspaceRef` or
 * `offer-blueprint.ts`'s `requirementId` - this module never reads or
 * interprets what they point to, only carries and validates their
 * presence, matching this repository's structural discipline of not
 * inventing a parallel mapping/execution engine.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const RECOGNIZED_HTTP_METHODS: ReadonlySet<string> = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * CONN-001: Generic Custom API auth modes are "API key, Bearer, Basic and
 * custom headers" - explicitly never `OAUTH2` (that is exactly what the
 * Generic Custom OAuth Connector, below, is for). This module never mixes
 * the two connector families under one auth surface.
 */
export type GenericApiAuthMode = Exclude<ConnectorAuthMode, "OAUTH2">;

const RECOGNIZED_GENERIC_API_AUTH_MODES: ReadonlySet<string> = new Set<GenericApiAuthMode>([
  "API_KEY",
  "BEARER_TOKEN",
  "BASIC",
  "CUSTOM_HEADER",
]);

export interface GenericConnectorEndpointDefinition {
  readonly capabilityRef: RequirementId;
  readonly method: HttpMethod;
  readonly path: string;
  readonly requestMapping?: string;
  readonly responseMapping?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidGenericConnectorDefinitionError(`${field} must be a non-empty string`);
  }
  return value;
}

/** Exported for reuse by `prebuilt-connector-definitions.ts`. */
export function requireAbsoluteHttpUrl(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InvalidGenericConnectorDefinitionError(`${field} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidGenericConnectorDefinitionError(`${field} must use http or https`);
  }
  return raw;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InvalidGenericConnectorDefinitionError(`${field} must be a positive integer`);
  }
  return value;
}

/**
 * Fail-closed rules shared by both connector families:
 * - at least one endpoint (a connector with no declared capability cannot
 *   satisfy any `ConnectionRequirement` at all - see `requestConnectorConnection`
 *   in `integration-connector-catalog.ts`, which already requires the
 *   catalog descriptor to declare the requirement's capability).
 * - every endpoint's `method` must be recognized and `path` must be a
 *   non-empty string starting with `/` (a relative path segment, joined
 *   against the connector's own base/authorization URL by whatever real
 *   adapter eventually executes it - never interpreted here).
 * - no two endpoints may declare the same `capabilityRef` - capability
 *   resolution (`resolveEndpointForCapability`, below) would otherwise be
 *   ambiguous.
 */
/**
 * Exported so `prebuilt-connector-definitions.ts` can reuse the exact
 * same endpoint validation discipline for CONN-001's prebuilt connector
 * registry, rather than re-implementing (and risking silently diverging
 * from) these fail-closed rules.
 */
export function validateConnectorEndpoints(endpoints: unknown): ReadonlyArray<GenericConnectorEndpointDefinition> {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new InvalidGenericConnectorDefinitionError("endpoints must be a non-empty array");
  }
  const seenCapabilityRefs = new Set<string>();
  const validated: GenericConnectorEndpointDefinition[] = [];
  for (const [index, raw] of endpoints.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new InvalidGenericConnectorDefinitionError(`endpoints[${index}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const capabilityRef = requireNonEmptyString(entry.capabilityRef, `endpoints[${index}].capabilityRef`);
    if (seenCapabilityRefs.has(capabilityRef)) {
      throw new InvalidGenericConnectorDefinitionError(
        `endpoints contains a duplicate capabilityRef: ${capabilityRef}`,
      );
    }
    seenCapabilityRefs.add(capabilityRef);
    if (typeof entry.method !== "string" || !RECOGNIZED_HTTP_METHODS.has(entry.method)) {
      throw new InvalidGenericConnectorDefinitionError(`endpoints[${index}].method is not a recognized HTTP method`);
    }
    const path = requireNonEmptyString(entry.path, `endpoints[${index}].path`);
    if (!path.startsWith("/")) {
      throw new InvalidGenericConnectorDefinitionError(`endpoints[${index}].path must start with "/"`);
    }
    const base = {
      capabilityRef: capabilityRef as RequirementId,
      method: entry.method as HttpMethod,
      path,
    };
    const withRequestMapping =
      entry.requestMapping === undefined
        ? base
        : { ...base, requestMapping: requireNonEmptyString(entry.requestMapping, `endpoints[${index}].requestMapping`) };
    const withResponseMapping =
      entry.responseMapping === undefined
        ? withRequestMapping
        : {
            ...withRequestMapping,
            responseMapping: requireNonEmptyString(entry.responseMapping, `endpoints[${index}].responseMapping`),
          };
    validated.push(withResponseMapping);
  }
  return validated;
}

/**
 * CONN-001: "validation/test endpoint" - the acceptance floor's own
 * "Test Connection passes" step needs a specific endpoint to probe.
 * `validationEndpointCapabilityRef`, when supplied, is fail-closed
 * required to reference a capability the definition actually declares -
 * a definition can never point its own test probe at a nonexistent
 * endpoint.
 */
export interface GenericApiConnectorDefinition {
  readonly connectionBindingId: ConnectorConnectionInstance["binding"]["connectionBindingId"];
  readonly baseUrl: string;
  readonly authMode: GenericApiAuthMode;
  readonly endpoints: ReadonlyArray<GenericConnectorEndpointDefinition>;
  readonly validationEndpointCapabilityRef?: RequirementId;
  readonly rateLimitPerMinute?: number;
  readonly retryMaxAttempts?: number;
}

export function createGenericApiConnectorDefinition(input: {
  connectionBindingId: unknown;
  baseUrl: unknown;
  authMode: unknown;
  endpoints: unknown;
  validationEndpointCapabilityRef?: unknown;
  rateLimitPerMinute?: unknown;
  retryMaxAttempts?: unknown;
}): GenericApiConnectorDefinition {
  const connectionBindingId = requireNonEmptyString(
    input.connectionBindingId,
    "connectionBindingId",
  ) as unknown as ConnectorConnectionInstance["binding"]["connectionBindingId"];
  const baseUrl = requireAbsoluteHttpUrl(input.baseUrl, "baseUrl");
  if (typeof input.authMode !== "string" || !RECOGNIZED_GENERIC_API_AUTH_MODES.has(input.authMode)) {
    throw new InvalidGenericConnectorDefinitionError(
      "authMode must be one of API_KEY, BEARER_TOKEN, BASIC, CUSTOM_HEADER - OAUTH2 is not permitted on a Generic Custom API definition",
    );
  }
  const authMode = input.authMode as GenericApiAuthMode;
  const endpoints = validateConnectorEndpoints(input.endpoints);

  let validationEndpointCapabilityRef: RequirementId | undefined;
  if (input.validationEndpointCapabilityRef !== undefined) {
    const ref = requireNonEmptyString(input.validationEndpointCapabilityRef, "validationEndpointCapabilityRef");
    if (!endpoints.some((endpoint) => (endpoint.capabilityRef as string) === ref)) {
      throw new InvalidGenericConnectorDefinitionError(
        `validationEndpointCapabilityRef "${ref}" does not match any declared endpoint`,
      );
    }
    validationEndpointCapabilityRef = ref as RequirementId;
  }

  const rateLimitPerMinute =
    input.rateLimitPerMinute === undefined ? undefined : requirePositiveInteger(input.rateLimitPerMinute, "rateLimitPerMinute");
  const retryMaxAttempts =
    input.retryMaxAttempts === undefined ? undefined : requirePositiveInteger(input.retryMaxAttempts, "retryMaxAttempts");

  return {
    connectionBindingId,
    baseUrl,
    authMode,
    endpoints,
    ...(validationEndpointCapabilityRef !== undefined ? { validationEndpointCapabilityRef } : {}),
    ...(rateLimitPerMinute !== undefined ? { rateLimitPerMinute } : {}),
    ...(retryMaxAttempts !== undefined ? { retryMaxAttempts } : {}),
  };
}

/**
 * CONN-001: "support multiple independent customer/workspace/provider
 * instances" for delegated OAuth2. `authMode` is not a field here at
 * all - it is implicitly `OAUTH2` by construction, the same "structural,
 * not a settable field" discipline `project-bootstrap-template.ts` uses
 * for `supersedesLocalAuthority: false`.
 */
export interface GenericOAuthConnectorDefinition {
  readonly connectionBindingId: ConnectorConnectionInstance["binding"]["connectionBindingId"];
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: ReadonlyArray<string>;
  readonly endpoints: ReadonlyArray<GenericConnectorEndpointDefinition>;
}

export function createGenericOAuthConnectorDefinition(input: {
  connectionBindingId: unknown;
  authorizationUrl: unknown;
  tokenUrl: unknown;
  scopes: unknown;
  endpoints: unknown;
}): GenericOAuthConnectorDefinition {
  const connectionBindingId = requireNonEmptyString(
    input.connectionBindingId,
    "connectionBindingId",
  ) as unknown as ConnectorConnectionInstance["binding"]["connectionBindingId"];
  const authorizationUrl = requireAbsoluteHttpUrl(input.authorizationUrl, "authorizationUrl");
  const tokenUrl = requireAbsoluteHttpUrl(input.tokenUrl, "tokenUrl");

  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    throw new InvalidGenericConnectorDefinitionError("scopes must be a non-empty array");
  }
  const seenScopes = new Set<string>();
  const scopes: string[] = [];
  for (const [index, scope] of input.scopes.entries()) {
    const value = requireNonEmptyString(scope, `scopes[${index}]`);
    if (seenScopes.has(value)) {
      throw new InvalidGenericConnectorDefinitionError(`scopes contains a duplicate entry: ${value}`);
    }
    seenScopes.add(value);
    scopes.push(value);
  }

  const endpoints = validateConnectorEndpoints(input.endpoints);

  return { connectionBindingId, authorizationUrl, tokenUrl, scopes, endpoints };
}

/**
 * Fail-closed resolution, matching `resolveConnectorDescriptor`'s own
 * discipline in `integration-connector-catalog.ts`: never returns
 * `undefined` for a capability the definition does not declare. This is
 * the function a real adapter/router would call to find which endpoint
 * satisfies a given capability - still no HTTP call is made here.
 */
export function resolveEndpointForCapability(
  definition: { endpoints: ReadonlyArray<GenericConnectorEndpointDefinition> },
  capabilityRef: unknown,
): GenericConnectorEndpointDefinition {
  if (typeof capabilityRef !== "string") {
    throw new InvalidGenericConnectorDefinitionError("capabilityRef must be a string");
  }
  const endpoint = definition.endpoints.find((candidate) => (candidate.capabilityRef as string) === capabilityRef);
  if (endpoint === undefined) {
    throw new InvalidGenericConnectorDefinitionError(
      `no endpoint declares capabilityRef: ${capabilityRef}`,
    );
  }
  return endpoint;
}

/**
 * Binds a declarative definition to the actual `ConnectorConnectionInstance`
 * it describes, fail-closed rejecting any mismatch: the definition must
 * belong to the same `connectionBindingId`, the instance must actually be
 * a `GENERIC_CUSTOM_API` connection, and its `authMode` must match the
 * definition's own - a definition can never be silently attached to a
 * connection it does not describe.
 */
export function bindGenericApiDefinition(input: {
  instance: ConnectorConnectionInstance;
  definition: GenericApiConnectorDefinition;
}): { instance: ConnectorConnectionInstance; definition: GenericApiConnectorDefinition } {
  if (input.instance.connectorKind !== "GENERIC_CUSTOM_API") {
    throw new InvalidGenericConnectorDefinitionError(
      `a GenericApiConnectorDefinition can only bind to a GENERIC_CUSTOM_API instance; got ${input.instance.connectorKind}`,
    );
  }
  if (input.instance.binding.connectionBindingId !== input.definition.connectionBindingId) {
    throw new InvalidGenericConnectorDefinitionError(
      "definition.connectionBindingId does not match instance.binding.connectionBindingId",
    );
  }
  if (input.instance.authMode !== input.definition.authMode) {
    throw new InvalidGenericConnectorDefinitionError(
      `instance.authMode (${input.instance.authMode}) does not match definition.authMode (${input.definition.authMode})`,
    );
  }
  return input;
}

/** Same binding discipline as `bindGenericApiDefinition`, for the OAuth family. */
export function bindGenericOAuthDefinition(input: {
  instance: ConnectorConnectionInstance;
  definition: GenericOAuthConnectorDefinition;
}): { instance: ConnectorConnectionInstance; definition: GenericOAuthConnectorDefinition } {
  if (input.instance.connectorKind !== "GENERIC_CUSTOM_OAUTH") {
    throw new InvalidGenericConnectorDefinitionError(
      `a GenericOAuthConnectorDefinition can only bind to a GENERIC_CUSTOM_OAUTH instance; got ${input.instance.connectorKind}`,
    );
  }
  if (input.instance.binding.connectionBindingId !== input.definition.connectionBindingId) {
    throw new InvalidGenericConnectorDefinitionError(
      "definition.connectionBindingId does not match instance.binding.connectionBindingId",
    );
  }
  if (input.instance.authMode !== "OAUTH2") {
    throw new InvalidGenericConnectorDefinitionError(
      `instance.authMode must be OAUTH2 for a GENERIC_CUSTOM_OAUTH instance; got ${input.instance.authMode}`,
    );
  }
  return input;
}
