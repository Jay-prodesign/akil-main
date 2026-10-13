import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveProtectedBillingReferenceStatusView,
  type BillingReferenceStatusSource,
} from "../src/web/billing-reference-view-state.js";
import { createAuthenticatedPrincipal, createSessionContext } from "../src/web/session-context.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import type { BillingReferenceRecord } from "../src/domain/billing-reference.js";

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

const FIXTURE_RECORD: BillingReferenceRecord = {
  tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
  customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
  subscriptionId: "sub-fixture" as BillingReferenceRecord["subscriptionId"],
  externalInvoiceRef: "inv-fixture",
  status: "ISSUED",
  recordedAt: "2026-10-13T00:00:00.000Z",
  evidenceRef: "internal://tests/web-billing-reference-view-state/fixture",
};

function fixtureSource(): BillingReferenceStatusSource & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    getBillingReferenceStatus(ownership) {
      callCount += 1;
      if (ownership.tenantId === FIXTURE_RECORD.tenantId && ownership.customerId === FIXTURE_RECORD.customerId) {
        return FIXTURE_RECORD;
      }
      return undefined;
    },
  };
}

test("a matching, authenticated request resolves READY with the exact underlying BillingReferenceRecord", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const source = fixtureSource();
  const view = resolveProtectedBillingReferenceStatusView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source,
  });
  assert.equal(view.kind, "READY");
  if (view.kind === "READY") {
    assert.equal(view.record, FIXTURE_RECORD);
  }
});

test("a tenant/customer mismatch resolves FORBIDDEN_TENANT_SCOPE WITHOUT ever calling the source (fail-closed isolation)", () => {
  const session = sessionForOwnership({ tenantId: "some-other-tenant", customerId: "some-other-customer", projectId: "some-other-project" });
  const source = fixtureSource();
  const view = resolveProtectedBillingReferenceStatusView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source,
  });
  assert.equal(view.kind, "FORBIDDEN_TENANT_SCOPE");
  assert.equal(source.callCount, 0, "the source must not be queried when tenant scope fails");
});

test("no source wired at all (port not yet used by a caller) resolves UNAVAILABLE, not an error or fabricated record", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const view = resolveProtectedBillingReferenceStatusView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: undefined,
  });
  assert.equal(view.kind, "UNAVAILABLE");
});

test("a source returning undefined resolves UNAVAILABLE, not a fabricated record", () => {
  const requestedOwnership = createProjectOwnershipRef({
    tenantId: "tenant-with-no-billing-ref",
    customerId: "cust-with-no-billing-ref",
    projectId: "proj-with-no-billing-ref",
  });
  const session = sessionForOwnership(requestedOwnership);
  const source = fixtureSource();
  const view = resolveProtectedBillingReferenceStatusView({ session, requestedOwnership, source });
  assert.equal(view.kind, "UNAVAILABLE");
  assert.equal(source.callCount, 1);
});

test("a source that throws resolves UNAVAILABLE, not an unhandled exception", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const throwingSource: BillingReferenceStatusSource = {
    getBillingReferenceStatus() {
      throw new Error("simulated billing-reference source failure");
    },
  };
  const view = resolveProtectedBillingReferenceStatusView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: throwingSource,
  });
  assert.equal(view.kind, "UNAVAILABLE");
});

test("adversarial: a source returning a record for a different tenant than requested resolves UNAVAILABLE, not READY with foreign-scope data", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const foreignTenantSource: BillingReferenceStatusSource = {
    getBillingReferenceStatus() {
      return { ...FIXTURE_RECORD, tenantId: "tenant-unrelated-other" as typeof FIXTURE_RECORD.tenantId };
    },
  };
  const view = resolveProtectedBillingReferenceStatusView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: foreignTenantSource,
  });
  assert.equal(view.kind, "UNAVAILABLE");
});

test("adversarial: a source returning a record for a different customer than requested resolves UNAVAILABLE, not READY with foreign-scope data", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const foreignCustomerSource: BillingReferenceStatusSource = {
    getBillingReferenceStatus() {
      return { ...FIXTURE_RECORD, customerId: "cust-unrelated-other" as typeof FIXTURE_RECORD.customerId };
    },
  };
  const view = resolveProtectedBillingReferenceStatusView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source: foreignCustomerSource,
  });
  assert.equal(view.kind, "UNAVAILABLE");
});

test("a source returning the exact matching scope still resolves READY (the scope check narrows nothing for honest sources)", () => {
  const session = sessionForOwnership(WEBSITE_BUILD_V1_OWNERSHIP);
  const source = fixtureSource();
  const view = resolveProtectedBillingReferenceStatusView({
    session,
    requestedOwnership: WEBSITE_BUILD_V1_OWNERSHIP,
    source,
  });
  assert.equal(view.kind, "READY");
});
