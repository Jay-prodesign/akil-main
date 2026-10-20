import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveProtectedCustomerLifecycleReadinessView,
  type CustomerLifecycleReadinessSource,
} from "../src/web/customer-lifecycle-readiness-view-state.js";
import { createAuthenticatedPrincipal, createSessionContext } from "../src/web/session-context.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import type { CustomerLifecycleReadinessProjection } from "../src/domain/customer-lifecycle-readiness.js";

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

const FIXTURE_PROJECTION: CustomerLifecycleReadinessProjection = {
  tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
  customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
  offboardingStatus: "NOT_REQUESTED",
  backupReadiness: "AVAILABLE",
};

function fixtureSource(): CustomerLifecycleReadinessSource & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    getLifecycleReadiness(ownership) {
      callCount += 1;
      if (ownership.tenantId === FIXTURE_PROJECTION.tenantId && ownership.customerId === FIXTURE_PROJECTION.customerId) {
        return FIXTURE_PROJECTION;
      }
      return undefined;
    },
  };
}

test("a matching, authenticated request resolves READY with the exact underlying CustomerLifecycleReadinessProjection", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const source = fixtureSource();
  const view = resolveProtectedCustomerLifecycleReadinessView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source,
  });
  assert.equal(view.kind, "READY");
  if (view.kind === "READY") {
    assert.equal(view.projection, FIXTURE_PROJECTION);
  }
});

test("a tenant/customer mismatch resolves FORBIDDEN_TENANT_SCOPE WITHOUT ever calling the source (fail-closed isolation)", () => {
  const session = sessionForOwnership({ tenantId: "some-other-tenant", customerId: "some-other-customer", projectId: "some-other-project" });
  const source = fixtureSource();
  const view = resolveProtectedCustomerLifecycleReadinessView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source,
  });
  assert.equal(view.kind, "FORBIDDEN_TENANT_SCOPE");
  assert.equal(source.callCount, 0, "the source must not be queried when tenant scope fails");
});

test("no source wired at all (port not yet used by a caller) resolves UNAVAILABLE, not an error or fabricated projection", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const view = resolveProtectedCustomerLifecycleReadinessView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: undefined,
  });
  assert.equal(view.kind, "UNAVAILABLE");
});

test("a source returning undefined resolves UNAVAILABLE, not a fabricated projection", () => {
  const requestedOwnership = createProjectOwnershipRef({
    tenantId: "tenant-with-no-readiness",
    customerId: "cust-with-no-readiness",
    projectId: "proj-with-no-readiness",
  });
  const session = sessionForOwnership(requestedOwnership);
  const source = fixtureSource();
  const view = resolveProtectedCustomerLifecycleReadinessView({ session, requestedOwnership, source });
  assert.equal(view.kind, "UNAVAILABLE");
  assert.equal(source.callCount, 1);
});

test("a source that throws resolves UNAVAILABLE, not an unhandled exception", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const throwingSource: CustomerLifecycleReadinessSource = {
    getLifecycleReadiness() {
      throw new Error("simulated lifecycle-readiness source failure");
    },
  };
  const view = resolveProtectedCustomerLifecycleReadinessView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: throwingSource,
  });
  assert.equal(view.kind, "UNAVAILABLE");
});

test("adversarial: a source returning a projection for a different tenant than requested resolves UNAVAILABLE, not READY with foreign-scope data", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const foreignTenantSource: CustomerLifecycleReadinessSource = {
    getLifecycleReadiness() {
      return { ...FIXTURE_PROJECTION, tenantId: "tenant-unrelated-other" as typeof FIXTURE_PROJECTION.tenantId };
    },
  };
  const view = resolveProtectedCustomerLifecycleReadinessView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: foreignTenantSource,
  });
  assert.equal(view.kind, "UNAVAILABLE");
});

test("adversarial: a source returning a projection for a different customer than requested resolves UNAVAILABLE, not READY with foreign-scope data", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const foreignCustomerSource: CustomerLifecycleReadinessSource = {
    getLifecycleReadiness() {
      return { ...FIXTURE_PROJECTION, customerId: "cust-unrelated-other" as typeof FIXTURE_PROJECTION.customerId };
    },
  };
  const view = resolveProtectedCustomerLifecycleReadinessView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: foreignCustomerSource,
  });
  assert.equal(view.kind, "UNAVAILABLE");
});

test("a source returning the exact matching scope still resolves READY (the scope check narrows nothing for honest sources)", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const source = fixtureSource();
  const view = resolveProtectedCustomerLifecycleReadinessView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source,
  });
  assert.equal(view.kind, "READY");
});
