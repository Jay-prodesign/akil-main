import type { Organization } from "../domain/organization.js";
import type { OrganizationMembership, AssignmentReference } from "../domain/organization-membership.js";
import type { Project } from "../domain/project.js";
import type { OutcomeJob } from "../domain/outcome-job.js";
import type { Permission } from "../domain/authority.js";
import type { EffectiveAccessResolution } from "../domain/effective-organization-access.js";
import type {
  OrganizationBindingActor,
  OrganizationBindingState,
  OrganizationResourceBindingStatus,
} from "../domain/organization-resource-binding.js";
import type { OperationalObservabilityView } from "../domain/operational-observability-view.js";
import {
  requireInternalOsProjectAccess,
  InternalOsAccessDeniedError,
  type InternalOsAccessContext,
} from "./internal-os-access.js";

/**
 * OS-V0-08 Phase A: the fixed, stable Information Architecture - designed
 * once, per Rev168's own instruction ("The full IA is designed once, but
 * visible destinations/actions vary by current effective access"). This
 * array is never filtered by identity; `resolveNavVisibility` below is the
 * one place visibility is computed, from real `EffectiveAccessResolution`
 * truth only - never from `OrganizationAccessRole` alone (Rev168: "OWNER/
 * ADMIN/MEMBER labels never create authority").
 */
export type DestinationKey =
  | "home"
  | "work"
  | "attention"
  | "ai-capabilities"
  | "connections"
  | "knowledge"
  | "people"
  | "products"
  | "admin";

export interface NavDestination {
  readonly key: DestinationKey;
  readonly label: string;
  readonly path: string;
}

export const NAV_DESTINATIONS: ReadonlyArray<NavDestination> = [
  { key: "home", label: "Home", path: "/os/home" },
  { key: "work", label: "Work", path: "/os/work" },
  { key: "attention", label: "Attention", path: "/os/attention" },
  { key: "ai-capabilities", label: "AI & Capabilities", path: "/os/ai-capabilities" },
  { key: "connections", label: "Connections", path: "/os/connections" },
  { key: "knowledge", label: "Knowledge", path: "/os/knowledge" },
  { key: "people", label: "People", path: "/os/people" },
  { key: "products", label: "Products", path: "/os/products" },
  { key: "admin", label: "Admin", path: "/os/admin" },
];

/**
 * Rev170 F1 correction: the stable IA is designed once, but the NINE
 * destinations are no longer uniformly visible to every GRANTED staff
 * member - Rev168/canonical 23B/23C require the projection to differ for
 * broad Founder/high-access, ordinary Member/project-scoped, and
 * restricted fixtures, derived from the CURRENT `EffectiveAccessResolution`
 * permissions/`canPerformProtectedActions` plus real assignment evidence -
 * never from `OrganizationAccessRole`/`OWNER`/`ADMIN` labels, which never
 * create authority (Rev168). `home`/`people`/`products` are the READ-only
 * floor every GRANTED staff member sees (each renders only safe,
 * self-scoped or already-authorized content); `work` requires at least one
 * real project `AssignmentReference` (Rev168: "Project detail requires
 * exact current assignment evidence" - a member with zero assignments has
 * nothing to see there, so the destination itself is hidden rather than
 * merely rendering EMPTY); `admin`/`ai-capabilities`/`connections`/
 * `knowledge` require `WRITE` (organization-shaping destinations, even
 * though Phase A itself exposes no mutating affordance yet); `attention`
 * requires `EXECUTE` or `canPerformProtectedActions` (approvals/execution
 * surface). This is the ONE place visibility is computed - both
 * `resolveNavVisibility` (what is LISTED) and the request handler's own
 * direct-route gate (what is REACHABLE) call this same function, so a
 * destination hidden from navigation cannot be reached by deep-linking
 * either (Rev170: "server-side fail-closed direct access to destinations
 * hidden by that policy").
 */
