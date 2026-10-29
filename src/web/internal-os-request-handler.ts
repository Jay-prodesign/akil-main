import { randomUUID } from "node:crypto";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import { StaffUnauthenticatedError, requireStaffSession } from "./staff-route-guard.js";
import { createTenantScope } from "../domain/tenant-scope.js";
import type { BreakGlassSupportViewKind } from "../domain/break-glass-support-access.js";
import {
  authorizeBreakGlassSupportAccessAsAuthenticatedStaff,
  type BreakGlassAccessGrantLookup,
  type BreakGlassSupportAccessAuditSink,
} from "./authenticated-break-glass-support-access.js";
import { NoStaffMembershipError, AmbiguousStaffMembershipError } from "./staff-membership-guard.js";
import type { Organization } from "../domain/organization.js";
import {
  requireInternalOsAccess,
  InternalOsAccessDeniedError,
  type StaffAccessGrant,
} from "./internal-os-access.js";
import {
  resolveNavVisibility,
  isDestinationVisible,
  resolveHomeView,
  resolveWorkView,
  resolveWorkProjectDetailView,
  resolvePeopleView,
  resolveProductsView,
  resolveAdminView,
  resolveConnectionsView,
  canMutateConnectorConnectionState,
  resolveKnowledgeView,
  resolveAttentionView,
  resolveWorkersRosterView,
  canDecideProtectedDecision,
  resolveBreakGlassObservabilityView,
  BREAK_GLASS_SUPPORT_VIEW_KINDS,
  type DestinationKey,
  type AttentionSource,
  type ConnectionsSource,
  type KnowledgeSource,
  type WorkersRosterSource,
  type PeopleDirectorySource,
  type WorkProjectSource,
  type WorkJobSource,
  type OrganizationResourceBindingSource,
  type OperationalObservabilitySource,
  type CustomerOffboardingAdminSource,
} from "./internal-os-view-state.js";
import {
  renderInternalOsPage,
  homePageContent,
  workPageContent,
  workProjectDetailPageContent,
  connectionsPageContent,
  knowledgePageContent,
  attentionPageContent,
  workersRosterPageContent,
  peoplePageContent,
  productsPageContent,
  adminPageContent,
  breakGlassObservabilityPageContent,
  delegationCreatedPageContent,
  delegatedAccessViewPageContent,
  type InternalOsPageContent,
  type RenderedInternalOsPage,
} from "./internal-os-render.js";
import type { IncomingRequestLike, OutgoingResponseLike } from "./request-handler.js";
import {
  handleCustomerOffboardingDecisionPost,
  parseOffboardingDecisionPath,
  type CustomerOffboardingDecisionDeps,
} from "./internal-os-offboarding-decision-route.js";
import {
  handleConnectorConnectionStatePost,
  parseConnectorConnectionStatePath,
  type ConnectorConnectionStateDecisionDeps,
} from "./internal-os-connector-connection-decision-route.js";
import {
  handleAttentionDecisionPost,
  parseAttentionDecisionPath,
  type AttentionDecisionDeps,
} from "./internal-os-attention-decision-route.js";
import {
  handleDelegatedAccessMintPost,
  handleDelegatedAccessRevokePost,
  type DelegatedAccessDeps,
} from "./internal-os-delegated-access-route.js";
import { DELEGATED_ACCESS_MINT_PATH, DELEGATED_ACCESS_REVOKE_PATH } from "./internal-os-delegated-access-controls.js";
import { resolveEffectiveDelegatedAccessAsAuthenticatedStaff } from "./authenticated-delegated-access.js";

/**
 * Rev168: distinct from the Client Portal's `x-akilta-session-token`
 * (`request-handler.ts`) - a different identity domain gets a different
 * header, so no ambiguity can arise about which session family a given
 * token belongs to even before either provider is consulted.
 */
export const STAFF_SESSION_TOKEN_HEADER = "x-akilta-staff-session-token";

/**
 * C7: the break-glass branch of `GET /os/admin` is reached ONLY when this
 * header carries a non-empty grant id (and `deps.breakGlass` is wired).
 * Without it, every request takes the unchanged ordinary path. Same
 * `x-akilta-...` prefix as `STAFF_SESSION_TOKEN_HEADER`; the caller still
 * authenticates through that same staff-session header.
 */
export const BREAK_GLASS_GRANT_ID_HEADER = "x-akilta-break-glass-grant-id";

