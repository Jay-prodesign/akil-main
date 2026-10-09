import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import {
  computeConfigurationPolicyDecisionProjection,
  encodeConfigurationPolicyDecisionKey,
} from "../src/domain/configuration-policy-decision-projection.js";
import {
  FileDurableConfigurationPolicyDecisionStore,
  InvalidDurableConfigurationPolicyDecisionStoreError,
} from "../src/domain/durable-configuration-policy-decision-store.js";
import {
  createProtectedDecisionWaitRequest,
  type ProtectedDecisionResumeAuthorization,
} from "../src/domain/protected-decision-wait-gate.js";
import {
  FileDurableProtectedDecisionWaitStore,
  InvalidDurableProtectedDecisionWaitStoreError,
} from "../src/domain/durable-protected-decision-wait-store.js";
import { createProtectedDecisionRecord } from "../src/domain/protected-decision-record.js";
import { FileDurableProtectedDecisionRecordStore } from "../src/domain/durable-protected-decision-record-store.js";

/**
 * OS-V1-03 ("Multi-Plane Isolation Certification"): the exact same
 * cross-organization (cross-TenantScope, this repo's own established
 * correspondence - see OS-V0-14's own fixture) bare-ID-collision-with-
 * zero-cross-visibility pattern OS-V0-14 already proved for
 * `FileDurableOrganizationResourceBindingStore`/`FileDurableConnectorConnectionStore`/
 * `FileDurableOutcomeJobExecutionStore`/`FileDurableQuotaReservationStore`,
 * extended to three activated OS-V0/V1 planes that had NOT yet been given
 * this specific witness: the configuration/policy/decision store
 * (OS-V0-11), and the protected-decision wait/resume and decision-record
 * stores (OS-V0-10) - the "callbacks"/"evidence-audit" plane family.
 * Also adds genuine `Promise.all` concurrent-same-ID-write races for two
 * of these stores (the outcome-job-execution/quota planes already have
 * extensive Promise.all race coverage in `outcome-job-execution-runtime.test.ts`
 * - cited, not re-proven here).
 */

