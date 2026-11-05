import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  type ConnectorConnectionInstance,
} from "../src/domain/integration-connector-catalog.js";
import { createConnectionRequirement, createSecretRef } from "../src/domain/connection-authority.js";
import { resolvePrebuiltConnectorDefinition, bindPrebuiltDefinition } from "../src/domain/prebuilt-connector-definitions.js";
import type {
  ConnectorTransport,
  ConnectorTransportRequest,
  SecretResolver,
  CurrentConnectorConnectionReader,
} from "../src/domain/connector-execution.js";
import { FileDurableWorkArtifactStore } from "../src/domain/durable-work-artifact-store.js";
import {
  createWebsiteBuildDarkRequestHandler,
  WEBSITE_BUILD_DARK_EXECUTE_PATH,
  WEBSITE_BUILD_DARK_APPROVE_PATH,
} from "../src/web/website-build-dark-route.js";
import { WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP } from "../src/fixtures/website-build-v1-recipe-binding.js";

function anthropicInstance(secretRefId: string): ConnectorConnectionInstance {
  const descriptor = createConnectorDescriptor({
    connectorKind: "ANTHROPIC",
    displayName: "Anthropic",
    supportedAuthModes: ["API_KEY"],
    capabilityRefs: ["cap:anthropic-model-inference", "cap:anthropic-model-catalog"],
    isAiModelProvider: true,
    requiresOAuthRedirect: false,
  });
  const requirement = createConnectionRequirement({
    connectionRequirementId: "req-anthropic-dark-route",
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    requiredCapabilityRef: "cap:anthropic-model-inference",
    purpose: "test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-anthropic-dark-route",
    workspaceRef: "workspace-anthropic-route",
    integrationInstanceRef: "instance-anthropic-route-1",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId }),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectorConnection(unverified, "evidence:handshake");
}

function currentStoreFor(instance: ConnectorConnectionInstance): CurrentConnectorConnectionReader {
  return {
    get(tenantId, connectionBindingId) {
      if (tenantId !== instance.binding.ownership.tenantId || connectionBindingId !== instance.binding.connectionBindingId) {
        return undefined;
      }
      return { instance, version: 1 };
    },
  };
}

class RecordingMockTransport implements ConnectorTransport {
  public readonly seenRequests: ConnectorTransportRequest[] = [];
  constructor(private readonly response: { outcome: "SUCCESS"; data: unknown } | { outcome: "AUTHORIZATION_FAILED" | "TRANSPORT_ERROR" }) {}
  execute(request: ConnectorTransportRequest) {
    this.seenRequests.push(request);
    return this.response.outcome === "SUCCESS"
      ? { outcome: "SUCCESS" as const, data: this.response.data }
      : { outcome: this.response.outcome };
  }
}

class FixedSecretResolver implements SecretResolver {
  resolve(): string {
    return "sk-test-route-value";
  }
}

function withHandlerDeps(
  run: (deps: {
    workArtifactStore: FileDurableWorkArtifactStore;
    connectorInstance: ConnectorConnectionInstance;
    connectorDefinition: ReturnType<typeof resolvePrebuiltConnectorDefinition>;
    connectionStore: CurrentConnectorConnectionReader;
    secretResolver: SecretResolver;
    transport: RecordingMockTransport;
  }) => void,
  secretRefId = "ANTHROPIC_API_KEY_ROUTE_TEST",
  transportResponse: { outcome: "SUCCESS"; data: unknown } | { outcome: "AUTHORIZATION_FAILED" | "TRANSPORT_ERROR" } = {
    outcome: "SUCCESS",
    data: { content: [{ type: "text", text: "Welcome to Reference Customer Co." }] },
  },
): void {
  const dir = mkdtempSync(join(tmpdir(), "website-build-dark-route-"));
  try {
    const instance = anthropicInstance(secretRefId);
    const definition = resolvePrebuiltConnectorDefinition("ANTHROPIC");
    bindPrebuiltDefinition({ instance, definition });
    run({
      workArtifactStore: new FileDurableWorkArtifactStore(dir),
      connectorInstance: instance,
      connectorDefinition: definition,
      connectionStore: currentStoreFor(instance),
      secretResolver: new FixedSecretResolver(),
      transport: new RecordingMockTransport(transportResponse),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("website-build-dark-route: execute then approve carries a real job from VERIFIED to CLOSED over HTTP-shaped requests", () => {
  withHandlerDeps((deps) => {
    const handler = createWebsiteBuildDarkRequestHandler({ ...deps, clock: () => "2026-11-05T00:00:00.000Z" });

    const executeResponse = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_EXECUTE_PATH,
      headers: {},
      body: JSON.stringify({
        requirementId: "discovery-evidence-intake",
        briefText: "A boutique coffee roastery launching its first storefront.",
      }),
    });
    assert.equal(executeResponse.status, 200);
    const executed = JSON.parse(executeResponse.body) as { jobId: string; state: string; artifactId: string; content: string };
    assert.equal(executed.state, "VERIFIED");
    assert.equal(executed.content, "Welcome to Reference Customer Co.");
    assert.ok(executed.jobId.length > 0);

    const approveResponse = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_APPROVE_PATH,
      headers: {},
      body: JSON.stringify({ jobId: executed.jobId, approverRef: "customer:reference-customer-co" }),
    });
    assert.equal(approveResponse.status, 200);
    const approved = JSON.parse(approveResponse.body) as { jobId: string; state: string };
    assert.equal(approved.jobId, executed.jobId);
    assert.equal(approved.state, "CLOSED");
  });
});