/**
 * C7: the fresh, per-session consent reference a grant with
 * `consentRequired: true` needs (`authorizeBreakGlassSupportAccess`'s own
 * `consentRef`). Ignored for a grant that does not require consent.
 */
export const BREAK_GLASS_CONSENT_REF_HEADER = "x-akilta-break-glass-consent-ref";

/**
 * D12 (delegated-access half): the read-only branch of `GET /os/admin` is
 * reached ONLY when this header carries a non-empty delegationId (and
 * `deps.delegatedAccess` is wired). Mirrors `BREAK_GLASS_GRANT_ID_HEADER`'s
 * own convention exactly - same `x-akilta-...` prefix, same "caller still
 * authenticates through the ordinary staff-session header" discipline.
 */
export const DELEGATION_ID_HEADER = "x-akilta-delegation-id";

/**
 * C7: the break-glass dependencies, typed as minimal ports (the same
 * convention as every other optional source here) - this web module never
 * imports the concrete durable store classes.
 */
export interface BreakGlassSupportAccessDeps {
  readonly grantStore: BreakGlassAccessGrantLookup;
  readonly auditStore: BreakGlassSupportAccessAuditSink;
  /** Server clock for the grant-expiry check and `decidedAt`. Defaults to `new Date().toISOString()`. Never read from the request. */
  readonly clock?: () => string;
}

