import type { Organization } from "../domain/organization.js";
import { createTenantScope } from "../domain/tenant-scope.js";
import { InsufficientAuthorityError } from "../domain/authority.js";
import {
  CustomerOffboardingDecisionError,
  InvalidCustomerOffboardingError,
  type CustomerOffboardingRequestId,
} from "../domain/customer-offboarding.js";
import {
  CustomerOffboardingRequestConflictError,
  CustomerOffboardingRequestTerminalError,
  CustomerOffboardingRequestVersionConflictError,
  type DurableCustomerOffboardingRequestStore,
} from "../domain/durable-customer-offboarding-request-store.js";
import type { CustomerRepository } from "../ports/customer-repository.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import { StaffUnauthenticatedError } from "./staff-route-guard.js";
import { NoStaffMembershipError, AmbiguousStaffMembershipError } from "./staff-membership-guard.js";
import { requireInternalOsAccess, InternalOsAccessDeniedError, type StaffAccessGrant } from "./internal-os-access.js";
import { isDestinationVisible, resolveNavVisibility } from "./internal-os-view-state.js";
import { renderInternalOsPage, type InternalOsPageContent } from "./internal-os-render.js";
import {
  completeCustomerOffboardingAsAuthenticatedStaff,
  denyCustomerOffboardingAsAuthenticatedStaff,
  CustomerNotFoundForOffboardingDecisionError,
  CustomerOffboardingRequestNotFoundError,
  CustomerOffboardingTenantScopeMismatchError,
} from "./customer-offboarding-decision-access.js";
import { OFFBOARDING_COMPLETE_PATH, OFFBOARDING_DENY_PATH } from "./internal-os-offboarding-decision-controls.js";
import type { IncomingRequestLike, OutgoingResponseLike } from "./request-handler.js";

/**
 * C4 (whole-product gap scan 2026-10-23, first slice): the first mutation
 * route on the staff `/os` surface. It is an HTTP POST wrapper around the
 * two existing, already-reviewed REV216 boundaries,
 * `denyCustomerOffboardingAsAuthenticatedStaff` and
 * `completeCustomerOffboardingAsAuthenticatedStaff`. It adds no new
 * authentication or authority logic. Those functions call
 * `requireInternalOsAccess` themselves, check the tenant, and re-prove
 * WRITE (deny) or protected-action authority (complete) inside the domain
 * layer before the store's optimistic-concurrency write.
 *
 * Routes: `POST /os/admin/offboarding/deny` and
 * `POST /os/admin/offboarding/complete`. Body:
 * `application/x-www-form-urlencoded`, which is what the `/os/admin`
 * forms submit, parsed with the built-in `URLSearchParams`.
 *
 * Order of checks (each one fails closed, and none touches the store):
 * 1. Same-origin check (`isSameOriginMutationRequest`) -> 403.
 * 2. `requireInternalOsAccess`, mapped exactly as the GET path maps it
 *    (401 / 403). In addition, a missing READ (`InsufficientAuthorityError`)
 *    is 403 here; the GET path lets that error reach the transport's
 *    generic 500, and that GET behavior is left unchanged.
 * 3. The `/os/admin` destination gate (WRITE), because the controls live
 *    on that page: a viewer who cannot reach the page cannot post from it
 *    either (Rev170 F1's deep-link rule applied to POST) -> 403.
 * 4. Complete only: protected-action authority -> 403. The domain checks
 *    this again. Checking it here as well lets a missing authority surface
 *    as 403 and not as the domain's generic decision refusal (409, below).
 * 5. Form parsing -> 400. This runs after authentication, so an
 *    unauthenticated caller learns nothing about the expected form shape.
 * 6. The REV216 boundary itself, with errors mapped below.
 * 7. Success -> 303 See Other to `/os/admin` (POST/redirect/GET, so a
 *    refresh never resubmits the decision).
 *
 * No response from this route contains an error message, a request id, a
 * tenant id or any other submitted value.
 */

export interface CustomerOffboardingDecisionDeps {
  readonly requestStore: DurableCustomerOffboardingRequestStore;
  readonly customerRepository: CustomerRepository;
  /** Server clock for `deniedAt`/`completedAt`. Defaults to `new Date().toISOString()`. Never read from the request. */
  readonly clock?: () => string;
}

export type OffboardingDecisionKind = "complete" | "deny";

/** Same segment split as `parseInternalOsPath` (empty segments dropped), so trailing slashes behave the same. */
export function parseOffboardingDecisionPath(path: string): OffboardingDecisionKind | undefined {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[0] !== "os" || segments[1] !== "admin" || segments[2] !== "offboarding") {
    return undefined;
  }
  if (`/${segments.join("/")}` === OFFBOARDING_COMPLETE_PATH) {
    return "complete";
  }
  if (`/${segments.join("/")}` === OFFBOARDING_DENY_PATH) {
    return "deny";
  }
  return undefined;
}