test("website-build-dark-route: execute rejects a malformed body, a missing requirementId, and a missing briefText with 400", () => {
  withHandlerDeps((deps) => {
    const handler = createWebsiteBuildDarkRequestHandler(deps);

    const notJson = handler({ method: "POST", path: WEBSITE_BUILD_DARK_EXECUTE_PATH, headers: {}, body: "not json" });
    assert.equal(notJson.status, 400);

    const noRequirementId = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_EXECUTE_PATH,
      headers: {},
      body: JSON.stringify({ briefText: "brief" }),
    });
    assert.equal(noRequirementId.status, 400);

    const noBriefText = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_EXECUTE_PATH,
      headers: {},
      body: JSON.stringify({ requirementId: "discovery-evidence-intake" }),
    });
    assert.equal(noBriefText.status, 400);

    const emptyBriefText = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_EXECUTE_PATH,
      headers: {},
      body: JSON.stringify({ requirementId: "discovery-evidence-intake", briefText: "   " }),
    });
    assert.equal(emptyBriefText.status, 400);

    assert.equal(deps.transport.seenRequests.length, 0, "no connector call should be made for any rejected request");
  });
});

test("website-build-dark-route: execute returns 404 for an unknown requirementId", () => {
  withHandlerDeps((deps) => {
    const handler = createWebsiteBuildDarkRequestHandler(deps);
    const response = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_EXECUTE_PATH,
      headers: {},
      body: JSON.stringify({ requirementId: "no-such-requirement", briefText: "brief" }),
    });
    assert.equal(response.status, 404);
  });
});

test("website-build-dark-route: execute returns 502 when the connector response carries no extractable text, and nothing is stored for approval", () => {
  withHandlerDeps(
    (deps) => {
      const handler = createWebsiteBuildDarkRequestHandler(deps);
      const executeResponse = handler({
        method: "POST",
        path: WEBSITE_BUILD_DARK_EXECUTE_PATH,
        headers: {},
        body: JSON.stringify({ requirementId: "content-information-architecture", briefText: "brief" }),
      });
      assert.equal(executeResponse.status, 502);

      const approveResponse = handler({
        method: "POST",
        path: WEBSITE_BUILD_DARK_APPROVE_PATH,
        headers: {},
        body: JSON.stringify({ jobId: "whatever", approverRef: "customer:x" }),
      });
      assert.equal(approveResponse.status, 404);
    },
    "ANTHROPIC_API_KEY_ROUTE_TEST_2",
    { outcome: "SUCCESS", data: { content: [] } },
  );
});

test("website-build-dark-route: approve rejects a malformed body and a missing jobId/approverRef with 400, and an unknown jobId with 404", () => {
  withHandlerDeps((deps) => {
    const handler = createWebsiteBuildDarkRequestHandler(deps);

    const notJson = handler({ method: "POST", path: WEBSITE_BUILD_DARK_APPROVE_PATH, headers: {}, body: "not json" });
    assert.equal(notJson.status, 400);

    const noJobId = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_APPROVE_PATH,
      headers: {},
      body: JSON.stringify({ approverRef: "customer:x" }),
    });
    assert.equal(noJobId.status, 400);

    const noApproverRef = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_APPROVE_PATH,
      headers: {},
      body: JSON.stringify({ jobId: "job-1" }),
    });
    assert.equal(noApproverRef.status, 400);

    const unknownJobId = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_APPROVE_PATH,
      headers: {},
      body: JSON.stringify({ jobId: "never-executed", approverRef: "customer:x" }),
    });
    assert.equal(unknownJobId.status, 404);
  });
});

test("website-build-dark-route: an unmatched path or method returns 404, and a second approve for the same jobId also returns 404", () => {
  withHandlerDeps((deps) => {
    const handler = createWebsiteBuildDarkRequestHandler(deps);

    assert.equal(handler({ method: "GET", path: WEBSITE_BUILD_DARK_EXECUTE_PATH, headers: {} }).status, 404);
    assert.equal(handler({ method: "POST", path: "/dark/website-build/unknown", headers: {} }).status, 404);

    const executeResponse = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_EXECUTE_PATH,
      headers: {},
      body: JSON.stringify({ requirementId: "discovery-evidence-intake", briefText: "brief" }),
    });
    const executed = JSON.parse(executeResponse.body) as { jobId: string };

    const firstApprove = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_APPROVE_PATH,
      headers: {},
      body: JSON.stringify({ jobId: executed.jobId, approverRef: "customer:x" }),
    });
    assert.equal(firstApprove.status, 200);

    const secondApprove = handler({
      method: "POST",
      path: WEBSITE_BUILD_DARK_APPROVE_PATH,
      headers: {},
      body: JSON.stringify({ jobId: executed.jobId, approverRef: "customer:x" }),
    });
    assert.equal(secondApprove.status, 404, "the job is removed from the awaiting-approval map once closed");
  });
});
