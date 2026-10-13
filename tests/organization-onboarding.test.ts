import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  submitOrganizationOnboardingRequest,
  admitOrganizationOnboardingRequest,
  rejectOrganizationOnboardingRequest,
  InvalidOrganizationOnboardingError,
  OrganizationOnboardingAdmissionError,
  type OrganizationOnboardingRequest,
} from "../src/domain/organization-onboarding.js";

function freshRequest(overrides: Partial<Parameters<typeof submitOrganizationOnboardingRequest>[0]> = {}): OrganizationOnboardingRequest {
  return submitOrganizationOnboardingRequest({
    requestId: "req-1",
    requestedDisplayName: "Acme Prospect Co",
    requestedByRef: "prospect-contact-1",
    submittedAt: "2026-10-11T00:00:00.000Z",
    ...overrides,
  });
}

test("O1: a submitted request is always born SUBMITTED, with no caller-forgeable status", () => {
  const request = freshRequest();
  assert.equal(request.status, "SUBMITTED");
  assert.equal(request.admittedOrganizationId, undefined);
});

test("O2: requestId/requestedDisplayName/requestedByRef/submittedAt must be non-empty, non-whitespace-only strings", () => {
  assert.throws(() => submitOrganizationOnboardingRequest({ requestId: "", requestedDisplayName: "x", requestedByRef: "y", submittedAt: "2026-10-11T00:00:00.000Z" }), InvalidOrganizationOnboardingError);
  assert.throws(() => submitOrganizationOnboardingRequest({ requestId: "req-2", requestedDisplayName: "  ", requestedByRef: "y", submittedAt: "2026-10-11T00:00:00.000Z" }), InvalidOrganizationOnboardingError);
  assert.throws(() => submitOrganizationOnboardingRequest({ requestId: "req-2", requestedDisplayName: "x", requestedByRef: "y", submittedAt: "not-a-date" }), InvalidOrganizationOnboardingError);
});

test("O3 (successful admission): constructs a real, active Organization + founder OWNER access role, with correct forward provenance on the admitted request", () => {
  const request = freshRequest();
  const tenantScope = createTenantScope("tenant-acme-prospect");

  const { admittedRequest, organization, founderMembership, founderAccessRoleContext } = admitOrganizationOnboardingRequest({
    request,
    newTenantScope: tenantScope,
    newOrganizationId: "org-acme",
    founderMembershipId: "membership-acme-founder",
    admittingAuthorityPrincipalRef: "akilta-staff-reviewer-1",
    evidenceRef: "internal://onboarding/review/req-1",
    admittedAt: "2026-10-11T01:00:00.000Z",
  });

  assert.equal(admittedRequest.status, "ADMITTED");
  assert.equal(admittedRequest.admittedOrganizationId, organization.organizationId);
  assert.equal(admittedRequest.decidedByRef, "akilta-staff-reviewer-1");

  assert.equal(organization.state, "ACTIVE");
  assert.equal(organization.tenantId, tenantScope.tenantId);
  assert.equal(organization.displayName, request.requestedDisplayName);

  assert.equal(founderMembership.principalRef, request.requestedByRef);
  assert.equal(founderAccessRoleContext.role, "OWNER");
  assert.equal(founderAccessRoleContext.membershipId, founderMembership.membershipId);
});

test("O4 (self-admission structurally impossible): admittingAuthorityPrincipalRef equal to the request's own requestedByRef is always rejected", () => {
  const request = freshRequest({ requestedByRef: "same-ref" });
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request,
        newTenantScope: createTenantScope("tenant-self-admit"),
        newOrganizationId: "org-self-admit",
        founderMembershipId: "membership-self-admit",
        admittingAuthorityPrincipalRef: "same-ref",
        evidenceRef: "internal://onboarding/review/self-admit",
        admittedAt: "2026-10-11T01:00:00.000Z",
      }),
    OrganizationOnboardingAdmissionError,
  );
});

