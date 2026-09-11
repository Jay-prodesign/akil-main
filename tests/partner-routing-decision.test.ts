import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePartnerRoute,
  InvalidPartnerRoutingRequestError,
  type PartnerRoutingCandidate,
} from "../src/domain/partner-routing-decision.js";
import {
  createPartnerOrganization,
  createPartnerEmployeeMembership,
  createPartnerClientAssignment,
  revokePartnerClientAssignment,
} from "../src/domain/partner-organization.js";
import {
  createPartnerCapabilityClaim,
  admitPartnerCapabilityClaim,
  revokePartnerCapabilityClaim,
} from "../src/domain/partner-capability-admission.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";

const tenantScope = createTenantScope("tenant-1");
const targetOwnership = createProjectOwnershipRef({
  tenantId: "tenant-1",
  customerId: "customer-1",
  projectId: "project-1",
});

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

function makeMembership(id: string, partner: ReturnType<typeof makePartner>) {
  return createPartnerEmployeeMembership({
    partnerEmployeeMembershipId: id,
    partnerOrganization: partner,
    principalRef: `principal-${id}`,
  });
}

function makeAuthorizedAssignment(
  id: string,
  membership: ReturnType<typeof makeMembership>,
  ownership = targetOwnership,
) {
  return createPartnerClientAssignment({
    partnerClientAssignmentId: id,
    partnerEmployeeMembership: membership,
    ownership,
    grantedAt: "2026-01-01T00:00:00.000Z",
  });
}

/**
 * A fully eligible candidate by default (admitted capability claim +
 * authorized client assignment for `targetOwnership`) - individual tests
 * override exactly the one dimension under test.
 */
function makeEligibleCandidate(seed: string): PartnerRoutingCandidate {
  const partner = makePartner(`partner-${seed}`);
  const membership = makeMembership(`membership-${seed}`, partner);
  return {
    partnerOrganization: partner,
    capabilityClaim: makeAdmittedClaim({
      claimId: `claim-${seed}`,
      partnerOrganization: partner,
      capabilityRef: "cap:seo-audit",
    }),
    partnerEmployeeMembership: membership,
    clientAssignments: [makeAuthorizedAssignment(`assignment-${seed}`, membership)],
  };
}

test("P1: routes to the only eligible candidate", () => {
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [makeEligibleCandidate("1")],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerOrganizationId, "partner-1");
  assert.deepEqual(decision.fallbackPartnerOrganizationIds, []);
  assert.equal(decision.decidedByOwnerId, "owner-1");
  assert.ok(decision.reason.length > 0);
});

test("P2: rejects when candidate's claim capabilityRef does not match requiredCapabilityRef", () => {
  const candidate = makeEligibleCandidate("2");
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:other",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [candidate],
  });
  assert.equal(decision.status, "REJECTED");
  assert.deepEqual(decision.fallbackPartnerOrganizationIds, []);
});

test("P3: rejects a candidate whose claim is still UNVERIFIED (never admitted)", () => {
  const partner = makePartner("partner-3");
  const membership = makeMembership("membership-3", partner);
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      {
        partnerOrganization: partner,
        capabilityClaim: createPartnerCapabilityClaim({
          partnerCapabilityClaimId: "claim-3",
          partnerOrganization: partner,
          capabilityRef: "cap:seo-audit",
        }),
        partnerEmployeeMembership: membership,
        clientAssignments: [makeAuthorizedAssignment("assignment-3", membership)],
      },
    ],
  });
  assert.equal(decision.status, "REJECTED");
});

test("P4 (§12 'may expire'): rejects a candidate whose claim is EXPIRED as of asOf", () => {
  const partner = makePartner("partner-4");
  const membership = makeMembership("membership-4", partner);
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      {
        partnerOrganization: partner,
        capabilityClaim: makeAdmittedClaim({
          claimId: "claim-4",
          partnerOrganization: partner,
          capabilityRef: "cap:seo-audit",
          admittedAt: "2026-01-01T00:00:00.000Z",
          reviewByAt: "2026-02-01T00:00:00.000Z",
        }),
        partnerEmployeeMembership: membership,
        clientAssignments: [makeAuthorizedAssignment("assignment-4", membership)],
      },
    ],
  });
  assert.equal(decision.status, "REJECTED");
});