export interface InternalOsRequestHandlerDeps {
  readonly provider: StaffSessionProvider;
  readonly organization: Organization;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
  readonly projectSource?: WorkProjectSource;
  readonly jobSource?: WorkJobSource;
  /**
   * Rev184 F3-residual: caller-injected read source for the Organization's
   * current resource-binding status, threaded into the real `/os/admin`
   * route - mirrors `projectSource`/`jobSource`'s own established optional-
   * source pattern. Absent (the honest production default until a durable
   * binding store is separately wired) renders `NOT_ACTIVE`, never
   * fabricated content. C1: the deployable runtime now wires
   * `createDurableOrganizationResourceBindingSource` here.
   */
  readonly resourceBindingSource?: OrganizationResourceBindingSource;
  /**
   * Rev195 F1: caller-injected read source for the Organization's current
   * operational observability view, threaded into the real `/os/admin`
   * route - mirrors `resourceBindingSource`'s own established optional-
   * source pattern exactly. Absent (the honest production default until a
   * real source is separately wired) renders `NOT_ACTIVE`, never
   * fabricated content. C1: the deployable runtime now wires
   * `createDurableOperationalObservabilitySource` here.
   */
  readonly operationalObservabilitySource?: OperationalObservabilitySource;
  /**
   * V2-ADMIN-SURFACE-001: caller-injected read source for the Organization's
   * pending `CustomerOffboardingRequest` queue, threaded into the real
   * `/os/admin` route - mirrors `resourceBindingSource`'s own established
   * optional-source pattern exactly. Absent (the honest production default
   * until a durable offboarding-request store is separately wired) renders
   * `NOT_ACTIVE`, never fabricated content. C1: the deployable runtime now
   * wires `createDurableCustomerOffboardingAdminSource` here.
   */
  readonly customerOffboardingAdminSource?: CustomerOffboardingAdminSource;
  /**
   * C3 (gap scan 2026-10-23): caller-injected read source for the dedicated
   * `/os/connections` destination. It follows the same optional-source
   * pattern as `operationalObservabilitySource`. Absent renders the same
   * `NOT_ACTIVE` page as before C3, never fabricated content. A source that
   * throws renders the OS ERROR page. The deployable runtime wires
   * `createDurableConnectionsSource` here.
   */
  readonly connectionsSource?: ConnectionsSource;
  /**
   * Gap scan N2: caller-injected read source for the dedicated
   * `/os/ai-capabilities` destination. Same optional-source pattern as
   * `connectionsSource`. Absent renders the same `NOT_ACTIVE` page as
   * before this slice, never fabricated content. A source that throws
   * renders the OS ERROR page. This roster is identity/lifecycle only - it
   * carries no capability, maturity, trust, or AI-worker routing-authority
   * data, and never will, by `WorkersRosterSource`'s own construction. The
   * deployable runtime wires `createDurableWorkersRosterSource` here.
   */
  readonly workersRosterSource?: WorkersRosterSource;
  /**
   * C3 People slice (gap scan 2026-10-23): caller-injected read source for
   * the `/os/people` membership roster. Same optional-source pattern as
   * `connectionsSource`. Absent renders the same self-only People page as
   * before C3. A source that throws renders the OS ERROR page. It is read
   * only on `/os/people`, only after `requireInternalOsAccess` has granted
   * access, and only when the caller additionally holds WRITE
   * (`resolvePeopleView`'s own gate - a READ-only grant still reaches this
   * destination, just without the roster). The deployable runtime wires
   * `createDurablePeopleDirectorySource` here.
   */
  readonly peopleDirectorySource?: PeopleDirectorySource;
  /**
   * C3 Knowledge slice (gap scan 2026-10-23): caller-injected read source for
   * the dedicated `/os/knowledge` destination. Same optional-source pattern
   * as `connectionsSource`. Absent renders the same `NOT_ACTIVE` page as
   * before C3, never fabricated content. A source that throws renders the OS
   * ERROR page. It is read only on `/os/knowledge`, only after
   * `requireInternalOsAccess` has granted access and the existing
   * `isDestinationVisible("knowledge")` WRITE gate has passed. The
   * deployable runtime wires `createDurableKnowledgeSource` here.
   */
  readonly knowledgeSource?: KnowledgeSource;
  /**
   * C3 Attention slice (gap scan 2026-10-23): caller-injected read source
   * for the dedicated `/os/attention` destination (credential/access
   * problems and customer approvals required). Same optional-source
   * pattern as `connectionsSource`. Absent renders the same `NOT_ACTIVE`
   * page as before C3, never fabricated content. A source that throws
   * renders the OS ERROR page. It is read only on `/os/attention`, only
   * after `requireInternalOsAccess` has granted access and the existing
   * `isDestinationVisible("attention")` EXECUTE/protected-actions gate has
   * passed, and only when the viewer additionally holds WRITE
   * (`resolveAttentionView`'s own gate - without WRITE the viewer gets the
   * unchanged pre-C3 page, not a 403). The deployable runtime wires
   * `createDurableAttentionSource` here.
   */
  readonly attentionSource?: AttentionSource;
  /**
   * C4 (gap scan 2026-10-23, first mutation slice): the durable stores the
   * customer-offboarding deny/complete POST routes write through
   * (`internal-os-offboarding-decision-route.ts`). Absent: those routes
   * answer exactly like every other POST did before C4 (501 UNSUPPORTED),
   * and `/os/admin` renders its pending list read-only, with no form. The
   * deployable runtime wires the same `FileDurableCustomerOffboardingRequestStore`
   * the admin list reads, plus a `FileDurableCustomerRepository`.
   */
  readonly customerOffboardingDecision?: CustomerOffboardingDecisionDeps;
  /**
   * C4 slice 2 (gap scan 2026-10-23, second `/os` mutation): the durable
   * store the connector-connection state-mutation POST route writes
   * through (`internal-os-connector-connection-decision-route.ts`).
   * Absent: that route answers exactly like every other POST did before
   * this slice (501 UNSUPPORTED), and `/os/connections` renders its table
   * read-only, with no control - mirrors `customerOffboardingDecision`'s
   * own optional-dependency pattern exactly. The deployable runtime wires
   * the same `FileDurableConnectorConnectionStore` the connections list
   * already reads.
   */
  readonly connectorConnectionStateDecision?: ConnectorConnectionStateDecisionDeps;
  /**
   * C4 slice 3 (gap scan 2026-10-23, third `/os` mutation): the durable
   * store the protected-decision-record create/revise POST route writes
   * through (`internal-os-attention-decision-route.ts`). Absent: that
   * route answers exactly like every other POST did before this slice
   * (501 UNSUPPORTED), and `/os/attention` renders its "customer approval
   * required" rows with no decision status and no control - mirrors
   * `connectorConnectionStateDecision`'s own optional-dependency pattern
   * exactly. The deployable runtime wires a `FileDurableProtectedDecisionRecordStore`,
   * the same instance `attentionSource`'s own `getProtectedDecisionRecord`
   * reads.
   */
  readonly attentionDecision?: AttentionDecisionDeps;
  /**
   * C7 (gap scan 2026-10-23): the durable break-glass grant lookup and
   * audit append behind the read-only break-glass branch of `GET /os/admin`
   * (see `handleBreakGlassAdminGet`). Absent, or present but the request
   * carries no `BREAK_GLASS_GRANT_ID_HEADER`: `/os/admin` behaves exactly
   * as before C7. The deployable runtime wires a
   * `FileDurableBreakGlassAccessGrantStore` and a
   * `FileDurableBreakGlassSupportAccessAuditStore`.
   */
  readonly breakGlass?: BreakGlassSupportAccessDeps;
  /**
   * D12 (delegated-access half, unblocked once C7 landed): the durable
   * delegated-access grant store behind both the mint/revoke POST routes
   * and the read-only delegated-access branch of `GET /os/admin`. Absent:
   * `/os/admin` behaves exactly as before this slice (no delegated-access
   * section, mint/revoke POST routes answer 501 UNSUPPORTED, and the
   * `DELEGATION_ID_HEADER` branch is never taken).
   */
  readonly delegatedAccess?: DelegatedAccessDeps;
}

