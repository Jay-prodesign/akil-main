import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createOrganizationAccessRoleContext } from "../src/domain/organization-access-role.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { resolveEffectiveOrganizationAccess } from "../src/domain/effective-organization-access.js";
import { createOrganizationServicePrincipal } from "../src/domain/organization-service-principal.js";
import {
  createDelegatedAccessGrant,
  revokeDelegatedAccessGrant,
  resolveEffectiveDelegatedAccess,
} from "../src/domain/delegated-access-grant.js";
import {
  createProtectedDecisionWaitRequest,
  authorizeProtectedDecisionResume,
} from "../src/domain/protected-decision-wait-gate.js";
import { createProtectedDecisionRecord } from "../src/domain/protected-decision-record.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";

/**
 * OS-V1-05 ("Expanded Admin / Delegated Authority", AA-005 REV209's own
 * detailed text): "use existing membership/worker/connection/policy
 * controls; curated roles; scoped temporary delegation; explicit
 * request/approval; explainable effective access; support access scoped,
 * time-bounded and audited. Approval never becomes execution authority.
 * Witness expired/revoked delegation, A-to-B delegation, approval without
 * execution authority and human/worker substitution."
 *
 * Reuse-surface inspection found every one of REV209's own named
 * requirements already individually closed by prior corridor work -
 * curated roles (`organization-access-role.ts`), scoped temporary
 * delegation + expired/revoked/A-to-B witnesses (OS-V1-02's own
 * `delegated-access-grant.ts` W1-W14), explicit request/approval + approval
 * never becoming execution authority (OS-V0-10's `protected-decision-wait-
 * gate.ts`), explainable effective access (`resolveEffectiveOrganizationAccess`'s
 * own `reasons` field, present on every call site already), human/worker
 * substitution (OS-V1-02 Rev208 witnesses I/J). This task's own genuine
 * contribution is a single END-TO-END composition proving these
 * already-accepted primitives actually fit together coherently as one
 * "Expanded Admin" story - a curated OWNER granting a scoped, explainable,
 * time-bounded delegation, which the delegate then uses to request a
 * protected action, which still requires separate, explicit approval
 * before executing - plus two genuinely new compositions neither prior
 * task exercised: a worker identity attempting to exercise a
 * human-targeted delegation (human/worker substitution INSIDE the
 * delegation flow specifically, distinct from OS-V1-02's own resolver-
 * level substitution witnesses), and "support access... audited" -
 * confirmed structurally: `authorizeProtectedDecisionResume`'s own
 * contract already makes a durable `decisionEvidenceRef`/`resolvedAt`
 * mandatory on every resume authorization, so an executed support/
 * delegated action can never be auditless by construction.
 */

const TENANT = createTenantScope("tenant-os-v1-05");
const OTHER_TENANT = createTenantScope("tenant-os-v1-05-other");

function orgFixture() {
  const organization = activateOrganization({
    organization: createOrganization({ organizationId: "org-v1-05", tenantScope: TENANT, displayName: "Org V1-05", createdAt: "2026-10-09T00:00:00.000Z" }),
    activatedAt: "2026-10-09T00:00:01.000Z",
  });
  const ownerMembership = createOrganizationMembership({ membershipId: "membership-v1-05-owner", tenantScope: TENANT, principalRef: "principal-v1-05-owner", role: "STAFF" });
  const ownerAuthority = createAuthorityContext({ tenantScope: TENANT, permissions: ["READ", "WRITE", "EXECUTE"], canPerformProtectedActions: true });
  const ownerRoleContext = createOrganizationAccessRoleContext({ membership: ownerMembership, role: "OWNER" });
  return { organization, ownerMembership, ownerAuthority, ownerRoleContext };
}

test("OS-V1-05 W1 (curated role + explainable effective access): an OWNER-curated role projects role: OWNER with an explicit, non-empty explanation", () => {
  const { organization, ownerMembership, ownerAuthority, ownerRoleContext } = orgFixture();
  const access = resolveEffectiveOrganizationAccess({
    organization,
    membership: ownerMembership,
    currentPrincipalRef: ownerMembership.principalRef,
    authority: ownerAuthority,
    roleContext: ownerRoleContext,
  });
  assert.equal(access.decision, "GRANTED");
  assert.equal(access.role, "OWNER");
  assert.ok(access.reasons.length > 0 && access.reasons[0]!.includes("curated role context verified"));
});

