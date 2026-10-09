import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOLDEN_PATH_TENANT_SCOPE,
  GOLDEN_PATH_CUSTOMER,
  GOLDEN_PATH_PROJECT,
  compileGoldenPathActivation,
} from "./helpers/golden-path-fixture.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership, revokeOrganizationMembership } from "../src/domain/organization-membership.js";
import { resolveEffectiveOrganizationAccess, type EffectiveAccessResolution } from "../src/domain/effective-organization-access.js";
import { createProtectedDecisionRecord, type ProtectedDecisionOutcome } from "../src/domain/protected-decision-record.js";
import {
  createProtectedDecisionWaitRequest,
  authorizeProtectedDecisionResume,
  InvalidProtectedDecisionWaitRequestError,
  ProtectedDecisionWaitStaleError,
} from "../src/domain/protected-decision-wait-gate.js";

const compilation = compileGoldenPathActivation("plan-pdw-1", "sold-pdw-1");
const job = compilation.jobs[0]!;

function waitRequest(overrides: Partial<Parameters<typeof createProtectedDecisionWaitRequest>[0]> = {}) {
  return createProtectedDecisionWaitRequest({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job,
    waitRequestId: "wait-1",
    runId: "run-1",
    attempt: 1,
    effectRef: "effect:example",
    decisionRef: "decision:example",
    reason: "human approval required before this effect",
    activationFingerprintAtWait: compilation.profile.sourceFingerprint,
    raisedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  });
}

function protectedAuthority() {
  return createAuthorityContext({ tenantScope: GOLDEN_PATH_TENANT_SCOPE, permissions: ["EXECUTE"], canPerformProtectedActions: true });
}

function decisionAuthoringFixture(authority = protectedAuthority(), tenantScope: TenantScope = GOLDEN_PATH_TENANT_SCOPE) {
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: `org-akilta-pdw-${tenantScope.tenantId}`,
      tenantScope,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });
  const membership = createOrganizationMembership({
    membershipId: "membership-pdw-resumer",
    tenantScope,
    principalRef: "principal-pdw-resumer",
    role: "STAFF",
  });
  return { organization, membership, currentPrincipalRef: "principal-pdw-resumer", authority };
}

function grantedAccess(authority = protectedAuthority(), tenantScope: TenantScope = GOLDEN_PATH_TENANT_SCOPE): EffectiveAccessResolution {
  return resolveEffectiveOrganizationAccess(decisionAuthoringFixture(authority, tenantScope));
}

function decisionRecord(overrides: {
  decisionRef?: string;
  outcome?: ProtectedDecisionOutcome;
  tenantScope?: TenantScope;
} = {}) {
  const tenantScope = overrides.tenantScope ?? GOLDEN_PATH_TENANT_SCOPE;
  return createProtectedDecisionRecord({
    tenantScope,
    decisionRef: overrides.decisionRef ?? "decision:example",
    outcome: overrides.outcome ?? "APPROVED",
    ...decisionAuthoringFixture(createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true }), tenantScope),
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:decision-made",
  });
}

test("createProtectedDecisionWaitRequest rejects attempt 0 or negative", () => {
  assert.throws(() => waitRequest({ attempt: 0 }), InvalidProtectedDecisionWaitRequestError);
  assert.throws(() => waitRequest({ attempt: -1 }), InvalidProtectedDecisionWaitRequestError);
});

test("createProtectedDecisionWaitRequest rejects a job foreign to the given tenant/customer/project", () => {
  const foreignJob = { ...job, projectId: "proj-foreign" as typeof job.projectId };
  assert.throws(
    () => waitRequest({ job: foreignJob }),
    InvalidProtectedDecisionWaitRequestError,
  );
});

test("authorizeProtectedDecisionResume requires protected-action authorization, not merely EXECUTE", () => {
  const request = waitRequest();
  const nonProtected = createAuthorityContext({ tenantScope: GOLDEN_PATH_TENANT_SCOPE, permissions: ["EXECUTE"], canPerformProtectedActions: false });
  assert.throws(() =>
    authorizeProtectedDecisionResume({
      waitRequest: request,
      access: grantedAccess(nonProtected),
      authority: nonProtected,
      decisionRecord: decisionRecord(),
      currentActivationFingerprint: compilation.profile.sourceFingerprint,
      now: "2026-10-02T00:01:00.000Z",
    }),
  );
});

