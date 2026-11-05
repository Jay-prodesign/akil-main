import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorityContext, type AuthorityContext } from "../src/domain/authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  type ConnectorConnectionInstance,
} from "../src/domain/integration-connector-catalog.js";
import { createConnectionRequirement, createSecretRef } from "../src/domain/connection-authority.js";
import { resolvePrebuiltConnectorDefinition, bindPrebuiltDefinition } from "../src/domain/prebuilt-connector-definitions.js";
import {
  ConnectorExecutionNotAuthorizedError,
  type ConnectorTransport,
  type ConnectorTransportRequest,
  type SecretResolver,
  type CurrentConnectorConnectionReader,
} from "../src/domain/connector-execution.js";
import { FileDurableWorkArtifactStore } from "../src/domain/durable-work-artifact-store.js";
import {
  runWebsiteBuildDarkExecution,
  approveWebsiteBuildDarkDelivery,
  WebsiteBuildDarkExecutionError,
} from "../src/application/website-build-dark-execution.js";
import {
  WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START,
  WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
  WEBSITE_BUILD_V1_RECIPE_ADMISSION,
  WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS,
  WEBSITE_BUILD_V1_BOUND_JOBS,
} from "../src/fixtures/website-build-v1-recipe-binding.js";
import type { OutcomeJob } from "../src/domain/outcome-job.js";
import type { OutcomeJobSpec } from "../src/domain/outcome-job-spec.js";

const coldStart = WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START;

function authority(): AuthorityContext {
  return createAuthorityContext({
    tenantScope: coldStart.tenantScope,
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: true,
  });
}

function findSpec(requirementId: string): OutcomeJobSpec {
  const spec = WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS.find((s) => s.requirementId === requirementId);
  assert.ok(spec !== undefined, `expected a spec for requirement "${requirementId}"`);
  return spec as OutcomeJobSpec;
}

function findJob(jobId: string): OutcomeJob {
  const job = WEBSITE_BUILD_V1_BOUND_JOBS.find((j) => (j.jobId as string) === jobId);
  assert.ok(job !== undefined, `expected a job with jobId "${jobId}"`);
  return job as OutcomeJob;
}

function unverifiedAnthropicInstance(secretRefId: string): ConnectorConnectionInstance {
  const descriptor = createConnectorDescriptor({
    connectorKind: "ANTHROPIC",
    displayName: "Anthropic",
    supportedAuthModes: ["API_KEY"],
    capabilityRefs: ["cap:anthropic-model-inference", "cap:anthropic-model-catalog"],
    isAiModelProvider: true,
    requiresOAuthRedirect: false,
  });
  const requirement = createConnectionRequirement({
    connectionRequirementId: "req-anthropic-dark-exec",
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
    connectionBindingId: "bind-anthropic-dark-exec",
    workspaceRef: "workspace-anthropic",
    integrationInstanceRef: "instance-anthropic-1",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId }),
  });
  return transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
}

function anthropicInstance(secretRefId = "ANTHROPIC_API_KEY_TEST"): ConnectorConnectionInstance {
  return verifyConnectorConnection(unverifiedAnthropicInstance(secretRefId), "evidence:handshake");
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
  constructor(private readonly value: string) {}
  resolve(): string {
    return this.value;
  }
}

