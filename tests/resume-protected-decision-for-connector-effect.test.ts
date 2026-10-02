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
import { createProtectedDecisionRecord, reviseProtectedDecisionRecord, type ProtectedDecisionOutcome } from "../src/domain/protected-decision-record.js";
import { FileDurableProtectedDecisionWaitStore } from "../src/domain/durable-protected-decision-wait-store.js";
import { FileDurableProtectedDecisionRecordStore } from "../src/domain/durable-protected-decision-record-store.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
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
  commitQuotaUsage,
  releaseQuotaReservation,
  EMPTY_QUOTA_LEDGER,
  type QuotaEnvelope,
  type QuotaLedger,
} from "../src/domain/execution-quota-admission.js";
import type { QuotaAdmissionPort, CurrentQuotaEnvelopeResolver, ExecutionEconomicsPort } from "../src/application/outcome-job-execution-runtime.js";
import type { ExecutionEconomicsEvent } from "../src/domain/execution-economics-attribution.js";
import {
  resumeProtectedDecisionAndExecuteConnectorEffect,
  computeConnectorEffectFingerprint,
  ProtectedDecisionRecordNotFoundError,
  ProtectedEffectBindingMismatchError,
  ProtectedEffectQuotaRejectedError,
  ProtectedEffectQuotaLineageMismatchError,
} from "../src/domain/resume-protected-decision-for-connector-effect.js";

/**
 * Rev186 F3's own core demand: "prove one real protected-effect path
 * consumes [the resume claim] once." These tests exercise the real
 * composition end-to-end (WAIT -> durable claimResume -> the one real
 * connector-capability verified effect), never a stub standing in for
 * either half. Rev187 widened this to also prove: F3a (exact effect
 * binding), F3b (a real durable decision record, fetched fresh), and F3c
 * (quota currentness/admission). Rev188 widens it further: item2
 * (authenticated access re-resolved from raw ingredients, never a
 * precomputed `EffectiveAccessResolution`), item3 (the exact-effect binding
 * is now a canonical fingerprint covering actionRef/retryClassification/
 * capabilityRef/connectionBindingId/requestPayload, not merely
 * effectIntentId), and item5 (quota lineage, a latest-moment pre-invocation
 * recheck, release-on-block, and commit+economics correlation) - each with
 * zero-transport-invocation adversarial coverage.
 */

const compilation = compileGoldenPathActivation("plan-rpdce-1", "sold-rpdce-1");
const job = compilation.jobs[0]!;
const tenantScope = GOLDEN_PATH_TENANT_SCOPE;
const EFFECT_INTENT_ID = "effect-intent-rpdce-1";
const ACTION_REF = "action:rpdce-ping";
const RETRY_CLASSIFICATION = "SAFE_TO_RETRY" as const;
const CAPABILITY_REF = "cap:rpdce-ping";
const CONNECTION_BINDING_ID = "bind-rpdce";

function effectFingerprint(overrides: {
  effectIntentId?: unknown;
  actionRef?: unknown;
  retryClassification?: unknown;
  capabilityRef?: unknown;
  connectionBindingId?: unknown;
  requestPayload?: unknown;
} = {}) {
  return computeConnectorEffectFingerprint({
    effectIntentId: overrides.effectIntentId ?? EFFECT_INTENT_ID,
    actionRef: overrides.actionRef ?? ACTION_REF,
    retryClassification: overrides.retryClassification ?? RETRY_CLASSIFICATION,
    capabilityRef: overrides.capabilityRef ?? CAPABILITY_REF,
    connectionBindingId: overrides.connectionBindingId ?? CONNECTION_BINDING_ID,
    requestPayload: overrides.requestPayload,
  });
}