test("Rev186 F3 (Founder implementation clarification): authorizeProtectedDecisionResume requires ordinary EXECUTE permission separately from canPerformProtectedActions - a READ-only authority cannot resume a protected decision merely because canPerformProtectedActions is true", () => {
  const request = waitRequest();
  const readOnlyButProtected = createAuthorityContext({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    permissions: ["READ"],
    canPerformProtectedActions: true,
  });
  assert.throws(() =>
    authorizeProtectedDecisionResume({
      waitRequest: request,
      access: grantedAccess(readOnlyButProtected),
      authority: readOnlyButProtected,
      decisionRecord: decisionRecord(),
      currentActivationFingerprint: compilation.profile.sourceFingerprint,
      now: "2026-10-02T00:01:00.000Z",
    }),
  );
});

test("authorizeProtectedDecisionResume fails closed when the current activation fingerprint has moved since the wait was raised - resume must re-resolve currentness before effect", () => {
  const request = waitRequest();
  assert.throws(
    () =>
      authorizeProtectedDecisionResume({
        waitRequest: request,
        access: grantedAccess(),
        authority: protectedAuthority(),
        decisionRecord: decisionRecord(),
        currentActivationFingerprint: "a-different-fingerprint",
        now: "2026-10-02T00:01:00.000Z",
      }),
    ProtectedDecisionWaitStaleError,
  );
});

test("Rev186 F3: authorizeProtectedDecisionResume fails closed when the decision record's decisionRef does not match this exact wait's own decisionRef", () => {
  const request = waitRequest();
  assert.throws(
    () =>
      authorizeProtectedDecisionResume({
        waitRequest: request,
        access: grantedAccess(),
        authority: protectedAuthority(),
        decisionRecord: decisionRecord({ decisionRef: "decision:a-different-one" }),
        currentActivationFingerprint: compilation.profile.sourceFingerprint,
        now: "2026-10-02T00:01:00.000Z",
      }),
    ProtectedDecisionWaitStaleError,
  );
});

test("Rev187 F3b: authorizeProtectedDecisionResume fails closed when the decision record belongs to a foreign tenant", () => {
  const request = waitRequest();
  assert.throws(
    () =>
      authorizeProtectedDecisionResume({
        waitRequest: request,
        access: grantedAccess(),
        authority: protectedAuthority(),
        decisionRecord: decisionRecord({ tenantScope: createTenantScope("tenant-pdw-foreign") }),
        currentActivationFingerprint: compilation.profile.sourceFingerprint,
        now: "2026-10-02T00:01:00.000Z",
      }),
    ProtectedDecisionWaitStaleError,
  );
});

test("Rev187 F3b: authorizeProtectedDecisionResume fails closed on a DENIED decision record", () => {
  const request = waitRequest();
  assert.throws(
    () =>
      authorizeProtectedDecisionResume({
        waitRequest: request,
        access: grantedAccess(),
        authority: protectedAuthority(),
        decisionRecord: decisionRecord({ outcome: "DENIED" }),
        currentActivationFingerprint: compilation.profile.sourceFingerprint,
        now: "2026-10-02T00:01:00.000Z",
      }),
    ProtectedDecisionWaitStaleError,
  );
});

test("Rev187 F3b: authorizeProtectedDecisionResume fails closed on a REVOKED decision record", () => {
  const request = waitRequest();
  assert.throws(
    () =>
      authorizeProtectedDecisionResume({
        waitRequest: request,
        access: grantedAccess(),
        authority: protectedAuthority(),
        decisionRecord: decisionRecord({ outcome: "REVOKED" }),
        currentActivationFingerprint: compilation.profile.sourceFingerprint,
        now: "2026-10-02T00:01:00.000Z",
      }),
    ProtectedDecisionWaitStaleError,
  );
});