function toResponse(rendered: RenderedInternalOsPage): OutgoingResponseLike {
  return {
    status: rendered.status,
    headers: { "content-type": rendered.contentType },
    body: rendered.html,
  };
}

type ParsedInternalOsPath =
  | { readonly kind: "home" }
  | { readonly kind: "work" }
  | { readonly kind: "work-detail"; readonly customerId: string; readonly projectId: string }
  | { readonly kind: "attention" }
  | { readonly kind: "ai-capabilities" }
  | { readonly kind: "connections" }
  | { readonly kind: "knowledge" }
  | { readonly kind: "people" }
  | { readonly kind: "products" }
  | { readonly kind: "admin" }
  | { readonly kind: "not-found" };

/**
 * Manual path parsing, matching `request-handler.ts`'s own `parsePortalPath`
 * discipline exactly (no router library, no query-string trust - route
 * params come only from path segments).
 */
function parseInternalOsPath(path: string): ParsedInternalOsPath {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments[0] !== "os") {
    return { kind: "not-found" };
  }
  const rest = segments.slice(1);
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "home")) {
    return { kind: "home" };
  }
  if (rest.length === 1) {
    switch (rest[0]) {
      case "work":
        return { kind: "work" };
      case "attention":
        return { kind: "attention" };
      case "ai-capabilities":
        return { kind: "ai-capabilities" };
      case "connections":
        return { kind: "connections" };
      case "knowledge":
        return { kind: "knowledge" };
      case "people":
        return { kind: "people" };
      case "products":
        return { kind: "products" };
      case "admin":
        return { kind: "admin" };
      default:
        return { kind: "not-found" };
    }
  }
  if (rest.length === 3 && rest[0] === "work" && rest[1] !== undefined && rest[2] !== undefined) {
    return { kind: "work-detail", customerId: rest[1], projectId: rest[2] };
  }
  return { kind: "not-found" };
}

export type InternalOsRequestHandler = (request: IncomingRequestLike) => OutgoingResponseLike;

/**
 * C7 (gap scan 2026-10-23; OS-V1-09.md's own named route-wiring
 * follow-on): the read-only break-glass branch of `GET /os/admin`. A
 * non-member support principal views THIS deployment's own organization's
 * operational observability under a scoped, time-bounded, audited
 * `BreakGlassAccessGrant` - never a different organization's data, and
 * never anything beyond the observability kinds the grant names.
 *
 * Order (every failure fails closed, and none renders an error message,
 * a grant id or any other request value):
 * 1. Authenticate the staff session (`requireStaffSession`) -> 401 on
 *    failure. Done BEFORE the grant lookup on purpose: if the lookup ran
 *    first, an unauthenticated caller would get 403 for an unknown grant
 *    id but 401 for a real one - an existence oracle for grant ids. The
 *    wrapper below re-authenticates the same token itself; this first call
 *    only fixes the response order, it never supplies identity to anything.
 * 2. Look the grant up ONCE, under this organization's own tenant. No grant
 *    -> 403, and the domain gate is never called (there is nothing to
 *    authorize against) and nothing is audited.
 * 3. Call the domain gate once PER view kind (`BREAK_GLASS_SUPPORT_VIEW_KINDS`),
 *    through `authorizeBreakGlassSupportAccessAsAuthenticatedStaff`, with the
 *    same grant, session token, consent header and `now` each time and a
 *    fresh `auditRef` per call. Each `GRANTED` call durably appends its own
 *    audit record before it returns; a kind outside the grant's scope comes
 *    back `DENIED` and is simply not shown.
 * 4. Every kind `DENIED` (expired, revoked, foreign tenant, wrong
 *    principal, missing consent) -> the same 403 as step 2.
 * 5. Otherwise resolve the observability source ONCE and render only the
 *    granted kinds' fields (`resolveBreakGlassObservabilityView`). An
 *    unwired source renders the page's `NOT_ACTIVE` state.
 *
 * A `StaffUnauthenticatedError` from either authentication call -> 401,
 * exactly like the ordinary path. Any other error propagates (the HTTP
 * server answers its generic 500), exactly like the ordinary path - for
 * example a corrupted grant file, or an audit append failure, which by
 * construction means no page is served for an access whose evidence was
 * not recorded.
 */