export function isDestinationVisible(key: DestinationKey, context: InternalOsAccessContext): boolean {
  const access = context.access;
  if (access.decision !== "GRANTED") {
    return false;
  }
  switch (key) {
    case "home":
    case "people":
    case "products":
      return true;
    case "work":
      return context.grant.assignments.some((assignment) => assignment.projectId !== undefined);
    case "attention":
      return access.canPerformProtectedActions || access.permissions.has("EXECUTE");
    case "admin":
    case "ai-capabilities":
    case "connections":
    case "knowledge":
      return access.permissions.has("WRITE");
  }
}

export function resolveNavVisibility(context: InternalOsAccessContext): ReadonlyArray<NavDestination> {
  if (context.access.decision !== "GRANTED") {
    return [];
  }
  return NAV_DESTINATIONS.filter((destination) => isDestinationVisible(destination.key, context));
}

export interface OrganizationSummary {
  readonly displayName: string;
  readonly state: string;
}

export function summarizeOrganization(organization: Organization): OrganizationSummary {
  return { displayName: organization.displayName, state: organization.state };
}

export interface AccessSummary {
  readonly role: string;
  readonly permissions: ReadonlyArray<Permission>;
  readonly canPerformProtectedActions: boolean;
}

const PERMISSION_ORDER: ReadonlyArray<Permission> = ["READ", "WRITE", "EXECUTE"];

export function summarizeAccess(access: EffectiveAccessResolution): AccessSummary {
  return {
    role: access.role ?? "MEMBER",
    permissions: PERMISSION_ORDER.filter((permission) => access.permissions.has(permission)),
    canPerformProtectedActions: access.canPerformProtectedActions,
  };
}

/**
 * Caller-injected read source for "Work" project listings - no
 * `ProjectStore`/`ProjectPort` exists anywhere in this repository today
 * (confirmed by repo-wide inspection), so this module invents no
 * persistence of its own. An absent source (the honest production default
 * until such a store is separately authorized) renders `NOT_ACTIVE`, never
 * fabricated content - mirroring `request-handler.ts`'s own optional
 * `teamAttentionSource?` pattern exactly.
 */
export interface WorkProjectSource {
  getProject(input: {
    tenantId: Organization["tenantId"];
    customerId: string;
    projectId: string;
  }): Project | undefined;
}

/**
 * Caller-injected read source for a project's OutcomeJob listing. A real
 * `DurableOutcomeJobStore`/`AsyncOutcomeJobStore` (OS-V0-03) can satisfy
 * this structurally, but wiring a real store into production is an
 * explicit later decision (Rev168: "Avoid touching OS-V0-05 runtime except
 * if... otherwise treat as read-only accepted substrate" - the same
 * discipline extends to OS-V0-03's own store here) - Phase A itself takes
 * only the narrow `listJobs` shape it actually renders.
 */
export interface WorkJobSource {
  listJobs(project: Project): ReadonlyArray<OutcomeJob>;
}

export interface JobSummary {
  readonly jobId: string;
  readonly jobFamily: string;
  readonly state: string;
}

export type JobsViewState =
  | { readonly kind: "NOT_ACTIVE" }
  | { readonly kind: "READY"; readonly jobs: ReadonlyArray<JobSummary> };

export interface ProjectSummary {
  readonly customerId: string;
  readonly projectId: string;
  readonly state: string;
  readonly jobs: JobsViewState;
}

export type WorkViewState =
  | { readonly kind: "NOT_ACTIVE" }
  | { readonly kind: "EMPTY" }
  | { readonly kind: "READY"; readonly projects: ReadonlyArray<ProjectSummary> };

function summarizeJobs(project: Project, jobSource: WorkJobSource | undefined): JobsViewState {
  if (jobSource === undefined) {
    return { kind: "NOT_ACTIVE" };
  }
  const jobs = jobSource.listJobs(project).map((job) => ({
    jobId: job.jobId,
    jobFamily: job.jobFamily,
    state: job.state,
  }));
  return { kind: "READY", jobs };
}

