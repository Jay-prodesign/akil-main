import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePartnerRoute,
  InvalidPartnerRoutingRequestError,
} from "../src/domain/partner-routing-decision.js";
import {
  createPartnerOrganization,
} from "../src/domain/partner-organization.js";
import {
  createPartnerCapabilityClaim,
  admitPartnerCapabilityClaim,
  revokePartnerCapabilityClaim,
} from "../src/domain/partner-capability-admission.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";

const tenantScope = createTenantScope("tenant-1");

function makePartner(id: string) {
  return createPartnerOrganization({
    partnerOrganizationId: id,
    tenantScope,
    relationshipType: "AGENCY",
  });
}

function makeAdmittedClaim(input: {
  claimId: string;
  partnerOrganization: ReturnType<typeof makePartner>;
  capabilityRef: string;
  admittedAt?: string;
  reviewByAt?: string;
  admittingAuthorityId?: string;
}) {
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: input.claimId,
    partnerOrganization: input.partnerOrganization,
    capabilityRef: input.capabilityRef,
  });
  return admitPartnerCapabilityClaim({
    claim,
    admittingAuthorityId: input.admittingAuthorityId ?? "authority-ops-1",
    evidenceRef: "evidence:x",
    admittedAt: input.admittedAt ?? "2026-01-01T00:00:00.000Z",
    reviewByAt: input.reviewByAt ?? "2027-01-01T00:00:00.000Z",
  });
}

test("I1: routes to the only eligible candidate", () => {
  const partner = makePartner("partner-1");
  const claim = makeAdmittedClaim({ claimId: "claim-1", partnerOrganization: partner, capabilityRef: "cap:seo-audit" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [{ partnerOrganization: partner, capabilityClaim: claim }],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerOrganizationId, "partner-1");
  assert.deepEqual(decision.fallbackPartnerOrganizationIds, []);
  assert.equal(decision.decidedByOwnerId, "owner-1");
  assert.ok(decision.reason.length > 0);
});

test("I2: rejects when candidate's claim capabilityRef does not match requiredCapabilityRef", () => {
  const partner = makePartner("partner-2");
  const claim = makeAdmittedClaim({ claimId: "claim-2", partnerOrganization: partner, capabilityRef: "cap:other" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [{ partnerOrganization: partner, capabilityClaim: claim }],
  });
  assert.equal(decision.status, "REJECTED");
  assert.deepEqual(decision.fallbackPartnerOrganizationIds, []);
  assert.ok(decision.reason.length > 0);
});

test("I3: rejects a candidate whose claim is still UNVERIFIED (never admitted)", () => {
  const partner = makePartner("partner-3");
  const claim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-3",
    partnerOrganization: partner,
    capabilityRef: "cap:seo-audit",
  });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [{ partnerOrganization: partner, capabilityClaim: claim }],
  });
  assert.equal(decision.status, "REJECTED");
});

test("I4 (§12 'may expire'): rejects a candidate whose claim is EXPIRED as of asOf", () => {
  const partner = makePartner("partner-4");
  const claim = makeAdmittedClaim({
    claimId: "claim-4",
    partnerOrganization: partner,
    capabilityRef: "cap:seo-audit",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2026-02-01T00:00:00.000Z",
  });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [{ partnerOrganization: partner, capabilityClaim: claim }],
  });
  assert.equal(decision.status, "REJECTED");
});

test("I5: rejects a candidate whose claim is REVOKED", () => {
  const partner = makePartner("partner-5");
  const admitted = makeAdmittedClaim({ claimId: "claim-5", partnerOrganization: partner, capabilityRef: "cap:seo-audit" });
  const revoked = revokePartnerCapabilityClaim({ claim: admitted, revokedAt: "2026-03-01T00:00:00.000Z" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [{ partnerOrganization: partner, capabilityClaim: revoked }],
  });
  assert.equal(decision.status, "REJECTED");
});

test("I6 (§12 'cannot self-certify', extended to routing): excludes a candidate whose partner equals the routing decision's own owner, even if otherwise eligible", () => {
  const selfPartner = makePartner("partner-6-self");
  const selfClaim = makeAdmittedClaim({ claimId: "claim-6a", partnerOrganization: selfPartner, capabilityRef: "cap:seo-audit" });
  const otherPartner = makePartner("partner-6-other");
  const otherClaim = makeAdmittedClaim({ claimId: "claim-6b", partnerOrganization: otherPartner, capabilityRef: "cap:seo-audit" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "partner-6-self",
    candidates: [
      { partnerOrganization: selfPartner, capabilityClaim: selfClaim },
      { partnerOrganization: otherPartner, capabilityClaim: otherClaim },
    ],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerOrganizationId, "partner-6-other");
});

test("I7: no eligible candidate at all returns REJECTED with an empty fallback list", () => {
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [],
  });
  assert.equal(decision.status, "REJECTED");
  assert.deepEqual(decision.fallbackPartnerOrganizationIds, []);
});

