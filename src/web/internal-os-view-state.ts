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
import type { Customer } from "../domain/customer.js";
import type { CustomerOffboardingRequest, CustomerOffboardingRequestId } from "../domain/customer-offboarding.js";
import type { StoredConnectorConnection } from "../domain/durable-connector-connection-store.js";
import { buildConnectorCatalog } from "../domain/integration-connector-catalog.js";
import { buildIntegrationsAdminView, type IntegrationConnectionSummary } from "../domain/integration-admin-view.js";
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
 *
 * C3 People slice: `people` deliberately stays on the READ floor - every
 * GRANTED staff member keeps seeing their own membership exactly as before
 * C3. When a `PeopleDirectorySource` is wired, `resolvePeopleView` ALSO
 * requires WRITE before it includes the Organization-wide membership
 * roster (every other member's role and lifecycle state, including
 * REVOKED) - a READ-only viewer gets the unchanged self-only page, not a
 * 403. The roster itself is limited to `PeopleDirectoryEntry`'s allow-list
 * (principal reference, role, state), so revocation reasons and
 * timestamps never reach either floor.
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
 *
 * C1 update: no longer true. `DurableProjectStore` exists (PROJ-DURABLE-001),
 * and the deployable runtime (`node-server-entrypoint.ts`) wires
 * `createDurableWorkProjectSource` into this port on the live `/os` route.
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
 *
 * C1 update: the deployable runtime (`node-server-entrypoint.ts`) now wires
 * `createDurableWorkJobSource` (WORK-JOB-SOURCE-001, over
 * `FileDurableOutcomeJobStore`) into this port on the live `/os` route.
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
 *
 * C3 (gap scan 2026-10-23) update: Connections now has a real source port
 * (`ConnectionsSource` / `resolveConnectionsView` below). It still renders
 * this same `NOT_ACTIVE` state when no source is wired. Attention, AI &
 * Capabilities and Knowledge are unchanged.
 */
export type NotActiveViewState = { readonly kind: "NOT_ACTIVE" };

export function resolveNotActiveView(): NotActiveViewState {
  return { kind: "NOT_ACTIVE" };
}

/**
 * C3 (gap scan 2026-10-23): caller-injected read source for the
 * Organization's connector connections, for the dedicated `/os/connections`
 * destination. It follows the same optional-source pattern as
 * `OperationalObservabilitySource`: an absent source renders `NOT_ACTIVE`,
 * never fabricated content. The deployable runtime wires
 * `createDurableConnectionsSource` (over `FileDurableConnectorConnectionStore`)
 * here.
 *
 * Contract: returns every stored connection for the Organization's tenant.
 * A read or replay failure THROWS. It must never be reported as an empty
 * list, which is the same rule `InternalOsOrganizationSource` and
 * `InternalOsStaffAccessGrantSource` follow (a storage error is never
 * relabeled as absence).
 *
 * The port deliberately returns the raw `StoredConnectorConnection` rather
 * than a pre-masked shape. Masking happens in `resolveConnectionsView`, so
 * every source, including a faulty one, goes through the one existing
 * secret-masking read model.
 */
export interface ConnectionsSource {
  listConnections(organization: Organization): ReadonlyArray<StoredConnectorConnection>;
}

/**
 * - `NOT_ACTIVE`: no source is wired (the pre-C3 default).
 * - `ERROR`: the source threw, or returned a record that belongs to a
 *   different tenant. Rendered as the OS ERROR page (500), never as EMPTY.
 * - `EMPTY`: the source was read successfully and this tenant has no
 *   connections.
 * - `READY`: at least one connection, already masked.
 *
 * `EMPTY` and `NOT_ACTIVE` are kept distinct on purpose: "this build has no
 * data source for this page" and "this organization has configured no
 * connections" are different facts. Collapsing them would tell a staff
 * member something false in one of the two cases.
 */
export type ConnectionsViewState =
  | { readonly kind: "NOT_ACTIVE" }
  | { readonly kind: "ERROR" }
  | { readonly kind: "EMPTY" }
  | { readonly kind: "READY"; readonly connections: ReadonlyArray<IntegrationConnectionSummary> };

/**
 * `buildIntegrationsAdminView` also lists the connector catalog. This
 * repository has no production connector catalog, and this page shows only
 * connection instances, so it is given an empty one. Only `.connections` is
 * read from its result.
 */
const NO_CONNECTOR_CATALOG = buildConnectorCatalog([]);

