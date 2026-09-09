import test from "node:test";
import assert from "node:assert/strict";
import {
  createPartnerCapabilityClaim,
  admitPartnerCapabilityClaim,
  revokePartnerCapabilityClaim,
  resolvePartnerCapabilityClaimStatus,
  InvalidPartnerCapabilityClaimError,
} from "../src/domain/partner-capability-admission.js";
import { createPartnerOrganization } from "../src/domain/partner-organization.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createAuthorityContext,
  CrossTenantAuthorityError,
  InsufficientAuthorityError,
  ProtectedActionNotAuthorizedError,
} from "../src/domain/authority.js";

const tenantScope = createTenantScope("tenant-1");
const partnerOrganization = createPartnerOrganization({
  partnerOrganizationId: "partner-1",
  tenantScope,
  relationshipType: "AGENCY",
});

// Rev62 "full-system authority ingress" hardening: the caller invoking
// admitPartnerCapabilityClaim/revokePartnerCapabilityClaim must now hold a
// real, tenant-matched, protected-action-authorized AuthorityContext.
const authority = createAuthorityContext({
  tenantScope,
  permissions: ["WRITE"],
  canPerformProtectedActions: true,
});

test("H1: a freshly created claim is always UNVERIFIED", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-1",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  assert.equal(claim.status, "UNVERIFIED");
  assert.equal(claim.evidenceRef, undefined);
  assert.equal(claim.admittedAt, undefined);
  assert.equal(claim.reviewByAt, undefined);
});

test("H2 (§12 'capability claim cannot self-certify'): createPartnerCapabilityClaim ignores any smuggled status/evidence field and always produces UNVERIFIED", () => {
  const smuggledInput = {
    partnerCapabilityClaimId: "claim-2",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
    status: "ADMITTED",
    evidenceRef: "self-asserted",
  };
  const claim = createPartnerCapabilityClaim(smuggledInput as Parameters<typeof createPartnerCapabilityClaim>[0]);
  assert.equal(claim.status, "UNVERIFIED");
  assert.equal((claim as unknown as Record<string, unknown>).evidenceRef, undefined);
});

test("H3: admitPartnerCapabilityClaim with valid evidence and dates transitions to ADMITTED", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-3",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:portfolio-review-2026",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(admitted.status, "ADMITTED");
  assert.equal(admitted.evidenceRef, "evidence:portfolio-review-2026");
  assert.equal(admitted.reviewByAt, "2027-01-01T00:00:00.000Z");
  assert.equal(admitted.admittedByAuthorityId, "authority-ops-1");
});

test("H4: admitPartnerCapabilityClaim rejects an empty evidenceRef", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-4",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  assert.throws(() => {
    admitPartnerCapabilityClaim({
      claim,
    authority,
      admittingAuthorityId: "authority-ops-1",
      evidenceRef: "",
      admittedAt: "2026-01-01T00:00:00.000Z",
      reviewByAt: "2027-01-01T00:00:00.000Z",
    });
  }, InvalidPartnerCapabilityClaimError);
});

test("H5: admitPartnerCapabilityClaim rejects reviewByAt at or before admittedAt", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-5",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  assert.throws(() => {
    admitPartnerCapabilityClaim({
      claim,
    authority,
      admittingAuthorityId: "authority-ops-1",
      evidenceRef: "evidence:x",
      admittedAt: "2026-06-01T00:00:00.000Z",
      reviewByAt: "2026-01-01T00:00:00.000Z",
    });
  }, InvalidPartnerCapabilityClaimError);
});

test("H6: admitPartnerCapabilityClaim rejects re-admitting an already-ADMITTED claim", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-6",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  assert.throws(() => {
    admitPartnerCapabilityClaim({
      claim: admitted,
    authority,
      admittingAuthorityId: "authority-ops-1",
      evidenceRef: "evidence:y",
      admittedAt: "2026-02-01T00:00:00.000Z",
      reviewByAt: "2027-02-01T00:00:00.000Z",
    });
  }, InvalidPartnerCapabilityClaimError);
});

test("H7: revokePartnerCapabilityClaim transitions an ADMITTED claim to REVOKED", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-7",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  const revoked = revokePartnerCapabilityClaim({ claim: admitted, authority, revokedAt: "2026-03-01T00:00:00.000Z" });
  assert.equal(revoked.status, "REVOKED");
  assert.equal(revoked.revokedAt, "2026-03-01T00:00:00.000Z");
});

test("H8: revokePartnerCapabilityClaim rejects revoking a claim that was never admitted (UNVERIFIED)", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-8",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  assert.throws(() => {
    revokePartnerCapabilityClaim({ claim, authority, revokedAt: "2026-03-01T00:00:00.000Z" });
  }, InvalidPartnerCapabilityClaimError);
});

test("H9: revokePartnerCapabilityClaim rejects revoking an already-REVOKED claim", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-9",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  const revoked = revokePartnerCapabilityClaim({ claim: admitted, authority, revokedAt: "2026-03-01T00:00:00.000Z" });
  assert.throws(() => {
    revokePartnerCapabilityClaim({ claim: revoked, authority, revokedAt: "2026-04-01T00:00:00.000Z" });
  }, InvalidPartnerCapabilityClaimError);
});