function waitRequest(overrides: Partial<Parameters<typeof createProtectedDecisionWaitRequest>[0]> = {}) {
  return createProtectedDecisionWaitRequest({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job,
    waitRequestId: "wait-rpdce-1",
    runId: "run-1",
    attempt: 1,
    effectRef: effectFingerprint(),
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

const RESUMER_PRINCIPAL_REF = "principal-rpdce-resumer";

function resumerOrganization(): Organization {
  return activateOrganization({
    organization: createOrganization({
      organizationId: "org-akilta-rpdce",
      tenantScope,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });
}

function resumerMembership(): OrganizationMembership {
  return createOrganizationMembership({
    membershipId: "membership-rpdce-resumer",
    tenantScope,
    principalRef: RESUMER_PRINCIPAL_REF,
    role: "STAFF",
  });
}

function decisionRecord(overrides: { decisionRef?: string; outcome?: ProtectedDecisionOutcome } = {}) {
  return createProtectedDecisionRecord({
    tenantScope,
    decisionRef: overrides.decisionRef ?? "decision:rpdce-example",
    outcome: overrides.outcome ?? "APPROVED",
    organization: resumerOrganization(),
    membership: resumerMembership(),
    currentPrincipalRef: RESUMER_PRINCIPAL_REF,
    authority: protectedAuthority(),
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
    connectionBindingId: CONNECTION_BINDING_ID,
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
  public releaseCount = 0;
  public commitCount = 0;

  admit(input: Parameters<QuotaAdmissionPort["admit"]>[0]) {
    const { ledger, outcome } = admitQuotaReservation({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }
  commit(input: Parameters<QuotaAdmissionPort["commit"]>[0]) {
    this.commitCount += 1;
    const { ledger, outcome } = commitQuotaUsage({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }
  release(input: Parameters<QuotaAdmissionPort["release"]>[0]) {
    this.releaseCount += 1;
    const { ledger, outcome } = releaseQuotaReservation({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }
  peekSettlement(): { settled: false } {
    return { settled: false };
  }
}

class InMemoryEconomicsPort implements ExecutionEconomicsPort {
  public events: ExecutionEconomicsEvent[] = [];
  recordSettledAttempt(event: ExecutionEconomicsEvent): void {
    this.events.push(event);
  }
}

function quotaScope() {
  return createQuotaAdmissionScope({
    tenantScope,
    customerId: GOLDEN_PATH_CUSTOMER.customerId,
    projectId: GOLDEN_PATH_PROJECT.projectId,
    planId: compilation.profile.planId,
    planVersion: compilation.profile.planVersion,
  });
}

function quotaFixture(unitLimit = 1_000_000) {
  const scope = quotaScope();
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
    quotaEnvelopeResolver: { resolveCurrentQuotaEnvelope: () => quotaEnvelope } satisfies CurrentQuotaEnvelopeResolver,
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
    connectionBindingId: CONNECTION_BINDING_ID,
    baseUrl: "https://api.rpdce.example.com",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: CAPABILITY_REF, method: "GET", path: "/ping" }],
  });
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new CountingTransport();
  const economicsPort = new InMemoryEconomicsPort();

  return {
    input: {
      waitStore,
      decisionRecordStore,
      waitRequest: request,
      organization: resumerOrganization(),
      membership: resumerMembership(),
      currentPrincipalRef: RESUMER_PRINCIPAL_REF,
      authority: protectedAuthority(),
      currentActivationFingerprint: compilation.profile.sourceFingerprint,
      currentActivationPlanId: compilation.profile.planId,
      currentActivationPlanVersion: compilation.profile.planVersion,
      now: "2026-10-02T00:01:00.000Z",
      tenantScope,
      effectIntentId: EFFECT_INTENT_ID,
      actionRef: ACTION_REF,
      retryClassification: RETRY_CLASSIFICATION,
      attemptId: "attempt-rpdce-1",
      bound,
      capabilityRef: CAPABILITY_REF,
      requestingOwnership: ownershipRef,
      connectionStore: storeFor(instance),
      secretResolver: { resolve: () => "sk-rpdce" } satisfies SecretResolver,
      transport,
      readback: alwaysConfirmsReadback(),
      economicsPort,
      economicsTaskRef: "task:rpdce-ping",
      economicsUsageSource: "OTHER_ADMITTED" as const,
      ...quotaFixture(),
      ...overrides,
    },
    transport,
    waitStore,
    decisionRecordStore,
    request,
    economicsPort,
  };
}

test("Rev186 F3: the first resumeProtectedDecisionAndExecuteConnectorEffect call wins the durable claim and invokes the connector transport exactly once, reaching VERIFIED", async () => {
  const { input, transport, economicsPort } = baseInput();
  const result = await resumeProtectedDecisionAndExecuteConnectorEffect(input);
  assert.equal(result.kind, "EFFECT_EXECUTED");
  assert.equal(transport.callCount, 1);
  if (result.kind === "EFFECT_EXECUTED") {
    assert.equal(result.outcome.kind, "VERIFIED");
  }
  assert.equal((input.quotaAdmission as InMemoryQuotaAdmissionStore).commitCount, 1, "item5d: usage must be committed after a real outcome");
  assert.equal(economicsPort.events.length, 1, "item5e: exactly one ExecutionEconomicsEvent must be recorded for the settled attempt");
  assert.equal(economicsPort.events[0]!.costBuckets[0]!.amount.presence, "UNKNOWN");
});

test("Rev186 F3 (the core atomicity proof): a second resumeProtectedDecisionAndExecuteConnectorEffect call for the SAME waitRequestId never invokes the transport again - it finds the claim already taken and returns ALREADY_RESUMED_NO_EFFECT", async () => {
  const { input, transport } = baseInput();
  const first = await resumeProtectedDecisionAndExecuteConnectorEffect(input);
  assert.equal(first.kind, "EFFECT_EXECUTED");
  assert.equal(transport.callCount, 1);

  // A second call - e.g. a replayed resume request, or a concurrent racer -
  // reusing the SAME waitStore/waitRequestId but otherwise independently
  // re-authorized (fresh now), to prove the durable claim itself - not
  // merely object identity of the first authorization - is what makes this
  // single-use.
  const second = await resumeProtectedDecisionAndExecuteConnectorEffect({
    ...input,
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

test("Rev188 item3 adversarial: a waitRequest.effectRef that does not identify the exact canonical effect fingerprint being executed blocks the effect with zero transport invocations and zero durable claim", async () => {
  const { input, transport, waitStore, request } = baseInput({ effectIntentId: "a-completely-different-effect" });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input), ProtectedEffectBindingMismatchError);
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});

test("Rev188 item3 adversarial (substitution attack): keeping the SAME effectIntentId but substituting a different actionRef blocks the effect with zero transport invocations", async () => {
  const { input, transport, waitStore, request } = baseInput({ actionRef: "action:a-substituted-action" });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input), ProtectedEffectBindingMismatchError);
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});

test("Rev188 item3 adversarial (substitution attack): keeping the SAME effectIntentId but substituting a different capabilityRef blocks the effect with zero transport invocations", async () => {
  const { input, transport, waitStore, request } = baseInput({ capabilityRef: "cap:a-substituted-capability" });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input), ProtectedEffectBindingMismatchError);
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});

test("Rev188 item3 adversarial (substitution attack): keeping the SAME effectIntentId but substituting a different requestPayload blocks the effect with zero transport invocations", async () => {
  const { input, transport, waitStore, request } = baseInput({ requestPayload: { substituted: true } });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input), ProtectedEffectBindingMismatchError);
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});

test("Rev188 item3 adversarial (substitution attack): keeping the SAME effectIntentId but substituting a different connectionBindingId (via a differently-bound connector instance) blocks the effect with zero transport invocations", async () => {
  const ownershipRef = ownership();
  const otherInstance = (() => {
    const descriptor = createConnectorDescriptor({
      connectorKind: "GENERIC_CUSTOM_API",
      displayName: "RPDCE API (other binding)",
      supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
      capabilityRefs: [CAPABILITY_REF],
      isAiModelProvider: false,
      requiresOAuthRedirect: false,
    });
    const requirement: ConnectionRequirement = createConnectionRequirement({
      connectionRequirementId: "req-rpdce-other",
      ownership: ownershipRef,
      requiredCapabilityRef: CAPABILITY_REF,
      purpose: "Rev188 item3 substitution witness",
      accountOwner: "AKILTA_MANAGED",
      minimumProviderScope: [],
      connectionMethod: "api",
      validationRequirement: "must respond 200",
    });
    const requested = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-rpdce-other",
      workspaceRef: "workspace-rpdce",
      integrationInstanceRef: "instance-rpdce-other",
      delegatedScope: [],
      authMode: "API_KEY",
      secretRef: createSecretRef({ secretRefId: "secret-rpdce-other" }),
    });
    const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
    return verifyConnectorConnection(unverified, "evidence:rpdce-other-handshake");
  })();
  const otherDefinition = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-rpdce-other",
    baseUrl: "https://api.rpdce-other.example.com",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: CAPABILITY_REF, method: "GET", path: "/ping" }],
  });
  const otherBound = bindGenericApiDefinition({ instance: otherInstance, definition: otherDefinition });

  const { input, transport, waitStore, request } = baseInput({
    bound: otherBound,
    connectionStore: storeFor(otherInstance),
  });
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

test("Rev187 F3c adversarial: a stale quota envelope (sourceFingerprint mismatch) at entry blocks the effect with zero transport invocations", async () => {
  const { input, transport } = baseInput({ currentQuotaSourceFingerprint: "a-different-quota-fingerprint" });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0);
});