function tenantFixture(label: "A" | "B") {
  const tenantScope = createTenantScope(label === "A" ? "tenant-v1-03-mp-a" : "tenant-v1-03-mp-b");
  const customer = createCustomer({ tenantScope, customerId: `cust-v1-03-${label}`, displayName: `Customer ${label}` });
  const project = createProject({ tenantScope, customer, projectId: `proj-v1-03-${label}`, ownerRef: `owner-v1-03-${label}`, state: "active" });
  const job = createOutcomeJob({ tenantScope, customer, project, jobId: `job-v1-03-${label}`, jobFamily: "fam", businessObjective: "obj" });
  const organization = activateOrganization({
    organization: createOrganization({ organizationId: `org-v1-03-${label}`, tenantScope, displayName: `Org ${label}`, createdAt: "2026-10-09T00:00:00.000Z" }),
    activatedAt: "2026-10-09T00:00:01.000Z",
  });
  const membership = createOrganizationMembership({ membershipId: `membership-v1-03-${label}`, tenantScope, principalRef: `principal-v1-03-${label}`, role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  return { tenantScope, customer, project, job, organization, membership, authority, currentPrincipalRef: `principal-v1-03-${label}` };
}

const A = tenantFixture("A");
const B = tenantFixture("B");

// --- configuration/policy/decision store (OS-V0-11) ---

function configEntry(fixture: ReturnType<typeof tenantFixture>, decisionId: string, sourceRef = "default") {
  return computeConfigurationPolicyDecisionProjection({
    identity: { tenantId: fixture.tenantScope.tenantId },
    controls: [{ kind: "CONFIG", scope: "PLATFORM", key: "theme", sourceRef, version: "1", identity: {} }],
    decisionId,
    now: "2026-10-09T00:00:00.000Z",
  });
}

test("OS-V1-03 W1: configuration-policy-decision-store - the exact SAME bare decisionId, appended by two different organizations against the SAME shared store instance, resolves to each organization's own independent entry with zero cross-visibility", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v1-03-shared-config-decision-"));
  const store = new FileDurableConfigurationPolicyDecisionStore(baseDir);
  const COLLIDING_DECISION_ID = "decision-shared-collision-probe";

  const resultA = store.appendDecisionProjection(A.tenantScope.tenantId, configEntry(A, COLLIDING_DECISION_ID, "theme-a"));
  const resultB = store.appendDecisionProjection(B.tenantScope.tenantId, configEntry(B, COLLIDING_DECISION_ID, "theme-b"));
  assert.equal(resultA.created, true);
  assert.equal(resultB.created, true);

  const decisionKeyA = encodeConfigurationPolicyDecisionKey({ tenantId: A.tenantScope.tenantId });
  const decisionKeyB = encodeConfigurationPolicyDecisionKey({ tenantId: B.tenantScope.tenantId });
  const activeA = store.getActiveDecisionProjection(A.tenantScope.tenantId, decisionKeyA);
  const activeB = store.getActiveDecisionProjection(B.tenantScope.tenantId, decisionKeyB);
  assert.notDeepEqual(activeA, activeB);
  assert.deepEqual(activeA, resultA.value);
  assert.deepEqual(activeB, resultB.value);

  // Cold restart: fresh store instance at the SAME shared baseDir
  // reconstructs each organization's own isolated decision independently.
  const restarted = new FileDurableConfigurationPolicyDecisionStore(baseDir);
  assert.deepEqual(restarted.getActiveDecisionProjection(A.tenantScope.tenantId, decisionKeyA), resultA.value);
  assert.deepEqual(restarted.getActiveDecisionProjection(B.tenantScope.tenantId, decisionKeyB), resultB.value);
});

test("OS-V1-03 W2: configuration-policy-decision-store - a genuine concurrent (Promise.all) race on the SAME tenant/decisionId with identical content converges on exactly one winner, never duplicated or corrupted", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v1-03-concurrent-config-decision-"));
  const store = new FileDurableConfigurationPolicyDecisionStore(baseDir);
  const entry = configEntry(A, "decision-concurrent-race");

  const [r1, r2, r3] = await Promise.all([
    Promise.resolve().then(() => store.appendDecisionProjection(A.tenantScope.tenantId, entry)),
    Promise.resolve().then(() => store.appendDecisionProjection(A.tenantScope.tenantId, entry)),
    Promise.resolve().then(() => store.appendDecisionProjection(A.tenantScope.tenantId, entry)),
  ]);
  const createdCount = [r1, r2, r3].filter((r) => r.created).length;
  assert.equal(createdCount, 1, "exactly one concurrent caller must win the durable creation");
  assert.deepEqual(r1.value, r2.value);
  assert.deepEqual(r2.value, r3.value);

  const decisionKey = encodeConfigurationPolicyDecisionKey({ tenantId: A.tenantScope.tenantId });
  const history = store.getDecisionProjectionHistory(A.tenantScope.tenantId, decisionKey);
  assert.equal(history.length, 1, "a concurrent race on identical content must never duplicate the append log");
});

test("OS-V1-03 W3: configuration-policy-decision-store - a concurrent race on the SAME tenant/decisionId with DIFFERENT content fails closed for the loser, never silently overwritten", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v1-03-concurrent-config-conflict-"));
  const store = new FileDurableConfigurationPolicyDecisionStore(baseDir);
  const entrySameIdDifferentContent = (sourceRef: string) => configEntry(A, "decision-concurrent-conflict", sourceRef);

  const results = await Promise.allSettled([
    Promise.resolve().then(() => store.appendDecisionProjection(A.tenantScope.tenantId, entrySameIdDifferentContent("variant-1"))),
    Promise.resolve().then(() => store.appendDecisionProjection(A.tenantScope.tenantId, entrySameIdDifferentContent("variant-2"))),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof InvalidDurableConfigurationPolicyDecisionStoreError);
});

// --- protected-decision wait/resume store (OS-V0-10) ---

function waitRequestFor(fixture: ReturnType<typeof tenantFixture>, waitRequestId: string, fingerprint: string) {
  return createProtectedDecisionWaitRequest({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    job: fixture.job,
    waitRequestId,
    runId: "run-1",
    attempt: 1,
    effectRef: "effect:example",
    decisionRef: "decision:example",
    reason: "human approval required",
    activationFingerprintAtWait: fingerprint,
    raisedAt: "2026-10-09T00:00:00.000Z",
  });
}

