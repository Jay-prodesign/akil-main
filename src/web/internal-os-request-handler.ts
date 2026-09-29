import type { StaffSessionProvider } from "./staff-session-provider.js";
import { StaffUnauthenticatedError } from "./staff-route-guard.js";
import { NoStaffMembershipError, AmbiguousStaffMembershipError } from "./staff-membership-guard.js";
import type { Organization } from "../domain/organization.js";
import {
  requireInternalOsAccess,
  InternalOsAccessDeniedError,
  type StaffAccessGrant,
} from "./internal-os-access.js";
import {
  resolveNavVisibility,
  resolveHomeView,
  resolveWorkView,
  resolveWorkProjectDetailView,
  resolvePeopleView,
  resolveProductsView,
  resolveAdminView,
  type WorkProjectSource,
  type WorkJobSource,
} from "./internal-os-view-state.js";
import {
  renderInternalOsPage,
  homePageContent,
  workPageContent,
  workProjectDetailPageContent,
  notActiveDestinationPageContent,
  peoplePageContent,
  productsPageContent,
  adminPageContent,
  type InternalOsPageContent,
  type RenderedInternalOsPage,
} from "./internal-os-render.js";
import type { IncomingRequestLike, OutgoingResponseLike } from "./request-handler.js";

/**
 * Rev168: distinct from the Client Portal's `x-akilta-session-token`
 * (`request-handler.ts`) - a different identity domain gets a different
 * header, so no ambiguity can arise about which session family a given
 * token belongs to even before either provider is consulted.
 */
export const STAFF_SESSION_TOKEN_HEADER = "x-akilta-staff-session-token";

export interface InternalOsRequestHandlerDeps {
  readonly provider: StaffSessionProvider;
  readonly organization: Organization;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
  readonly projectSource?: WorkProjectSource;
  readonly jobSource?: WorkJobSource;
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
    if (request.method !== "GET") {
      return toResponse(renderInternalOsPage({ kind: "UNSUPPORTED", reason: `method ${request.method} is not supported` }));
    }

    const parsed = parseInternalOsPath(request.path);
    if (parsed.kind === "not-found") {
      return toResponse(renderInternalOsPage({ kind: "NOT_FOUND" }));
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

    const nav = resolveNavVisibility(context.access);
    const organizationName = deps.organization.displayName;

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
      case "ai-capabilities":
      case "connections":
      case "knowledge":
        content = notActiveDestinationPageContent(nav, organizationName, parsed.kind);
        break;
      case "people":
        content = peoplePageContent(nav, organizationName, resolvePeopleView({ context }));
        break;
      case "products":
        content = productsPageContent(nav, organizationName, resolveProductsView());
        break;
      case "admin":
        content = adminPageContent(nav, organizationName, resolveAdminView({ organization: deps.organization, context }));
        break;
    }

    return toResponse(renderInternalOsPage(content));
  };
}