function handleBreakGlassAdminGet(input: {
  readonly request: IncomingRequestLike;
  readonly grantId: string;
  readonly deps: InternalOsRequestHandlerDeps;
  readonly breakGlass: BreakGlassSupportAccessDeps;
}): OutgoingResponseLike {
  const { request, grantId, deps, breakGlass } = input;
  const sessionToken = request.headers[STAFF_SESSION_TOKEN_HEADER];
  const consentRef = request.headers[BREAK_GLASS_CONSENT_REF_HEADER];
  const now = breakGlass.clock !== undefined ? breakGlass.clock() : new Date().toISOString();
  try {
    requireStaffSession(deps.provider, sessionToken, now);
    const targetTenantScope = createTenantScope(deps.organization.tenantId);
    const grant = breakGlass.grantStore.getGrant(targetTenantScope, grantId);
    if (grant === undefined) {
      return toResponse(renderInternalOsPage({ kind: "FORBIDDEN" }));
    }
    const grantedKinds: BreakGlassSupportViewKind[] = [];
    for (const requestedView of BREAK_GLASS_SUPPORT_VIEW_KINDS) {
      const decision = authorizeBreakGlassSupportAccessAsAuthenticatedStaff({
        grant,
        targetTenantScope,
        provider: deps.provider,
        sessionToken,
        requestedView,
        consentRef,
        auditRef: `break-glass-audit-${randomUUID()}`,
        now,
        auditStore: breakGlass.auditStore,
      });
      if (decision.outcome === "GRANTED") {
        grantedKinds.push(requestedView);
      }
    }
    if (grantedKinds.length === 0) {
      return toResponse(renderInternalOsPage({ kind: "FORBIDDEN" }));
    }
    return toResponse(
      renderInternalOsPage(
        breakGlassObservabilityPageContent(
          deps.organization.displayName,
          resolveBreakGlassObservabilityView({
            organization: deps.organization,
            grantedKinds,
            source: deps.operationalObservabilitySource,
          }),
        ),
      ),
    );
  } catch (error) {
    if (error instanceof StaffUnauthenticatedError) {
      return toResponse(renderInternalOsPage({ kind: "UNAUTHENTICATED" }));
    }
    throw error;
  }
}

/**
 * D12 (delegated-access half; unblocked once C7 landed - see
 * `durable-delegated-access-grant-store.ts`'s own doc comment): the
 * read-only delegated-access branch of `GET /os/admin`. A delegate views
 * their OWN currently-effective access under a named `DelegatedAccessGrant`
 * - never anyone else's, and never more than the grant's intersection with
 * the delegator's own current authority.
 *
 * Order (every failure fails closed, and none renders an error message, a
 * delegationId, or any other request value):
 * 1. Authenticate the staff session (`requireStaffSession`) -> 401,
 *    BEFORE the grant lookup, for the same "no existence oracle for grant
 *    ids" reason `handleBreakGlassAdminGet` orders its own two steps.
 * 2. Look the grant up ONCE under this organization's own tenant. No grant
 *    -> 403 (`resolveEffectiveDelegatedAccessAsAuthenticatedStaff`'s own
 *    "no grant" path already answers `DENIED`, but the lookup happens here
 *    so the FORBIDDEN branch below can also cover "no delegator evidence
 *    found" without a second domain call).
 * 3. Find the delegator's own `StaffAccessGrant` in `deps.grants` by
 *    `grant.delegatorMembershipId` - the exact evidence
 *    `resolveEffectiveDelegatedAccessAsAuthenticatedStaff` re-resolves the
 *    delegator's CURRENT standing from, never a snapshot taken at mint
 *    time. Not found (the delegator's own membership has since been fully
 *    removed, not merely revoked) -> 403; the domain function is never
 *    called without it.
 * 4. Call `resolveEffectiveDelegatedAccessAsAuthenticatedStaff` once. A
 *    `DENIED` decision renders the same read-only view (never thrown,
 *    never 403) - unlike break-glass, which hides a denied kind entirely,
 *    a delegate asking "what do I currently have" is told DENIED directly,
 *    since there is nothing else on this branch to leak by comparison.
 */
