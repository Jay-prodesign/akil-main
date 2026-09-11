import type { ConnectorAuthMode, ConnectorKind, ConnectorConnectionInstance } from "./integration-connector-catalog.js";
import {
  validateConnectorEndpoints,
  requireAbsoluteHttpUrl,
  InvalidGenericConnectorDefinitionError,
  type GenericConnectorEndpointDefinition,
} from "./generic-connector-definition.js";

/**
 * CONN-001 slice 5: "prebuilt adapters" step. Static, real endpoint/
 * capability declarations for the prebuilt connector kinds whose public
 * API this module can honestly describe as a single, stable, well-
 * documented HTTP surface - still no real HTTP call, DNS resolution, or
 * request ever executed, matching every other module in `src/domain/`.
 *
 * Reuses `generic-connector-definition.ts`'s own endpoint/URL validators
 * rather than re-implementing them, so a prebuilt definition and a
 * caller-authored Generic Custom API definition are held to exactly the
 * same fail-closed shape rules.
 *
 * DELIBERATELY DEFERRED, NOT FABRICATED (Rev90's own "avoid speculative
 * provider breadth" instruction):
 * - `GOOGLE_WORKSPACE` - the blueprint's own text calls for "applicable
 *   Docs/Sheets/Slides capabilities," but those are three genuinely
 *   distinct Google API hosts (`docs.googleapis.com`,
 *   `sheets.googleapis.com`, `slides.googleapis.com`). This module's
 *   `PrebuiltConnectorDefinition` (like `GenericApiConnectorDefinition`)
 *   has exactly one `baseUrl` per definition - supporting three hosts
 *   under one definition would require a genuine architecture decision
 *   (a per-endpoint base-URL override) this bounded slice does not
 *   unilaterally make. Fabricating a definition against only one of the
 *   three hosts and calling it "Workspace" would misrepresent capability.
 * - `META` - Rev90's own text: "may be included when its adapter can be
 *   implemented honestly without production credential activation." Meta
 *   exposes multiple, materially different product APIs (Graph API,
 *   WhatsApp Business API, Marketing API) with no single canonical
 *   surface a bounded slice can honestly default to without guessing
 *   which product this repository actually needs.
 *
 * `GOOGLE_DRIVE` is included (the blueprint explicitly names it as
 * requiring "a real initial connector capability, not a decorative
 * catalog card") because the Drive API v3 is genuinely one stable host
 * covering search/read/create/write/share.
 */
const PREBUILT_ENDPOINT_SOURCE: Record<
  "GITHUB" | "OPENAI" | "ANTHROPIC" | "GOOGLE_AI" | "GOOGLE_DRIVE",
  {
    baseUrl: string;
    authMode: ConnectorAuthMode;
    endpoints: ReadonlyArray<{ capabilityRef: string; method: GenericConnectorEndpointDefinition["method"]; path: string }>;
  }
> = {
  GITHUB: {
    baseUrl: "https://api.github.com",
    authMode: "OAUTH2",
    endpoints: [
      { capabilityRef: "cap:github-repo-metadata", method: "GET", path: "/repos/{owner}/{repo}" },
      { capabilityRef: "cap:github-repo-contents-read", method: "GET", path: "/repos/{owner}/{repo}/contents/{path}" },
    ],
  },
  OPENAI: {
    baseUrl: "https://api.openai.com/v1",
    authMode: "API_KEY",
    endpoints: [
      { capabilityRef: "cap:openai-model-inference", method: "POST", path: "/chat/completions" },
      { capabilityRef: "cap:openai-model-catalog", method: "GET", path: "/models" },
    ],
  },
  ANTHROPIC: {
    baseUrl: "https://api.anthropic.com/v1",
    authMode: "API_KEY",
    endpoints: [
      { capabilityRef: "cap:anthropic-model-inference", method: "POST", path: "/messages" },
      { capabilityRef: "cap:anthropic-model-catalog", method: "GET", path: "/models" },
    ],
  },
  GOOGLE_AI: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authMode: "API_KEY",
    endpoints: [
      { capabilityRef: "cap:google-ai-model-inference", method: "POST", path: "/models/{model}:generateContent" },
      { capabilityRef: "cap:google-ai-model-catalog", method: "GET", path: "/models" },
    ],
  },
  GOOGLE_DRIVE: {
    baseUrl: "https://www.googleapis.com/drive/v3",
    authMode: "OAUTH2",
    endpoints: [
      { capabilityRef: "cap:drive-search", method: "GET", path: "/files" },
      { capabilityRef: "cap:drive-read", method: "GET", path: "/files/{fileId}" },
      { capabilityRef: "cap:drive-create", method: "POST", path: "/files" },
      { capabilityRef: "cap:drive-write", method: "PATCH", path: "/files/{fileId}" },
      { capabilityRef: "cap:drive-share", method: "POST", path: "/files/{fileId}/permissions" },
    ],
  },
};