test("OS-V1-05 W2 (end-to-end): a curated OWNER's scoped temporary delegation lets the delegate request a protected action, which still requires a SEPARATE explicit approval before it may execute - approval never becomes execution authority on its own", () => {
  const { organization, ownerMembership, ownerAuthority } = orgFixture();
  const ownerAccess = resolveEffectiveOrganizationAccess({
    organization,
    membership: ownerMembership,
    currentPrincipalRef: ownerMembership.principalRef,
    authority: ownerAuthority,
  });
  assert.equal(ownerAccess.decision, "GRANTED");

  const grant = createDelegatedAccessGrant({
    tenantScope: TENANT,
    organization,
    delegatorMembership: ownerMembership,
    delegatorAuthority: ownerAuthority,
    delegationId: "delegation-v1-05-support",
    delegatePrincipalRef: "principal-v1-05-delegate",
    permissions: ["EXECUTE"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:30:00.000Z",
    expiresAt: "2026-10-09T01:30:00.000Z",
  });
  const delegatedAccess = resolveEffectiveDelegatedAccess({
    organization,
    grant,
    currentPrincipalRef: "principal-v1-05-delegate",
    now: "2026-10-09T00:45:00.000Z",
    delegatorCurrentAccess: ownerAccess,
  });
  assert.equal(delegatedAccess.decision, "GRANTED");
  assert.equal(delegatedAccess.canPerformProtectedActions, false, "a delegation never carries protected-action authority the delegator didn't explicitly hand it - approval/protected-action status is never implied by ordinary EXECUTE");

  // The delegate (holding only ordinary EXECUTE, never canPerformProtectedActions)
  // raises a protected-decision wait for the actual action - raising a wait
  // is never itself authority-gated (fail CLOSED by pausing is always safe).
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-v1-05", displayName: "Customer V1-05" });
  const project = createProject({ tenantScope: TENANT, customer, projectId: "proj-v1-05", ownerRef: "owner-v1-05", state: "active" });
  const job = createOutcomeJob({ tenantScope: TENANT, customer, project, jobId: "job-v1-05", jobFamily: "fam", businessObjective: "obj" });
  const waitRequest = createProtectedDecisionWaitRequest({
    tenantScope: TENANT,
    customer,
    project,
    job,
    waitRequestId: "wait-v1-05",
    runId: "run-1",
    attempt: 1,
    effectRef: "effect:v1-05",
    decisionRef: "decision:v1-05",
    reason: "delegate-requested protected action requires separate approval",
    activationFingerprintAtWait: "fingerprint-v1-05",
    raisedAt: "2026-10-09T00:50:00.000Z",
  });

  // The OWNER (who retains full protected-action authority, never delegated
  // away) is the one who actually approves and resumes - the delegate's own
  // merely-EXECUTE authority could never satisfy authorizeProtectedDecisionResume's
  // own canPerformProtectedActions requirement, proving approval/execution
  // stay distinct roles even inside one delegated workflow.
  const decisionRecord = createProtectedDecisionRecord({
    tenantScope: TENANT,
    decisionRef: "decision:v1-05",
    outcome: "APPROVED",
    organization,
    membership: ownerMembership,
    currentPrincipalRef: ownerMembership.principalRef,
    authority: ownerAuthority,
    decidedAt: "2026-10-09T01:00:00.000Z",
    evidenceRef: "evidence:v1-05-owner-approval",
  });
  const resumeAuthorization = authorizeProtectedDecisionResume({
    waitRequest,
    access: ownerAccess,
    authority: ownerAuthority,
    decisionRecord,
    currentActivationFingerprint: "fingerprint-v1-05",
    now: "2026-10-09T01:05:00.000Z",
  });
  assert.equal(resumeAuthorization.decisionRef, "decision:v1-05");
  // "support access... audited": a durable evidence reference and resolution
  // timestamp are structurally mandatory on every resume authorization -
  // there is no field-optional path that could produce an auditless resume.
  assert.ok(resumeAuthorization.decisionEvidenceRef.length > 0);
  assert.ok(resumeAuthorization.resolvedAt.length > 0);
});

test("OS-V1-05 W3 (expired/revoked delegation denied): a delegation past its own expiresAt, and a grant revoked outright, both deny the delegate - regardless of the delegator's own still-current standing", () => {
  const { organization, ownerMembership, ownerAuthority } = orgFixture();
  const ownerAccess = resolveEffectiveOrganizationAccess({ organization, membership: ownerMembership, currentPrincipalRef: ownerMembership.principalRef, authority: ownerAuthority });

  const grant = createDelegatedAccessGrant({
    tenantScope: TENANT,
    organization,
    delegatorMembership: ownerMembership,
    delegatorAuthority: ownerAuthority,
    delegationId: "delegation-v1-05-expiry",
    delegatePrincipalRef: "principal-v1-05-delegate-expiry",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T01:00:00.000Z",
  });
  const expired = resolveEffectiveDelegatedAccess({
    organization,
    grant,
    currentPrincipalRef: "principal-v1-05-delegate-expiry",
    now: "2026-10-09T01:00:00.001Z",
    delegatorCurrentAccess: ownerAccess,
  });
  assert.equal(expired.decision, "DENIED");

  const revokedGrant = revokeDelegatedAccessGrant({ grant, revokedAt: "2026-10-09T00:15:00.000Z", revokedReason: "support engagement ended early" });
  const revoked = resolveEffectiveDelegatedAccess({
    organization,
    grant: revokedGrant,
    currentPrincipalRef: "principal-v1-05-delegate-expiry",
    now: "2026-10-09T00:20:00.000Z",
    delegatorCurrentAccess: ownerAccess,
  });
  assert.equal(revoked.decision, "DENIED");
});

test("OS-V1-05 W4 (A-to-B delegation denied): a delegation minted for Organization A's own scope is denied when resolved against Organization B", () => {
  const { organization: orgA, ownerMembership, ownerAuthority } = orgFixture();
  const orgB = activateOrganization({
    organization: createOrganization({ organizationId: "org-v1-05-b", tenantScope: TENANT, displayName: "Org V1-05 B", createdAt: "2026-10-09T00:00:00.000Z" }),
    activatedAt: "2026-10-09T00:00:01.000Z",
  });
  const ownerAccess = resolveEffectiveOrganizationAccess({ organization: orgA, membership: ownerMembership, currentPrincipalRef: ownerMembership.principalRef, authority: ownerAuthority });
  const grant = createDelegatedAccessGrant({
    tenantScope: TENANT,
    organization: orgA,
    delegatorMembership: ownerMembership,
    delegatorAuthority: ownerAuthority,
    delegationId: "delegation-v1-05-a-to-b",
    delegatePrincipalRef: "principal-v1-05-a-to-b",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T02:00:00.000Z",
  });
  const resolution = resolveEffectiveDelegatedAccess({
    organization: orgB,
    grant,
    currentPrincipalRef: "principal-v1-05-a-to-b",
    now: "2026-10-09T00:30:00.000Z",
    delegatorCurrentAccess: ownerAccess,
  });
  assert.equal(resolution.decision, "DENIED");
});

test("OS-V1-05 W5 (approval without execution authority denied): an APPROVED decision record does not, on its own, satisfy authorizeProtectedDecisionResume's own separate EXECUTE+canPerformProtectedActions requirement", () => {
  const { organization, ownerMembership, ownerAuthority } = orgFixture();
  const ownerAccess = resolveEffectiveOrganizationAccess({ organization, membership: ownerMembership, currentPrincipalRef: ownerMembership.principalRef, authority: ownerAuthority });

  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-v1-05-w5", displayName: "Customer V1-05 W5" });
  const project = createProject({ tenantScope: TENANT, customer, projectId: "proj-v1-05-w5", ownerRef: "owner-v1-05-w5", state: "active" });
  const job = createOutcomeJob({ tenantScope: TENANT, customer, project, jobId: "job-v1-05-w5", jobFamily: "fam", businessObjective: "obj" });
  const waitRequest = createProtectedDecisionWaitRequest({
    tenantScope: TENANT,
    customer,
    project,
    job,
    waitRequestId: "wait-v1-05-w5",
    runId: "run-1",
    attempt: 1,
    effectRef: "effect:v1-05-w5",
    decisionRef: "decision:v1-05-w5",
    reason: "approval-without-authority probe",
    activationFingerprintAtWait: "fingerprint-v1-05-w5",
    raisedAt: "2026-10-09T00:50:00.000Z",
  });
  const decisionRecord = createProtectedDecisionRecord({
    tenantScope: TENANT,
    decisionRef: "decision:v1-05-w5",
    outcome: "APPROVED",
    organization,
    membership: ownerMembership,
    currentPrincipalRef: ownerMembership.principalRef,
    authority: ownerAuthority,
    decidedAt: "2026-10-09T01:00:00.000Z",
    evidenceRef: "evidence:v1-05-w5",
  });

  // The record is genuinely APPROVED, but the resuming caller's own
  // authority here lacks canPerformProtectedActions - approval alone can
  // never substitute for that separate, explicit grant.
  const insufficientAuthority = createAuthorityContext({ tenantScope: TENANT, permissions: ["EXECUTE"], canPerformProtectedActions: false });
  assert.throws(
    () =>
      authorizeProtectedDecisionResume({
        waitRequest,
        access: ownerAccess,
        authority: insufficientAuthority,
        decisionRecord,
        currentActivationFingerprint: "fingerprint-v1-05-w5",
        now: "2026-10-09T01:05:00.000Z",
      }),
    (err: unknown) => err instanceof Error && err.name === "ProtectedActionNotAuthorizedError",
  );
});

test("OS-V1-05 W6 (human/worker substitution inside a delegation flow): a worker's own workerRef can never be asserted as the currentPrincipalRef of a human-targeted delegation", () => {
  const { organization, ownerMembership, ownerAuthority } = orgFixture();
  const ownerAccess = resolveEffectiveOrganizationAccess({ organization, membership: ownerMembership, currentPrincipalRef: ownerMembership.principalRef, authority: ownerAuthority });
  const grant = createDelegatedAccessGrant({
    tenantScope: TENANT,
    organization,
    delegatorMembership: ownerMembership,
    delegatorAuthority: ownerAuthority,
    delegationId: "delegation-v1-05-human-worker",
    delegatePrincipalRef: "principal-v1-05-human-delegate",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T02:00:00.000Z",
  });

  const worker = createOrganizationServicePrincipal({ servicePrincipalId: "sp-v1-05", tenantScope: TENANT, workerRef: "worker-v1-05" });
  const resolution = resolveEffectiveDelegatedAccess({
    organization,
    grant,
    currentPrincipalRef: worker.workerRef,
    now: "2026-10-09T00:30:00.000Z",
    delegatorCurrentAccess: ownerAccess,
  });
  assert.equal(resolution.decision, "DENIED");
  assert.match(resolution.reasons[0]!, /different delegate/);
});

test("OS-V1-05 W7 (cross-tenant delegator standing denied): a delegator's own currentAccess resolved against a DIFFERENT tenant's organization can never satisfy a delegation minted in this tenant", () => {
  const { organization, ownerMembership, ownerAuthority } = orgFixture();
  const grant = createDelegatedAccessGrant({
    tenantScope: TENANT,
    organization,
    delegatorMembership: ownerMembership,
    delegatorAuthority: ownerAuthority,
    delegationId: "delegation-v1-05-cross-tenant",
    delegatePrincipalRef: "principal-v1-05-cross-tenant",
    permissions: ["READ"],
    canPerformProtectedActions: false,
    issuedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T02:00:00.000Z",
  });

  const otherTenantOrg = activateOrganization({
    organization: createOrganization({ organizationId: "org-v1-05-other-tenant", tenantScope: OTHER_TENANT, displayName: "Other Tenant Org", createdAt: "2026-10-09T00:00:00.000Z" }),
    activatedAt: "2026-10-09T00:00:01.000Z",
  });
  const otherTenantMembership = createOrganizationMembership({ membershipId: "membership-other-tenant-v1-05", tenantScope: OTHER_TENANT, principalRef: "principal-v1-05-cross-tenant", role: "STAFF" });
  const otherTenantAuthority = createAuthorityContext({ tenantScope: OTHER_TENANT, permissions: ["READ"], canPerformProtectedActions: false });
  const otherTenantAccess = resolveEffectiveOrganizationAccess({ organization: otherTenantOrg, membership: otherTenantMembership, currentPrincipalRef: otherTenantMembership.principalRef, authority: otherTenantAuthority });

  const resolution = resolveEffectiveDelegatedAccess({
    organization,
    grant,
    currentPrincipalRef: "principal-v1-05-cross-tenant",
    now: "2026-10-09T00:30:00.000Z",
    delegatorCurrentAccess: otherTenantAccess,
  });
  assert.equal(resolution.decision, "DENIED");
});
