import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOLDEN_PATH_TENANT_SCOPE,
  GOLDEN_PATH_CUSTOMER,
  GOLDEN_PATH_PROJECT,
  compileGoldenPathActivation,
} from "./helpers/golden-path-fixture.js";
import {
  createProtectedDecisionWaitRequest,
  createProtectedDecisionOutcomeEvidence,
} from "../src/domain/protected-decision-wait-gate.js";
import { FileDurableProtectedDecisionWaitStore } from "../src/domain/durable-protected-decision-wait-store.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { resolveEffectiveOrganizationAccess, type EffectiveAccessResolution } from "../src/domain/effective-organization-access.js";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  createConnectionRequirement,
  createSecretRef,
  type ConnectionRequirement,
} from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  type ConnectorConnectionInstance,
} from "../src/domain/integration-connector-catalog.js";
import { createGenericApiConnectorDefinition, bindGenericApiDefinition } from "../src/domain/generic-connector-definition.js";
import type { ConnectorTransport, ConnectorTransportRequest, SecretResolver, CurrentConnectorConnectionReader } from "../src/domain/connector-execution.js";
import type { ConnectorCapabilityReadback } from "../src/domain/connector-capability-verified-effect.js";
import { resumeProtectedDecisionAndExecuteConnectorEffect } from "../src/domain/resume-protected-decision-for-connector-effect.js";

/**
 * Rev186 F3's own core demand: "prove one real protected-effect path
 * consumes [the resume claim] once." These tests exercise the real
 * composition end-to-end (WAIT -> durable claimResume -> the one real
 * connector-capability verified effect), never a stub standing in for
 * either half.
 */

const compilation = compileGoldenPathActivation("plan-rpdce-1", "sold-rpdce-1");
const job = compilation.jobs[0]!;
const tenantScope = GOLDEN_PATH_TENANT_SCOPE;

function waitRequest(overrides: Partial<Parameters<typeof createProtectedDecisionWaitRequest>[0]> = {}) {
  return createProtectedDecisionWaitRequest({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job,
    waitRequestId: "wait-rpdce-1",
    runId: "run-1",
    attempt: 1,
    effectRef: "effect:rpdce-example",
    decisionRef: "decision:rpdce-example",
    reason: "human approval required before this connector effect",
    activationFingerprintAtWait: compilation.profile.sourceFingerprint,
    raisedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  });
}

function decisionOutcome(overrides: Partial<Parameters<typeof createProtectedDecisionOutcomeEvidence>[0]> = {}) {
  return createProtectedDecisionOutcomeEvidence({
    decisionRef: "decision:rpdce-example",
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:decision-made",
    ...overrides,
  });
}

function protectedAuthority() {
  return createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true });
}

function grantedAccess(): EffectiveAccessResolution {
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: "org-akilta-rpdce",
      tenantScope,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });
  const membership = createOrganizationMembership({
    membershipId: "membership-rpdce-resumer",
    tenantScope,
    principalRef: "principal-rpdce-resumer",
    role: "STAFF",
  });
  return resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "principal-rpdce-resumer",
    authority: protectedAuthority(),
  });
}

function ownership(): ProjectOwnershipRef {
  return createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: "customer-rpdce", projectId: "project-rpdce" });
}