export type DefinedPrebuiltConnectorKind = keyof typeof PREBUILT_ENDPOINT_SOURCE;

export interface PrebuiltConnectorDefinition {
  readonly connectorKind: DefinedPrebuiltConnectorKind;
  readonly baseUrl: string;
  readonly authMode: ConnectorAuthMode;
  readonly endpoints: ReadonlyArray<GenericConnectorEndpointDefinition>;
}

/**
 * Built once, validated through the exact same fail-closed rules as any
 * caller-authored generic definition - if a hardcoded entry above were
 * ever malformed (a duplicate capabilityRef, a bad path, an invalid URL),
 * this throws at module load time rather than silently registering a
 * broken definition.
 */
const PREBUILT_CONNECTOR_DEFINITIONS: ReadonlyMap<DefinedPrebuiltConnectorKind, PrebuiltConnectorDefinition> = new Map(
  (Object.entries(PREBUILT_ENDPOINT_SOURCE) as Array<[DefinedPrebuiltConnectorKind, (typeof PREBUILT_ENDPOINT_SOURCE)[DefinedPrebuiltConnectorKind]]>).map(
    ([connectorKind, source]) => [
      connectorKind,
      {
        connectorKind,
        baseUrl: requireAbsoluteHttpUrl(source.baseUrl, `${connectorKind}.baseUrl`),
        authMode: source.authMode,
        endpoints: validateConnectorEndpoints(source.endpoints),
      },
    ],
  ),
);

/**
 * Fail-closed: never returns `undefined`. A recognized `PrebuiltConnectorKind`
 * (per `integration-connector-catalog.ts`'s closed enum) that has no entry
 * in this registry yet (`GOOGLE_WORKSPACE`, `META`) throws a distinct,
 * honest "not yet defined" error rather than being confused with a
 * genuinely unrecognized kind.
 */
export function resolvePrebuiltConnectorDefinition(connectorKind: unknown): PrebuiltConnectorDefinition {
  if (typeof connectorKind !== "string") {
    throw new InvalidGenericConnectorDefinitionError("connectorKind must be a string");
  }
  const definition = PREBUILT_CONNECTOR_DEFINITIONS.get(connectorKind as DefinedPrebuiltConnectorKind);
  if (definition !== undefined) {
    return definition;
  }
  if (connectorKind === "GOOGLE_WORKSPACE" || connectorKind === "META") {
    throw new InvalidGenericConnectorDefinitionError(
      `${connectorKind} is a recognized prebuilt connector kind but has no defined endpoint set yet - deliberately deferred, not fabricated`,
    );
  }
  throw new InvalidGenericConnectorDefinitionError(`${connectorKind} has no prebuilt connector definition`);
}

export function listDefinedPrebuiltConnectorKinds(): ReadonlyArray<DefinedPrebuiltConnectorKind> {
  return [...PREBUILT_CONNECTOR_DEFINITIONS.keys()];
}

/**
 * Same binding discipline as `bindGenericApiDefinition`/`bindGenericOAuthDefinition`
 * in `generic-connector-definition.ts`: fail-closed rejects a prebuilt
 * definition attaching to the wrong connector kind, connection, or auth
 * mode - a definition can never be silently attached to a connection it
 * does not describe.
 */
export function bindPrebuiltDefinition(input: {
  instance: ConnectorConnectionInstance;
  definition: PrebuiltConnectorDefinition;
}): { instance: ConnectorConnectionInstance; definition: PrebuiltConnectorDefinition } {
  const instanceKind: ConnectorKind = input.instance.connectorKind;
  if (instanceKind !== input.definition.connectorKind) {
    throw new InvalidGenericConnectorDefinitionError(
      `instance.connectorKind (${instanceKind}) does not match definition.connectorKind (${input.definition.connectorKind})`,
    );
  }
  if (input.instance.authMode !== input.definition.authMode) {
    throw new InvalidGenericConnectorDefinitionError(
      `instance.authMode (${input.instance.authMode}) does not match definition.authMode (${input.definition.authMode})`,
    );
  }
  return input;
}