function withArtifactStore(run: (store: FileDurableWorkArtifactStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "website-build-dark-execution-"));
  try {
    run(new FileDurableWorkArtifactStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runWebsiteBuildDarkExecution: a successful AI response carries the job through EXECUTING/VERIFYING all the way to VERIFIED, and records a real WorkArtifact with the generated text", () => {
  withArtifactStore((workArtifactStore) => {
    const spec = findSpec("discovery-evidence-intake");
    const draftJob = findJob(spec.specId as string);
    assert.equal(draftJob.state, "DRAFT");

    const instance = anthropicInstance();
    const definition = resolvePrebuiltConnectorDefinition("ANTHROPIC");
    bindPrebuiltDefinition({ instance, definition });

    const transport = new RecordingMockTransport({
      outcome: "SUCCESS",
      data: { content: [{ type: "text", text: "Welcome to Reference Customer Co - crafted for your brand." }] },
    });

    const result = runWebsiteBuildDarkExecution({
      authority: authority(),
      draftJob,
      spec,
      admission: WEBSITE_BUILD_V1_RECIPE_ADMISSION,
      briefText: "A boutique coffee roastery launching its first storefront.",
      connectorInstance: instance,
      connectorDefinition: definition,
      requestingOwnership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
      connectionStore: currentStoreFor(instance),
      secretResolver: new FixedSecretResolver("sk-test-anthropic-value"),
      transport,
      workArtifactStore,
      artifactId: "artifact-dark-exec-1",
      evidenceId: "evidence-dark-exec-1",
      verificationId: "verification-dark-exec-1",
      clock: () => "2026-11-05T00:00:00.000Z",
    });

    assert.equal(result.job.state, "VERIFIED");
    assert.equal(result.artifact.content, "Welcome to Reference Customer Co - crafted for your brand.");
    assert.equal(result.artifact.producedByConnectorKind, "ANTHROPIC");

    const stored = workArtifactStore.get(coldStart.tenantScope.tenantId, result.artifact.artifactId);
    assert.deepEqual(stored?.artifact, result.artifact);

    // The resolved secret reached the transport, but never leaks back out.
    assert.equal(transport.seenRequests.length, 1);
    assert.equal(transport.seenRequests[0]?.authSecretValue, "sk-test-anthropic-value");
    assert.ok(!JSON.stringify(result).includes("sk-test-anthropic-value"));
  });
});

test("runWebsiteBuildDarkExecution: no extractable text in the provider response throws WebsiteBuildDarkExecutionError, nothing is recorded", () => {
  withArtifactStore((workArtifactStore) => {
    const spec = findSpec("content-information-architecture");
    const draftJob = findJob(spec.specId as string);

    const instance = anthropicInstance("ANTHROPIC_API_KEY_TEST_2");
    const definition = resolvePrebuiltConnectorDefinition("ANTHROPIC");
    bindPrebuiltDefinition({ instance, definition });

    const transport = new RecordingMockTransport({ outcome: "SUCCESS", data: { content: [] } });

    assert.throws(
      () =>
        runWebsiteBuildDarkExecution({
          authority: authority(),
          draftJob,
          spec,
          admission: WEBSITE_BUILD_V1_RECIPE_ADMISSION,
          briefText: "brief",
          connectorInstance: instance,
          connectorDefinition: definition,
          requestingOwnership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
          connectionStore: currentStoreFor(instance),
          secretResolver: new FixedSecretResolver("sk-test"),
          transport,
          workArtifactStore,
          artifactId: "artifact-dark-exec-2",
          evidenceId: "evidence-dark-exec-2",
          verificationId: "verification-dark-exec-2",
          clock: () => "2026-11-05T00:00:00.000Z",
        }),
      WebsiteBuildDarkExecutionError,
    );
    assert.deepEqual(workArtifactStore.listByTenant(coldStart.tenantScope.tenantId), []);
  });
});

test("runWebsiteBuildDarkExecution: an authority for a different tenant fails closed before any connector call is made", () => {
  withArtifactStore((workArtifactStore) => {
    const spec = findSpec("discovery-evidence-intake");
    const draftJob = findJob(spec.specId as string);
    const instance = anthropicInstance("ANTHROPIC_API_KEY_TEST_3");
    const definition = resolvePrebuiltConnectorDefinition("ANTHROPIC");
    bindPrebuiltDefinition({ instance, definition });
    const transport = new RecordingMockTransport({ outcome: "SUCCESS", data: { content: [{ type: "text", text: "x" }] } });

    const wrongTenantAuthority = createAuthorityContext({
      tenantScope: { tenantId: "some-other-tenant" } as typeof coldStart.tenantScope,
      permissions: ["READ", "WRITE", "EXECUTE"],
      canPerformProtectedActions: true,
    });

    assert.throws(() =>
      runWebsiteBuildDarkExecution({
        authority: wrongTenantAuthority,
        draftJob,
        spec,
        admission: WEBSITE_BUILD_V1_RECIPE_ADMISSION,
        briefText: "brief",
        connectorInstance: instance,
        connectorDefinition: definition,
        requestingOwnership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
        connectionStore: currentStoreFor(instance),
        secretResolver: new FixedSecretResolver("sk-test"),
        transport,
        workArtifactStore,
        artifactId: "artifact-dark-exec-4",
        evidenceId: "evidence-dark-exec-4",
        verificationId: "verification-dark-exec-4",
        clock: () => "2026-11-05T00:00:00.000Z",
      }),
    );
    assert.equal(transport.seenRequests.length, 0, "no connector call should be made when authority fails tenant check");
  });
});