/**
 * Lists only the projects the CURRENT membership has exact
 * `AssignmentReference` evidence for (per Rev168: "Project detail requires
 * exact current assignment evidence") - never every project in the
 * organization/tenant. `projectSource` absent renders the whole destination
 * `NOT_ACTIVE`; present but unable to resolve a specific assigned
 * `projectId` (a data inconsistency between assignment evidence and the
 * project source) silently omits that one entry rather than fabricating a
 * placeholder project.
 */
export function resolveWorkView(input: {
  context: InternalOsAccessContext;
  projectSource: WorkProjectSource | undefined;
  jobSource: WorkJobSource | undefined;
}): WorkViewState {
  if (input.projectSource === undefined) {
    return { kind: "NOT_ACTIVE" };
  }
  const tenantId = input.context.membership.tenantId;
  const projectAssignments = input.context.grant.assignments.filter(
    (assignment) => assignment.projectId !== undefined,
  );
  const projects: ProjectSummary[] = [];
  for (const assignment of projectAssignments) {
    const project = input.projectSource.getProject({
      tenantId,
      customerId: assignment.customerId,
      projectId: assignment.projectId as string,
    });
    if (project === undefined) {
      continue;
    }
    projects.push({
      customerId: project.customerId,
      projectId: project.projectId,
      state: project.state,
      jobs: summarizeJobs(project, input.jobSource),
    });
  }
  if (projects.length === 0) {
    return { kind: "EMPTY" };
  }
  return { kind: "READY", projects };
}

export type WorkProjectDetailViewState =
  | { readonly kind: "NOT_ACTIVE" }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "FORBIDDEN" }
  | { readonly kind: "READY"; readonly project: ProjectSummary };

/**
 * Project-detail resolution deliberately re-proves assignment via
 * `requireInternalOsProjectAccess` even though `resolveWorkView` above
 * already filters the LIST to assigned projects - a caller could reach
 * this route by deep-linking a `customerId`/`projectId` it was never shown
 * (Rev168 mandatory test: "deep-linking hidden routes must fail server-
 * side"). `NOT_FOUND` (no such project) and `FORBIDDEN` (project exists but
 * this membership has no assignment evidence for it) are deliberately
 * distinct outcomes - a caller cannot use response shape to enumerate real
 * project ids it lacks access to, since `NOT_FOUND` is the FIRST check
 * here, always before assignment is ever tested.
 */
export function resolveWorkProjectDetailView(input: {
  organization: Organization;
  context: InternalOsAccessContext;
  projectSource: WorkProjectSource | undefined;
  jobSource: WorkJobSource | undefined;
  customerId: string;
  projectId: string;
}): WorkProjectDetailViewState {
  if (input.projectSource === undefined) {
    return { kind: "NOT_ACTIVE" };
  }
  const project = input.projectSource.getProject({
    tenantId: input.organization.tenantId,
    customerId: input.customerId,
    projectId: input.projectId,
  });
  if (project === undefined) {
    return { kind: "NOT_FOUND" };
  }
  try {
    requireInternalOsProjectAccess({ organization: input.organization, context: input.context, project });
  } catch (error) {
    if (error instanceof InternalOsAccessDeniedError) {
      return { kind: "FORBIDDEN" };
    }
    throw error;
  }
  return {
    kind: "READY",
    project: {
      customerId: project.customerId,
      projectId: project.projectId,
      state: project.state,
      jobs: summarizeJobs(project, input.jobSource),
    },
  };
}

export interface HomeViewState {
  readonly kind: "READY";
  readonly organization: OrganizationSummary;
  readonly access: AccessSummary;
  readonly work: WorkViewState;
}

export function resolveHomeView(input: {
  organization: Organization;
  context: InternalOsAccessContext;
  projectSource: WorkProjectSource | undefined;
  jobSource: WorkJobSource | undefined;
}): HomeViewState {
  return {
    kind: "READY",
    organization: summarizeOrganization(input.organization),
    access: summarizeAccess(input.context.access),
    work: resolveWorkView({
      context: input.context,
      projectSource: input.projectSource,
      jobSource: input.jobSource,
    }),
  };
}

