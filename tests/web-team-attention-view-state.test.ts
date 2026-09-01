import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProtectedTeamAttentionView, type TeamAttentionSource } from "../src/web/team-attention-view-state.js";
import { createAuthenticatedPrincipal, createSessionContext } from "../src/web/session-context.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import { WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION } from "../src/fixtures/website-build-v1-team-attention.js";

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

function fixtureSource(): TeamAttentionSource & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    getTeamAttentionProjection(ownership) {
      callCount += 1;
      if (
        ownership.tenantId === WEBSITE_BUILD_V1_OWNERSHIP.tenantId &&
        ownership.customerId === WEBSITE_BUILD_V1_OWNERSHIP.customerId &&
        ownership.projectId === WEBSITE_BUILD_V1_OWNERSHIP.projectId
      ) {
        return WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION;
      }
      return undefined;
    },
  };
}

test("a matching, authenticated request resolves READY with the exact underlying TeamAttentionProjection", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const source = fixtureSource();
  const view = resolveProtectedTeamAttentionView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source,
  });
  assert.equal(view.kind, "READY");
  if (view.kind === "READY") {
    assert.equal(view.projection, WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION);
  }
});

test("a tenant/project mismatch resolves FORBIDDEN_TENANT_SCOPE WITHOUT ever calling the source (fail-closed isolation)", () => {
  const session = sessionForOwnership({
    tenantId: "some-other-tenant",
    customerId: "some-other-customer",
    projectId: "some-other-project",
  });
  const source = fixtureSource();
  const view = resolveProtectedTeamAttentionView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source,
  });
  assert.equal(view.kind, "FORBIDDEN_TENANT_SCOPE");
  assert.equal(source.callCount, 0, "the source must not be queried when tenant scope fails");
});

test("no source wired at all (port not yet used by a caller) resolves UNAVAILABLE, not an error or fabricated projection", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const view = resolveProtectedTeamAttentionView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: undefined,
  });
  assert.equal(view.kind, "UNAVAILABLE");
});

test("a source returning undefined resolves UNAVAILABLE, not NOT_FOUND or a fabricated projection", () => {
  const session = sessionForOwnership({
    tenantId: "tenant-with-no-projection",
    customerId: "cust-with-no-projection",
    projectId: "proj-with-no-projection",
  });
  const requestedOwnership = createProjectOwnershipRef({
    tenantId: "tenant-with-no-projection",
    customerId: "cust-with-no-projection",
    projectId: "proj-with-no-projection",
  });
  const source = fixtureSource();
  const view = resolveProtectedTeamAttentionView({ session, requestedOwnership, source });
  assert.equal(view.kind, "UNAVAILABLE");
  assert.equal(source.callCount, 1);
});

test("a source that throws resolves UNAVAILABLE, not an unhandled exception", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const throwingSource: TeamAttentionSource = {
    getTeamAttentionProjection() {
      throw new Error("simulated team-attention source failure");
    },
  };
  const view = resolveProtectedTeamAttentionView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: throwingSource,
  });
  assert.equal(view.kind, "UNAVAILABLE");
});
