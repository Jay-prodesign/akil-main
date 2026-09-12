import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createAuthorityContext } from "../src/domain/authority.js";
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
  type ConnectorDescriptor,
} from "../src/domain/integration-connector-catalog.js";
import { createGenericApiConnectorDefinition, bindGenericApiDefinition } from "../src/domain/generic-connector-definition.js";
import {
  ConnectorExecutionAuthorizationError,
  type ConnectorTransport,
  type ConnectorTransportRequest,
  type SecretResolver,
} from "../src/domain/connector-execution.js";
import {
  readWebsiteBuildSignal,
  diagnoseWebsiteBuildSignal,
  recommendWebsiteBuildAction,
  draftWebsiteBuildEffectIntent,
  startWebsiteBuildEffectAttempt,
  controlledApplyWebsiteBuildEffect,
  InvalidWebsiteBuildControlAdapterError,
} from "../src/domain/website-build-control-adapter.js";
import { verifyExternalEffectReadback } from "../src/domain/external-effect-envelope.js";

const tenantScope = createTenantScope("tenant-wb-1");

function ownership(): ProjectOwnershipRef {
  return createProjectOwnershipRef({
    tenantId: tenantScope.tenantId,
    customerId: "customer-1",
    projectId: "project-1",
  });
}

function descriptor(): ConnectorDescriptor {
  return createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "Generic API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: ["cap:site-content"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
}