test("Rev188 item5a adversarial: a quota scope bound to a foreign project blocks the effect with zero transport invocations and zero durable claim", async () => {
  const foreignScope = createQuotaAdmissionScope({
    tenantScope,
    customerId: GOLDEN_PATH_CUSTOMER.customerId,
    projectId: "a-foreign-project",
    planId: compilation.profile.planId,
    planVersion: compilation.profile.planVersion,
  });
  const foreignEnvelope = createQuotaEnvelope({
    scope: foreignScope,
    envelopeRef: "envelope-rpdce-foreign",
    sourceFingerprint: "qfp-rpdce-foreign",
    unitLimit: 1_000_000,
  });
  const { input, transport, waitStore, request } = baseInput({
    quotaEnvelope: foreignEnvelope,
    currentQuotaSourceFingerprint: "qfp-rpdce-foreign",
    quotaEnvelopeResolver: { resolveCurrentQuotaEnvelope: () => foreignEnvelope } satisfies CurrentQuotaEnvelopeResolver,
  });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input), ProtectedEffectQuotaLineageMismatchError);
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});

test("Rev188 item5a adversarial: a quota scope bound to a stale/foreign activation plan version blocks the effect with zero transport invocations", async () => {
  const { input, transport, waitStore, request } = baseInput({ currentActivationPlanVersion: compilation.profile.planVersion + 1 });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input), ProtectedEffectQuotaLineageMismatchError);
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});