test("Rev186 F3: authorizeProtectedDecisionResume fails closed on a DENIED access resolution - resume requires a current authenticated principal, not a bare authority context", () => {
  const request = waitRequest();
  const authority = protectedAuthority();
  const deniedAccess: EffectiveAccessResolution = {
    decision: "DENIED",
    tenantId: GOLDEN_PATH_TENANT_SCOPE.tenantId,
    organizationId: "org-akilta-pdw" as unknown as EffectiveAccessResolution["organizationId"],
    permissions: new Set(),
    canPerformProtectedActions: false,
    reasons: ["membership is not an active, coherent membership record"],
  };
  assert.throws(
    () =>
      authorizeProtectedDecisionResume({
        waitRequest: request,
        access: deniedAccess,
        authority,
        decisionRecord: decisionRecord(),
        currentActivationFingerprint: compilation.profile.sourceFingerprint,
        now: "2026-10-02T00:01:00.000Z",
      }),
    ProtectedDecisionWaitStaleError,
  );
});

test("Rev186 F3 (adversarial, isolates the GRANTED check from the membershipId check): a DENIED access resolution from a real revoked membership - which still carries a real membershipId - fails closed on access.decision alone", () => {
  const request = waitRequest();
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: "org-akilta-pdw-revoked",
      tenantScope: GOLDEN_PATH_TENANT_SCOPE,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });
  const activeMembership = createOrganizationMembership({
    membershipId: "membership-pdw-revoked",
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    principalRef: "principal-pdw-revoked",
    role: "STAFF",
  });
  const revokedMembership = revokeOrganizationMembership({
    membership: activeMembership,
    revokedAt: "2026-10-02T00:00:15.000Z",
    revokedReason: "offboarded",
  });
  const deniedAccess = resolveEffectiveOrganizationAccess({
    organization,
    membership: revokedMembership,
    currentPrincipalRef: "principal-pdw-revoked",
    authority: protectedAuthority(),
  });
  assert.equal(deniedAccess.decision, "DENIED");
  assert.equal(deniedAccess.membershipId, "membership-pdw-revoked");
  assert.throws(
    () =>
      authorizeProtectedDecisionResume({
        waitRequest: request,
        access: deniedAccess,
        authority: protectedAuthority(),
        decisionRecord: decisionRecord(),
        currentActivationFingerprint: compilation.profile.sourceFingerprint,
        now: "2026-10-02T00:01:00.000Z",
      }),
    ProtectedDecisionWaitStaleError,
  );
});

test("Rev186 F3 (adversarial, isolates the membershipId check): a GRANTED access resolution with no membershipId (e.g. a service-principal-bound access, never an OrganizationMembership) cannot resume a protected decision", () => {
  const request = waitRequest();
  const authority = protectedAuthority();
  const servicePrincipalShapedAccess: EffectiveAccessResolution = {
    decision: "GRANTED",
    tenantId: GOLDEN_PATH_TENANT_SCOPE.tenantId,
    organizationId: "org-akilta-pdw-svcprincipal" as unknown as EffectiveAccessResolution["organizationId"],
    permissions: new Set(authority.permissions),
    canPerformProtectedActions: authority.canPerformProtectedActions,
    reasons: ["organization/service-principal/authority tenant correlation verified"],
  };
  assert.throws(
    () =>
      authorizeProtectedDecisionResume({
        waitRequest: request,
        access: servicePrincipalShapedAccess,
        authority,
        decisionRecord: decisionRecord(),
        currentActivationFingerprint: compilation.profile.sourceFingerprint,
        now: "2026-10-02T00:01:00.000Z",
      }),
    ProtectedDecisionWaitStaleError,
  );
});

test("authorizeProtectedDecisionResume succeeds when currentness/decision/access/decisionRecord all match, and the resulting authorization binds the exact effectRef, decisionRef and current authenticated principal", () => {
  const request = waitRequest();
  const access = grantedAccess();
  const authorization = authorizeProtectedDecisionResume({
    waitRequest: request,
    access,
    authority: protectedAuthority(),
    decisionRecord: decisionRecord(),
    currentActivationFingerprint: compilation.profile.sourceFingerprint,
    now: "2026-10-02T00:01:00.000Z",
  });
  assert.equal(authorization.effectRef, request.effectRef);
  assert.equal(authorization.waitRequestId, request.waitRequestId);
  assert.equal(authorization.resolvedByPrincipalRef, access.membershipId);
  assert.equal(authorization.decisionRef, "decision:example");
  assert.equal(authorization.decisionEvidenceRef, "evidence:decision-made");
});
