import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob, enterExceptionState } from "../src/domain/outcome-job.js";
import { buildAttentionState } from "../src/domain/attention-state.js";
import { toOperationsAttentionItem, type OperationsAttentionItem } from "../src/domain/operations-attention.js";
import {
  createPartnerCapabilityClaim,
  admitPartnerCapabilityClaim,
  revokePartnerCapabilityClaim,
  type PartnerCapabilityClaim,
} from "../src/domain/partner-capability-admission.js";
import type { PartnerOrganization } from "../src/domain/partner-organization.js";
import {
  buildInternalCommandCenterProjection,
  InvalidInternalCommandProjectionError,
} from "../src/domain/internal-command-projection.js";

function buildAttentionItem(input: {
  tenantSuffix: string;
  jobId: string;
  enterException?: boolean;
}): OperationsAttentionItem {
  const tenantScope = createTenantScope(`akilta-tenant-${input.tenantSuffix}`);
  const customer = createCustomer({
    tenantScope,
    customerId: `customer-${input.tenantSuffix}`,
    displayName: `Customer ${input.tenantSuffix}`,
  });
  const project = createProject({
    tenantScope,
    customer,
    projectId: `project-${input.tenantSuffix}`,
    ownerRef: `owner-${input.tenantSuffix}`,
    state: "active",
  });
  let job = createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId: input.jobId,
    jobFamily: "website-build-v1",
    businessObjective: "test objective",
  });
  let latestExceptionEvent;
  if (input.enterException) {
    const result = enterExceptionState({
      job,
      to: "BLOCKED",
      eventId: `event-${input.jobId}`,
      actorRef: "system",
      timestamp: "2026-09-10T09:00:00.000Z",
      reason: "provider outage",
    });
    job = result.job;
    latestExceptionEvent = result.auditEvent;
  }
  const state = buildAttentionState(
    latestExceptionEvent !== undefined ? { job, latestExceptionEvent } : { job },
  );
  return toOperationsAttentionItem({ state, job });
}

function partnerOrg(id: string, tenantScope = createTenantScope("akilta-tenant-a")): PartnerOrganization {
  return {
    partnerOrganizationId: id as PartnerOrganization["partnerOrganizationId"],
    tenantId: tenantScope.tenantId,
    relationshipType: "AGENCY",
  };
}

function unverifiedClaim(id: string, orgId: string): PartnerCapabilityClaim {
  return createPartnerCapabilityClaim({
    partnerCapabilityClaimId: id,
    partnerOrganization: partnerOrg(orgId),
    capabilityRef: "cap:seo-audit",
  });
}

test("J1: buildInternalCommandCenterProjection rejects an invalid generatedAt/asOf", () => {
  assert.throws(
    () =>
      buildInternalCommandCenterProjection({
        attentionItems: [],
        partnerClaims: [],
        generatedAt: "not-a-date",
        asOf: "2026-09-10T00:00:00.000Z",
      }),
    InvalidInternalCommandProjectionError,
  );
  assert.throws(
    () =>
      buildInternalCommandCenterProjection({
        attentionItems: [],
        partnerClaims: [],
        generatedAt: "2026-09-10T00:00:00.000Z",
        asOf: "",
      }),
    InvalidInternalCommandProjectionError,
  );
});

test("J2: empty inputs produce an all-zero projection", () => {
  const projection = buildInternalCommandCenterProjection({
    attentionItems: [],
    partnerClaims: [],
    generatedAt: "2026-09-10T00:00:00.000Z",
    asOf: "2026-09-10T00:00:00.000Z",
  });
  assert.equal(projection.companyPortfolioAttention.activeCount, 0);
  assert.deepEqual(projection.companyPortfolioAttention.levelTally, {
    NORMAL: 0,
    EXCEPTION: 0,
    ESCALATED: 0,
  });
  assert.deepEqual(projection.partners.statusTally, {
    UNVERIFIED: 0,
    ADMITTED: 0,
    EXPIRED: 0,
    REVOKED: 0,
  });
});

