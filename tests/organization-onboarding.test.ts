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
  assert.equal(admittedRequest.admissionEvidenceRef, "internal://onboarding/review/req-1");

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

test("O6b (evidenceRef required): a whitespace-only evidenceRef is rejected (malformed, not merely empty)", () => {
  const request = freshRequest({ requestId: "req-6b" });
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request,
        newTenantScope: createTenantScope("tenant-6b"),
        newOrganizationId: "org-6b",
        founderMembershipId: "membership-6b",
        admittingAuthorityPrincipalRef: "staff-6b",
        evidenceRef: "   ",
        admittedAt: "2026-10-11T01:00:00.000Z",
      }),
    InvalidOrganizationOnboardingError,
  );
});

test("O6c (Brain correction, comment 6294369735): two admissions of otherwise-identical requests over DIFFERENT evidenceRef values are NOT observationally identical - each admitted request durably retains its own exact evidence", () => {
  const requestA = freshRequest({ requestId: "req-6c-a" });
  const requestB = freshRequest({ requestId: "req-6c-b" });

  const { admittedRequest: admittedA } = admitOrganizationOnboardingRequest({
    request: requestA,
    newTenantScope: createTenantScope("tenant-6c"),
    newOrganizationId: "org-6c-a",
    founderMembershipId: "membership-6c-a",
    admittingAuthorityPrincipalRef: "staff-6c",
    evidenceRef: "internal://onboarding/review/evidence-A",
    admittedAt: "2026-10-11T01:00:00.000Z",
  });
  const { admittedRequest: admittedB } = admitOrganizationOnboardingRequest({
    request: requestB,
    newTenantScope: createTenantScope("tenant-6c"),
    newOrganizationId: "org-6c-b",
    founderMembershipId: "membership-6c-b",
    admittingAuthorityPrincipalRef: "staff-6c",
    evidenceRef: "internal://onboarding/review/evidence-B",
    admittedAt: "2026-10-11T01:00:00.000Z",
  });

  assert.equal(admittedA.admissionEvidenceRef, "internal://onboarding/review/evidence-A");
  assert.equal(admittedB.admissionEvidenceRef, "internal://onboarding/review/evidence-B");
  assert.notEqual(admittedA.admissionEvidenceRef, admittedB.admissionEvidenceRef);
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

// --- Brain correction (comment 6311999915, F2): submitted-request coherence revalidation ---

test("O11 (Brain F2): a hand-built nominally-SUBMITTED request carrying stale terminal metadata (decidedAt/decidedByRef) cannot be admitted", () => {
  const request = freshRequest({ requestId: "req-11" });
  const forged: OrganizationOnboardingRequest = {
    ...request,
    decidedAt: "2026-10-01T00:00:00.000Z",
    decidedByRef: "someone-else",
  };
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request: forged,
        newTenantScope: createTenantScope("tenant-11"),
        newOrganizationId: "org-11",
        founderMembershipId: "membership-11",
        admittingAuthorityPrincipalRef: "staff-11",
        evidenceRef: "internal://onboarding/review/11",
        admittedAt: "2026-10-11T01:00:00.000Z",
      }),
    OrganizationOnboardingAdmissionError,
  );
});

test("O12 (Brain F2): a hand-built nominally-SUBMITTED request carrying a stale admissionEvidenceRef or admittedOrganizationId cannot be admitted or rejected", () => {
  const request = freshRequest({ requestId: "req-12" });
  const forgedWithEvidence: OrganizationOnboardingRequest = {
    ...request,
    admissionEvidenceRef: "internal://stale-evidence",
  };
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request: forgedWithEvidence,
        newTenantScope: createTenantScope("tenant-12"),
        newOrganizationId: "org-12",
        founderMembershipId: "membership-12",
        admittingAuthorityPrincipalRef: "staff-12",
        evidenceRef: "internal://onboarding/review/12",
        admittedAt: "2026-10-11T01:00:00.000Z",
      }),
    OrganizationOnboardingAdmissionError,
  );

  const forgedWithOrgId: OrganizationOnboardingRequest = {
    ...request,
    admittedOrganizationId: "org-forged" as never,
  };
  assert.throws(
    () =>
      rejectOrganizationOnboardingRequest({
        request: forgedWithOrgId,
        rejectingAuthorityPrincipalRef: "staff-12b",
        reason: "x",
        rejectedAt: "2026-10-11T01:00:00.000Z",
      }),
    OrganizationOnboardingAdmissionError,
  );
});

