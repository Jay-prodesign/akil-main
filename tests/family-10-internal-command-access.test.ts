import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requireInternalCommandAccess,
  resolveInternalCommandCenterView,
} from "../src/web/internal-command-access.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { createProductionStaffSessionProvider } from "../src/web/production-staff-session-provider.js";
import { StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import { NoStaffMembershipError } from "../src/web/staff-membership-guard.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
import type { OperationsAttentionItem } from "../src/domain/operations-attention.js";
import { createPartnerCapabilityClaim, type PartnerCapabilityClaim } from "../src/domain/partner-capability-admission.js";
import { createPartnerOrganization } from "../src/domain/partner-organization.js";

const tenantScope = createTenantScope("tenant-a");
const otherTenantScope = createTenantScope("tenant-b");

function staffSession(principalId = "staff-1"): StaffSessionContext {
  return {
    principal: createAuthenticatedStaffPrincipal({ principalId, displayName: "Ada Staffer" }),
    issuedAt: "2026-01-01T00:00:00.000Z",
  };
}

function membership(overrides: Partial<Parameters<typeof createOrganizationMembership>[0]> = {}): OrganizationMembership {
  return createOrganizationMembership({
    membershipId: "membership-1",
    tenantScope,
    principalRef: "staff-1",
    role: "STAFF",
    ...overrides,
  });
}

function attentionItem(overrides: Partial<OperationsAttentionItem> = {}): OperationsAttentionItem {
  return {
    sourceDomain: "DELIVERY_OUTCOME_JOB",
    tenantId: tenantScope.tenantId,
    customerId: "customer-1" as OperationsAttentionItem["customerId"],
    projectId: "project-1" as OperationsAttentionItem["projectId"],
    jobId: "job-1" as OperationsAttentionItem["jobId"],
    isActive: true,
    internalAttentionLevel: "NORMAL",
    evidenceFreshness: "CURRENT",
    ...overrides,
  };
}

function partnerClaim(): PartnerCapabilityClaim {
  const partnerOrganization = createPartnerOrganization({
    partnerOrganizationId: "partner-1",
    tenantScope,
    relationshipType: "AGENCY",
  });
  return createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-1",
    partnerOrganization,
    capabilityRef: "cap:x",
  });
}

// --- requireInternalCommandAccess ---

test("F10-1: requireInternalCommandAccess returns the session+membership pair for a valid session bound to a real membership", () => {
  const session = staffSession();
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([["token-1", session]]),
    isProduction: false,
  });
  const access = requireInternalCommandAccess({
    provider,
    sessionToken: "token-1",
    tenantScope,
    memberships: [membership()],
  });
  assert.equal(access.session, session);
  assert.equal(access.membership.membershipId, "membership-1");
});

test("F10-2 (adversarial): requireInternalCommandAccess throws StaffUnauthenticatedError for an undefined token - never reaches the membership check", () => {
  const provider = createDevFixtureStaffSessionProvider({ fixtures: new Map(), isProduction: false });
  assert.throws(
    () =>
      requireInternalCommandAccess({
        provider,
        sessionToken: undefined,
        tenantScope,
        memberships: [membership()],
      }),
    StaffUnauthenticatedError,
  );
});

test("F10-3 (adversarial): requireInternalCommandAccess throws StaffUnauthenticatedError against the production provider regardless of token - no real IdP admitted", () => {
  const provider = createProductionStaffSessionProvider();
  assert.throws(
    () =>
      requireInternalCommandAccess({
        provider,
        sessionToken: "any-token",
        tenantScope,
        memberships: [membership()],
      }),
    StaffUnauthenticatedError,
  );
});

test("F10-4 (adversarial): requireInternalCommandAccess throws NoStaffMembershipError when authenticated but unbound - a valid session alone is never sufficient", () => {
  const session = staffSession("staff-unknown");
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([["token-1", session]]),
    isProduction: false,
  });
  assert.throws(
    () =>
      requireInternalCommandAccess({
        provider,
        sessionToken: "token-1",
        tenantScope,
        memberships: [membership()],
      }),
    NoStaffMembershipError,
  );
});

// --- resolveInternalCommandCenterView ---

test("F10-5: resolveInternalCommandCenterView delegates to buildInternalCommandCenterProjection unmodified once access is granted", () => {
  const session = staffSession();
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([["token-1", session]]),
    isProduction: false,
  });
  const view = resolveInternalCommandCenterView({
    provider,
    sessionToken: "token-1",
    tenantScope,
    memberships: [membership()],
    attentionItems: [],
    partnerClaims: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
    asOf: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(view.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(view.companyPortfolioAttention.items, []);
  assert.deepEqual(view.partners.items, []);
  assert.equal(view.companyPortfolioAttention.activeCount, 0);
});

test("F10-6 (adversarial): resolveInternalCommandCenterView never reaches the projection when the session is unauthenticated - fails before any data is aggregated", () => {
  const provider = createProductionStaffSessionProvider();
  assert.throws(
    () =>
      resolveInternalCommandCenterView({
        provider,
        sessionToken: "any-token",
        tenantScope,
        memberships: [membership()],
        attentionItems: [],
        partnerClaims: [],
        generatedAt: "2026-01-01T00:00:00.000Z",
        asOf: "2026-01-01T00:00:00.000Z",
      }),
    StaffUnauthenticatedError,
  );
});

test("F10-7 (adversarial): resolveInternalCommandCenterView never reaches the projection when the authenticated staff member has no membership in this tenant", () => {
  const session = staffSession("staff-unknown");
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([["token-1", session]]),
    isProduction: false,
  });
  assert.throws(
    () =>
      resolveInternalCommandCenterView({
        provider,
        sessionToken: "token-1",
        tenantScope,
        memberships: [membership()],
        attentionItems: [],
        partnerClaims: [],
        generatedAt: "2026-01-01T00:00:00.000Z",
        asOf: "2026-01-01T00:00:00.000Z",
      }),
    NoStaffMembershipError,
  );
});

// --- Rev106 correction (F1 - authentication is not authorization / cross-tenant read) ---

test("F10-8 (Rev106 adversarial): resolveInternalCommandCenterView never exposes another tenant's attention items - membership in tenant A never authorizes company-wide visibility", () => {
  const session = staffSession();
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([["token-1", session]]),
    isProduction: false,
  });
  const view = resolveInternalCommandCenterView({
    provider,
    sessionToken: "token-1",
    tenantScope,
    memberships: [membership()],
    attentionItems: [
      attentionItem({ tenantId: tenantScope.tenantId, jobId: "job-own-tenant" as OperationsAttentionItem["jobId"] }),
      attentionItem({
        tenantId: otherTenantScope.tenantId,
        jobId: "job-other-tenant" as OperationsAttentionItem["jobId"],
      }),
    ],
    partnerClaims: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
    asOf: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(view.companyPortfolioAttention.items.length, 1);
  assert.equal(view.companyPortfolioAttention.items[0]?.jobId, "job-own-tenant");
});

test("F10-9 (Rev106 adversarial): resolveInternalCommandCenterView never exposes partner data through a tenant-membership-only gate - no canonical authority policy honestly authorizes it yet", () => {
  const session = staffSession();
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([["token-1", session]]),
    isProduction: false,
  });
  const view = resolveInternalCommandCenterView({
    provider,
    sessionToken: "token-1",
    tenantScope,
    memberships: [membership()],
    attentionItems: [],
    partnerClaims: [partnerClaim()],
    generatedAt: "2026-01-01T00:00:00.000Z",
    asOf: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(view.partners.items, []);
});