/**
 * Defense in depth against cross-site request forgery. The main defense is
 * structural: staff authentication is the `x-akilta-staff-session-token`
 * request header, never a browser-managed credential, so a browser does not
 * attach it to a request another site triggers. A plain cross-site HTML
 * form cannot set that header, and a cross-site script that tries to
 * triggers a CORS preflight, which this server never grants.
 *
 * This check covers the case where that premise fails, for example an
 * authenticating proxy in front of the server that adds the header to
 * every request it forwards:
 * - `sec-fetch-site`, when present, must be `same-origin` (or `none`, a
 *   request the user started directly). Modern browsers send it.
 * - `origin`, when present, must name the same host (and port) as the
 *   request's own `host` header. `Origin: null` fails.
 * - A request with neither header passes. Browsers send `origin` on every
 *   POST, so this is a non-browser client (curl, a script, a test), which
 *   holds no ambient credential to forge with, and which still needs the
 *   session header to get past `requireInternalOsAccess`.
 *
 * The scheme is not compared: behind a TLS-terminating proxy the server
 * cannot see it.
 */
export function isSameOriginMutationRequest(headers: Readonly<Record<string, string | undefined>>): boolean {
  const fetchSite = headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }
  const origin = headers["origin"];
  if (origin === undefined) {
    return true;
  }
  const host = headers["host"];
  if (host === undefined || host.length === 0) {
    return false;
  }
  let originUrl: URL;
  let hostUrl: URL;
  try {
    originUrl = new URL(origin);
    if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
      return false;
    }
    // Parsed with the origin's own scheme, so a default port written out in
    // `host` (":443" for https) compares equal to the origin without it.
    hostUrl = new URL(`${originUrl.protocol}//${host}`);
  } catch {
    return false;
  }
  if (hostUrl.username !== "" || hostUrl.password !== "" || hostUrl.pathname !== "/" || hostUrl.search !== "" || hostUrl.hash !== "") {
    return false;
  }
  return hostUrl.host === originUrl.host;
}

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** `expectedVersion` is a store version: a positive integer, written in plain decimal. */
const EXPECTED_VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;

export type ParsedOffboardingDecisionForm =
  | { readonly kind: "complete"; readonly requestId: CustomerOffboardingRequestId; readonly expectedVersion: number }
  | {
      readonly kind: "deny";
      readonly requestId: CustomerOffboardingRequestId;
      readonly expectedVersion: number;
      readonly reason: string;
    };

/**
 * Allow-list parsing. Returns `undefined` (-> 400) unless:
 * - the content type is `application/x-www-form-urlencoded` (parameters
 *   such as `charset` are ignored);
 * - every field is one this decision takes, and each appears exactly once
 *   (an unknown or repeated field is rejected, never silently picked);
 * - `requestId` is non-empty with no surrounding whitespace (it comes from
 *   a hidden field the server rendered, so it is never trimmed here);
 * - `expectedVersion` is a positive decimal integer;
 * - for deny, `reason` is non-empty after trimming. Surrounding whitespace
 *   typed into the text box is trimmed before it reaches
 *   `denyCustomerOffboarding`, which rejects untrimmed text.
 */
export function parseOffboardingDecisionForm(
  kind: OffboardingDecisionKind,
  contentType: string | undefined,
  body: string | undefined,
): ParsedOffboardingDecisionForm | undefined {
  if (contentType === undefined || contentType.split(";")[0]?.trim().toLowerCase() !== FORM_CONTENT_TYPE) {
    return undefined;
  }
  if (body === undefined) {
    return undefined;
  }
  const allowed: ReadonlyArray<string> = kind === "deny" ? ["requestId", "expectedVersion", "reason"] : ["requestId", "expectedVersion"];
  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(body)) {
    if (!allowed.includes(key) || fields.has(key)) {
      return undefined;
    }
    fields.set(key, value);
  }
  const requestId = fields.get("requestId");
  if (requestId === undefined || requestId.length === 0 || requestId.trim() !== requestId) {
    return undefined;
  }
  const rawVersion = fields.get("expectedVersion");
  if (rawVersion === undefined || !EXPECTED_VERSION_PATTERN.test(rawVersion)) {
    return undefined;
  }
  const expectedVersion = Number(rawVersion);
  if (kind === "complete") {
    return { kind, requestId: requestId as CustomerOffboardingRequestId, expectedVersion };
  }
  const reason = fields.get("reason")?.trim();
  if (reason === undefined || reason.length === 0) {
    return undefined;
  }
  return { kind, requestId: requestId as CustomerOffboardingRequestId, expectedVersion, reason };
}

function page(content: InternalOsPageContent): OutgoingResponseLike {
  const rendered = renderInternalOsPage(content);
  return { status: rendered.status, headers: { "content-type": rendered.contentType }, body: rendered.html };
}

const DECISION_APPLIED_REDIRECT: OutgoingResponseLike = {
  status: 303,
  headers: { location: "/os/admin", "content-type": "text/plain; charset=utf-8" },
  body: "See Other",
};

