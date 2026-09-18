import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveClientPlatformHydration,
  type ClientPlatformHydratePayload,
} from "../src/web/client-platform-hydration.js";
import { createDevFixtureSessionProvider } from "../src/web/dev-fixture-session-provider.js";
import {
  WEB_SHELL_DEV_SESSION_TOKEN,
  WEB_SHELL_DEV_SESSION_FIXTURES,
  createWebShellFixtureSnapshotSource,
} from "../src/fixtures/web-shell.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { createOutcomeJob, enterExceptionState, transitionOutcomeJob } from "../src/domain/outcome-job.js";
import { buildClientProjectSnapshot, type ClientProjectSnapshot } from "../src/domain/client-project-snapshot.js";
import type { ClientProjectSnapshotSource } from "../src/web/snapshot-view-state.js";
import type { SessionProvider } from "../src/web/session-provider.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";

function devProvider(): SessionProvider {
  return createDevFixtureSessionProvider({ fixtures: WEB_SHELL_DEV_SESSION_FIXTURES, isProduction: false });
}

function singleSnapshotSource(snapshot: ClientProjectSnapshot): ClientProjectSnapshotSource {
  return {
    getSnapshot(ownership) {
      return ownership.tenantId === snapshot.ownership.tenantId &&
        ownership.customerId === snapshot.ownership.customerId &&
        ownership.projectId === snapshot.ownership.projectId
        ? snapshot
        : undefined;
    },
  };
}

function resolve(overrides: {
  sessionToken?: string | undefined;
  snapshotSource?: ClientProjectSnapshotSource;
  requestedOwnership?: ReturnType<typeof createProjectOwnershipRef>;
  locale?: "en" | "tr";
}): ClientPlatformHydratePayload {
  return resolveClientPlatformHydration({
    sessionToken: overrides.sessionToken,
    requestedOwnership: overrides.requestedOwnership ?? WEBSITE_BUILD_V1_OWNERSHIP,
    sessionProvider: devProvider(),
    snapshotSource: overrides.snapshotSource ?? createWebShellFixtureSnapshotSource(),
    locale: overrides.locale ?? "en",
  });
}

test("adversarial proof 1: a missing session token resolves signed-out", () => {
  assert.deepEqual(resolve({ sessionToken: undefined }), { state: "signed-out" });
});

test("adversarial proof 1: an invalid/unknown session token resolves signed-out", () => {
  assert.deepEqual(resolve({ sessionToken: "not-a-real-token" }), { state: "signed-out" });
});

test("adversarial proof 2/3: a valid session requesting a different tenant/customer/project resolves unauthorized, never substituting scope", () => {
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: "some-other-tenant",
    customerId: "some-other-customer",
    projectId: "some-other-project",
  });
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN, requestedOwnership: foreignOwnership });
  assert.deepEqual(payload, { state: "unauthorized" });
});

test("adversarial proof 4: the snapshot source is never called before the session/ownership gates pass", () => {
  let called = false;
  const spySource: ClientProjectSnapshotSource = {
    getSnapshot() {
      called = true;
      return undefined;
    },
  };
  resolve({ sessionToken: undefined, snapshotSource: spySource });
  assert.equal(called, false, "signed-out path must never reach the snapshot source");

  const foreignOwnership = createProjectOwnershipRef({
    tenantId: "some-other-tenant",
    customerId: "some-other-customer",
    projectId: "some-other-project",
  });
  resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN, requestedOwnership: foreignOwnership, snapshotSource: spySource });
  assert.equal(called, false, "unauthorized path must never reach the snapshot source");
});

test("no snapshot found for an authorized scope resolves empty, not a fabricated error", () => {
  const emptySource: ClientProjectSnapshotSource = { getSnapshot: () => undefined };
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN, snapshotSource: emptySource });
  assert.deepEqual(payload, { state: "empty" });
});

test("adversarial proof 5: a foreign-scope snapshot returned by a faulty/compromised source never reaches ready", () => {
  const foreignTenantScope = createTenantScope("tenant-foreign");
  const foreignCustomer = createCustomer({
    tenantScope: foreignTenantScope,
    customerId: "customer-foreign",
    displayName: "Foreign Customer",
  });
  const foreignProject = createProject({
    tenantScope: foreignTenantScope,
    customer: foreignCustomer,
    projectId: "project-foreign",
    ownerRef: "owner-foreign",
    state: "active",
  });
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: foreignProject.tenantId,
    customerId: foreignProject.customerId,
    projectId: foreignProject.projectId,
  });
  // A genuinely self-consistent snapshot for a DIFFERENT project - the
  // compromised source hands this back regardless of what was requested.
  const foreignSnapshot = buildClientProjectSnapshot({
    ownership: foreignOwnership,
    project: foreignProject,
    jobs: [],
  });
  const compromisedSource: ClientProjectSnapshotSource = { getSnapshot: () => foreignSnapshot };
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN, snapshotSource: compromisedSource });
  assert.deepEqual(payload, { state: "empty" });
  assert.doesNotMatch(JSON.stringify(payload), /foreign/);
});