function handleDelegatedAccessAdminGet(input: {
  readonly request: IncomingRequestLike;
  readonly delegationId: string;
  readonly deps: InternalOsRequestHandlerDeps;
  readonly delegatedAccess: DelegatedAccessDeps;
}): OutgoingResponseLike {
  const { request, delegationId, deps, delegatedAccess } = input;
  const sessionToken = request.headers[STAFF_SESSION_TOKEN_HEADER];
  const now = delegatedAccess.clock !== undefined ? delegatedAccess.clock() : new Date().toISOString();
  try {
    requireStaffSession(deps.provider, sessionToken, now);
    const tenantScope = createTenantScope(deps.organization.tenantId);
    const grant = delegatedAccess.store.getGrant(tenantScope, delegationId);
    if (grant === undefined) {
      return toResponse(renderInternalOsPage({ kind: "FORBIDDEN" }));
    }
    const delegatorGrant = deps.grants.find((candidate) => candidate.membership.membershipId === grant.delegatorMembershipId);
    if (delegatorGrant === undefined) {
      return toResponse(renderInternalOsPage({ kind: "FORBIDDEN" }));
    }
    const resolution = resolveEffectiveDelegatedAccessAsAuthenticatedStaff({
      organization: deps.organization,
      grant,
      now,
      provider: deps.provider,
      sessionToken,
      delegatorMembership: delegatorGrant.membership,
      delegatorAuthority: delegatorGrant.authority,
      delegatorAssignments: delegatorGrant.assignments,
      ...(delegatorGrant.roleContext !== undefined ? { delegatorRoleContext: delegatorGrant.roleContext } : {}),
    });
    return toResponse(renderInternalOsPage(delegatedAccessViewPageContent(deps.organization.displayName, resolution)));
  } catch (error) {
    if (error instanceof StaffUnauthenticatedError) {
      return toResponse(renderInternalOsPage({ kind: "UNAUTHENTICATED" }));
    }
    throw error;
  }
}

/**
 * Rev168 mandatory tests, all enforced here before any destination content
 * is ever resolved: unauthenticated fails closed (`StaffUnauthenticatedError`
 * -> 401), a session with no matching/ambiguous membership fails closed
 * (`NoStaffMembershipError`/`AmbiguousStaffMembershipError` -> 403), and any
 * other `InternalOsAccessDeniedError` (tenant mismatch, revoked membership,
 * insufficient READ permission) also fails closed -> 403. No destination
 * branch below can be reached without `requireInternalOsAccess` having
 * already returned a genuinely `GRANTED` context.
 */