test("O13 (Brain F2): a hand-built SUBMITTED request with malformed submittedAt/requestId/requestedDisplayName/requestedByRef provenance is rejected at the transition boundary, not just at submit time", () => {
  const request = freshRequest({ requestId: "req-13" });

  const malformedSubmittedAt: OrganizationOnboardingRequest = { ...request, submittedAt: "not-a-timestamp" };
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request: malformedSubmittedAt,
        newTenantScope: createTenantScope("tenant-13"),
        newOrganizationId: "org-13a",
        founderMembershipId: "membership-13a",
        admittingAuthorityPrincipalRef: "staff-13a",
        evidenceRef: "internal://onboarding/review/13a",
        admittedAt: "2026-10-11T01:00:00.000Z",
      }),
    InvalidOrganizationOnboardingError,
  );

  const emptyRequestId: OrganizationOnboardingRequest = { ...request, requestId: "" as never };
  assert.throws(
    () =>
      rejectOrganizationOnboardingRequest({
        request: emptyRequestId,
        rejectingAuthorityPrincipalRef: "staff-13b",
        reason: "x",
        rejectedAt: "2026-10-11T01:00:00.000Z",
      }),
    InvalidOrganizationOnboardingError,
  );

  const paddedDisplayName: OrganizationOnboardingRequest = { ...request, requestedDisplayName: "  padded  " };
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request: paddedDisplayName,
        newTenantScope: createTenantScope("tenant-13c"),
        newOrganizationId: "org-13c",
        founderMembershipId: "membership-13c",
        admittingAuthorityPrincipalRef: "staff-13c",
        evidenceRef: "internal://onboarding/review/13c",
        admittedAt: "2026-10-11T01:00:00.000Z",
      }),
    InvalidOrganizationOnboardingError,
  );

  const emptyRequestedByRef: OrganizationOnboardingRequest = { ...request, requestedByRef: "" };
  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request: emptyRequestedByRef,
        newTenantScope: createTenantScope("tenant-13d"),
        newOrganizationId: "org-13d",
        founderMembershipId: "membership-13d",
        admittingAuthorityPrincipalRef: "staff-13d",
        evidenceRef: "internal://onboarding/review/13d",
        admittedAt: "2026-10-11T01:00:00.000Z",
      }),
    InvalidOrganizationOnboardingError,
  );
});

test("O14 (Brain F2): a decision timestamp chronologically before the request's own submittedAt fails closed for both admission and rejection", () => {
  const request = freshRequest({ requestId: "req-14", submittedAt: "2026-10-11T12:00:00.000Z" });

  assert.throws(
    () =>
      admitOrganizationOnboardingRequest({
        request,
        newTenantScope: createTenantScope("tenant-14a"),
        newOrganizationId: "org-14a",
        founderMembershipId: "membership-14a",
        admittingAuthorityPrincipalRef: "staff-14a",
        evidenceRef: "internal://onboarding/review/14a",
        admittedAt: "2026-10-11T00:00:00.000Z",
      }),
    InvalidOrganizationOnboardingError,
  );

  const request2 = freshRequest({ requestId: "req-14b", submittedAt: "2026-10-11T12:00:00.000Z" });
  assert.throws(
    () =>
      rejectOrganizationOnboardingRequest({
        request: request2,
        rejectingAuthorityPrincipalRef: "staff-14b",
        reason: "x",
        rejectedAt: "2026-10-11T00:00:00.000Z",
      }),
    InvalidOrganizationOnboardingError,
  );

  // Equal to submittedAt is acceptable (not "before").
  const request3 = freshRequest({ requestId: "req-14c", submittedAt: "2026-10-11T12:00:00.000Z" });
  const admitted = admitOrganizationOnboardingRequest({
    request: request3,
    newTenantScope: createTenantScope("tenant-14c"),
    newOrganizationId: "org-14c",
    founderMembershipId: "membership-14c",
    admittingAuthorityPrincipalRef: "staff-14c",
    evidenceRef: "internal://onboarding/review/14c",
    admittedAt: "2026-10-11T12:00:00.000Z",
  });
  assert.equal(admitted.admittedRequest.status, "ADMITTED");
});