/**
 * Secret masking: every connection goes through CONN-001's own
 * `buildIntegrationsAdminView`. Its `IntegrationConnectionSummary` type has
 * no field that can hold a `secretRef`, so a secret reference cannot reach
 * the rendered page.
 *
 * Tenant isolation: each returned record's own `binding.ownership.tenantId`
 * is re-checked against the Organization's `tenantId`. A mismatch makes the
 * whole view `ERROR`. It is not filtered out silently, because dropping the
 * record could turn a contaminated read into `EMPTY` ("no connections"),
 * which is the relabeling the port contract above forbids.
 * `FileDurableConnectorConnectionStore` already throws on this case during
 * replay. This check covers any other implementation of the port.
 */
export function resolveConnectionsView(
  organization: Organization,
  source: ConnectionsSource | undefined,
): ConnectionsViewState {
  if (source === undefined) {
    return { kind: "NOT_ACTIVE" };
  }
  let stored: ReadonlyArray<StoredConnectorConnection>;
  try {
    stored = source.listConnections(organization);
  } catch {
    // A read/replay failure (e.g. CorruptedConnectorConnectionFileError) is
    // never relabeled as EMPTY ("no connections") or left to escape as an
    // uncaught exception - it is this view state's own ERROR, exactly like
    // the tenant-mismatch check just below.
    return { kind: "ERROR" };
  }
  if (stored.some((record) => record.instance.binding.ownership.tenantId !== organization.tenantId)) {
    return { kind: "ERROR" };
  }
  if (stored.length === 0) {
    return { kind: "EMPTY" };
  }
  const { connections } = buildIntegrationsAdminView({ catalog: NO_CONNECTOR_CATALOG, connections: stored });
  return { kind: "READY", connections };
}

/**
 * C3 People slice (gap scan 2026-10-23): caller-injected read source for the
 * Organization's membership roster, for the `/os/people` destination. Same
 * optional-source pattern as `ConnectionsSource`: an absent source leaves
 * the page exactly as it was before (the viewer's own membership only). The
 * deployable runtime wires `createDurablePeopleDirectorySource` (over the
 * runtime's single `FileDurableOrganizationMembershipStore`) here.
 *
 * Contract: returns every stored membership for the Organization's tenant,
 * `ACTIVE` and `REVOKED` alike. A read or replay failure THROWS. It must
 * never be reported as an empty list (a storage error is never relabeled
 * as absence).
 *
 * The port returns the raw `OrganizationMembership`, not a pre-masked
 * shape. Field selection happens in `resolvePeopleView`, so every source,
 * including a faulty one, goes through the same allow-list.
 */
export interface PeopleDirectorySource {
  listMemberships(organization: Organization): ReadonlyArray<OrganizationMembership>;
}

/**
 * One roster row. This is an allow-list of the only membership fields that
 * are shown: the principal reference, the organization role and the
 * lifecycle state.
 *
 * Left out on purpose:
 * - `revokedReason`: free text written when a membership is revoked. It can
 *   carry personnel detail, and `/os/people` is on the READ floor that
 *   every GRANTED staff member reaches.
 * - `revokedAt`: when someone was removed is not needed to read a
 *   directory. `state` already says the membership is `REVOKED`.
 * - `membershipId` and `tenantId`: internal keys. The tenant is the page's
 *   own Organization by construction.
 *
 * No display name exists here. `OrganizationMembership` stores only an
 * opaque `principalRef`, and this repository has no staff-principal
 * directory to resolve a name from (the viewer's own display name comes
 * from their authenticated session, which is why only the self-section has
 * one). The roster shows the reference as stored rather than inventing a
 * name.
 */
export interface PeopleDirectoryEntry {
  readonly principalRef: string;
  readonly organizationRole: OrganizationMembership["role"];
  readonly membershipState: OrganizationMembership["state"];
}

/**
 * - `ERROR`: the source threw, or returned a membership that belongs to a
 *   different tenant. `peoplePageContent` renders the OS ERROR page (500),
 *   never an empty roster.
 * - `READY`: the source was read successfully. `members` may be empty only
 *   if the source truly has no memberships for this tenant.
 */
export type PeopleDirectoryViewState =
  | { readonly kind: "ERROR" }
  | { readonly kind: "READY"; readonly members: ReadonlyArray<PeopleDirectoryEntry> };

/**
 * `self` is the viewer's own membership, resolved from the authenticated
 * access context. It is always present and unchanged by C3.
 *
 * `roster` is optional so the pre-C3 shape stays valid: absent means no
 * `PeopleDirectorySource` is wired, and the page renders exactly what it
 * rendered before C3.
 */
