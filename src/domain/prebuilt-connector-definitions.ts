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
 * Rev94 F3 correction: `GOOGLE_WORKSPACE` is now defined. The original
 * Rev90 deferral reasoned that Docs/Sheets/Slides live on three genuinely
 * distinct API hosts and that `PrebuiltConnectorDefinition` had exactly
 * one `baseUrl` per definition, so representing Workspace honestly would
 * need a genuine architecture decision. Rev94 explicitly authorized
 * exactly that decision: `generic-connector-definition.ts`'s
 * `GenericConnectorEndpointDefinition` now carries an optional, explicit
 * per-endpoint `baseUrlOverride` - the connector keeps one canonical
 * definition (and one representative top-level `baseUrl`, Docs' own host),
 * while each Sheets/Slides endpoint declares its own real host via
 * `baseUrlOverride`. Scope/capability separation stays explicit: Drive,
 * Docs, Sheets and Slides each get their own distinct `capabilityRef`s
 * (never one collapsed "workspace" capability), so a connection admitted
 * for only some of them cannot be treated as authorizing the rest -
 * `resolveEndpointForCapability` only ever resolves a capability the
 * definition actually declares.
 *
 * DELIBERATELY DEFERRED, NOT FABRICATED (Rev90/95's own "avoid speculative
 * provider breadth" instruction):
 * - `META` - Rev90's own text: "may be included when its adapter can be
 *   implemented honestly without production credential activation." Meta
 *   exposes multiple, materially different product APIs (Graph API,
 *   WhatsApp Business API, Marketing API) with no single canonical
 *   surface a bounded slice can honestly default to without guessing
 *   which product this repository actually needs - unlike Workspace's
 *   Docs/Sheets/Slides (three hosts of the *same* well-understood product
 *   family), Meta's three APIs are different products entirely.
 *
 * `GOOGLE_DRIVE` is included (the blueprint explicitly names it as
 * requiring "a real initial connector capability, not a decorative
 * catalog card") because the Drive API v3 is genuinely one stable host
 * covering search/read/create/write/share.
 */
const PREBUILT_ENDPOINT_SOURCE: Record<
  "GITHUB" | "OPENAI" | "ANTHROPIC" | "GOOGLE_AI" | "GOOGLE_DRIVE" | "GOOGLE_WORKSPACE",
  {
    baseUrl: string;
    authMode: ConnectorAuthMode;
    endpoints: ReadonlyArray<{
      capabilityRef: string;
      method: GenericConnectorEndpointDefinition["method"];
      path: string;
      baseUrlOverride?: string;
    }>;
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
  GOOGLE_WORKSPACE: {
    // Representative/primary host - Docs' own. Sheets and Slides endpoints
    // below declare their own real host via baseUrlOverride rather than
    // being forced under this one.
    baseUrl: "https://docs.googleapis.com/v1",
    authMode: "OAUTH2",
    endpoints: [
      { capabilityRef: "cap:workspace-docs-read", method: "GET", path: "/documents/{documentId}" },
      { capabilityRef: "cap:workspace-docs-create", method: "POST", path: "/documents" },
      {
        capabilityRef: "cap:workspace-sheets-read",
        method: "GET",
        path: "/spreadsheets/{spreadsheetId}",
        baseUrlOverride: "https://sheets.googleapis.com/v4",
      },
      {
        capabilityRef: "cap:workspace-sheets-create",
        method: "POST",
        path: "/spreadsheets",
        baseUrlOverride: "https://sheets.googleapis.com/v4",
      },
      {
        capabilityRef: "cap:workspace-slides-read",
        method: "GET",
        path: "/presentations/{presentationId}",
        baseUrlOverride: "https://slides.googleapis.com/v1",
      },
      {
        capabilityRef: "cap:workspace-slides-create",
        method: "POST",
        path: "/presentations",
        baseUrlOverride: "https://slides.googleapis.com/v1",
      },
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
 * Fail-closed: never returns `undefined`. `META` - a recognized
 * `PrebuiltConnectorKind` (per `integration-connector-catalog.ts`'s closed
 * enum) with no entry in this registry yet - throws a distinct, honest
 * "not yet defined" error rather than being confused with a genuinely
 * unrecognized kind.
 */
export function resolvePrebuiltConnectorDefinition(connectorKind: unknown): PrebuiltConnectorDefinition {
  if (typeof connectorKind !== "string") {
    throw new InvalidGenericConnectorDefinitionError("connectorKind must be a string");
  }
  const definition = PREBUILT_CONNECTOR_DEFINITIONS.get(connectorKind as DefinedPrebuiltConnectorKind);
  if (definition !== undefined) {
    return definition;
  }
  if (connectorKind === "META") {
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