function requirement(desc: ConnectorDescriptor, ownershipRef: ProjectOwnershipRef): ConnectionRequirement {
  return createConnectionRequirement({
    connectionRequirementId: `req-${ownershipRef.tenantId}`,
    ownership: ownershipRef,
    requiredCapabilityRef: desc.capabilityRefs[0] as string,
    purpose: "website build control",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
}

function verifiedInstance(ownershipRef: ProjectOwnershipRef): ConnectorConnectionInstance {
  const desc = descriptor();
  const req = requirement(desc, ownershipRef);
  const requested = requestConnectorConnection({
    requirement: req,
    connectorDescriptor: desc,
    connectionBindingId: `bind-${ownershipRef.tenantId}`,
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-ref-1" }),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectorConnection(unverified, "evidence:handshake");
}

function bound(ownershipRef: ProjectOwnershipRef) {
  const instance = verifiedInstance(ownershipRef);
  const definition = createGenericApiConnectorDefinition({
    connectionBindingId: instance.binding.connectionBindingId,
    baseUrl: "https://api.website-build-example.com",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: "cap:site-content", method: "GET", path: "/content" }],
  });
  return bindGenericApiDefinition({ instance, definition });
}

class MockTransport implements ConnectorTransport {
  constructor(
    private readonly outcome: "SUCCESS" | "AUTHORIZATION_FAILED" | "TRANSPORT_ERROR" = "SUCCESS",
    private readonly data: unknown = { title: "Home", brokenLinks: 0 },
  ) {}
  execute(_request: ConnectorTransportRequest) {
    if (this.outcome === "SUCCESS") {
      return { outcome: "SUCCESS" as const, data: this.data };
    }
    return { outcome: this.outcome, errorMessage: `mock ${this.outcome}` };
  }
}

class FixedSecretResolver implements SecretResolver {
  resolve(): string {
    return "resolved-secret-value";
  }
}

function connectorRequest(ownershipRef: ProjectOwnershipRef, transport: ConnectorTransport) {
  return {
    bound: bound(ownershipRef),
    capabilityRef: "cap:site-content",
    requestingOwnership: ownershipRef,
    secretResolver: new FixedSecretResolver(),
    transport,
  };
}

function grantedAuthority() {
  return createAuthorityContext({ tenantScope, permissions: ["WRITE"], canPerformProtectedActions: true });
}

// --- readWebsiteBuildSignal ---

test("W1: readWebsiteBuildSignal is tagged READ_ONLY and returns the connector's execution result", () => {
  const ownershipRef = ownership();
  const signal = readWebsiteBuildSignal(connectorRequest(ownershipRef, new MockTransport()));
  assert.equal(signal.executionMaturity, "READ_ONLY");
  assert.deepEqual(signal.result.data, { title: "Home", brokenLinks: 0 });
});

test("W2 (adversarial, reuses executeConnectorCapability unmodified): readWebsiteBuildSignal fails closed exactly like the underlying connector call", () => {
  const ownershipRef = ownership();
  assert.throws(
    () => readWebsiteBuildSignal(connectorRequest(ownershipRef, new MockTransport("AUTHORIZATION_FAILED"))),
    ConnectorExecutionAuthorizationError,
  );
});

// --- diagnoseWebsiteBuildSignal ---

function signal() {
  return readWebsiteBuildSignal(connectorRequest(ownership(), new MockTransport()));
}

test("W3: diagnoseWebsiteBuildSignal binds severity/evidenceRef to the exact prior signal", () => {
  const diagnosis = diagnoseWebsiteBuildSignal({
    signal: signal(),
    severity: "ISSUE_DETECTED",
    evidenceRef: "evidence:crawl-1",
  });
  assert.equal(diagnosis.executionMaturity, "DIAGNOSE");
  assert.equal(diagnosis.severity, "ISSUE_DETECTED");
  assert.deepEqual(diagnosis.basedOnResult, signal().result);
});

test("W4 (adversarial): diagnoseWebsiteBuildSignal rejects an unrecognized severity", () => {
  assert.throws(
    () => diagnoseWebsiteBuildSignal({ signal: signal(), severity: "MOSTLY_FINE", evidenceRef: "evidence:x" }),
    InvalidWebsiteBuildControlAdapterError,
  );
});

test("W5 (adversarial): diagnoseWebsiteBuildSignal rejects an empty evidenceRef", () => {
  assert.throws(
    () => diagnoseWebsiteBuildSignal({ signal: signal(), severity: "HEALTHY", evidenceRef: "" }),
    InvalidWebsiteBuildControlAdapterError,
  );
});

// --- recommendWebsiteBuildAction ---

function issueDiagnosis() {
  return diagnoseWebsiteBuildSignal({ signal: signal(), severity: "ISSUE_DETECTED", evidenceRef: "evidence:crawl-1" });
}

test("W6: recommendWebsiteBuildAction binds actionRef/rationale to the exact prior diagnosis", () => {
  const recommendation = recommendWebsiteBuildAction({
    diagnosis: issueDiagnosis(),
    actionRef: "action:fix-broken-link",
    rationale: "3 broken links found on homepage",
  });
  assert.equal(recommendation.executionMaturity, "RECOMMEND");
  assert.equal(recommendation.actionRef, "action:fix-broken-link");
});

test("W7 (adversarial, the honest-recommendation guard): recommendWebsiteBuildAction refuses to recommend an action against a HEALTHY diagnosis", () => {
  const healthyDiagnosis = diagnoseWebsiteBuildSignal({
    signal: signal(),
    severity: "HEALTHY",
    evidenceRef: "evidence:crawl-2",
  });
  assert.throws(
    () =>
      recommendWebsiteBuildAction({
        diagnosis: healthyDiagnosis,
        actionRef: "action:unnecessary-change",
        rationale: "no real reason",
      }),
    InvalidWebsiteBuildControlAdapterError,
  );
});

// --- draftWebsiteBuildEffectIntent ---

function recommendation() {
  return recommendWebsiteBuildAction({
    diagnosis: issueDiagnosis(),
    actionRef: "action:fix-broken-link",
    rationale: "3 broken links found on homepage",
  });
}

test("W8: draftWebsiteBuildEffectIntent always sets requiresApproval true, never caller-settable", () => {
  const draft = draftWebsiteBuildEffectIntent({
    recommendation: recommendation(),
    tenantScope,
    effectIntentId: "intent-wb-1",
    retryClassification: "SAFE_TO_RETRY",
  });
  assert.equal(draft.executionMaturity, "DRAFT_PREVIEW");
  assert.equal(draft.intent.requiresApproval, true);
  assert.equal(draft.intent.actionRef, "action:fix-broken-link");
});

// --- startWebsiteBuildEffectAttempt ---

function draft() {
  return draftWebsiteBuildEffectIntent({
    recommendation: recommendation(),
    tenantScope,
    effectIntentId: "intent-wb-1",
    retryClassification: "SAFE_TO_RETRY",
  });
}

test("W9: startWebsiteBuildEffectAttempt requires and records approval evidence", () => {
  const approved = startWebsiteBuildEffectAttempt({
    draft: draft(),
    attemptId: "attempt-wb-1",
    authority: grantedAuthority(),
    evidenceRef: "evidence:approval-1",
  });
  assert.equal(approved.executionMaturity, "APPROVAL_REQUIRED");
  assert.equal(approved.attempt.approvalEvidenceRef, "evidence:approval-1");
  assert.equal(approved.attempt.state, "NOT_STARTED");
});

test("W10 (adversarial, reuses startExternalEffectAttempt unmodified): startWebsiteBuildEffectAttempt fails closed on an unauthorized authority", () => {
  const readOnly = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });
  assert.throws(() =>
    startWebsiteBuildEffectAttempt({
      draft: draft(),
      attemptId: "attempt-wb-2",
      authority: readOnly,
      evidenceRef: "evidence:approval-1",
    }),
  );
});