export interface PeopleViewState {
  readonly kind: "READY";
  readonly self: {
    readonly principalDisplayName: string;
    readonly organizationRole: string;
    readonly membershipState: string;
  };
  readonly roster?: PeopleDirectoryViewState;
}

function comparePeopleDirectoryOrder(a: OrganizationMembership, b: OrganizationMembership): number {
  if (a.principalRef !== b.principalRef) {
    return a.principalRef < b.principalRef ? -1 : 1;
  }
  if (a.membershipId !== b.membershipId) {
    return a.membershipId < b.membershipId ? -1 : 1;
  }
  return 0;
}

/**
 * Tenant isolation follows `resolveConnectionsView`: each returned
 * membership's own `tenantId` is re-checked against the Organization's. A
 * mismatch makes the whole roster `ERROR` instead of being dropped, because
 * dropping it could turn a contaminated read into a shorter (or empty)
 * roster that looks correct. `FileDurableOrganizationMembershipStore`
 * already throws on this case during replay; this check covers any other
 * implementation of the port.
 */
function resolvePeopleDirectoryView(
  organization: Organization,
  source: PeopleDirectorySource,
): PeopleDirectoryViewState {
  let memberships: ReadonlyArray<OrganizationMembership>;
  try {
    memberships = source.listMemberships(organization);
  } catch {
    // A read/replay failure (e.g. CorruptedOrganizationMembershipFileError,
    // or a lock timeout) is this roster's own ERROR, never an empty list.
    return { kind: "ERROR" };
  }
  if (memberships.some((membership) => membership.tenantId !== organization.tenantId)) {
    return { kind: "ERROR" };
  }
  const members = [...memberships].sort(comparePeopleDirectoryOrder).map((membership) => ({
    principalRef: membership.principalRef,
    organizationRole: membership.role,
    membershipState: membership.state,
  }));
  return { kind: "READY", members };
}

/**
 * People: Phase A showed only the CURRENT viewer's own membership, because
 * no "list all memberships in a tenant" source existed. C3 People slice:
 * one exists now (`FileDurableOrganizationMembershipStore.listByTenant`,
 * reached through `PeopleDirectorySource`). When `directory` is given, the
 * view also carries the tenant's roster. The self-section is unchanged
 * either way. When `directory` is absent, the result is exactly the pre-C3
 * value (no `roster` key at all).
 */
