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
import { createProtectedDecisionWaitRequest } from "../src/domain/protected-decision-wait-gate.js";
import { createProtectedDecisionRecord, type ProtectedDecisionOutcome } from "../src/domain/protected-decision-record.js";
import { FileDurableProtectedDecisionWaitStore } from "../src/domain/durable-protected-decision-wait-store.js";
import { FileDurableProtectedDecisionRecordStore } from "../src/domain/durable-protected-decision-record-store.js";
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
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  admitQuotaReservation,
  EMPTY_QUOTA_LEDGER,
  type QuotaEnvelope,
  type QuotaLedger,
} from "../src/domain/execution-quota-admission.js";
import type { QuotaAdmissionPort } from "../src/application/outcome-job-execution-runtime.js";
import {
  resumeProtectedDecisionAndExecuteConnectorEffect,
  ProtectedDecisionRecordNotFoundError,
  ProtectedEffectBindingMismatchError,
  ProtectedEffectQuotaRejectedError,
} from "../src/domain/resume-protected-decision-for-connector-effect.js";

/**
 * Rev186 F3's own core demand: "prove one real protected-effect path
 * consumes [the resume claim] once." These tests exercise the real
 * composition end-to-end (WAIT -> durable claimResume -> the one real
 * connector-capability verified effect), never a stub standing in for
 * either half. Rev187 widens this to also prove: F3a (exact effect
 * binding), F3b (a real durable decision record, fetched fresh), and F3c
 * (quota currentness/admission), each with zero-transport-invocation
 * adversarial coverage.
 */

const compilation = compileGoldenPathActivation("plan-rpdce-1", "sold-rpdce-1");
const job = compilation.jobs[0]!;
const tenantScope = GOLDEN_PATH_TENANT_SCOPE;
const EFFECT_INTENT_ID = "effect-intent-rpdce-1";