// --- controlledApplyWebsiteBuildEffect ---

function approvedAttempt() {
  return startWebsiteBuildEffectAttempt({
    draft: draft(),
    attemptId: "attempt-wb-3",
    authority: grantedAuthority(),
    evidenceRef: "evidence:approval-1",
  });
}

test("W11: a successful connector execution reports APPLIED", () => {
  const ownershipRef = ownership();
  const applied = controlledApplyWebsiteBuildEffect({
    approvedAttempt: approvedAttempt(),
    connectorRequest: connectorRequest(ownershipRef, new MockTransport("SUCCESS")),
    externalCorrelationRef: "correlation:apply-1",
  });
  assert.equal(applied.executionMaturity, "CONTROLLED_APPLY");
  assert.equal(applied.attempt.state, "APPLIED");
  assert.equal(applied.attempt.externalCorrelationRef, "correlation:apply-1");
});

test("W12 (adversarial): an authorization failure at the connector layer reports FAILED, never APPLIED", () => {
  const ownershipRef = ownership();
  const applied = controlledApplyWebsiteBuildEffect({
    approvedAttempt: approvedAttempt(),
    connectorRequest: connectorRequest(ownershipRef, new MockTransport("AUTHORIZATION_FAILED")),
    externalCorrelationRef: "correlation:apply-2",
  });
  assert.equal(applied.attempt.state, "FAILED");
});

test("W13 (adversarial, ambiguity honesty): a transport-level error reports UNKNOWN, never a guessed FAILED", () => {
  const ownershipRef = ownership();
  const applied = controlledApplyWebsiteBuildEffect({
    approvedAttempt: approvedAttempt(),
    connectorRequest: connectorRequest(ownershipRef, new MockTransport("TRANSPORT_ERROR")),
    externalCorrelationRef: "correlation:apply-3",
  });
  assert.equal(applied.attempt.state, "UNKNOWN");
});

// --- full chain to VERIFIED (composing verifyExternalEffectReadback directly) ---

test("W14: the full READ->DIAGNOSE->RECOMMEND->DRAFT_PREVIEW->APPROVAL_REQUIRED->CONTROLLED_APPLY chain reaches VERIFIED via the unmodified external-effect-envelope readback", () => {
  const ownershipRef = ownership();
  const sig = readWebsiteBuildSignal(connectorRequest(ownershipRef, new MockTransport()));
  const diagnosis = diagnoseWebsiteBuildSignal({ signal: sig, severity: "CRITICAL", evidenceRef: "evidence:crawl-3" });
  const rec = recommendWebsiteBuildAction({
    diagnosis,
    actionRef: "action:fix-broken-link",
    rationale: "critical issue found",
  });
  const d = draftWebsiteBuildEffectIntent({
    recommendation: rec,
    tenantScope,
    effectIntentId: "intent-wb-chain",
    retryClassification: "SAFE_TO_RETRY",
  });
  const approved = startWebsiteBuildEffectAttempt({
    draft: d,
    attemptId: "attempt-wb-chain",
    authority: grantedAuthority(),
    evidenceRef: "evidence:approval-chain",
  });
  const applied = controlledApplyWebsiteBuildEffect({
    approvedAttempt: approved,
    connectorRequest: connectorRequest(ownershipRef, new MockTransport("SUCCESS")),
    externalCorrelationRef: "correlation:apply-chain",
  });
  const verified = verifyExternalEffectReadback({
    attempt: applied.attempt,
    readbackConfirmsApplied: true,
    evidenceRef: "evidence:readback-chain",
  });
  assert.equal(verified.state, "VERIFIED");
});