test("Rev188 item5b adversarial: a quota envelope that goes stale between admission and invocation blocks the effect, releases the reservation, but does NOT undo the already-won resume claim", async () => {
  const scope = quotaScope();
  const admittedEnvelope = createQuotaEnvelope({
    scope,
    envelopeRef: "envelope-rpdce",
    sourceFingerprint: "qfp-rpdce",
    unitLimit: 1_000_000,
  });
  const staleAtInvocationEnvelope = createQuotaEnvelope({
    scope,
    envelopeRef: "envelope-rpdce",
    sourceFingerprint: "qfp-rpdce-rotated",
    unitLimit: 1_000_000,
  });
  const quotaAdmission = new InMemoryQuotaAdmissionStore();
  const { input, transport, waitStore, request } = baseInput({
    quotaAdmission,
    quotaEnvelope: admittedEnvelope,
    currentQuotaSourceFingerprint: "qfp-rpdce",
    quotaEnvelopeResolver: { resolveCurrentQuotaEnvelope: () => staleAtInvocationEnvelope } satisfies CurrentQuotaEnvelopeResolver,
  });
  const result = await resumeProtectedDecisionAndExecuteConnectorEffect(input);
  assert.equal(result.kind, "EFFECT_BLOCKED_STALE_QUOTA");
  assert.equal(transport.callCount, 0, "zero transport invocation - the effect must never be invoked against a post-claim-stale quota envelope");
  assert.equal(quotaAdmission.releaseCount, 1, "the reservation must be released on a post-claim staleness finding");
  assert.equal(quotaAdmission.commitCount, 0);
  // The resume claim itself is never undone - a second call now finds it
  // already resumed, never re-attempting (and never re-blocking) it.
  const second = await resumeProtectedDecisionAndExecuteConnectorEffect(input);
  assert.equal(second.kind, "ALREADY_RESUMED_NO_EFFECT");
  assert.equal(transport.callCount, 0);
  void waitStore;
  void request;
});