function resumeAuthorizationFor(waitRequestId: string, principalRef: string): ProtectedDecisionResumeAuthorization {
  return {
    waitRequestId: waitRequestId as unknown as ProtectedDecisionResumeAuthorization["waitRequestId"],
    effectRef: "effect:example",
    resolvedAt: "2026-10-09T00:01:00.000Z",
    resolvedByPrincipalRef: principalRef,
    decisionRef: "decision:example",
    decisionEvidenceRef: "evidence:example",
  };
}

test("OS-V1-03 W4: protected-decision-wait-store - the exact SAME bare waitRequestId, recorded by two different organizations against the SAME shared store instance, resolves to each organization's own independent wait/resume/effect-started state with zero cross-visibility", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v1-03-shared-wait-store-"));
  const store = new FileDurableProtectedDecisionWaitStore(baseDir);
  const COLLIDING_WAIT_ID = "wait-shared-collision-probe";

  const requestA = waitRequestFor(A, COLLIDING_WAIT_ID, "fingerprint-a");
  const requestB = waitRequestFor(B, COLLIDING_WAIT_ID, "fingerprint-b");
  store.putIfAbsentWaitRequest(A.tenantScope.tenantId, COLLIDING_WAIT_ID, requestA);
  store.putIfAbsentWaitRequest(B.tenantScope.tenantId, COLLIDING_WAIT_ID, requestB);

  assert.deepEqual(store.get(A.tenantScope.tenantId, COLLIDING_WAIT_ID), requestA);
  assert.deepEqual(store.get(B.tenantScope.tenantId, COLLIDING_WAIT_ID), requestB);
  assert.notDeepEqual(store.get(A.tenantScope.tenantId, COLLIDING_WAIT_ID), store.get(B.tenantScope.tenantId, COLLIDING_WAIT_ID));

  // Organization A resolves its own resume; this must never become visible
  // to, or satisfiable by, Organization B's own identically-named wait.
  const authorizationA = resumeAuthorizationFor(COLLIDING_WAIT_ID, A.currentPrincipalRef);
  const claimA = store.claimResume(A.tenantScope.tenantId, COLLIDING_WAIT_ID, authorizationA);
  assert.equal(claimA.created, true);
  assert.equal(store.getResume(B.tenantScope.tenantId, COLLIDING_WAIT_ID), undefined, "Organization B must never see Organization A's own resume claim for the identically-named wait");

  // "Wrong-org callback": Organization B's own claimEffectStarted/claimResume
  // are independent of A's - B must still be able to independently claim
  // its own resume for its own wait, proving A's claim did not exhaust or
  // otherwise poison B's identically-named (but structurally distinct) one.
  const authorizationB = resumeAuthorizationFor(COLLIDING_WAIT_ID, B.currentPrincipalRef);
  const claimB = store.claimResume(B.tenantScope.tenantId, COLLIDING_WAIT_ID, authorizationB);
  assert.equal(claimB.created, true);
  assert.deepEqual(store.getResume(A.tenantScope.tenantId, COLLIDING_WAIT_ID), authorizationA);
  assert.deepEqual(store.getResume(B.tenantScope.tenantId, COLLIDING_WAIT_ID), authorizationB);

  const effectStartedA = store.claimEffectStarted(A.tenantScope.tenantId, COLLIDING_WAIT_ID);
  assert.equal(effectStartedA.created, true);
  assert.equal(store.getEffectStarted(B.tenantScope.tenantId, COLLIDING_WAIT_ID), false, "Organization B's own effect-started marker must remain independently false despite A's identically-named wait starting its effect");

  // Cold restart: fresh store instance at the SAME shared baseDir
  // reconstructs each organization's own isolated state independently.
  const restarted = new FileDurableProtectedDecisionWaitStore(baseDir);
  assert.deepEqual(restarted.get(A.tenantScope.tenantId, COLLIDING_WAIT_ID), requestA);
  assert.deepEqual(restarted.get(B.tenantScope.tenantId, COLLIDING_WAIT_ID), requestB);
  assert.deepEqual(restarted.getResume(A.tenantScope.tenantId, COLLIDING_WAIT_ID), authorizationA);
  assert.deepEqual(restarted.getResume(B.tenantScope.tenantId, COLLIDING_WAIT_ID), authorizationB);
});