/**
 * Maps every error the REV216 boundary (and the store under it) can throw
 * to a status page. Unknown errors become the generic OS ERROR page (500).
 * None of these pages renders the error.
 *
 * - 401: `StaffUnauthenticatedError`.
 * - 403: membership or access denied (`NoStaffMembershipError`,
 *   `AmbiguousStaffMembershipError`, `InternalOsAccessDeniedError`,
 *   `InsufficientAuthorityError`) and `CustomerOffboardingTenantScopeMismatchError`.
 *   The tenant mismatch cannot happen through this route, because the tenant
 *   is always the authenticated organization's own, but it is still mapped.
 * - 404: `CustomerOffboardingRequestNotFoundError`,
 *   `CustomerNotFoundForOffboardingDecisionError`.
 * - 409: a stale `expectedVersion` (`CustomerOffboardingRequestVersionConflictError`),
 *   an already-terminal request (`CustomerOffboardingRequestTerminalError`),
 *   an identity conflict in the store (`CustomerOffboardingRequestConflictError`),
 *   and `CustomerOffboardingDecisionError`. The domain uses that one error
 *   type for every refusal: request no longer REQUESTED (the common case,
 *   such as a second submit after someone else decided), self-completion by
 *   the requester, and the authority floors. The authority floors are
 *   already checked before this point (steps 2 to 4), so what is left is a
 *   state conflict in practice.
 * - 400: `InvalidCustomerOffboardingError`. Unreachable after
 *   `parseOffboardingDecisionForm`, but mapped.
 */
function mapDecisionError(error: unknown): OutgoingResponseLike {
  if (error instanceof StaffUnauthenticatedError) {
    return page({ kind: "UNAUTHENTICATED" });
  }
  if (
    error instanceof NoStaffMembershipError ||
    error instanceof AmbiguousStaffMembershipError ||
    error instanceof InternalOsAccessDeniedError ||
    error instanceof InsufficientAuthorityError ||
    error instanceof CustomerOffboardingTenantScopeMismatchError
  ) {
    return page({ kind: "FORBIDDEN" });
  }
  if (error instanceof CustomerOffboardingRequestNotFoundError || error instanceof CustomerNotFoundForOffboardingDecisionError) {
    return page({ kind: "NOT_FOUND" });
  }
  if (
    error instanceof CustomerOffboardingRequestVersionConflictError ||
    error instanceof CustomerOffboardingRequestTerminalError ||
    error instanceof CustomerOffboardingRequestConflictError ||
    error instanceof CustomerOffboardingDecisionError
  ) {
    return page({ kind: "CONFLICT" });
  }
  if (error instanceof InvalidCustomerOffboardingError) {
    return page({ kind: "BAD_REQUEST" });
  }
  return page({ kind: "ERROR", reason: "the offboarding decision could not be applied" });
}

export function handleCustomerOffboardingDecisionPost(input: {
  readonly request: IncomingRequestLike;
  readonly decisionKind: OffboardingDecisionKind;
  readonly sessionToken: string | undefined;
  readonly provider: StaffSessionProvider;
  readonly organization: Organization;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
  readonly decision: CustomerOffboardingDecisionDeps;
}): OutgoingResponseLike {
  const { request, decisionKind, organization } = input;

  if (!isSameOriginMutationRequest(request.headers)) {
    return page({ kind: "FORBIDDEN" });
  }

  let context;
  try {
    context = requireInternalOsAccess({
      provider: input.provider,
      sessionToken: input.sessionToken,
      organization,
      grants: input.grants,
    });
  } catch (error) {
    return mapDecisionError(error);
  }

  const nav = resolveNavVisibility(context);
  if (!isDestinationVisible("admin", context)) {
    return page({ kind: "FORBIDDEN", nav });
  }
  if (decisionKind === "complete" && !context.access.canPerformProtectedActions) {
    return page({ kind: "FORBIDDEN", nav });
  }

  const form = parseOffboardingDecisionForm(decisionKind, request.headers["content-type"], request.body);
  if (form === undefined) {
    return page({ kind: "BAD_REQUEST" });
  }

  const decidedAt = input.decision.clock !== undefined ? input.decision.clock() : new Date().toISOString();
  try {
    const tenantScope = createTenantScope(organization.tenantId);
    if (form.kind === "deny") {
      denyCustomerOffboardingAsAuthenticatedStaff({
        organization,
        provider: input.provider,
        sessionToken: input.sessionToken,
        grants: input.grants,
        requestStore: input.decision.requestStore,
        tenantScope,
        requestId: form.requestId,
        expectedVersion: form.expectedVersion,
        reason: form.reason,
        deniedAt: decidedAt,
      });
    } else {
      completeCustomerOffboardingAsAuthenticatedStaff({
        organization,
        provider: input.provider,
        sessionToken: input.sessionToken,
        grants: input.grants,
        requestStore: input.decision.requestStore,
        customerRepository: input.decision.customerRepository,
        tenantScope,
        requestId: form.requestId,
        expectedVersion: form.expectedVersion,
        completedAt: decidedAt,
      });
    }
  } catch (error) {
    return mapDecisionError(error);
  }
  return DECISION_APPLIED_REDIRECT;
}