test("P5: rejects a candidate whose claim is REVOKED", () => {
  const partner = makePartner("partner-5");
  const membership = makeMembership("membership-5", partner);
  const admitted = makeAdmittedClaim({ claimId: "claim-5", partnerOrganization: partner, capabilityRef: "cap:seo-audit" });
  const revoked = revokePartnerCapabilityClaim({ claim: admitted, revokedAt: "2026-03-01T00:00:00.000Z" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      {
        partnerOrganization: partner,
        capabilityClaim: revoked,
        partnerEmployeeMembership: membership,
        clientAssignments: [makeAuthorizedAssignment("assignment-5", membership)],
      },
    ],
  });
  assert.equal(decision.status, "REJECTED");
});

test("P6 (§12 'cannot self-certify', extended to routing): excludes a candidate whose partner equals the routing decision's own owner, even if otherwise eligible", () => {
  const selfCandidate = makeEligibleCandidate("6-self");
  const otherCandidate = makeEligibleCandidate("6-other");
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "partner-6-self",
    candidates: [selfCandidate, otherCandidate],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerOrganizationId, "partner-6-other");
});

test("P7: no eligible candidate at all returns REJECTED with an empty fallback list", () => {
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [],
  });
  assert.equal(decision.status, "REJECTED");
  assert.deepEqual(decision.fallbackPartnerOrganizationIds, []);
});

test("P8: selects the first eligible candidate in order and records the rest as fallback, in order", () => {
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [makeEligibleCandidate("8-a"), makeEligibleCandidate("8-b"), makeEligibleCandidate("8-c")],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerOrganizationId, "partner-8-a");
  assert.deepEqual(decision.fallbackPartnerOrganizationIds, ["partner-8-b", "partner-8-c"]);
});

test("P9: a candidate whose capabilityClaim.partnerOrganizationId does not match its own partnerOrganization is treated as ineligible, not thrown", () => {
  const partner = makePartner("partner-9");
  const otherPartner = makePartner("partner-9-other");
  const membership = makeMembership("membership-9", partner);
  const mismatchedClaim = makeAdmittedClaim({ claimId: "claim-9", partnerOrganization: otherPartner, capabilityRef: "cap:seo-audit" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      {
        partnerOrganization: partner,
        capabilityClaim: mismatchedClaim,
        partnerEmployeeMembership: membership,
        clientAssignments: [makeAuthorizedAssignment("assignment-9", membership)],
      },
    ],
  });
  assert.equal(decision.status, "REJECTED");
});

test("P10: throws on an empty requiredCapabilityRef", () => {
  assert.throws(() => {
    resolvePartnerRoute({
      requiredCapabilityRef: "",
      targetOwnership,
      asOf: "2026-06-01T00:00:00.000Z",
      decidedByOwnerId: "owner-1",
      candidates: [],
    });
  }, InvalidPartnerRoutingRequestError);
});

test("P11: throws on an empty decidedByOwnerId", () => {
  assert.throws(() => {
    resolvePartnerRoute({
      requiredCapabilityRef: "cap:seo-audit",
      targetOwnership,
      asOf: "2026-06-01T00:00:00.000Z",
      decidedByOwnerId: "",
      candidates: [],
    });
  }, InvalidPartnerRoutingRequestError);
});

test("P12: throws on an invalid asOf timestamp", () => {
  assert.throws(() => {
    resolvePartnerRoute({
      requiredCapabilityRef: "cap:seo-audit",
      targetOwnership,
      asOf: "not-a-date",
      decidedByOwnerId: "owner-1",
      candidates: [],
    });
  }, InvalidPartnerRoutingRequestError);
});

