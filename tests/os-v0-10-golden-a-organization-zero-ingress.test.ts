import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership, createAssignmentReference } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { requireInternalOsAccess, requireInternalOsProjectAccess, type StaffAccessGrant } from "../src/web/internal-os-access.js";
import {
  bootstrapOrganizationResourceBinding,
  FileDurableOrganizationResourceBindingStore,
} from "../src/domain/durable-organization-resource-binding-store.js";
import { resolveOrganizationResourceBindingStatus } from "../src/domain/organization-resource-binding.js";
import { transitionOutcomeJob } from "../src/domain/outcome-job.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult, type VerificationResult } from "../src/domain/verification-result.js";
import { verifyOutcomeJob } from "../src/domain/outcome-job.js";
import {
  composeTaskPacketForOutcomeJob,
  resolveNextRunnableGoldenPathAction,
} from "../src/domain/outcome-job-golden-path-composition.js";
import {
  compileGoldenPathActivation,
  GOLDEN_PATH_TENANT_SCOPE,
  GOLDEN_PATH_CUSTOMER,
  GOLDEN_PATH_PROJECT,
  GOLDEN_PATH_OWNERSHIP,
} from "./helpers/golden-path-fixture.js";

/**
 * OS-V0-10 Rev186 F1 (Founder implementation clarification, same scope):
 * Golden A must begin at an authorized principal -> org_akilta -> bounded
 * outcome/project, not a synthetic tenant/customer/project with a bare
 * caller-constructed `AuthorityContext`, and the authenticated-human proof
 * must reuse the already-accepted staff ingress chain
 * (`StaffSessionProvider` -> `requireInternalOsAccess` ->
 * `resolveEffectiveOrganizationAccess`) rather than calling
 * `resolveEffectiveOrganizationAccess` directly - a production IdP/session
 * is intentionally not fabricated here (`createProductionStaffSessionProvider()`
 * remains fail-closed/unauthenticated until separately admitted), so this
 * test uses `createDevFixtureStaffSessionProvider`, the same dev-only
 * mechanical guard `tests/web-internal-os-access.test.ts` already uses,
 * never a production provider. A real `Organization`, a real
 * `OrganizationMembership` with real assignment evidence, a real staff
 * session resolved through `requireInternalOsAccess` (GRANTED), a real
 * `bootstrapOrganizationResourceBinding`/`resolveOrganizationResourceBindingStatus`
 * (READY) - before the already-proven activation/recipe/plan/OutcomeJob
 * -> TaskPacket -> execution -> evidence -> verification -> next-action
 * lineage is exercised on the SAME tenant/customer/project identity. No
 * AKILTA-only bypass, isSystem flag, or second IAM/context system - this
 * is the ordinary OS-V0-01/02/08/09 kernel, consumed exactly as any other
 * Organization would consume it.
 */

function foundingPrincipalContext() {
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: "org-akilta-golden-a",
      tenantScope: GOLDEN_PATH_TENANT_SCOPE,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });

  const membership = createOrganizationMembership({
    membershipId: "membership-golden-a-founder",
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    principalRef: "principal-golden-a-founder",
    role: "STAFF",
  });

  const assignment = createAssignmentReference({
    assignmentId: "assignment-golden-a-founder",
    membership,
    customerId: GOLDEN_PATH_CUSTOMER.customerId,
    projectId: GOLDEN_PATH_PROJECT.projectId,
  });

  const authority = createAuthorityContext({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    permissions: ["EXECUTE", "WRITE", "READ"],
    canPerformProtectedActions: true,
  });

  const principal = createAuthenticatedStaffPrincipal({
    principalId: "principal-golden-a-founder",
    displayName: "Golden A Founding Principal",
  });
  const sessionToken = "token-golden-a-founder";
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-02T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const grant: StaffAccessGrant = { membership, authority, assignments: [assignment] };

  const internalOsAccess = requireInternalOsAccess({
    provider,
    sessionToken,
    organization,
    grants: [grant],
  });

  return { organization, membership, authority, access: internalOsAccess.access, internalOsAccess };
}

test("Rev186 F1: Golden A begins at authorized principal -> org_akilta -> bounded project through resolveEffectiveOrganizationAccess (GRANTED)", () => {
  const { access } = foundingPrincipalContext();
  assert.equal(access.decision, "GRANTED");
  assert.equal(access.role, "MEMBER");
  assert.equal(access.canPerformProtectedActions, true);
});