test("H10: resolvePartnerCapabilityClaimStatus passes through UNVERIFIED unchanged", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-10",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const status = resolvePartnerCapabilityClaimStatus({ claim, asOf: "2026-06-01T00:00:00.000Z" });
  assert.equal(status, "UNVERIFIED");
});

test("H11: resolvePartnerCapabilityClaimStatus resolves ADMITTED as of a date before reviewByAt", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-11",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  const status = resolvePartnerCapabilityClaimStatus({ claim: admitted, asOf: "2026-06-01T00:00:00.000Z" });
  assert.equal(status, "ADMITTED");
});

test("H12 (§12 'may expire'): resolvePartnerCapabilityClaimStatus resolves EXPIRED as of a date at/after reviewByAt, without any stored mutation", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-12",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  const expiredStatus = resolvePartnerCapabilityClaimStatus({
    claim: admitted,
    asOf: "2027-06-01T00:00:00.000Z",
  });
  assert.equal(expiredStatus, "EXPIRED");
  // the stored claim itself is never mutated by resolving its effective status
  assert.equal(admitted.status, "ADMITTED");
});

test("H13: resolvePartnerCapabilityClaimStatus resolves EXPIRED exactly at reviewByAt (boundary)", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-13",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  const status = resolvePartnerCapabilityClaimStatus({ claim: admitted, asOf: "2027-01-01T00:00:00.000Z" });
  assert.equal(status, "EXPIRED");
});

test("H14: resolvePartnerCapabilityClaimStatus passes through REVOKED unchanged regardless of asOf", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-14",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  const revoked = revokePartnerCapabilityClaim({ claim: admitted, authority, revokedAt: "2026-03-01T00:00:00.000Z" });
  const status = resolvePartnerCapabilityClaimStatus({ claim: revoked, asOf: "2099-01-01T00:00:00.000Z" });
  assert.equal(status, "REVOKED");
});

test("H15: an invalid admittedAt/reviewByAt timestamp fails closed with a thrown error", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-15",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  assert.throws(() => {
    admitPartnerCapabilityClaim({
      claim,
    authority,
      admittingAuthorityId: "authority-ops-1",
      evidenceRef: "evidence:x",
      admittedAt: "not-a-date",
      reviewByAt: "2027-01-01T00:00:00.000Z",
    });
  }, InvalidPartnerCapabilityClaimError);
});

test("H16: empty partnerCapabilityClaimId or capabilityRef fails closed at construction", () => {
  assert.throws(() => {
    createPartnerCapabilityClaim({
      partnerCapabilityClaimId: "",
      partnerOrganization,
      capabilityRef: "cap:seo-audit",
    });
  }, InvalidPartnerCapabilityClaimError);
  assert.throws(() => {
    createPartnerCapabilityClaim({
      partnerCapabilityClaimId: "claim-16",
      partnerOrganization,
      capabilityRef: "",
    });
  }, InvalidPartnerCapabilityClaimError);
});

test("H17 (Rev55 F1, §12 'capability claim cannot self-certify'): admitPartnerCapabilityClaim fails closed when admittingAuthorityId equals the claimant's own partnerOrganizationId", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-17",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  assert.throws(() => {
    admitPartnerCapabilityClaim({
      claim,
    authority,
      admittingAuthorityId: partnerOrganization.partnerOrganizationId,
      evidenceRef: "evidence:self-supplied",
      admittedAt: "2026-01-01T00:00:00.000Z",
      reviewByAt: "2027-01-01T00:00:00.000Z",
    });
  }, InvalidPartnerCapabilityClaimError);
});

test("H18 (Rev55 F1): admitPartnerCapabilityClaim rejects an empty admittingAuthorityId", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-18",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  assert.throws(() => {
    admitPartnerCapabilityClaim({
      claim,
    authority,
      admittingAuthorityId: "",
      evidenceRef: "evidence:x",
      admittedAt: "2026-01-01T00:00:00.000Z",
      reviewByAt: "2027-01-01T00:00:00.000Z",
    });
  }, InvalidPartnerCapabilityClaimError);
});

test("H19 (Rev55 F1): admitPartnerCapabilityClaim succeeds when admittingAuthorityId is a distinct identity from the claimant, and persists it on the admitted claim for audit", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-19",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-independent-reviewer-7",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(admitted.admittedByAuthorityId, "authority-independent-reviewer-7");
  assert.notEqual(admitted.admittedByAuthorityId, admitted.partnerOrganizationId);
});

test("H20 (Rev62 full-system authority ingress): a freshly created claim carries the tenantId derived from its partnerOrganization", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-20",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  assert.equal(claim.tenantId, tenantScope.tenantId);
});