/**
 * Attention/Approvals, AI & Capabilities, Connections, Knowledge/Evidence:
 * Phase A has no real backing source for any of these (Rev168's own
 * boundary: "no OS-V0-06/07/13 backend implementation"). Rendering a
 * truthful `NOT_ACTIVE` state for all four is the honest Phase A answer -
 * "Missing data source must degrade to explicit UNAVAILABLE rather than
 * fabricate content."
 */
export type NotActiveViewState = { readonly kind: "NOT_ACTIVE" };

export function resolveNotActiveView(): NotActiveViewState {
  return { kind: "NOT_ACTIVE" };
}

export interface PeopleViewState {
  readonly kind: "READY";
  readonly self: {
    readonly principalDisplayName: string;
    readonly organizationRole: string;
    readonly membershipState: string;
  };
}

/**
 * People: Phase A shows only the CURRENT viewer's own membership - no
 * directory-listing source exists anywhere in this repository (there is no
 * "list all memberships in a tenant" port), so rendering a broader
 * directory would require fabricating one. This is an honest, narrow but
 * real projection rather than a placeholder.
 */
export function resolvePeopleView(input: { context: InternalOsAccessContext }): PeopleViewState {
  return {
    kind: "READY",
    self: {
      principalDisplayName: input.context.session.principal.displayName,
      organizationRole: input.context.membership.role,
      membershipState: input.context.membership.state,
    },
  };
}

export interface ProductLineSummary {
  readonly name: string;
  readonly status: "ACTIVE" | "NOT_ACTIVE";
}

export interface ProductsViewState {
  readonly kind: "READY";
  readonly products: ReadonlyArray<ProductLineSummary>;
}

/**
 * Products: Rev168 explicitly forbids "purchase/commercial activation
 * implication." The only product line this Phase A build can honestly
 * claim `ACTIVE` for is this internal shell itself - every other
 * conceivable product line is declared `NOT_ACTIVE` rather than invented.
 */
export function resolveProductsView(): ProductsViewState {
  return {
    kind: "READY",
    products: [
      { name: "AKILTA OS (this internal shell)", status: "ACTIVE" },
      { name: "AKILTA Commerce", status: "NOT_ACTIVE" },
    ],
  };
}

/**
 * Rev183 F3: caller-injected read source for the Organization's current
 * resource-binding status - mirrors `WorkProjectSource`/`WorkJobSource`'s
 * own established optional-source pattern exactly. No durable
 * `OrganizationResourceBinding` store is wired into production Admin/shell
 * composition yet (a separate, later decision - the same discipline
 * `resolveWorkView` already applies to `WorkProjectSource`), so an absent
 * source renders `NOT_ACTIVE`, never fabricated content. `resolveStatus`
 * returning `undefined` means the Organization has genuinely never been
 * bootstrapped yet (no `OrganizationResourceBinding` exists for it) - a
 * legitimate, distinct `NOT_BOUND` state, never conflated with `NOT_ACTIVE`
 * (no source wired) or a fabricated `READY`.
 */
export interface OrganizationResourceBindingSource {
  resolveStatus(organization: Organization): OrganizationResourceBindingStatus | undefined;
}

export interface AdminResourceBindingSummary {
  readonly state: OrganizationBindingState;
  readonly nextRequiredActor: OrganizationBindingActor;
  readonly nextRequiredActionCode?: string;
  readonly nextRequiredActionReason?: string;
  readonly unresolvedGates: ReadonlyArray<string>;
}

export type AdminResourceBindingViewState =
  | { readonly kind: "NOT_ACTIVE" }
  | { readonly kind: "NOT_BOUND" }
  | { readonly kind: "READY"; readonly summary: AdminResourceBindingSummary };

/**
 * Rev183 F3: the smallest read-only projection of
 * `resolveOrganizationResourceBindingStatus`'s own truth - state, next
 * required actor/action, and unresolved gates only, never a richer or
 * re-derived status of its own. No mutation affordance is added anywhere;
 * this function cannot bootstrap, re-bind, or change anything.
 */