export function resolvePeopleView(input: {
  readonly context: InternalOsAccessContext;
  readonly directory?: { readonly organization: Organization; readonly source: PeopleDirectorySource };
}): PeopleViewState {
  const self = {
    principalDisplayName: input.context.session.principal.displayName,
    organizationRole: input.context.membership.role,
    membershipState: input.context.membership.state,
  };
  // The `people` destination itself stays on the READ floor (every GRANTED
  // staff member can see their own membership, exactly as before C3). The
  // roster is new, broader exposure - every OTHER member's role and
  // lifecycle state, including REVOKED - so it additionally requires
  // WRITE, the same bar `isDestinationVisible` already applies to
  // `connections`/`admin`/`knowledge` for comparable reasons. A READ-only
  // viewer with a directory source wired still gets the unchanged
  // self-only page, never a 403: the destination remains reachable, only
  // the roster section is withheld.
  if (input.directory === undefined || !input.context.access.permissions.has("WRITE")) {
    return { kind: "READY", self };
  }
  return {
    kind: "READY",
    self,
    roster: resolvePeopleDirectoryView(input.directory.organization, input.directory.source),
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
 *
 * C1 update: the deployable runtime (`node-server-entrypoint.ts`) now wires
 * `createDurableOrganizationResourceBindingSource` (ORG-MEMBERSHIP-DURABLE-001
 * and its follow-ons) into this port on the live `/os/admin` route.
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
 *
 * C1 update: the deployable runtime (`node-server-entrypoint.ts`) now wires
 * `createDurableOperationalObservabilitySource` (OBS-ADMIN-SOURCE-001) into
 * this port on the live `/os/admin` route.
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

/**
 * V2-ADMIN-SURFACE-001 (fresh current-main + canonical-blueprint scan,
 * REV215): the customer-commercial-lifecycle floor slices landed by
 * V2-CUST-SURFACE-001 (`APP-SUB-002`/`APP-BILL-001`/`CUS-OFFBOARD-001`/`002`)
 * surfaced a real staff-facing gap - `completeCustomerOffboarding`
 * (`customer-offboarding.ts`) requires a deciding staff principal distinct
 * from the original requester, but nothing anywhere in `/os/admin` ever
 * lists a pending `CustomerOffboardingRequest` for a staff member to act
 * on. Canonical OS blueprint §33.13 V1-04 names "approvals and pending
 * attention" as a required admin/control-plane concern; this closes the
 * visibility half of it. Mirrors `OrganizationResourceBindingSource`'s own
 * established optional-source pattern exactly: at the time this port was
 * introduced, no durable `CustomerOffboardingRequest` store existed
 * anywhere in this repository (confirmed by repo-wide inspection), so this
 * module invented no persistence of its own - an absent source renders
 * `NOT_ACTIVE`, never fabricated content. `CUS-OFFBOARD-DURABLE-001` later
 * supplied that durable store and wired it in
 * (`customer-offboarding-admin-source.ts`'s `createDurableCustomerOffboardingAdminSource`),
 * reusing this port unmodified - the `undefined`-source `NOT_ACTIVE`
 * fallback above remains correct for any future caller that does not wire
 * a source. This checkpoint is deliberately READ-ONLY: completing or
 * denying a request requires an authenticated admin-mutation boundary,
 * which `customer-offboarding-decision-access.ts` (`CUSTOMER-REPO-DURABLE-001`)
 * later supplied separately from this read-only listing port.
 */
export interface CustomerOffboardingAdminSource {
  listPendingRequests(organization: Organization): ReadonlyArray<CustomerOffboardingRequest>;
}

export interface PendingOffboardingRequestSummary {
  readonly requestId: CustomerOffboardingRequestId;
  readonly customerId: Customer["customerId"];
  readonly requestedByRef: string;
  readonly requestedAt: string;
}

export type PendingOffboardingRequestsViewState =
  | { readonly kind: "NOT_ACTIVE" }
  | { readonly kind: "READY"; readonly requests: ReadonlyArray<PendingOffboardingRequestSummary> };

/**
 * Tenant isolation fails closed exactly like `resolveResourceBindingView`:
 * `source` is optional so an unwired caller degrades to `NOT_ACTIVE` rather
 * than throwing or fabricating data; a throwing source also degrades to
 * `NOT_ACTIVE` rather than propagating. The returned requests are
 * independently re-verified against the given `organization`'s own
 * `tenantId` and filtered to `status === "REQUESTED"` before ever being
 * summarized - mirroring the Rev28 bounded correction already applied
 * throughout this corridor - so a faulty or compromised source can never
 * leak a foreign tenant's requests, and a stale/already-decided request can
 * never be shown as pending.
 */
export function resolvePendingOffboardingRequestsView(
  organization: Organization,
  source: CustomerOffboardingAdminSource | undefined,
): PendingOffboardingRequestsViewState {
  if (source === undefined) {
    return { kind: "NOT_ACTIVE" };
  }
  let requests: ReadonlyArray<CustomerOffboardingRequest>;
  try {
    requests = source.listPendingRequests(organization);
  } catch {
    return { kind: "NOT_ACTIVE" };
  }
  const summaries: PendingOffboardingRequestSummary[] = requests
    .filter((request) => request.tenantId === organization.tenantId && request.status === "REQUESTED")
    .map((request) => ({
      requestId: request.requestId,
      customerId: request.customerId,
      requestedByRef: request.requestedByRef,
      requestedAt: request.requestedAt,
    }));
  return { kind: "READY", requests: summaries };
}

export interface AdminViewState {
  readonly kind: "READY";
  readonly organization: OrganizationSummary;
  readonly access: AccessSummary;
  readonly resourceBinding: AdminResourceBindingViewState;
  readonly operationalObservability: OperationalObservabilityViewState;
  readonly pendingOffboardingRequests: PendingOffboardingRequestsViewState;
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
  customerOffboardingAdminSource?: CustomerOffboardingAdminSource;
}): AdminViewState {
  return {
    kind: "READY",
    organization: summarizeOrganization(input.organization),
    access: summarizeAccess(input.context.access),
    resourceBinding: resolveResourceBindingView(input.organization, input.resourceBindingSource),
    operationalObservability: resolveOperationalObservabilityView(input.organization, input.operationalObservabilitySource),
    pendingOffboardingRequests: resolvePendingOffboardingRequestsView(input.organization, input.customerOffboardingAdminSource),
    notActiveConcepts: ADMIN_NOT_ACTIVE_CONCEPTS,
  };
}

export interface OrganizationMembershipEvidence {
  readonly membership: OrganizationMembership;
  readonly assignments: ReadonlyArray<AssignmentReference>;
}