test("P13: throws when candidates is not an array", () => {
  assert.throws(() => {
    resolvePartnerRoute({
      requiredCapabilityRef: "cap:seo-audit",
      targetOwnership,
      asOf: "2026-06-01T00:00:00.000Z",
      decidedByOwnerId: "owner-1",
      candidates: undefined as unknown as [],
    });
  }, InvalidPartnerRoutingRequestError);
});

test("P14 (§12 'records reason'): reason is always a non-empty string for both ROUTED and REJECTED outcomes", () => {
  const routed = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [makeEligibleCandidate("14")],
  });
  const rejected = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [],
  });
  assert.equal(typeof routed.reason, "string");
  assert.ok(routed.reason.length > 0);
  assert.equal(typeof rejected.reason, "string");
  assert.ok(rejected.reason.length > 0);
});

test("P15: fallback list deduplicates a partner that appears more than once in candidates (e.g. via two employees)", () => {
  const partnerB = makePartner("partner-15-b");
  const membershipB1 = makeMembership("membership-15-b1", partnerB);
  const membershipB2 = makeMembership("membership-15-b2", partnerB);
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      makeEligibleCandidate("15-a"),
      {
        partnerOrganization: partnerB,
        capabilityClaim: makeAdmittedClaim({ claimId: "claim-15b1", partnerOrganization: partnerB, capabilityRef: "cap:seo-audit" }),
        partnerEmployeeMembership: membershipB1,
        clientAssignments: [makeAuthorizedAssignment("assignment-15b1", membershipB1)],
      },
      {
        partnerOrganization: partnerB,
        capabilityClaim: makeAdmittedClaim({ claimId: "claim-15b2", partnerOrganization: partnerB, capabilityRef: "cap:seo-audit" }),
        partnerEmployeeMembership: membershipB2,
        clientAssignments: [makeAuthorizedAssignment("assignment-15b2", membershipB2)],
      },
    ],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerOrganizationId, "partner-15-a");
  assert.deepEqual(decision.fallbackPartnerOrganizationIds, ["partner-15-b"]);
});

test("P16: an ineligible-but-earlier candidate is never chosen over an eligible later one", () => {
  const ineligiblePartner = makePartner("partner-16-ineligible");
  const ineligibleMembership = makeMembership("membership-16-ineligible", ineligiblePartner);
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      {
        partnerOrganization: ineligiblePartner,
        capabilityClaim: createPartnerCapabilityClaim({
          partnerCapabilityClaimId: "claim-16-ineligible",
          partnerOrganization: ineligiblePartner,
          capabilityRef: "cap:seo-audit",
        }),
        partnerEmployeeMembership: ineligibleMembership,
        clientAssignments: [makeAuthorizedAssignment("assignment-16-ineligible", ineligibleMembership)],
      },
      makeEligibleCandidate("16-eligible"),
    ],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerOrganizationId, "partner-16-eligible");
});

// --- Rev98 gap-audit dimension: tenant/client/project authority, not capability alone ---

test("P17 (Rev98 gap fix): an admitted capability claim alone is NOT sufficient - a candidate with no client assignment at all for targetOwnership is rejected", () => {
  const partner = makePartner("partner-17");
  const membership = makeMembership("membership-17", partner);
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      {
        partnerOrganization: partner,
        capabilityClaim: makeAdmittedClaim({ claimId: "claim-17", partnerOrganization: partner, capabilityRef: "cap:seo-audit" }),
        partnerEmployeeMembership: membership,
        clientAssignments: [],
      },
    ],
  });
  assert.equal(decision.status, "REJECTED");
});

test("P18: a candidate whose only client assignment for targetOwnership has been REVOKED is rejected", () => {
  const partner = makePartner("partner-18");
  const membership = makeMembership("membership-18", partner);
  const assignment = makeAuthorizedAssignment("assignment-18", membership);
  const revokedAssignment = revokePartnerClientAssignment({ assignment, revokedAt: "2026-02-01T00:00:00.000Z" });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      {
        partnerOrganization: partner,
        capabilityClaim: makeAdmittedClaim({ claimId: "claim-18", partnerOrganization: partner, capabilityRef: "cap:seo-audit" }),
        partnerEmployeeMembership: membership,
        clientAssignments: [revokedAssignment],
      },
    ],
  });
  assert.equal(decision.status, "REJECTED");
});

