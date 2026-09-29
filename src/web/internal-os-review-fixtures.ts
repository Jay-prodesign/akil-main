import { createTenantScope } from "../domain/tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "../domain/organization.js";
import { createCustomer } from "../domain/customer.js";
import { createProject, type Project } from "../domain/project.js";
import { createOutcomeJob, type OutcomeJob } from "../domain/outcome-job.js";
import { createOrganizationMembership, createAssignmentReference } from "../domain/organization-membership.js";
import { createOrganizationAccessRoleContext } from "../domain/organization-access-role.js";
import { createAuthorityContext } from "../domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "./staff-session-context.js";
import { createAuthenticatedPrincipal, createSessionContext, type SessionContext } from "./session-context.js";
import { createOrganizationServicePrincipal, type OrganizationServicePrincipal } from "../domain/organization-service-principal.js";
import type { StaffAccessGrant } from "./internal-os-access.js";
import type { WorkProjectSource, WorkJobSource } from "./internal-os-view-state.js";

/**
 * Rev168 "FOUNDER REVIEW FIXTURES": deterministic, non-production
 * fixture data ONLY - never wired into `createProductionStaffSessionProvider`
 * or a production `isProduction: true` internal OS server (which always
 * uses that unauthenticated production provider regardless of what this
 * module exports). This mirrors `dev-fixture-staff-session-provider.ts`'s
 * own construction-time production guard: even if a caller mistakenly
 * wired these fixtures into a `createDevFixtureStaffSessionProvider` call
 * with `isProduction: true`, that call throws before returning a usable
 * provider - the fail-closed boundary does not depend on this module
 * behaving correctly.
 */
const REVIEW_TENANT_SCOPE = createTenantScope("tenant-os-v0-08-review");