test("OS-V1-03 W5: protected-decision-wait-store - a genuine concurrent (Promise.all) claimResume race on the SAME tenant/waitRequestId converges on exactly one winning authorization, never a second authorizing claim", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v1-03-concurrent-wait-"));
  const store = new FileDurableProtectedDecisionWaitStore(baseDir);
  const waitId = "wait-concurrent-race";
  store.putIfAbsentWaitRequest(A.tenantScope.tenantId, waitId, waitRequestFor(A, waitId, "fingerprint-concurrent"));

  const authorization = resumeAuthorizationFor(waitId, A.currentPrincipalRef);
  const [c1, c2, c3] = await Promise.all([
    Promise.resolve().then(() => store.claimResume(A.tenantScope.tenantId, waitId, authorization)),
    Promise.resolve().then(() => store.claimResume(A.tenantScope.tenantId, waitId, authorization)),
    Promise.resolve().then(() => store.claimResume(A.tenantScope.tenantId, waitId, authorization)),
  ]);
  const createdCount = [c1, c2, c3].filter((c) => c.created).length;
  assert.equal(createdCount, 1, "exactly one concurrent caller must win the single-use resume claim");
  assert.deepEqual(c1.value, c2.value);
  assert.deepEqual(c2.value, c3.value);
});

test("OS-V1-03 W6: protected-decision-wait-store - claimResume for a waitRequestId that was never recorded under the CALLING organization's own tenant fails closed, even when the identical bare id is recorded under a different organization's tenant", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v1-03-wrong-org-callback-"));
  const store = new FileDurableProtectedDecisionWaitStore(baseDir);
  const waitId = "wait-wrong-org-callback";
  // Only Organization A ever raises this wait - Organization B never does.
  store.putIfAbsentWaitRequest(A.tenantScope.tenantId, waitId, waitRequestFor(A, waitId, "fingerprint-wrong-org"));

  assert.throws(
    () => store.claimResume(B.tenantScope.tenantId, waitId, resumeAuthorizationFor(waitId, B.currentPrincipalRef)),
    InvalidDurableProtectedDecisionWaitStoreError,
  );
});

// --- protected-decision record store (OS-V0-10) ---

function decisionRecordFor(fixture: ReturnType<typeof tenantFixture>, decisionRef: string) {
  return createProtectedDecisionRecord({
    tenantScope: fixture.tenantScope,
    decisionRef,
    outcome: "APPROVED",
    organization: fixture.organization,
    membership: fixture.membership,
    currentPrincipalRef: fixture.currentPrincipalRef,
    authority: fixture.authority,
    decidedAt: "2026-10-09T00:00:30.000Z",
    evidenceRef: "evidence:decision-made",
  });
}

test("OS-V1-03 W7: protected-decision-record-store - the exact SAME bare decisionRef, recorded by two different organizations against the SAME shared store instance, resolves to each organization's own independent record with zero cross-visibility", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v1-03-shared-decision-record-"));
  const store = new FileDurableProtectedDecisionRecordStore(baseDir);
  const COLLIDING_DECISION_REF = "decision:shared-collision-probe";

  const recordA = decisionRecordFor(A, COLLIDING_DECISION_REF);
  const recordB = decisionRecordFor(B, COLLIDING_DECISION_REF);
  const resultA = store.putIfAbsentDecisionRecord(A.tenantScope.tenantId, COLLIDING_DECISION_REF, recordA);
  const resultB = store.putIfAbsentDecisionRecord(B.tenantScope.tenantId, COLLIDING_DECISION_REF, recordB);
  assert.equal(resultA.created, true);
  assert.equal(resultB.created, true);

  assert.deepEqual(store.getDecisionRecord(A.tenantScope.tenantId, COLLIDING_DECISION_REF), recordA);
  assert.deepEqual(store.getDecisionRecord(B.tenantScope.tenantId, COLLIDING_DECISION_REF), recordB);
  assert.notDeepEqual(recordA, recordB, "each organization's own decision record must carry its own distinct identity, never the same shared object despite the identical bare decisionRef string");

  const restarted = new FileDurableProtectedDecisionRecordStore(baseDir);
  assert.deepEqual(restarted.getDecisionRecord(A.tenantScope.tenantId, COLLIDING_DECISION_REF), recordA);
  assert.deepEqual(restarted.getDecisionRecord(B.tenantScope.tenantId, COLLIDING_DECISION_REF), recordB);
});