test("Rev188 item5c/d adversarial: a thrown exception from executeConnectorCapabilityAsVerifiedEffect releases the quota reservation before propagating", async () => {
  // attemptId is validated by startExternalEffectAttempt (inside
  // executeConnectorCapabilityAsVerifiedEffect) but is NOT part of the
  // effect fingerprint, so an empty attemptId reaches all the way to the
  // already-won claim before throwing - exercising the try/catch release
  // path, not an earlier currentness/authority check.
  const { input } = baseInput({ attemptId: "" });
  const quotaAdmission = input.quotaAdmission as InMemoryQuotaAdmissionStore;
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(quotaAdmission.releaseCount, 1, "a thrown exception from the verified-effect call must release the reservation before propagating");
  assert.equal(quotaAdmission.commitCount, 0);
});

test("Rev186 F3 adversarial: a membership whose principalRef does not match the supplied currentPrincipalRef (forged identity) blocks the effect with zero transport invocations and no durable claim is created", async () => {
  const { input, transport, waitStore, request } = baseInput({
    currentPrincipalRef: "a-forged-unrelated-principal",
  });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});

test("Rev188 item2 adversarial: access re-resolved from a REVOKED membership (even though an earlier resolution for this same membership was GRANTED) blocks the effect with zero transport invocations", async () => {
  const revoked: OrganizationMembership = { ...resumerMembership(), state: "REVOKED" } as OrganizationMembership;
  const { input, transport, waitStore, request } = baseInput({ membership: revoked });
  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0);
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});

test("Rev188 item4 capstone: a decision APPROVED at wait time but REVOKED (via the durable store's own monotonic revision) before resume blocks the effect with zero transport invocations - the fresh F3b decision-record lookup observes the REVOKED revision, not the original APPROVED creation", async () => {
  const { input, transport, waitStore, request, decisionRecordStore } = baseInput();
  const currentlyApproved = decisionRecordStore.getDecisionRecord(tenantScope.tenantId, "decision:rpdce-example")!;
  assert.equal(currentlyApproved.outcome, "APPROVED");

  const revocation = reviseProtectedDecisionRecord({
    current: currentlyApproved,
    tenantScope,
    outcome: "REVOKED",
    organization: resumerOrganization(),
    membership: resumerMembership(),
    currentPrincipalRef: RESUMER_PRINCIPAL_REF,
    authority: protectedAuthority(),
    decidedAt: "2026-10-02T00:00:45.000Z",
    evidenceRef: "evidence:revoked-before-resume",
  });
  decisionRecordStore.reviseDecisionRecord(tenantScope.tenantId, "decision:rpdce-example", revocation);
  assert.equal(decisionRecordStore.getDecisionRecord(tenantScope.tenantId, "decision:rpdce-example")!.outcome, "REVOKED");

  await assert.rejects(() => resumeProtectedDecisionAndExecuteConnectorEffect(input));
  assert.equal(transport.callCount, 0, "a decision revoked between wait and resume must never invoke the transport");
  assert.equal(waitStore.getResume(tenantScope.tenantId, request.waitRequestId), undefined);
});