test("O5 (no resurrection): an already-ADMITTED request can never be admitted again", () => {
  const request = freshRequest({ requestId: "req-5" });
  const { admittedRequest } = admitOrganizationOnboardingRequest({
    request,
    newTenantScope: createTenantScope("tenant-5"),
    newOrganizationId: "org-5",
    founderMembershipId: "membership-5",
    admittingAuthorityPrincipalRef: "staff-5",
    evidenceRef: "internal://onboarding/review/5",
    admittedAt: "2026-10-11T01:00:00.000Z",
  });
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request: admittedRequest,
        newTenantScope: createTenantScope("tenant-5-again"),
        newOrganizationId: "org-5-again",
        founderMembershipId: "membership-5-again",
        admittingAuthorityPrincipalRef: "staff-5",
        evidenceRef: "internal://onboarding/review/5-again",
        admittedAt: "2026-10-11T02:00:00.000Z",
      }),
    OrganizationOnboardingAdmissionError,
  );
});

test("O6 (evidenceRef required): an admission with an empty evidenceRef is rejected", () => {
  const request = freshRequest({ requestId: "req-6" });
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request,
        newTenantScope: createTenantScope("tenant-6"),
        newOrganizationId: "org-6",
        founderMembershipId: "membership-6",
        admittingAuthorityPrincipalRef: "staff-6",
        evidenceRef: "",
        admittedAt: "2026-10-11T01:00:00.000Z",
      }),
    InvalidOrganizationOnboardingError,
  );
});

test("O7 (successful rejection): a SUBMITTED request can be rejected, terminal, with reason/decision provenance recorded", () => {
  const request = freshRequest({ requestId: "req-7" });
  const rejected = rejectOrganizationOnboardingRequest({
    request,
    rejectingAuthorityPrincipalRef: "staff-7",
    reason: "insufficient information provided",
    rejectedAt: "2026-10-11T01:00:00.000Z",
  });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.decidedByRef, "staff-7");
  assert.equal(rejected.rejectionReason, "insufficient information provided");
});

test("O8 (no reconsideration after rejection): a REJECTED request can never be admitted or rejected again", () => {
  const request = freshRequest({ requestId: "req-8" });
  const rejected = rejectOrganizationOnboardingRequest({
    request,
    rejectingAuthorityPrincipalRef: "staff-8",
    reason: "duplicate application",
    rejectedAt: "2026-10-11T01:00:00.000Z",
  });
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request: rejected,
        newTenantScope: createTenantScope("tenant-8"),
        newOrganizationId: "org-8",
        founderMembershipId: "membership-8",
        admittingAuthorityPrincipalRef: "staff-8-other",
        evidenceRef: "internal://onboarding/review/8",
        admittedAt: "2026-10-11T02:00:00.000Z",
      }),
    OrganizationOnboardingAdmissionError,
  );
  assert.throws(
    () =>
      rejectOrganizationOnboardingRequest({
        request: rejected,
        rejectingAuthorityPrincipalRef: "staff-8-other",
        reason: "reconsidered",
        rejectedAt: "2026-10-11T02:00:00.000Z",
      }),
    OrganizationOnboardingAdmissionError,
  );
});

test("O9 (no tenant identity before admission): a freshly-submitted request carries no tenantId/TenantScope field at all", () => {
  const request = freshRequest({ requestId: "req-9" });
  assert.equal(Object.prototype.hasOwnProperty.call(request, "tenantId"), false);
});

test("O10 (malformed admittedAt/rejectedAt timestamps rejected)", () => {
  const request = freshRequest({ requestId: "req-10" });
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request,
        newTenantScope: createTenantScope("tenant-10"),
        newOrganizationId: "org-10",
        founderMembershipId: "membership-10",
        admittingAuthorityPrincipalRef: "staff-10",
        evidenceRef: "internal://onboarding/review/10",
        admittedAt: "not-a-timestamp",
      }),
    InvalidOrganizationOnboardingError,
  );
  const request2 = freshRequest({ requestId: "req-10b" });
  assert.throws(
    () =>
      rejectOrganizationOnboardingRequest({
        request: request2,
        rejectingAuthorityPrincipalRef: "staff-10b",
        reason: "x",
        rejectedAt: "not-a-timestamp",
      }),
    InvalidOrganizationOnboardingError,
  );
});