export function resolveResourceBindingView(
  organization: Organization,
  source: OrganizationResourceBindingSource | undefined,
): AdminResourceBindingViewState {
  if (source === undefined) {
    return { kind: "NOT_ACTIVE" };
  }
  const status = source.resolveStatus(organization);
  if (status === undefined) {
    return { kind: "NOT_BOUND" };
  }
  return {
    kind: "READY",
    summary: {
      state: status.state,
      nextRequiredActor: status.nextRequiredActor,
      ...(status.nextRequiredAction !== undefined
        ? {
            nextRequiredActionCode: status.nextRequiredAction.code,
            nextRequiredActionReason: status.nextRequiredAction.reason,
          }
        : {}),
      unresolvedGates: status.unresolvedGates,
    },
  };
}

/**
 * OS-V0-12: caller-injected read source for the Organization's current
 * operational observability view - mirrors `OrganizationResourceBindingSource`'s
 * own established optional-source pattern exactly. No durable wiring exists
 * in production Admin/shell composition yet (a separate, later decision,
 * the same discipline already applied to `resourceBindingSource` by Rev183
 * F3 and only threaded into the live `/os/admin` route by the later Rev184
 * F3-residual correction); an absent source renders `NOT_ACTIVE`, never
 * fabricated content. A wired source always returns a real (possibly
 * empty-dimensioned) `OperationalObservabilityView` - there is no separate
 * "never bootstrapped" state here, since every dimension of the view is
 * already independently optional/empty by construction.
 */
export interface OperationalObservabilitySource {
  resolveView(organization: Organization): OperationalObservabilityView;
}

export type OperationalObservabilityViewState =
  | { readonly kind: "NOT_ACTIVE" }
  | { readonly kind: "READY"; readonly view: OperationalObservabilityView };

export function resolveOperationalObservabilityView(
  organization: Organization,
  source: OperationalObservabilitySource | undefined,
): OperationalObservabilityViewState {
  if (source === undefined) {
    return { kind: "NOT_ACTIVE" };
  }
  return { kind: "READY", view: source.resolveView(organization) };
}

export interface AdminViewState {
  readonly kind: "READY";
  readonly organization: OrganizationSummary;
  readonly access: AccessSummary;
  readonly resourceBinding: AdminResourceBindingViewState;
  readonly operationalObservability: OperationalObservabilityViewState;
  readonly notActiveConcepts: ReadonlyArray<string>;
}

const ADMIN_NOT_ACTIVE_CONCEPTS: ReadonlyArray<string> = [
  "Workers",
  "Connections",
  "Policies",
  "Defaults",
  "Approvals",
  "Usage",
  "Audit",
  "Kill-switch",
];

/**
 * Admin/Settings: a safe read-only inventory of organization/access truth
 * this package already resolved (never any richer data), plus an explicit
 * list of the concepts Rev168 names that have no backing source yet, plus
 * (Rev183 F3) the Organization's own current resource-binding
 * explainability - what is bound, missing/blocked, and why. No mutating
 * control exists anywhere in this view - Phase A exposes zero
 * write/execute affordances of any kind, so "ADMIN label + READ-only
 * authority exposes no active write/execute CTA" holds by construction
 * (see `os-v0-08-boundary-scan.test.ts`).
 */
export function resolveAdminView(input: {
  organization: Organization;
  context: InternalOsAccessContext;
  resourceBindingSource?: OrganizationResourceBindingSource;
  operationalObservabilitySource?: OperationalObservabilitySource;
}): AdminViewState {
  return {
    kind: "READY",
    organization: summarizeOrganization(input.organization),
    access: summarizeAccess(input.context.access),
    resourceBinding: resolveResourceBindingView(input.organization, input.resourceBindingSource),
    operationalObservability: resolveOperationalObservabilityView(input.organization, input.operationalObservabilitySource),
    notActiveConcepts: ADMIN_NOT_ACTIVE_CONCEPTS,
  };
}

export interface OrganizationMembershipEvidence {
  readonly membership: OrganizationMembership;
  readonly assignments: ReadonlyArray<AssignmentReference>;
}