function verifiedInstance(ownershipRef: ProjectOwnershipRef): ConnectorConnectionInstance {
  const descriptor = createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "RPDCE API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: ["cap:rpdce-ping"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
  const requirement: ConnectionRequirement = createConnectionRequirement({
    connectionRequirementId: "req-rpdce",
    ownership: ownershipRef,
    requiredCapabilityRef: "cap:rpdce-ping",
    purpose: "Rev186 F3 atomic single-use connector-effect proof",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-rpdce",
    workspaceRef: "workspace-rpdce",
    integrationInstanceRef: "instance-rpdce",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-rpdce" }),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectorConnection(unverified, "evidence:rpdce-handshake");
}

function storeFor(instance: ConnectorConnectionInstance): CurrentConnectorConnectionReader {
  return {
    get(tid, connectionBindingId) {
      if (tid !== instance.binding.ownership.tenantId || connectionBindingId !== instance.binding.connectionBindingId) {
        return undefined;
      }
      return { instance, version: 1 };
    },
  };
}

class CountingTransport implements ConnectorTransport {
  public callCount = 0;
  execute(_request: ConnectorTransportRequest) {
    this.callCount += 1;
    return { outcome: "SUCCESS" as const, data: { ok: true } };
  }
}

function alwaysConfirmsReadback(): ConnectorCapabilityReadback {
  return {
    confirmsApplied: () => true,
    evidenceRef: (result) => `evidence:readback:${result.capabilityRef}`,
  };
}

function baseInput(overrides: Partial<Parameters<typeof resumeProtectedDecisionAndExecuteConnectorEffect>[0]> = {}) {
  const waitStore = new FileDurableProtectedDecisionWaitStore(mkdtempSync(join(tmpdir(), "os-v0-10-rpdce-")));
  const request = waitRequest();
  waitStore.putIfAbsentWaitRequest(tenantScope.tenantId, request.waitRequestId, request);

  const ownershipRef = ownership();
  const instance = verifiedInstance(ownershipRef);
  const definition = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-rpdce",
    baseUrl: "https://api.rpdce.example.com",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: "cap:rpdce-ping", method: "GET", path: "/ping" }],
  });
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new CountingTransport();

  return {
    input: {
      waitStore,
      waitRequest: request,
      access: grantedAccess(),
      authority: protectedAuthority(),
      decisionOutcome: decisionOutcome(),
      currentActivationFingerprint: compilation.profile.sourceFingerprint,
      now: "2026-10-02T00:01:00.000Z",
      tenantScope,
      effectIntentId: "effect-intent-rpdce-1",
      actionRef: "action:rpdce-ping",
      retryClassification: "SAFE_TO_RETRY" as const,
      attemptId: "attempt-rpdce-1",
      bound,
      capabilityRef: "cap:rpdce-ping",
      requestingOwnership: ownershipRef,
      connectionStore: storeFor(instance),
      secretResolver: { resolve: () => "sk-rpdce" } satisfies SecretResolver,
      transport,
      readback: alwaysConfirmsReadback(),
      ...overrides,
    },
    transport,
    waitStore,
    request,
  };
}

test("Rev186 F3: the first resumeProtectedDecisionAndExecuteConnectorEffect call wins the durable claim and invokes the connector transport exactly once, reaching VERIFIED", () => {
  const { input, transport } = baseInput();
  const result = resumeProtectedDecisionAndExecuteConnectorEffect(input);
  assert.equal(result.kind, "EFFECT_EXECUTED");
  assert.equal(transport.callCount, 1);
  if (result.kind === "EFFECT_EXECUTED") {
    assert.equal(result.outcome.kind, "VERIFIED");
  }
});

test("Rev186 F3 (the core atomicity proof): a second resumeProtectedDecisionAndExecuteConnectorEffect call for the SAME waitRequestId never invokes the transport again - it finds the claim already taken and returns ALREADY_RESUMED_NO_EFFECT", () => {
  const { input, transport } = baseInput();
  const first = resumeProtectedDecisionAndExecuteConnectorEffect(input);
  assert.equal(first.kind, "EFFECT_EXECUTED");
  assert.equal(transport.callCount, 1);

  // A second call - e.g. a replayed resume request, or a concurrent racer -
  // reusing the SAME waitStore/waitRequestId but otherwise independently
  // re-authorized (fresh access/decisionOutcome/now), to prove the durable
  // claim itself - not merely object identity of the first authorization -
  // is what makes this single-use.
  const second = resumeProtectedDecisionAndExecuteConnectorEffect({
    ...input,
    access: grantedAccess(),
    decisionOutcome: decisionOutcome(),
    now: "2026-10-02T00:02:00.000Z",
  });
  assert.equal(second.kind, "ALREADY_RESUMED_NO_EFFECT");
  assert.equal(transport.callCount, 1, "the transport must NOT have been invoked a second time");
  if (first.kind === "EFFECT_EXECUTED" && second.kind === "ALREADY_RESUMED_NO_EFFECT") {
    assert.deepEqual(second.resume, first.resume);
  }
});

test("Rev186 F3 adversarial: a stale activation fingerprint at resume time blocks the effect with zero transport invocations, before any durable claim is attempted", () => {
  const { input, transport } = baseInput({ currentActivationFingerprint: "a-different-fingerprint" });
  assert.throws(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0);
});

test("Rev186 F3 adversarial: a decisionOutcome for a different decisionRef blocks the effect with zero transport invocations", () => {
  const { input, transport } = baseInput({ decisionOutcome: decisionOutcome({ decisionRef: "decision:a-different-one" }) });
  assert.throws(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0);
});

test("Rev186 F3 adversarial: a non-GRANTED access resolution blocks the effect with zero transport invocations and no durable claim is created", () => {
  const { input, transport, waitStore, request } = baseInput({
    access: {
      decision: "DENIED",
      tenantId: tenantScope.tenantId,
      organizationId: "org-akilta-rpdce" as unknown as EffectiveAccessResolution["organizationId"],
      permissions: new Set(),
      canPerformProtectedActions: false,
      reasons: ["membership is not an active, coherent membership record"],
    } satisfies EffectiveAccessResolution,
  });
  assert.throws(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});