test("J3: company/portfolio attention aggregates across multiple tenants (internal cross-tenant view, unlike the customer-scoped filter)", () => {
  const itemA = buildAttentionItem({ tenantSuffix: "a", jobId: "job-a", enterException: true });
  const itemB = buildAttentionItem({ tenantSuffix: "b", jobId: "job-b", enterException: false });
  assert.notEqual(itemA.tenantId, itemB.tenantId);
  assert.equal(itemA.internalAttentionLevel, "EXCEPTION");
  assert.equal(itemB.internalAttentionLevel, "NORMAL");

  const projection = buildInternalCommandCenterProjection({
    attentionItems: [itemA, itemB],
    partnerClaims: [],
    generatedAt: "2026-09-10T00:00:00.000Z",
    asOf: "2026-09-10T00:00:00.000Z",
  });
  assert.equal(projection.companyPortfolioAttention.activeCount, 1);
  assert.deepEqual(projection.companyPortfolioAttention.levelTally, {
    NORMAL: 1,
    EXCEPTION: 1,
    ESCALATED: 0,
  });
  assert.equal(projection.companyPortfolioAttention.items.length, 2);
});

test("J4: partner status tally reflects stored UNVERIFIED/ADMITTED/REVOKED statuses directly", () => {
  const unverified = unverifiedClaim("claim-1", "org-1");
  const admitted = admitPartnerCapabilityClaim({
    claim: unverifiedClaim("claim-2", "org-2"),
    admittingAuthorityId: "authority-1",
    evidenceRef: "evidence:portfolio-review",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2026-12-01T00:00:00.000Z",
  });
  const revoked = revokePartnerCapabilityClaim({
    claim: admitPartnerCapabilityClaim({
      claim: unverifiedClaim("claim-3", "org-3"),
      admittingAuthorityId: "authority-1",
      evidenceRef: "evidence:portfolio-review-2",
      admittedAt: "2026-01-01T00:00:00.000Z",
      reviewByAt: "2026-12-01T00:00:00.000Z",
    }),
    revokedAt: "2026-06-01T00:00:00.000Z",
  });

  const projection = buildInternalCommandCenterProjection({
    attentionItems: [],
    partnerClaims: [unverified, admitted, revoked],
    generatedAt: "2026-09-10T00:00:00.000Z",
    asOf: "2026-09-10T00:00:00.000Z",
  });
  assert.deepEqual(projection.partners.statusTally, {
    UNVERIFIED: 1,
    ADMITTED: 1,
    EXPIRED: 0,
    REVOKED: 1,
  });
});

test("J5: partner status tally reflects computed EXPIRED (never a stored status) as of the caller-supplied asOf, reusing resolvePartnerCapabilityClaimStatus", () => {
  const admitted = admitPartnerCapabilityClaim({
    claim: unverifiedClaim("claim-4", "org-4"),
    admittingAuthorityId: "authority-1",
    evidenceRef: "evidence:portfolio-review-3",
    admittedAt: "2026-01-01T00:00:00.000Z",
    reviewByAt: "2026-06-01T00:00:00.000Z",
  });

  const beforeExpiry = buildInternalCommandCenterProjection({
    attentionItems: [],
    partnerClaims: [admitted],
    generatedAt: "2026-03-01T00:00:00.000Z",
    asOf: "2026-03-01T00:00:00.000Z",
  });
  assert.equal(beforeExpiry.partners.statusTally.ADMITTED, 1);
  assert.equal(beforeExpiry.partners.statusTally.EXPIRED, 0);

  const afterExpiry = buildInternalCommandCenterProjection({
    attentionItems: [],
    partnerClaims: [admitted],
    generatedAt: "2026-09-10T00:00:00.000Z",
    asOf: "2026-09-10T00:00:00.000Z",
  });
  assert.equal(afterExpiry.partners.statusTally.ADMITTED, 0);
  assert.equal(afterExpiry.partners.statusTally.EXPIRED, 1);
  // the underlying stored claim itself is never mutated by this projection
  assert.equal(admitted.status, "ADMITTED");
});

test("J6: this function adds no independent judgment - the returned items/claims arrays are the exact input references, never re-derived", () => {
  const items = [buildAttentionItem({ tenantSuffix: "c", jobId: "job-c" })];
  const claims = [unverifiedClaim("claim-5", "org-5")];
  const projection = buildInternalCommandCenterProjection({
    attentionItems: items,
    partnerClaims: claims,
    generatedAt: "2026-09-10T00:00:00.000Z",
    asOf: "2026-09-10T00:00:00.000Z",
  });
  assert.equal(projection.companyPortfolioAttention.items, items);
  assert.equal(projection.partners.claims, claims);
});
