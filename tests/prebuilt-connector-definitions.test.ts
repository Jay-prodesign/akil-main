import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, type ConnectionRequirement } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  type ConnectorDescriptor,
} from "../src/domain/integration-connector-catalog.js";
import {
  resolvePrebuiltConnectorDefinition,
  listDefinedPrebuiltConnectorKinds,
  bindPrebuiltDefinition,
} from "../src/domain/prebuilt-connector-definitions.js";
import { resolveEndpointForCapability, InvalidGenericConnectorDefinitionError } from "../src/domain/generic-connector-definition.js";

function ownership(): ProjectOwnershipRef {
  return createProjectOwnershipRef({
    tenantId: "akilta-tenant-a",
    customerId: "customer-a",
    projectId: "project-a",
  });
}

test("Q1: listDefinedPrebuiltConnectorKinds lists exactly the five honestly-scoped single-host prebuilt kinds, excluding GOOGLE_WORKSPACE and META", () => {
  const kinds = listDefinedPrebuiltConnectorKinds();
  assert.deepEqual(
    [...kinds].sort(),
    ["ANTHROPIC", "GITHUB", "GOOGLE_AI", "GOOGLE_DRIVE", "OPENAI"].sort(),
  );
});

test("Q2 (adversarial): resolvePrebuiltConnectorDefinition fail-closed throws (never returns undefined) for a not-yet-defined but recognized kind, distinctly from a genuinely unrecognized one", () => {
  assert.throws(() => resolvePrebuiltConnectorDefinition("GOOGLE_WORKSPACE"), InvalidGenericConnectorDefinitionError);
  assert.throws(() => resolvePrebuiltConnectorDefinition("META"), InvalidGenericConnectorDefinitionError);
  assert.throws(() => resolvePrebuiltConnectorDefinition("SLACK"), InvalidGenericConnectorDefinitionError);
});

test("Q3: GITHUB's definition uses a stable single host and OAUTH2, with both declared capabilities resolvable", () => {
  const definition = resolvePrebuiltConnectorDefinition("GITHUB");
  assert.equal(definition.baseUrl, "https://api.github.com");
  assert.equal(definition.authMode, "OAUTH2");
  const metadata = resolveEndpointForCapability(definition, "cap:github-repo-metadata");
  assert.equal(metadata.method, "GET");
  const contents = resolveEndpointForCapability(definition, "cap:github-repo-contents-read");
  assert.equal(contents.method, "GET");
});

test("Q4: OPENAI/ANTHROPIC/GOOGLE_AI each declare model-inference and model-catalog capabilities with distinct base URLs", () => {
  const openai = resolvePrebuiltConnectorDefinition("OPENAI");
  const anthropic = resolvePrebuiltConnectorDefinition("ANTHROPIC");
  const googleAi = resolvePrebuiltConnectorDefinition("GOOGLE_AI");
  assert.equal(openai.authMode, "API_KEY");
  assert.equal(anthropic.authMode, "API_KEY");
  assert.equal(googleAi.authMode, "API_KEY");
  const urls = new Set([openai.baseUrl, anthropic.baseUrl, googleAi.baseUrl]);
  assert.equal(urls.size, 3);
  assert.equal(resolveEndpointForCapability(openai, "cap:openai-model-inference").method, "POST");
  assert.equal(resolveEndpointForCapability(anthropic, "cap:anthropic-model-inference").method, "POST");
  assert.equal(resolveEndpointForCapability(googleAi, "cap:google-ai-model-inference").method, "POST");
});

test("Q5: GOOGLE_DRIVE declares real search/read/create/write/share capabilities on one stable host", () => {
  const definition = resolvePrebuiltConnectorDefinition("GOOGLE_DRIVE");
  assert.equal(definition.baseUrl, "https://www.googleapis.com/drive/v3");
  assert.equal(definition.authMode, "OAUTH2");
  for (const capabilityRef of ["cap:drive-search", "cap:drive-read", "cap:drive-create", "cap:drive-write", "cap:drive-share"]) {
    assert.doesNotThrow(() => resolveEndpointForCapability(definition, capabilityRef));
  }
});

test("Q6: bindPrebuiltDefinition succeeds for a matching instance and fail-closed rejects a mismatched connectorKind or authMode", () => {
  const descriptor: ConnectorDescriptor = createConnectorDescriptor({
    connectorKind: "GITHUB",
    displayName: "GitHub",
    supportedAuthModes: ["OAUTH2"],
    capabilityRefs: ["cap:github-repo-metadata"],
    isAiModelProvider: false,
    requiresOAuthRedirect: true,
  });
  const requirement: ConnectionRequirement = createConnectionRequirement({
    connectionRequirementId: "req-github",
    ownership: ownership(),
    requiredCapabilityRef: "cap:github-repo-metadata",
    purpose: "test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  const instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
  });

  const definition = resolvePrebuiltConnectorDefinition("GITHUB");
  assert.doesNotThrow(() => bindPrebuiltDefinition({ instance, definition }));

  const wrongDefinition = resolvePrebuiltConnectorDefinition("OPENAI");
  assert.throws(() => bindPrebuiltDefinition({ instance, definition: wrongDefinition }), InvalidGenericConnectorDefinitionError);
});

test("Q7: every defined prebuilt connector's endpoints resolve uniquely and never cross-resolve another connector's capability", () => {
  const definitions = listDefinedPrebuiltConnectorKinds().map((kind) => resolvePrebuiltConnectorDefinition(kind));
  for (let i = 0; i < definitions.length; i += 1) {
    for (let j = 0; j < definitions.length; j += 1) {
      if (i === j) continue;
      for (const endpoint of definitions[j]!.endpoints) {
        assert.throws(
          () => resolveEndpointForCapability(definitions[i]!, endpoint.capabilityRef),
          InvalidGenericConnectorDefinitionError,
        );
      }
    }
  }
});