test("runWebsiteBuildDarkExecution: a connection that is not currently VERIFIED fails closed before any transport call is made", () => {
  withArtifactStore((workArtifactStore) => {
    const spec = findSpec("seo-runtime-qa");
    const draftJob = findJob(spec.specId as string);

    const unverifiedInstance = unverifiedAnthropicInstance("ANTHROPIC_API_KEY_TEST_UNVERIFIED");
    const definition = resolvePrebuiltConnectorDefinition("ANTHROPIC");
    bindPrebuiltDefinition({ instance: unverifiedInstance, definition });
    const transport = new RecordingMockTransport({ outcome: "SUCCESS", data: { content: [{ type: "text", text: "x" }] } });

    assert.throws(
      () =>
        runWebsiteBuildDarkExecution({
          authority: authority(),
          draftJob,
          spec,
          admission: WEBSITE_BUILD_V1_RECIPE_ADMISSION,
          briefText: "brief",
          connectorInstance: unverifiedInstance,
          connectorDefinition: definition,
          requestingOwnership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
          connectionStore: currentStoreFor(unverifiedInstance),
          secretResolver: new FixedSecretResolver("sk-test"),
          transport,
          workArtifactStore,
          artifactId: "artifact-dark-exec-6",
          evidenceId: "evidence-dark-exec-6",
          verificationId: "verification-dark-exec-6",
          clock: () => "2026-11-05T00:00:00.000Z",
        }),
      ConnectorExecutionNotAuthorizedError,
    );
    assert.equal(transport.seenRequests.length, 0, "no transport call should be made when the connection is not VERIFIED");
    assert.deepEqual(workArtifactStore.listByTenant(coldStart.tenantScope.tenantId), []);
  });
});

test("approveWebsiteBuildDarkDelivery: the only authorized path from VERIFIED to CLOSED, delegating to the real approval-gated closure", () => {
  withArtifactStore((workArtifactStore) => {
    const spec = findSpec("discovery-evidence-intake");
    const draftJob = findJob(spec.specId as string);
    const instance = anthropicInstance("ANTHROPIC_API_KEY_TEST_5");
    const definition = resolvePrebuiltConnectorDefinition("ANTHROPIC");
    bindPrebuiltDefinition({ instance, definition });
    const transport = new RecordingMockTransport({
      outcome: "SUCCESS",
      data: { content: [{ type: "text", text: "Delivered homepage copy." }] },
    });

    const { job: verifiedJob } = runWebsiteBuildDarkExecution({
      authority: authority(),
      draftJob,
      spec,
      admission: WEBSITE_BUILD_V1_RECIPE_ADMISSION,
      briefText: "brief",
      connectorInstance: instance,
      connectorDefinition: definition,
      requestingOwnership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
      connectionStore: currentStoreFor(instance),
      secretResolver: new FixedSecretResolver("sk-test"),
      transport,
      workArtifactStore,
      artifactId: "artifact-dark-exec-5",
      evidenceId: "evidence-dark-exec-5",
      verificationId: "verification-dark-exec-5",
      clock: () => "2026-11-05T00:00:00.000Z",
    });
    assert.equal(verifiedJob.state, "VERIFIED");

    const closedJob = approveWebsiteBuildDarkDelivery({
      authority: authority(),
      verifiedJob,
      closureApprovalId: "closure-dark-exec-5",
      approvedAt: "2026-11-05T00:05:00.000Z",
      approverRef: "customer:reference-customer-co",
    });
    assert.equal(closedJob.state, "CLOSED");
  });
});