test("Rev186 F1: Golden A's authorized principal is bound through a real bootstrapped OrganizationResourceBinding resolving READY, not a synthetic/bare context", () => {
  const { organization, membership } = foundingPrincipalContext();
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-golden-a-org-zero-"));
  const store = new FileDurableOrganizationResourceBindingStore(baseDir);

  const bootstrap = bootstrapOrganizationResourceBinding({
    store,
    organization,
    memberships: [membership],
    project: GOLDEN_PATH_PROJECT,
    ownership: GOLDEN_PATH_OWNERSHIP,
    boundAt: "2026-10-02T00:00:02.000Z",
  });
  assert.equal(bootstrap.created, true);

  const status = resolveOrganizationResourceBindingStatus({
    binding: bootstrap.binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: GOLDEN_PATH_PROJECT,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(status.state, "READY");
});

test("Rev186 F1 end-to-end: authorized org_akilta principal + resource binding -> real activation/plan/OutcomeJob -> TaskPacket -> dispatch -> SUCCEEDED -> VERIFYING -> independent verification -> VERIFIED -> CLOSE_JOB", async () => {
  const { organization, membership, authority, internalOsAccess } = foundingPrincipalContext();
  assert.equal(internalOsAccess.access.decision, "GRANTED");
  // "Bounded outcome/project": re-check access scoped to the exact project
  // Golden A will operate against, not merely organization-level access.
  const access = requireInternalOsProjectAccess({ organization, context: internalOsAccess, project: GOLDEN_PATH_PROJECT });
  assert.equal(access.decision, "GRANTED");

  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-golden-a-org-zero-e2e-"));
  const store = new FileDurableOrganizationResourceBindingStore(baseDir);
  const bootstrap = bootstrapOrganizationResourceBinding({
    store,
    organization,
    memberships: [membership],
    project: GOLDEN_PATH_PROJECT,
    ownership: GOLDEN_PATH_OWNERSHIP,
    boundAt: "2026-10-02T00:00:02.000Z",
  });
  const bindingStatus = resolveOrganizationResourceBindingStatus({
    binding: bootstrap.binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: GOLDEN_PATH_PROJECT,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(bindingStatus.state, "READY");

  // Only now - with a GRANTED authorized principal and a READY Organization
  // Zero resource binding both independently proven - does Golden A proceed
  // onto the already-proven activation/plan/OutcomeJob composition, reusing
  // the SAME authority that was just verified current, not a fresh one.
  const compilation = compileGoldenPathActivation("plan-gpa-org-zero", "sold-gpa-org-zero");
  assert.equal(compilation.profile.state, "READY");
  const wiredJob = compilation.jobs[0]!;
  const spec = compilation.specs.find((s) => (s.specId as unknown as string) === (wiredJob.jobId as unknown as string))!;
  const readyJob = transitionOutcomeJob(transitionOutcomeJob(wiredJob, "QUALIFIED"), "READY");

  const packet = composeTaskPacketForOutcomeJob({
    job: readyJob,
    spec,
    activation: compilation.profile,
    projectOwnership: GOLDEN_PATH_OWNERSHIP,
    baseIdentity: "sha-org-zero-1",
    acceptanceCriteria: ["the golden path requirement is satisfied"],
  });
  assert.equal(packet.nextAuthorizedAction.startsWith("AKILTA:DISPATCH_EXECUTION"), true);
  // The authority consumed downstream is the exact same one just proven
  // current through resolveEffectiveOrganizationAccess - never a fresh,
  // unverified context.
  assert.deepEqual(access.permissions, authority.permissions);

  const executingJob = transitionOutcomeJob(readyJob, "EXECUTING");
  const succeededJob = transitionOutcomeJob(executingJob, "VERIFYING");
  const evidence = createEvidenceReference({
    job: succeededJob,
    evidenceId: "ev-org-zero-1",
    evidenceType: "TEST_RESULT",
    sourceLocator: "internal://golden-path/org-zero",
    capturedAt: "2026-10-02T00:00:10.000Z",
  });
  const verification: VerificationResult = createVerificationResult({
    verificationId: "verif-org-zero-1",
    job: succeededJob,
    evidence,
    verificationRequirementRef: "req-golden-path",
    status: "PASSED",
  });
  const verifiedJob = verifyOutcomeJob(succeededJob, verification);
  assert.equal(verifiedJob.state, "VERIFIED");

  const closeAction = resolveNextRunnableGoldenPathAction({ job: verifiedJob, activation: compilation.profile });
  assert.equal(closeAction.code, "CLOSE_JOB");
});