test("H21 (Rev62 full-system authority ingress): admitPartnerCapabilityClaim fails closed when the caller's authority is from a different tenant", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-21",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const otherTenantAuthority = createAuthorityContext({
    tenantScope: createTenantScope("tenant-other"),
    permissions: ["WRITE"],
    canPerformProtectedActions: true,
  });
  assert.throws(() => {
    admitPartnerCapabilityClaim({
      claim,
      authority: otherTenantAuthority,
      admittingAuthorityId: "authority-ops-1",
      evidenceRef: "evidence:x",
      admittedAt: "2026-01-01T00:00:00.000Z",
      reviewByAt: "2027-01-01T00:00:00.000Z",
    });
  }, CrossTenantAuthorityError);
});

test("H22 (Rev62 full-system authority ingress): admitPartnerCapabilityClaim fails closed when the caller's authority lacks WRITE permission", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-22",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const readOnlyAuthority = createAuthorityContext({
    tenantScope,
    permissions: ["READ"],
    canPerformProtectedActions: true,
  });
  assert.throws(() => {
    admitPartnerCapabilityClaim({
      claim,
      authority: readOnlyAuthority,
      admittingAuthorityId: "authority-ops-1",
      evidenceRef: "evidence:x",
      admittedAt: "2026-01-01T00:00:00.000Z",
      reviewByAt: "2027-01-01T00:00:00.000Z",
    });
  }, InsufficientAuthorityError);
});

test("H23 (Rev62 full-system authority ingress): admitPartnerCapabilityClaim fails closed when the caller's authority cannot perform protected actions", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-23",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const unprotectedAuthority = createAuthorityContext({
    tenantScope,
    permissions: ["WRITE"],
    canPerformProtectedActions: false,
  });
  assert.throws(() => {
    admitPartnerCapabilityClaim({
      claim,
      authority: unprotectedAuthority,
      admittingAuthorityId: "authority-ops-1",
      evidenceRef: "evidence:x",
      admittedAt: "2026-01-01T00:00:00.000Z",
      reviewByAt: "2027-01-01T00:00:00.000Z",
    });
  }, ProtectedActionNotAuthorizedError);
});

test("H24 (Rev62 full-system authority ingress): revokePartnerCapabilityClaim fails closed when the caller's authority is from a different tenant", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-24",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  const otherTenantAuthority = createAuthorityContext({
    tenantScope: createTenantScope("tenant-other"),
    permissions: ["WRITE"],
    canPerformProtectedActions: true,
  });
  assert.throws(() => {
    revokePartnerCapabilityClaim({
      claim: admitted,
      authority: otherTenantAuthority,
      revokedAt: "2026-03-01T00:00:00.000Z",
    });
  }, CrossTenantAuthorityError);
});

test("H25 (Rev62 full-system authority ingress): revokePartnerCapabilityClaim fails closed when the caller's authority lacks WRITE permission", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-25",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  const readOnlyAuthority = createAuthorityContext({
    tenantScope,
    permissions: ["READ"],
    canPerformProtectedActions: true,
  });
  assert.throws(() => {
    revokePartnerCapabilityClaim({
      claim: admitted,
      authority: readOnlyAuthority,
      revokedAt: "2026-03-01T00:00:00.000Z",
    });
  }, InsufficientAuthorityError);
});

test("H26 (Rev62 full-system authority ingress): revokePartnerCapabilityClaim fails closed when the caller's authority cannot perform protected actions", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-26",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const admitted = admitPartnerCapabilityClaim({
    claim,
    authority,
    admittingAuthorityId: "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2027-01-01T00:00:00.000Z",
  });
  const unprotectedAuthority = createAuthorityContext({
    tenantScope,
    permissions: ["WRITE"],
    canPerformProtectedActions: false,
  });
  assert.throws(() => {
    revokePartnerCapabilityClaim({
      claim: admitted,
      authority: unprotectedAuthority,
      revokedAt: "2026-03-01T00:00:00.000Z",
    });
  }, ProtectedActionNotAuthorizedError);
});

test("H27 (Rev62 full-system authority ingress): the authority check happens before the business-field checks - a mismatched-tenant caller cannot even discover whether admittingAuthorityId would have been accepted", () => {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-27",
    partnerOrganization,
    capabilityRef: "cap:seo-audit",
  });
  const otherTenantAuthority = createAuthorityContext({
    tenantScope: createTenantScope("tenant-other"),
    permissions: ["WRITE"],
    canPerformProtectedActions: true,
  });
  assert.throws(() => {
    admitPartnerCapabilityClaim({
      claim,
      authority: otherTenantAuthority,
      // an admittingAuthorityId that would otherwise be rejected as
      // self-admission - if this test throws CrossTenantAuthorityError
      // (not InvalidPartnerCapabilityClaimError), the authority gate ran
      // first, exactly as intended.
      admittingAuthorityId: claim.partnerOrganizationId,
      evidenceRef: "evidence:x",
      admittedAt: "2026-01-01T00:00:00.000Z",
      reviewByAt: "2027-01-01T00:00:00.000Z",
    });
  }, CrossTenantAuthorityError);
});