export function createInternalOsRequestHandler(deps: InternalOsRequestHandlerDeps): InternalOsRequestHandler {
  return (request: IncomingRequestLike): OutgoingResponseLike => {
    /**
     * C4: the only POST routes are the two offboarding decisions, and only
     * when their stores are wired. Every other POST, and every other
     * non-GET method, gets the same 501 UNSUPPORTED page as before C4. The
     * GET flow below is unchanged.
     */
    if (request.method === "POST") {
      const decisionKind = parseOffboardingDecisionPath(request.path);
      if (decisionKind !== undefined && deps.customerOffboardingDecision !== undefined) {
        return handleCustomerOffboardingDecisionPost({
          request,
          decisionKind,
          sessionToken: request.headers[STAFF_SESSION_TOKEN_HEADER],
          provider: deps.provider,
          organization: deps.organization,
          grants: deps.grants,
          decision: deps.customerOffboardingDecision,
        });
      }
      /**
       * C4 slice 2: the second `/os` mutation route, dispatched the same
       * way as the offboarding decision route just above - a path match
       * with no wired dependency still falls through to the generic 501
       * below, unchanged from before this slice.
       */
      const connectionBindingId = parseConnectorConnectionStatePath(request.path);
      if (connectionBindingId !== undefined && deps.connectorConnectionStateDecision !== undefined) {
        return handleConnectorConnectionStatePost({
          request,
          connectionBindingId,
          sessionToken: request.headers[STAFF_SESSION_TOKEN_HEADER],
          provider: deps.provider,
          organization: deps.organization,
          grants: deps.grants,
          decision: deps.connectorConnectionStateDecision,
        });
      }
      /**
       * C4 slice 3: the third `/os` mutation route, dispatched the same
       * way as the two routes just above - a path match with no wired
       * dependency still falls through to the generic 501 below,
       * unchanged from before this slice.
       */
      const decisionRef = parseAttentionDecisionPath(request.path);
      if (decisionRef !== undefined && deps.attentionDecision !== undefined) {
        return handleAttentionDecisionPost({
          request,
          decisionRef,
          sessionToken: request.headers[STAFF_SESSION_TOKEN_HEADER],
          provider: deps.provider,
          organization: deps.organization,
          grants: deps.grants,
          decision: deps.attentionDecision,
        });
      }
      /**
       * D12 (delegated-access half): the fourth and fifth `/os` mutation
       * routes, dispatched the same way as the three above - a path match
       * with no wired dependency still falls through to the generic 501
       * below, unchanged from before this slice.
       */
      if (request.path === DELEGATED_ACCESS_MINT_PATH && deps.delegatedAccess !== undefined) {
        return handleDelegatedAccessMintPost({
          request,
          sessionToken: request.headers[STAFF_SESSION_TOKEN_HEADER],
          provider: deps.provider,
          organization: deps.organization,
          grants: deps.grants,
          decision: deps.delegatedAccess,
        });
      }
      if (request.path === DELEGATED_ACCESS_REVOKE_PATH && deps.delegatedAccess !== undefined) {
        return handleDelegatedAccessRevokePost({
          request,
          sessionToken: request.headers[STAFF_SESSION_TOKEN_HEADER],
          provider: deps.provider,
          organization: deps.organization,
          grants: deps.grants,
          decision: deps.delegatedAccess,
        });
      }
    }

    if (request.method !== "GET") {
      return toResponse(renderInternalOsPage({ kind: "UNSUPPORTED", reason: `method ${request.method} is not supported` }));
    }

    const parsed = parseInternalOsPath(request.path);
    if (parsed.kind === "not-found") {
      return toResponse(renderInternalOsPage({ kind: "NOT_FOUND" }));
    }

    /**
     * C7: the break-glass branch, taken ONLY for `/os/admin` with
     * `deps.breakGlass` wired AND a non-empty `BREAK_GLASS_GRANT_ID_HEADER`.
     * It always returns - it never falls through to the ordinary path below.
     * For every other request (no header, which is every pre-C7 caller) this
     * condition is false and the code below runs exactly as before C7.
     */
    if (parsed.kind === "admin" && deps.breakGlass !== undefined) {
      const breakGlassGrantId = request.headers[BREAK_GLASS_GRANT_ID_HEADER];
      if (typeof breakGlassGrantId === "string" && breakGlassGrantId.length > 0) {
        return handleBreakGlassAdminGet({ request, grantId: breakGlassGrantId, deps, breakGlass: deps.breakGlass });
      }
    }

    /**
     * D12 (delegated-access half): the delegated-access branch, taken ONLY
     * for `/os/admin` with `deps.delegatedAccess` wired AND a non-empty
     * `DELEGATION_ID_HEADER` - mirrors the break-glass branch immediately
     * above exactly, including that it always returns and never falls
     * through to the ordinary path below.
     */
    if (parsed.kind === "admin" && deps.delegatedAccess !== undefined) {
      const delegationId = request.headers[DELEGATION_ID_HEADER];
      if (typeof delegationId === "string" && delegationId.length > 0) {
        return handleDelegatedAccessAdminGet({ request, delegationId, deps, delegatedAccess: deps.delegatedAccess });
      }
    }

    let context;
    try {
      context = requireInternalOsAccess({
        provider: deps.provider,
        sessionToken: request.headers[STAFF_SESSION_TOKEN_HEADER],
        organization: deps.organization,
        grants: deps.grants,
      });
    } catch (error) {
      if (error instanceof StaffUnauthenticatedError) {
        return toResponse(renderInternalOsPage({ kind: "UNAUTHENTICATED" }));
      }
      if (
        error instanceof NoStaffMembershipError ||
        error instanceof AmbiguousStaffMembershipError ||
        error instanceof InternalOsAccessDeniedError
      ) {
        return toResponse(renderInternalOsPage({ kind: "FORBIDDEN" }));
      }
      throw error;
    }

    const nav = resolveNavVisibility(context);
    const organizationName = deps.organization.displayName;

    /**
     * Rev170 F1: a destination hidden from `nav` must also fail closed when
     * reached directly - a Member/Restricted fixture cannot bypass the
     * navigation policy by deep-linking a path it was never shown. `work`
     * covers both the listing and its project-detail sub-route (a
     * destination hidden in its entirety has no reachable detail page
     * either); `home`/`people`/`products` are never gated here since
     * `isDestinationVisible` always returns `true` for them under Phase A's
     * policy.
     */
    let gatedDestinationKey: DestinationKey | undefined;
    switch (parsed.kind) {
      case "work":
      case "work-detail":
        gatedDestinationKey = "work";
        break;
      case "attention":
      case "ai-capabilities":
      case "connections":
      case "knowledge":
      case "admin":
        gatedDestinationKey = parsed.kind;
        break;
      default:
        gatedDestinationKey = undefined;
    }
    if (gatedDestinationKey !== undefined && !isDestinationVisible(gatedDestinationKey, context)) {
      return toResponse(renderInternalOsPage({ kind: "FORBIDDEN", nav }));
    }

    let content: InternalOsPageContent;
    switch (parsed.kind) {
      case "home":
        content = homePageContent(
          nav,
          organizationName,
          resolveHomeView({
            organization: deps.organization,
            context,
            projectSource: deps.projectSource,
            jobSource: deps.jobSource,
          }),
        );
        break;
      case "work":
        content = workPageContent(
          nav,
          organizationName,
          resolveWorkView({ context, projectSource: deps.projectSource, jobSource: deps.jobSource }),
        );
        break;
      case "work-detail":
        content = workProjectDetailPageContent(
          nav,
          organizationName,
          resolveWorkProjectDetailView({
            organization: deps.organization,
            context,
            projectSource: deps.projectSource,
            jobSource: deps.jobSource,
            customerId: parsed.customerId,
            projectId: parsed.projectId,
          }),
        );
        break;
      case "attention":
        content = attentionPageContent(
          nav,
          organizationName,
          resolveAttentionView({
            organization: deps.organization,
            context,
            source: deps.attentionSource,
            canDecide: deps.attentionDecision !== undefined && canDecideProtectedDecision(context),
          }),
        );
        break;
      case "ai-capabilities":
        content = workersRosterPageContent(
          nav,
          organizationName,
          resolveWorkersRosterView(deps.organization, deps.workersRosterSource),
        );
        break;
      case "knowledge":
        content = knowledgePageContent(
          nav,
          organizationName,
          resolveKnowledgeView(deps.organization, deps.knowledgeSource),
        );
        break;
      case "connections":
        content = connectionsPageContent(
          nav,
          organizationName,
          resolveConnectionsView(
            deps.organization,
            deps.connectionsSource,
            deps.connectorConnectionStateDecision !== undefined && canMutateConnectorConnectionState(context),
          ),
        );
        break;
      case "people":
        content = peoplePageContent(
          nav,
          organizationName,
          resolvePeopleView({
            context,
            ...(deps.peopleDirectorySource !== undefined
              ? { directory: { organization: deps.organization, source: deps.peopleDirectorySource } }
              : {}),
          }),
        );
        break;
      case "products":
        content = productsPageContent(nav, organizationName, resolveProductsView());
        break;
      case "admin":
        content = adminPageContent(
          nav,
          organizationName,
          resolveAdminView({
            organization: deps.organization,
            context,
            ...(deps.resourceBindingSource !== undefined ? { resourceBindingSource: deps.resourceBindingSource } : {}),
            ...(deps.operationalObservabilitySource !== undefined
              ? { operationalObservabilitySource: deps.operationalObservabilitySource }
              : {}),
            ...(deps.customerOffboardingAdminSource !== undefined
              ? { customerOffboardingAdminSource: deps.customerOffboardingAdminSource }
              : {}),
            ...(deps.customerOffboardingDecision !== undefined ? { offboardingDecisionEnabled: true } : {}),
            ...(deps.delegatedAccess !== undefined ? { delegatedAccessEnabled: true } : {}),
          }),
        );
        break;
    }

    return toResponse(renderInternalOsPage(content));
  };
}
