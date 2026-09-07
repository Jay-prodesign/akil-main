import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProtectedSnapshotView, type ClientProjectSnapshotSource } from "../src/web/snapshot-view-state.js";
import { createAuthenticatedPrincipal, createSessionContext } from "../src/web/session-context.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT } from "../src/fixtures/website-build-v1-snapshot.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";

function sessionForOwnership(ownership: { tenantId: string; customerId: string; projectId?: string }) {
  return createSessionContext({
    principal: createAuthenticatedPrincipal({
      principalId: "principal-1",
      tenantId: ownership.tenantId,
      customerId: ownership.customerId,
      displayName: "Test User",
    }),
    ...(ownership.projectId !== undefined ? { projectId: ownership.projectId } : {}),
    issuedAt: "2026-08-26T00:00:00Z",
  });
}

function fixtureSource(): ClientProjectSnapshotSource & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    getSnapshot(ownership) {
      callCount += 1;
      if (
        ownership.tenantId === WEBSITE_BUILD_V1_OWNERSHIP.tenantId &&
        ownership.customerId === WEBSITE_BUILD_V1_OWNERSHIP.customerId &&
        ownership.projectId === WEBSITE_BUILD_V1_OWNERSHIP.projectId
      ) {
        return WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT;
      }
      return undefined;
    },
  };
}

test("A9: a matching, authenticated request resolves READY with the exact underlying ClientProjectSnapshot - never a re-derived/modified copy", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const source = fixtureSource();
  const view = resolveProtectedSnapshotView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source,
  });
  assert.equal(view.kind, "READY");
  if (view.kind === "READY") {
    assert.equal(view.snapshot, WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT);
  }
});

test("A10: a tenant/project mismatch resolves FORBIDDEN_TENANT_SCOPE WITHOUT ever calling the snapshot source", () => {
  const session = sessionForOwnership({ tenantId: "some-other-tenant", customerId: "some-other-customer", projectId: "some-other-project" });
  const source = fixtureSource();
  const view = resolveProtectedSnapshotView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source,
  });
  assert.equal(view.kind, "FORBIDDEN_TENANT_SCOPE");
  assert.equal(source.callCount, 0, "the snapshot source must not be queried when tenant scope fails");
});

test("A9: a source returning undefined (no snapshot exists yet) resolves NOT_FOUND, not an error or fabricated snapshot", () => {
  const session = sessionForOwnership({
    tenantId: "tenant-with-no-snapshot",
    customerId: "cust-with-no-snapshot",
    projectId: "proj-with-no-snapshot",
  });
  const requestedOwnership = createProjectOwnershipRef({
    tenantId: "tenant-with-no-snapshot",
    customerId: "cust-with-no-snapshot",
    projectId: "proj-with-no-snapshot",
  });
  const source = fixtureSource();
  const view = resolveProtectedSnapshotView({ session, requestedOwnership, source });
  assert.equal(view.kind, "NOT_FOUND");
  assert.equal(source.callCount, 1);
});

test("Rev62 AUD-V2-02: a source returning a foreign-scope snapshot resolves NOT_FOUND, never READY with leaked foreign data", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const foreignScopedSource: ClientProjectSnapshotSource = {
    getSnapshot() {
      // Deliberately returns a snapshot scoped to a different project than
      // the one requested/authorized - simulates a faulty/compromised
      // source responding with foreign-tenant data despite the session's
      // own tenant/project check having already passed.
      return {
        ...WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT,
        ownership: createProjectOwnershipRef({
          tenantId: WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT.ownership.tenantId,
          customerId: WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT.ownership.customerId,
          projectId: "some-foreign-project",
        }),
      };
    },
  };
  const view = resolveProtectedSnapshotView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: foreignScopedSource,
  });
  assert.equal(view.kind, "NOT_FOUND");
});

test("A9: a source that throws resolves ERROR with a bounded reason, not an unhandled exception", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const throwingSource: ClientProjectSnapshotSource = {
    getSnapshot() {
      throw new Error("simulated snapshot source failure");
    },
  };
  const view = resolveProtectedSnapshotView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: throwingSource,
  });
  assert.equal(view.kind, "ERROR");
  if (view.kind === "ERROR") {
    assert.equal(view.reason, "simulated snapshot source failure");
  }
});