export const REVIEW_ORGANIZATION: Organization = activateOrganization({
  organization: createOrganization({
    organizationId: "org-os-v0-08-review",
    tenantScope: REVIEW_TENANT_SCOPE,
    displayName: "AKILTA (Review)",
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
  activatedAt: "2026-01-01T00:00:00.000Z",
});

const REVIEW_CUSTOMER = createCustomer({
  tenantScope: REVIEW_TENANT_SCOPE,
  customerId: "customer-os-v0-08-review",
  displayName: "Review Customer",
});

export const REVIEW_PROJECT_ALPHA: Project = createProject({
  tenantScope: REVIEW_TENANT_SCOPE,
  customer: REVIEW_CUSTOMER,
  projectId: "project-alpha",
  ownerRef: "owner-alpha",
  state: "active",
});

export const REVIEW_PROJECT_BETA: Project = createProject({
  tenantScope: REVIEW_TENANT_SCOPE,
  customer: REVIEW_CUSTOMER,
  projectId: "project-beta",
  ownerRef: "owner-beta",
  state: "active",
});

const REVIEW_PROJECTS: ReadonlyArray<Project> = [REVIEW_PROJECT_ALPHA, REVIEW_PROJECT_BETA];

const REVIEW_JOBS: ReadonlyArray<OutcomeJob> = [
  createOutcomeJob({
    tenantScope: REVIEW_TENANT_SCOPE,
    customer: REVIEW_CUSTOMER,
    project: REVIEW_PROJECT_ALPHA,
    jobId: "job-alpha-1",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver review website",
  }),
];

export interface StaffReviewFixture {
  readonly key: "founder-admin" | "member" | "restricted";
  readonly description: string;
  readonly sessionToken: string;
  readonly session: StaffSessionContext;
  readonly grant: StaffAccessGrant;
}

/**
 * Fixture A - "Broad internal Founder/Admin review fixture": explicit
 * ACTIVE staff membership, a curated OWNER access-role label, and a
 * deliberately high-access TEST AuthorityContext (READ+WRITE+EXECUTE,
 * `canPerformProtectedActions: true`). This is a test/review fixture, not a
 * hidden production superuser - it is unreachable in production (see this
 * module's own top doc comment).
 */
const founderSession = createAuthenticatedStaffPrincipal({ principalId: "staff-founder", displayName: "Founder Review" });
const founderMembership = createOrganizationMembership({
  membershipId: "membership-founder",
  tenantScope: REVIEW_TENANT_SCOPE,
  principalRef: founderSession.principalId,
  role: "STAFF",
});
export const FOUNDER_REVIEW_FIXTURE: StaffReviewFixture = {
  key: "founder-admin",
  description: "Broad internal Founder/Admin review fixture (A): ACTIVE membership, curated OWNER label, high-access TEST authority.",
  sessionToken: "dev-staff-founder",
  session: { principal: founderSession, issuedAt: "2026-01-01T00:00:00.000Z" },
  grant: {
    membership: founderMembership,
    authority: createAuthorityContext({
      tenantScope: REVIEW_TENANT_SCOPE,
      permissions: ["READ", "WRITE", "EXECUTE"],
      canPerformProtectedActions: true,
    }),
    assignments: REVIEW_PROJECTS.map((project, index) =>
      createAssignmentReference({
        assignmentId: `assignment-founder-${index}`,
        membership: founderMembership,
        customerId: project.customerId,
        projectId: project.projectId,
      }),
    ),
    roleContext: createOrganizationAccessRoleContext({ membership: founderMembership, role: "OWNER" }),
  },
};

/**
 * Fixture B - "Normal MEMBER fixture": ACTIVE membership + READ permission
 * plus exactly one selected project assignment (`project-alpha`, not
 * `project-beta`) - proves this fixture sees assigned Work and safe read
 * surfaces, but never a project it is not assigned to.
 */
const memberSession = createAuthenticatedStaffPrincipal({ principalId: "staff-member", displayName: "Member Review" });
const memberMembership = createOrganizationMembership({
  membershipId: "membership-member",
  tenantScope: REVIEW_TENANT_SCOPE,
  principalRef: memberSession.principalId,
  role: "STAFF",
});
export const MEMBER_REVIEW_FIXTURE: StaffReviewFixture = {
  key: "member",
  description: "Normal MEMBER fixture (B): ACTIVE membership, READ only, assigned to project-alpha only.",
  sessionToken: "dev-staff-member",
  session: { principal: memberSession, issuedAt: "2026-01-01T00:00:00.000Z" },
  grant: {
    membership: memberMembership,
    authority: createAuthorityContext({
      tenantScope: REVIEW_TENANT_SCOPE,
      permissions: ["READ"],
      canPerformProtectedActions: false,
    }),
    assignments: [
      createAssignmentReference({
        assignmentId: "assignment-member-alpha",
        membership: memberMembership,
        customerId: REVIEW_PROJECT_ALPHA.customerId,
        projectId: REVIEW_PROJECT_ALPHA.projectId,
      }),
    ],
  },
};

/**
 * Fixture C - "Restricted fixture": ACTIVE membership + READ only + zero
 * project assignments - sees only organization-safe state (Home, People,
 * Products, Admin's own safe inventory), never any project.
 */
const restrictedSession = createAuthenticatedStaffPrincipal({ principalId: "staff-restricted", displayName: "Restricted Review" });
const restrictedMembership = createOrganizationMembership({
  membershipId: "membership-restricted",
  tenantScope: REVIEW_TENANT_SCOPE,
  principalRef: restrictedSession.principalId,
  role: "STAFF",
});
export const RESTRICTED_REVIEW_FIXTURE: StaffReviewFixture = {
  key: "restricted",
  description: "Restricted fixture (C): ACTIVE membership, READ only, no project assignments.",
  sessionToken: "dev-staff-restricted",
  session: { principal: restrictedSession, issuedAt: "2026-01-01T00:00:00.000Z" },
  grant: {
    membership: restrictedMembership,
    authority: createAuthorityContext({
      tenantScope: REVIEW_TENANT_SCOPE,
      permissions: ["READ"],
      canPerformProtectedActions: false,
    }),
    assignments: [],
  },
};

export const ALL_STAFF_REVIEW_FIXTURES: ReadonlyArray<StaffReviewFixture> = [
  FOUNDER_REVIEW_FIXTURE,
  MEMBER_REVIEW_FIXTURE,
  RESTRICTED_REVIEW_FIXTURE,
];

export function buildReviewStaffSessionFixtureMap(): ReadonlyMap<string, StaffSessionContext> {
  const map = new Map<string, StaffSessionContext>();
  for (const fixture of ALL_STAFF_REVIEW_FIXTURES) {
    map.set(fixture.sessionToken, fixture.session);
  }
  return map;
}

export function buildReviewStaffAccessGrants(): ReadonlyArray<StaffAccessGrant> {
  return ALL_STAFF_REVIEW_FIXTURES.map((fixture) => fixture.grant);
}

/**
 * Fixture D - "Negative identity fixtures": a genuine customer
 * `SessionContext` and a genuine `OrganizationServicePrincipal`, proving
 * (via `tests/web-internal-os-access.test.ts`) that neither identity family
 * can satisfy `StaffSessionProvider.resolveStaffSession` - they are
 * structurally disjoint types, so no adapter exists that could even attempt
 * to pass one where a `StaffSessionContext` is required.
 */
export const NEGATIVE_CUSTOMER_SESSION: SessionContext = createSessionContext({
  principal: createAuthenticatedPrincipal({
    principalId: "customer-principal-review",
    tenantId: REVIEW_TENANT_SCOPE.tenantId,
    customerId: REVIEW_CUSTOMER.customerId,
    displayName: "Review Customer Contact",
  }),
  issuedAt: "2026-01-01T00:00:00.000Z",
});

export const NEGATIVE_SERVICE_PRINCIPAL: OrganizationServicePrincipal = createOrganizationServicePrincipal({
  servicePrincipalId: "service-principal-review",
  tenantScope: REVIEW_TENANT_SCOPE,
  workerRef: "worker-review",
});

/**
 * Deterministic in-memory `WorkProjectSource`/`WorkJobSource` for the local
 * dogfood bootstrap and for tests - never a durable production store.
 */
export function buildReviewWorkProjectSource(): WorkProjectSource {
  return {
    getProject(input) {
      return REVIEW_PROJECTS.find(
        (project) =>
          project.tenantId === input.tenantId &&
          project.customerId === input.customerId &&
          project.projectId === input.projectId,
      );
    },
  };
}

export function buildReviewWorkJobSource(): WorkJobSource {
  return {
    listJobs(project) {
      return REVIEW_JOBS.filter((job) => job.projectId === project.projectId && job.customerId === project.customerId);
    },
  };
}