test("P19: a candidate whose client assignment is scoped to a different tenant/customer/project is rejected, even with an admitted capability claim", () => {
  const partner = makePartner("partner-19");
  const membership = makeMembership("membership-19", partner);
  const wrongScopeOwnership = createProjectOwnershipRef({
    tenantId: "tenant-1",
    customerId: "customer-1",
    projectId: "some-other-project",
  });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      {
        partnerOrganization: partner,
        capabilityClaim: makeAdmittedClaim({ claimId: "claim-19", partnerOrganization: partner, capabilityRef: "cap:seo-audit" }),
        partnerEmployeeMembership: membership,
        clientAssignments: [makeAuthorizedAssignment("assignment-19", membership, wrongScopeOwnership)],
      },
    ],
  });
  assert.equal(decision.status, "REJECTED");
});

test("P20: a candidate whose partnerEmployeeMembership structurally belongs to a different partner organization is treated as ineligible, not thrown", () => {
  const partner = makePartner("partner-20");
  const otherPartner = makePartner("partner-20-other-employer");
  const foreignMembership = makeMembership("membership-20-foreign", otherPartner);
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      {
        partnerOrganization: partner,
        capabilityClaim: makeAdmittedClaim({ claimId: "claim-20", partnerOrganization: partner, capabilityRef: "cap:seo-audit" }),
        partnerEmployeeMembership: foreignMembership,
        clientAssignments: [makeAuthorizedAssignment("assignment-20", foreignMembership)],
      },
    ],
  });
  assert.equal(decision.status, "REJECTED");
});

test("P21: a ROUTED decision records the specific selected employee membership, not just the partner organization", () => {
  const candidate = makeEligibleCandidate("21");
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [candidate],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerEmployeeMembershipId, "membership-21");
});

test("P22 (per-employee granularity): two employees at the same partner organization - only the one with an authorized assignment for targetOwnership is eligible", () => {
  const partner = makePartner("partner-22");
  const claim = makeAdmittedClaim({ claimId: "claim-22", partnerOrganization: partner, capabilityRef: "cap:seo-audit" });
  const unauthorizedMembership = makeMembership("membership-22-unauthorized", partner);
  const authorizedMembership = makeMembership("membership-22-authorized", partner);
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership,
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      { partnerOrganization: partner, capabilityClaim: claim, partnerEmployeeMembership: unauthorizedMembership, clientAssignments: [] },
      {
        partnerOrganization: partner,
        capabilityClaim: claim,
        partnerEmployeeMembership: authorizedMembership,
        clientAssignments: [makeAuthorizedAssignment("assignment-22", authorizedMembership)],
      },
    ],
  });
  assert.equal(decision.status, "ROUTED");
  assert.equal(decision.selectedPartnerEmployeeMembershipId, "membership-22-authorized");
});

test("P23 (Rev62 serviceRef exactness extended to routing): an assignment scoped to a specific serviceRef does not authorize a targetOwnership request with no serviceRef", () => {
  const partner = makePartner("partner-23");
  const membership = makeMembership("membership-23", partner);
  const serviceScopedOwnership = createProjectOwnershipRef({
    tenantId: "tenant-1",
    customerId: "customer-1",
    projectId: "project-1",
    serviceRef: "svc-seo",
  });
  const decision = resolvePartnerRoute({
    requiredCapabilityRef: "cap:seo-audit",
    targetOwnership, // no serviceRef
    asOf: "2026-06-01T00:00:00.000Z",
    decidedByOwnerId: "owner-1",
    candidates: [
      {
        partnerOrganization: partner,
        capabilityClaim: makeAdmittedClaim({ claimId: "claim-23", partnerOrganization: partner, capabilityRef: "cap:seo-audit" }),
        partnerEmployeeMembership: membership,
        clientAssignments: [makeAuthorizedAssignment("assignment-23", membership, serviceScopedOwnership)],
      },
    ],
  });
  assert.equal(decision.status, "REJECTED");
});