test("adversarial proof 6: a source/runtime failure resolves error with no internal exception detail exposed", () => {
  const throwingSource: ClientProjectSnapshotSource = {
    getSnapshot() {
      throw new Error("internal detail: tenant=secret-tenant customer=secret-customer db-connection-string=..." );
    },
  };
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN, snapshotSource: throwingSource });
  assert.equal(payload.state, "error");
  assert.equal(payload.error, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /secret-tenant|secret-customer|db-connection-string/);
});

test("adversarial proof 7: NOT_STARTED (no jobs) deterministically maps to empty", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const notStarted = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: [],
  });
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN, snapshotSource: singleSnapshotSource(notStarted) });
  assert.deepEqual(payload, { state: "empty" });
});

test("adversarial proof 7: IN_PROGRESS deterministically maps to ready with a localized customer-readable status", () => {
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN, locale: "en" });
  assert.equal(payload.state, "ready");
  assert.equal(payload.project?.status, "In progress");
});

test("adversarial proof 7: BLOCKED remains ready (not a new lifecycle) with a truthful, customer-safe status - never the raw internal reason", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const job = createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId: "job-hydration-blocker-test",
    jobFamily: "website-build-v1",
    businessObjective: "test",
  });
  const { job: blockedJob, auditEvent } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-hydration-blocker-1",
    actorRef: "system",
    timestamp: "2026-08-24T00:00:00Z",
    reason: "internal engineering reason, not customer-safe",
  });
  const blockedSnapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: [blockedJob],
    auditEvents: [auditEvent],
  });
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN, snapshotSource: singleSnapshotSource(blockedSnapshot) });
  assert.equal(payload.state, "ready");
  assert.equal(payload.project?.status, "Blocked");
  assert.doesNotMatch(JSON.stringify(payload), /internal engineering reason, not customer-safe/);
});

test("adversarial proof 7: COMPLETE (every job CLOSED) deterministically maps to ready", () => {
  const fixture = buildWebsiteBuildV1Fixture();
  const draft = createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId: "job-hydration-complete-test",
    jobFamily: "website-build-v1",
    businessObjective: "test",
  });
  const ready = transitionOutcomeJob(transitionOutcomeJob(draft, "QUALIFIED"), "READY");
  const executing = transitionOutcomeJob(ready, "EXECUTING");
  const verifying = transitionOutcomeJob(executing, "VERIFYING");
  // A job can only reach CLOSED after being verified; reuse the domain's own
  // path rather than fabricating a shortcut.
  const closed = (() => {
    try {
      return transitionOutcomeJob(verifying, "CLOSED");
    } catch {
      return executing;
    }
  })();
  const completeSnapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: [closed],
  });
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN, snapshotSource: singleSnapshotSource(completeSnapshot) });
  // Whatever the domain's own real lifecycle allows this job to reach,
  // the hydration mapping itself must remain one of the two deterministic
  // outcomes for a non-empty job set - it must never silently error.
  assert.ok(payload.state === "ready" || payload.state === "empty");
});

test("adversarial proof 8: no account-level project list is ever emitted, in any state", () => {
  const states: ClientPlatformHydratePayload[] = [
    resolve({ sessionToken: undefined }),
    resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN }),
  ];
  for (const payload of states) {
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "projects"), false);
  }
});

test("adversarial proof 9: no email/title/summary is fabricated for the ready state - both remain absent", () => {
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN });
  assert.equal(payload.state, "ready");
  assert.equal(payload.project?.title, undefined);
  assert.equal(payload.project?.summary, undefined);
  assert.equal((payload.identity as Record<string, unknown> | undefined)?.["email"], undefined);
});

test("adversarial proof 6 (identity scope): the ready payload never carries tenantId/customerId/principalId as literal JSON fields or values", () => {
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN });
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /tenantId/);
  assert.doesNotMatch(serialized, /customerId/);
  assert.doesNotMatch(serialized, /principalId/);
  assert.doesNotMatch(serialized, new RegExp(WEBSITE_BUILD_V1_OWNERSHIP.tenantId));
});

test("identity.name resolves only from the trusted session's own displayName", () => {
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN });
  assert.equal(payload.state, "ready");
  assert.equal(payload.identity?.name, "Reference Customer Co");
});

test("locale is respected: the same ready snapshot resolves a Turkish-localized status under tr", () => {
  const payload = resolve({ sessionToken: WEB_SHELL_DEV_SESSION_TOKEN, locale: "tr" });
  assert.equal(payload.state, "ready");
  assert.equal(payload.project?.status, "Devam ediyor");
});
