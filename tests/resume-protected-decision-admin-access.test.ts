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
import { createProtectedDecisionRecord } from "../src/domain/protected-decision-record.js";
import { FileDurableProtectedDecisionWaitStore } from "../src/domain/durable-protected-decision-wait-store.js";
import { FileDurableProtectedDecisionRecordStore } from "../src/domain/durable-protected-decision-record-store.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, createSecretRef, type ConnectionRequirement } from "../src/domain/connection-authority.js";
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
import { computeConnectorEffectFingerprint } from "../src/domain/resume-protected-decision-for-connector-effect.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";
import { StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import { resumeProtectedDecisionAndExecuteConnectorEffectAsAuthenticatedStaff } from "../src/web/resume-protected-decision-admin-access.js";

/**
 * Rev188 item2: `resumeProtectedDecisionAndExecuteConnectorEffectAsAuthenticatedStaff`
 * (`src/web/resume-protected-decision-admin-access.ts`) is the missing
 * authenticated ingress boundary in front of
 * `resumeProtectedDecisionAndExecuteConnectorEffect`. This exercises only
 * the web-layer concern (a forged session fails before the domain function
 * is ever reached, and a real session wires through to a real effect) -
 * the domain function's own currentness/binding/quota adversarial coverage
 * is already proven directly in
 * `tests/resume-protected-decision-for-connector-effect.test.ts`.
 */

const compilation = compileGoldenPathActivation("plan-rpdce-web-1", "sold-rpdce-web-1");
const job = compilation.jobs[0]!;
const tenantScope = GOLDEN_PATH_TENANT_SCOPE;
const EFFECT_INTENT_ID = "effect-intent-rpdce-web-1";
const ACTION_REF = "action:rpdce-web-ping";
const RETRY_CLASSIFICATION = "SAFE_TO_RETRY" as const;
const CAPABILITY_REF = "cap:rpdce-web-ping";
const CONNECTION_BINDING_ID = "bind-rpdce-web";
const RESUMER_PRINCIPAL_REF = "principal-rpdce-web-resumer";

function effectFingerprint() {
  return computeConnectorEffectFingerprint({
    effectIntentId: EFFECT_INTENT_ID,
    actionRef: ACTION_REF,
    retryClassification: RETRY_CLASSIFICATION,
    capabilityRef: CAPABILITY_REF,
    connectionBindingId: CONNECTION_BINDING_ID,
  });
}

function protectedAuthority() {
  // READ is required by requireInternalOsAccess's own Phase A gate; EXECUTE
  // is required by the domain function's own protected-action checks.
  return createAuthorityContext({ tenantScope, permissions: ["READ", "EXECUTE"], canPerformProtectedActions: true });
}

function resumerOrganization() {
  return activateOrganization({
    organization: createOrganization({
      organizationId: "org-akilta-rpdce-web",
      tenantScope,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });
}

function resumerMembership() {
  return createOrganizationMembership({
    membershipId: "membership-rpdce-web-resumer",
    tenantScope,
    principalRef: RESUMER_PRINCIPAL_REF,
    role: "STAFF",
  });
}

function decisionRecord() {
  return createProtectedDecisionRecord({
    tenantScope,
    decisionRef: "decision:rpdce-web-example",
    outcome: "APPROVED",
    organization: resumerOrganization(),
    membership: resumerMembership(),
    currentPrincipalRef: RESUMER_PRINCIPAL_REF,
    authority: protectedAuthority(),
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:decision-made-web",
  });
}

function ownership(): ProjectOwnershipRef {
  return createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: "customer-rpdce-web", projectId: "project-rpdce-web" });
}

function verifiedInstance(ownershipRef: ProjectOwnershipRef): ConnectorConnectionInstance {
  const descriptor = createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "RPDCE Web API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: [CAPABILITY_REF],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
  const requirement: ConnectionRequirement = createConnectionRequirement({
    connectionRequirementId: "req-rpdce-web",
    ownership: ownershipRef,
    requiredCapabilityRef: CAPABILITY_REF,
    purpose: "Rev188 item2 web ingress proof",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: CONNECTION_BINDING_ID,
    workspaceRef: "workspace-rpdce-web",
    integrationInstanceRef: "instance-rpdce-web",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-rpdce-web" }),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectorConnection(unverified, "evidence:rpdce-web-handshake");
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
  commit(input: Parameters<QuotaAdmissionPort["commit"]>[0]) {
    const { ledger, outcome } = commitQuotaUsage({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }
  release(input: Parameters<QuotaAdmissionPort["release"]>[0]) {
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

function sessionFixture() {
  const principal = createAuthenticatedStaffPrincipal({ principalId: RESUMER_PRINCIPAL_REF, displayName: "RPDCE Web Resumer" });
  const sessionToken = "token-rpdce-web-resumer";
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-02T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const grant: StaffAccessGrant = { membership: resumerMembership(), authority: protectedAuthority(), assignments: [] };
  return { provider, sessionToken, grants: [grant] };
}

function baseInput(overrides: Partial<Parameters<typeof resumeProtectedDecisionAndExecuteConnectorEffectAsAuthenticatedStaff>[0]> = {}) {
  const waitStore = new FileDurableProtectedDecisionWaitStore(mkdtempSync(join(tmpdir(), "os-v0-10-rpdce-web-")));
  const decisionRecordStore = new FileDurableProtectedDecisionRecordStore(mkdtempSync(join(tmpdir(), "os-v0-10-rpdce-web-decision-")));
  const request = createProtectedDecisionWaitRequest({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job,
    waitRequestId: "wait-rpdce-web-1",
    runId: "run-web-1",
    attempt: 1,
    effectRef: effectFingerprint(),
    decisionRef: "decision:rpdce-web-example",
    reason: "human approval required before this connector effect",
    activationFingerprintAtWait: compilation.profile.sourceFingerprint,
    raisedAt: "2026-10-02T00:00:00.000Z",
  });
  waitStore.putIfAbsentWaitRequest(tenantScope.tenantId, request.waitRequestId, request);
  const record = decisionRecord();
  decisionRecordStore.putIfAbsentDecisionRecord(tenantScope.tenantId, record.decisionRef, record);

  const ownershipRef = ownership();
  const instance = verifiedInstance(ownershipRef);
  const definition = createGenericApiConnectorDefinition({
    connectionBindingId: CONNECTION_BINDING_ID,
    baseUrl: "https://api.rpdce-web.example.com",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: CAPABILITY_REF, method: "GET", path: "/ping" }],
  });
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new CountingTransport();
  const { provider, sessionToken, grants } = sessionFixture();
  const scope = createQuotaAdmissionScope({
    tenantScope,
    customerId: GOLDEN_PATH_CUSTOMER.customerId,
    projectId: GOLDEN_PATH_PROJECT.projectId,
    planId: compilation.profile.planId,
    planVersion: compilation.profile.planVersion,
  });
  const quotaEnvelope: QuotaEnvelope = createQuotaEnvelope({
    scope,
    envelopeRef: "envelope-rpdce-web",
    sourceFingerprint: "qfp-rpdce-web",
    unitLimit: 1_000_000,
  });

  return {
    input: {
      waitStore,
      decisionRecordStore,
      waitRequest: request,
      organization: resumerOrganization(),
      provider,
      sessionToken,
      grants,
      authority: protectedAuthority(),
      currentActivationFingerprint: compilation.profile.sourceFingerprint,
      currentActivationPlanId: compilation.profile.planId,
      currentActivationPlanVersion: compilation.profile.planVersion,
      now: "2026-10-02T00:01:00.000Z",
      tenantScope,
      effectIntentId: EFFECT_INTENT_ID,
      actionRef: ACTION_REF,
      retryClassification: RETRY_CLASSIFICATION,
      attemptId: "attempt-rpdce-web-1",
      bound,
      capabilityRef: CAPABILITY_REF,
      requestingOwnership: ownershipRef,
      connectionStore: storeFor(instance),
      secretResolver: { resolve: () => "sk-rpdce-web" } satisfies SecretResolver,
      transport,
      readback: alwaysConfirmsReadback(),
      quotaAdmission: new InMemoryQuotaAdmissionStore(),
      quotaEnvelope,
      currentQuotaSourceFingerprint: "qfp-rpdce-web",
      quotaEnvelopeResolver: { resolveCurrentQuotaEnvelope: () => quotaEnvelope } satisfies CurrentQuotaEnvelopeResolver,
      estimatedCost: { presence: "REPORTED" as const, amountMinorUnits: 10, currency: "USD" },
      economicsPort: new InMemoryEconomicsPort(),
      economicsTaskRef: "task:rpdce-web-ping",
      economicsUsageSource: "OTHER_ADMITTED" as const,
      ...overrides,
    },
    transport,
  };
}

test("Rev188 item2: a valid authenticated staff session resumes the protected decision and invokes the connector transport exactly once through the web-layer wrapper", async () => {
  const { input, transport } = baseInput();
  const result = await resumeProtectedDecisionAndExecuteConnectorEffectAsAuthenticatedStaff(input);
  assert.equal(result.kind, "EFFECT_EXECUTED");
  assert.equal(transport.callCount, 1);
});

test("Rev188 item2 adversarial (forged identity): a sessionToken with no matching session fails inside requireInternalOsAccess itself, before the domain function is ever reached - zero transport invocation", async () => {
  const { input, transport } = baseInput({ sessionToken: "a-forged-unrelated-session-token" });
  await assert.rejects(
    () => resumeProtectedDecisionAndExecuteConnectorEffectAsAuthenticatedStaff(input),
    StaffUnauthenticatedError,
  );
  assert.equal(transport.callCount, 0);
});