function waitRequest(overrides: Partial<Parameters<typeof createProtectedDecisionWaitRequest>[0]> = {}) {
  return createProtectedDecisionWaitRequest({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job,
    waitRequestId: "wait-rpdce-1",
    runId: "run-1",
    attempt: 1,
    effectRef: EFFECT_INTENT_ID,
    decisionRef: "decision:rpdce-example",
    reason: "human approval required before this connector effect",
    activationFingerprintAtWait: compilation.profile.sourceFingerprint,
    raisedAt: "2026-10-02T00:00:00.000Z",
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

function decisionRecord(overrides: { decisionRef?: string; outcome?: ProtectedDecisionOutcome } = {}) {
  return createProtectedDecisionRecord({
    tenantScope,
    decisionRef: overrides.decisionRef ?? "decision:rpdce-example",
    outcome: overrides.outcome ?? "APPROVED",
    decidedByAccess: grantedAccess(),
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:decision-made",
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

class InMemoryQuotaAdmissionStore implements QuotaAdmissionPort {
  private ledger: QuotaLedger = EMPTY_QUOTA_LEDGER;

  admit(input: Parameters<QuotaAdmissionPort["admit"]>[0]) {
    const { ledger, outcome } = admitQuotaReservation({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }
  commit(): never {
    throw new Error("not exercised by this test");
  }
  release(): never {
    throw new Error("not exercised by this test");
  }
  peekSettlement(): { settled: false } {
    return { settled: false };
  }
}

function quotaFixture(unitLimit = 1_000_000) {
  const scope = createQuotaAdmissionScope({
    tenantScope,
    customerId: GOLDEN_PATH_CUSTOMER.customerId,
    projectId: GOLDEN_PATH_PROJECT.projectId,
    planId: compilation.profile.planId,
    planVersion: compilation.profile.planVersion,
  });
  const quotaEnvelope: QuotaEnvelope = createQuotaEnvelope({
    scope,
    envelopeRef: "envelope-rpdce",
    sourceFingerprint: "qfp-rpdce",
    unitLimit,
  });
  return {
    quotaAdmission: new InMemoryQuotaAdmissionStore(),
    quotaEnvelope,
    currentQuotaSourceFingerprint: "qfp-rpdce",
    estimatedCost: { presence: "REPORTED" as const, amountMinorUnits: 10, currency: "USD" },
  };
}

function baseInput(overrides: Partial<Parameters<typeof resumeProtectedDecisionAndExecuteConnectorEffect>[0]> = {}) {
  const waitStore = new FileDurableProtectedDecisionWaitStore(mkdtempSync(join(tmpdir(), "os-v0-10-rpdce-")));
  const decisionRecordStore = new FileDurableProtectedDecisionRecordStore(mkdtempSync(join(tmpdir(), "os-v0-10-rpdce-decision-")));
  const request = waitRequest();
  waitStore.putIfAbsentWaitRequest(tenantScope.tenantId, request.waitRequestId, request);
  const record = decisionRecord();
  decisionRecordStore.putIfAbsentDecisionRecord(tenantScope.tenantId, record.decisionRef, record);

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
      decisionRecordStore,
      waitRequest: request,
      access: grantedAccess(),
      authority: protectedAuthority(),
      currentActivationFingerprint: compilation.profile.sourceFingerprint,
      now: "2026-10-02T00:01:00.000Z",
      tenantScope,
      effectIntentId: EFFECT_INTENT_ID,
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
      ...quotaFixture(),
      ...overrides,
    },
    transport,
    waitStore,
    decisionRecordStore,
    request,
  };
}

test("Rev186 F3: the first resumeProtectedDecisionAndExecuteConnectorEffect call wins the durable claim and invokes the connector transport exactly once, reaching VERIFIED", async () => {
  const { input, transport } = baseInput();
  const result = await resumeProtectedDecisionAndExecuteConnectorEffect(input);
  assert.equal(result.kind, "EFFECT_EXECUTED");
  assert.equal(transport.callCount, 1);
  if (result.kind === "EFFECT_EXECUTED") {
    assert.equal(result.outcome.kind, "VERIFIED");
  }
});

test("Rev186 F3 (the core atomicity proof): a second resumeProtectedDecisionAndExecuteConnectorEffect call for the SAME waitRequestId never invokes the transport again - it finds the claim already taken and returns ALREADY_RESUMED_NO_EFFECT", async () => {
  const { input, transport } = baseInput();
  const first = await resumeProtectedDecisionAndExecuteConnectorEffect(input);
  assert.equal(first.kind, "EFFECT_EXECUTED");
  assert.equal(transport.callCount, 1);

  // A second call - e.g. a replayed resume request, or a concurrent racer -
  // reusing the SAME waitStore/waitRequestId but otherwise independently
  // re-authorized (fresh access/now), to prove the durable claim itself -
  // not merely object identity of the first authorization - is what makes
  // this single-use.
  const second = await resumeProtectedDecisionAndExecuteConnectorEffect({
    ...input,
    access: grantedAccess(),
    now: "2026-10-02T00:02:00.000Z",
  });
  assert.equal(second.kind, "ALREADY_RESUMED_NO_EFFECT");
  assert.equal(transport.callCount, 1, "the transport must NOT have been invoked a second time");
  if (first.kind === "EFFECT_EXECUTED" && second.kind === "ALREADY_RESUMED_NO_EFFECT") {
    assert.deepEqual(second.resume, first.resume);
  }
});

test("Rev186 F3 adversarial: a stale activation fingerprint at resume time blocks the effect with zero transport invocations, before any durable claim is attempted", async () => {
  const { input, transport } = baseInput({ currentActivationFingerprint: "a-different-fingerprint" });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0);
});

test("Rev187 F3b adversarial: an absent durable decision record (e.g. a store holding only a record for a different decisionRef) blocks the effect with zero transport invocations, before authorizeProtectedDecisionResume is even called", async () => {
  const emptyDecisionStore = new FileDurableProtectedDecisionRecordStore(mkdtempSync(join(tmpdir(), "os-v0-10-rpdce-absent-")));
  const { input, transport } = baseInput({ decisionRecordStore: emptyDecisionStore });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input), ProtectedDecisionRecordNotFoundError);
  assert.equal(transport.callCount, 0);
});

test("Rev187 F3b adversarial: a DENIED durable decision record blocks the effect with zero transport invocations", async () => {
  const deniedStore = new FileDurableProtectedDecisionRecordStore(mkdtempSync(join(tmpdir(), "os-v0-10-rpdce-denied-")));
  const denied = decisionRecord({ outcome: "DENIED" });
  deniedStore.putIfAbsentDecisionRecord(tenantScope.tenantId, denied.decisionRef, denied);
  const { input, transport } = baseInput({ decisionRecordStore: deniedStore });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0);
});

test("Rev187 F3a adversarial: a waitRequest.effectRef that does not identify the exact effectIntentId being executed blocks the effect with zero transport invocations and zero durable claim", async () => {
  const { input, transport, waitStore, request } = baseInput({ effectIntentId: "a-completely-different-effect" });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input), ProtectedEffectBindingMismatchError);
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});

test("Rev187 F3c adversarial: a REJECTED quota admission (zero unit allowance) blocks the effect with zero transport invocations and zero durable claim", async () => {
  const { input, transport, waitStore, request } = baseInput(quotaFixture(0));
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input), ProtectedEffectQuotaRejectedError);
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});

test("Rev187 F3c adversarial: a stale quota envelope (sourceFingerprint mismatch) blocks the effect with zero transport invocations", async () => {
  const { input, transport } = baseInput({ currentQuotaSourceFingerprint: "a-different-quota-fingerprint" });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0);
});

test("Rev186 F3 adversarial: a non-GRANTED access resolution blocks the effect with zero transport invocations and no durable claim is created", async () => {
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
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});
