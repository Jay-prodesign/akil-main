import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOLDEN_PATH_TENANT_SCOPE,
  GOLDEN_PATH_CUSTOMER,
  GOLDEN_PATH_PROJECT,
  compileGoldenPathActivation,
} from "./helpers/golden-path-fixture.js";
import { createProtectedDecisionWaitRequest, authorizeProtectedDecisionResume } from "../src/domain/protected-decision-wait-gate.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import {
  FileDurableProtectedDecisionWaitStore,
  InvalidDurableProtectedDecisionWaitStoreError,
  CorruptedProtectedDecisionWaitLineError,
} from "../src/domain/durable-protected-decision-wait-store.js";

const compilation = compileGoldenPathActivation("plan-dpdw-1", "sold-dpdw-1");
const job = compilation.jobs[0]!;

function freshStore(): { store: FileDurableProtectedDecisionWaitStore; baseDir: string } {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-protected-decision-wait-"));
  return { store: new FileDurableProtectedDecisionWaitStore(baseDir), baseDir };
}

function sampleRequest(waitRequestId: string) {
  return createProtectedDecisionWaitRequest({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job,
    waitRequestId,
    runId: "run-1",
    attempt: 1,
    effectRef: "effect:example",
    decisionRef: "decision:example",
    reason: "human approval required",
    activationFingerprintAtWait: compilation.profile.sourceFingerprint,
    raisedAt: "2026-10-02T00:00:00.000Z",
  });
}

test("D1: putIfAbsentWaitRequest is idempotent for identical content", () => {
  const { store } = freshStore();
  const request = sampleRequest("wait-d1");
  const first = store.putIfAbsentWaitRequest(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d1", request);
  const second = store.putIfAbsentWaitRequest(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d1", request);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.value, request);
});

test("D2: putIfAbsentWaitRequest rejects a different wait request under the same waitRequestId", () => {
  const { store } = freshStore();
  const request = sampleRequest("wait-d2");
  store.putIfAbsentWaitRequest(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d2", request);
  const differentRequest = { ...request, reason: "a materially different reason" };
  assert.throws(
    () => store.putIfAbsentWaitRequest(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d2", differentRequest),
    InvalidDurableProtectedDecisionWaitStoreError,
  );
});

test("D3: cold restart reconstructs the identical wait request from a fresh store instance pointed at the same baseDir", () => {
  const { store, baseDir } = freshStore();
  const request = sampleRequest("wait-d3");
  store.putIfAbsentWaitRequest(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d3", request);
  const restarted = new FileDurableProtectedDecisionWaitStore(baseDir);
  assert.deepEqual(restarted.get(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d3"), request);
});

test("D4: claimResume requires a durably-recorded wait request to already exist", () => {
  const { store } = freshStore();
  const request = sampleRequest("wait-d4");
  const authorization = authorizeProtectedDecisionResume({
    waitRequest: request,
    authority: createAuthorityContext({ tenantScope: GOLDEN_PATH_TENANT_SCOPE, permissions: ["EXECUTE"], canPerformProtectedActions: true }),
    authorityId: "authority-1",
    currentActivationFingerprint: compilation.profile.sourceFingerprint,
    now: "2026-10-02T00:01:00.000Z",
  });
  assert.throws(
    () => store.claimResume(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d4", authorization),
    InvalidDurableProtectedDecisionWaitStoreError,
  );
});

test("D5 (benchmark-audit single-use): a second claimResume for the same waitRequestId is a safe no-op returning the ORIGINAL resume, never a second authorizing claim", () => {
  const { store } = freshStore();
  const request = sampleRequest("wait-d5");
  store.putIfAbsentWaitRequest(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d5", request);

  const authority = createAuthorityContext({ tenantScope: GOLDEN_PATH_TENANT_SCOPE, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  const firstAuthorization = authorizeProtectedDecisionResume({
    waitRequest: request,
    authority,
    authorityId: "authority-first",
    currentActivationFingerprint: compilation.profile.sourceFingerprint,
    now: "2026-10-02T00:01:00.000Z",
  });
  const firstClaim = store.claimResume(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d5", firstAuthorization);
  assert.equal(firstClaim.created, true);

  const secondAuthorization = authorizeProtectedDecisionResume({
    waitRequest: request,
    authority,
    authorityId: "authority-second",
    currentActivationFingerprint: compilation.profile.sourceFingerprint,
    now: "2026-10-02T00:02:00.000Z",
  });
  const secondClaim = store.claimResume(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d5", secondAuthorization);
  assert.equal(secondClaim.created, false);
  assert.equal(secondClaim.value.resolvedByAuthorityId, "authority-first");
  assert.equal(store.getResume(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d5")?.resolvedByAuthorityId, "authority-first");
});

test("D6: cold restart reconstructs the identical resume claim", () => {
  const { store, baseDir } = freshStore();
  const request = sampleRequest("wait-d6");
  store.putIfAbsentWaitRequest(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d6", request);
  const authorization = authorizeProtectedDecisionResume({
    waitRequest: request,
    authority: createAuthorityContext({ tenantScope: GOLDEN_PATH_TENANT_SCOPE, permissions: ["EXECUTE"], canPerformProtectedActions: true }),
    authorityId: "authority-1",
    currentActivationFingerprint: compilation.profile.sourceFingerprint,
    now: "2026-10-02T00:01:00.000Z",
  });
  store.claimResume(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d6", authorization);
  const restarted = new FileDurableProtectedDecisionWaitStore(baseDir);
  assert.deepEqual(restarted.getResume(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d6"), authorization);
});

test("D7: a corrupted wait-request line (cross-tenant contamination) fails closed on replay", () => {
  const { store, baseDir } = freshStore();
  const request = sampleRequest("wait-d7");
  store.putIfAbsentWaitRequest(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d7", request);
  const filePath = join(baseDir, `${Buffer.from(GOLDEN_PATH_TENANT_SCOPE.tenantId, "utf8").toString("base64url")}.wait.jsonl`);
  const corrupted = JSON.stringify({
    waitRequestId: "wait-d7",
    request: { ...request, tenantId: "a-different-tenant" },
  });
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(filePath, `${corrupted}\n`, "utf8");
  const restarted = new FileDurableProtectedDecisionWaitStore(baseDir);
  assert.throws(() => restarted.get(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d7"), CorruptedProtectedDecisionWaitLineError);
});

test("D8: claimResume rejects an authorization whose effectRef does not match the recorded wait request's own effectRef", () => {
  const { store } = freshStore();
  const request = sampleRequest("wait-d8");
  store.putIfAbsentWaitRequest(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d8", request);
  const authorization = authorizeProtectedDecisionResume({
    waitRequest: request,
    authority: createAuthorityContext({ tenantScope: GOLDEN_PATH_TENANT_SCOPE, permissions: ["EXECUTE"], canPerformProtectedActions: true }),
    authorityId: "authority-1",
    currentActivationFingerprint: compilation.profile.sourceFingerprint,
    now: "2026-10-02T00:01:00.000Z",
  });
  const tampered = { ...authorization, effectRef: "effect:tampered" };
  assert.throws(
    () => store.claimResume(GOLDEN_PATH_TENANT_SCOPE.tenantId, "wait-d8", tampered),
    InvalidDurableProtectedDecisionWaitStoreError,
  );
});