test("I8: selects the first eligible candidate in order and records the rest as fallback, in order", () => {
  const partnerA = makePartner("partner-8-a");
  const claimA = makeAdmittedClaim({ claimId: "claim-8a", partnerOrganization: partnerA, capabilityRef: "cap:seo-audit" });
  const partnerB = makePartner("partner-8-b");
  const claimB = makeAdmittedClaim({ claimId: "claim-8b", partnerOrganization: partnerB, capabilityRef: "cap:seo-audit" });
  const partnerC = makePartner("partner-8-c");
  const claimC = makeAdmittedClaim({ claimId: "claim-8c", partnerOrganization: partnerC, capabilityRef: "cap:seo-audit" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      { partnerOrganization: partnerA, capabilityClaim: claimA },
      { partnerOrganization: partnerB, capabilityClaim: claimB },
      { partnerOrganization: partnerC, capabilityClaim: claimC },
    ],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerOrganizationId, "partner-8-a");
  assert.deepEqual(decision.fallbackPartnerOrganizationIds, ["partner-8-b", "partner-8-c"]);
});

test("I9: a candidate whose capabilityClaim.partnerOrganizationId does not match its own partnerOrganization is treated as ineligible, not thrown", () => {
  const partner = makePartner("partner-9");
  const otherPartner = makePartner("partner-9-other");
  const mismatchedClaim = makeAdmittedClaim({ claimId: "claim-9", partnerOrganization: otherPartner, capabilityRef: "cap:seo-audit" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [{ partnerOrganization: partner, capabilityClaim: mismatchedClaim }],
  });
  assert.equal(decision.status, "REJECTED");
});

test("I10: throws on an empty requiredCapabilityRef", () => {
  assert.throws(() => {
    resolvePartnerRoute({
      requiredCapabilityRef: "",
      asOf: "2026-06-01T00:00:00.000Z",
      decidedByOwnerId: "owner-1",
      candidates: [],
    });
  }, InvalidPartnerRoutingRequestError);
});

test("I11: throws on an empty decidedByOwnerId", () => {
  assert.throws(() => {
    resolvePartnerRoute({
      requiredCapabilityRef: "cap:seo-audit",
      asOf: "2026-06-01T00:00:00.000Z",
      decidedByOwnerId: "",
      candidates: [],
    });
  }, InvalidPartnerRoutingRequestError);
});

test("I12: throws on an invalid asOf timestamp", () => {
  assert.throws(() => {
    resolvePartnerRoute({
      requiredCapabilityRef: "cap:seo-audit",
      asOf: "not-a-date",
      decidedByOwnerId: "owner-1",
      candidates: [],
    });
  }, InvalidPartnerRoutingRequestError);
});

test("I13: throws when candidates is not an array", () => {
  assert.throws(() => {
    resolvePartnerRoute({
      requiredCapabilityRef: "cap:seo-audit",
      asOf: "2026-06-01T00:00:00.000Z",
      decidedByOwnerId: "owner-1",
      candidates: undefined as unknown as [],
    });
  }, InvalidPartnerRoutingRequestError);
});

test("I14 (§12 'records reason'): reason is always a non-empty string for both ROUTED and REJECTED outcomes", () => {
  const routed = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [{
      partnerOrganization: makePartner("partner-14a"),
      capabilityClaim: makeAdmittedClaim({ claimId: "claim-14a", partnerOrganization: makePartner("partner-14a"), capabilityRef: "cap:seo-audit" }),
    }],
  });
  const rejected = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [],
  });
  assert.equal(typeof routed.reason, "string");
  assert.ok(routed.reason.length > 0);
  assert.equal(typeof rejected.reason, "string");
  assert.ok(rejected.reason.length > 0);
});

test("I15: fallback list deduplicates a partner that appears more than once in candidates (e.g. via two claims)", () => {
  const partnerA = makePartner("partner-15-a");
  const claimA1 = makeAdmittedClaim({ claimId: "claim-15a1", partnerOrganization: partnerA, capabilityRef: "cap:seo-audit" });
  const partnerB = makePartner("partner-15-b");
  const claimB = makeAdmittedClaim({ claimId: "claim-15b", partnerOrganization: partnerB, capabilityRef: "cap:seo-audit" });
  const claimB2 = makeAdmittedClaim({ claimId: "claim-15b2", partnerOrganization: partnerB, capabilityRef: "cap:seo-audit" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      { partnerOrganization: partnerA, capabilityClaim: claimA1 },
      { partnerOrganization: partnerB, capabilityClaim: claimB },
      { partnerOrganization: partnerB, capabilityClaim: claimB2 },
    ],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerOrganizationId, "partner-15-a");
  assert.deepEqual(decision.fallbackPartnerOrganizationIds, ["partner-15-b"]);
});

test("I16: an ineligible-but-earlier candidate is never chosen over an eligible later one", () => {
  const ineligiblePartner = makePartner("partner-16-ineligible");
  const ineligibleClaim = createPartnerCapabilityClaim({
    partnerCapabilityClaimId: "claim-16-ineligible",
    partnerOrganization: ineligiblePartner,
    capabilityRef: "cap:seo-audit",
  });
  const eligiblePartner = makePartner("partner-16-eligible");
  const eligibleClaim = makeAdmittedClaim({ claimId: "claim-16-eligible", partnerOrganization: eligiblePartner, capabilityRef: "cap:seo-audit" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      { partnerOrganization: ineligiblePartner, capabilityClaim: ineligibleClaim },
      { partnerOrganization: eligiblePartner, capabilityClaim: eligibleClaim },
    ],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerOrganizationId, "partner-16-eligible");
});
