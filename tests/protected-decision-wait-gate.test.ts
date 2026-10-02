import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOLDEN_PATH_TENANT_SCOPE,
  GOLDEN_PATH_CUSTOMER,
  GOLDEN_PATH_PROJECT,
  compileGoldenPathActivation,
} from "./helpers/golden-path-fixture.js";
import { createAuthorityContext } from "../src/domain/authority.js";
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
      authority: nonProtected,
      authorityId: "authority-1",
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
        authority: protectedAuthority(),
        authorityId: "authority-1",
        currentActivationFingerprint: "a-different-fingerprint",
        now: "2026-10-02T00:01:00.000Z",
      }),
    ProtectedDecisionWaitStaleError,
  );
});

test("authorizeProtectedDecisionResume succeeds when currentness matches and authority is granted, and the resulting authorization binds the exact same effectRef", () => {
  const request = waitRequest();
  const authorization = authorizeProtectedDecisionResume({
    waitRequest: request,
    authority: protectedAuthority(),
    authorityId: "authority-1",
    currentActivationFingerprint: compilation.profile.sourceFingerprint,
    now: "2026-10-02T00:01:00.000Z",
  });
  assert.equal(authorization.effectRef, request.effectRef);
  assert.equal(authorization.waitRequestId, request.waitRequestId);
  assert.equal(authorization.resolvedByAuthorityId, "authority-1");
});
