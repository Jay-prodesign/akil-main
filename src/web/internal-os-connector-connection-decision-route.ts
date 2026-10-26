import type { Organization } from "../domain/organization.js";
import { createTenantScope } from "../domain/tenant-scope.js";
import {
  InsufficientAuthorityError,
  ProtectedActionNotAuthorizedError,
  CrossTenantAuthorityError,
} from "../domain/authority.js";
import { InvalidConnectionTransitionError, type ConnectionState } from "../domain/connection-authority.js";
import type { DurableConnectorConnectionStore } from "../domain/durable-connector-connection-store.js";
import type { ConnectorConnectionInstance } from "../domain/integration-connector-catalog.js";
import { ConnectorConnectionAdminMutationNotAuthorizedError } from "../domain/connector-connection-admin-mutation.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import { StaffUnauthenticatedError } from "./staff-route-guard.js";
import { NoStaffMembershipError, AmbiguousStaffMembershipError } from "./staff-membership-guard.js";
import { requireInternalOsAccess, InternalOsAccessDeniedError, type StaffAccessGrant } from "./internal-os-access.js";
import { isDestinationVisible, resolveNavVisibility } from "./internal-os-view-state.js";
import { renderInternalOsPage, type InternalOsPageContent } from "./internal-os-render.js";
import { mutateConnectorConnectionStateAsAuthenticatedAdmin } from "./connector-connection-admin-access.js";
import { isSameOriginMutationRequest } from "./internal-os-offboarding-decision-route.js";
import type { IncomingRequestLike, OutgoingResponseLike } from "./request-handler.js";

/**
 * C4 slice 2 (gap scan 2026-10-23, second `/os` mutation route): an HTTP
 * POST wrapper around the already-reviewed Rev188 F2 boundary,
 * `mutateConnectorConnectionStateAsAuthenticatedAdmin`
 * (`connector-connection-admin-access.ts`), exactly the way
 * `internal-os-offboarding-decision-route.ts` wraps the two offboarding
 * decision boundaries - the first `/os` mutation route (C4 slice 1). It
 * adds no new authentication or authority logic: the wrapped function
 * calls `requireInternalOsAccess` itself, and the domain function under
 * it (`mutateConnectorConnectionStateAsAdmin`) re-proves EXECUTE
 * permission, protected-action authority, and an OWNER/ADMIN curated
 * access role, re-reads the connection's current version fresh, and
 * writes through the store's own existing optimistic-concurrency check.
 *
 * Route: `POST /os/connections/<connectionBindingId>/state`. Body:
 * `application/x-www-form-urlencoded`, one field (`to`), parsed with the
 * built-in `URLSearchParams`, matching the offboarding route's own form
 * convention exactly. Unlike the offboarding decision forms, no
 * `expectedVersion` field exists here: `mutateConnectorConnectionStateAsAdmin`'s
 * own signature takes no caller-supplied version - it always re-reads the
 * connection's current version immediately before writing, so there is
 * nothing for a caller to stale-supply.
 *
 * Order of checks (each one fails closed, and none touches the store):
 * 1. Same-origin check (`isSameOriginMutationRequest`, reused unchanged
 *    from the offboarding route rather than duplicated) -> 403.
 * 2. `requireInternalOsAccess`, mapped exactly as the GET path maps it
 *    (401 / 403), plus the same `InsufficientAuthorityError` -> 403
 *    widening the offboarding route's own mapping already applies (a
 *    missing READ permission, which the GET path lets escape to the
 *    generic 500, is 403 here).
 * 3. The `/os/connections` destination gate (WRITE), because the control
 *    lives on that page: a viewer who cannot reach the page cannot post
 *    from it either (Rev170 F1's deep-link rule, same as the offboarding
 *    route's step 3) -> 403.
 * 4. Form parsing -> 400. This runs after authentication, so an
 *    unauthenticated caller learns nothing about the expected form shape.
 * 5. The Rev188 F2 boundary itself, with errors mapped below. This is
 *    where EXECUTE, protected-action authority, and the OWNER/ADMIN
 *    curated access role are actually re-proven - this route does not
 *    pre-check them (unlike the offboarding route's "complete" branch),
 *    because every one of this mutation's own authority floors already
 *    maps to a distinct, non-leaking 403 below, so pre-checking would only
 *    duplicate, never change, the outcome.
 * 6. Success -> 303 See Other to `/os/connections` (POST/redirect/GET, so
 *    a refresh never resubmits the transition).
 *
 * No response from this route contains an error message, a
 * connectionBindingId, a tenant id, or any other submitted value.
 */

export interface ConnectorConnectionStateDecisionDeps {
  readonly store: DurableConnectorConnectionStore;
}

const CONNECTIONS_PATH = "/os/connections";

/**
 * Same segment-split discipline as `parseInternalOsPath`'s own
 * `work/<customerId>/<projectId>` convention (empty segments dropped): 3
 * segments after `os` - `connections`, the id, `state`. Returns the raw,
 * caller-supplied `connectionBindingId` segment, never yet cast to its
 * branded type (the handler below does that at the one call site that
 * needs it, mirroring how the offboarding route casts `requestId`).
 */
export function parseConnectorConnectionStatePath(path: string): string | undefined {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[0] !== "os" || segments[1] !== "connections" || segments[3] !== "state") {
    return undefined;
  }
  const connectionBindingId = segments[2];
  if (connectionBindingId === undefined || connectionBindingId.length === 0) {
    return undefined;
  }
  return connectionBindingId;
}

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/**
 * The exact six `ConnectionState` literals (`connection-authority.ts`'s own
 * closed vocabulary), never duplicated as a transition table here - which
 * of these is actually a legal next state from the connection's real
 * current state is decided exclusively by `transitionConnectorConnection`
 * inside the domain layer, which this module never second-guesses.
 */
const CONNECTION_STATE_VALUES: ReadonlySet<string> = new Set<ConnectionState>([
  "REQUESTED",
  "CONNECTED_UNVERIFIED",
  "VERIFIED",
  "DEGRADED",
  "REVOKED",
  "HANDOVER_COMPLETE",
]);

/**
 * Allow-list parsing. Returns `undefined` (-> 400) unless:
 * - the content type is `application/x-www-form-urlencoded` (parameters
 *   such as `charset` are ignored, exactly like the offboarding route);
 * - the body carries exactly one field, `to`, appearing exactly once (an
 *   unknown or repeated field is rejected, never silently picked);
 * - `to` is exactly one of the six recognized `ConnectionState` literals.
 *
 * No `expectedVersion` field is accepted here - see this module's own top
 * doc comment for why none is needed.
 */
export function parseConnectorConnectionStateForm(
  contentType: string | undefined,
  body: string | undefined,
): ConnectionState | undefined {
  if (contentType === undefined || contentType.split(";")[0]?.trim().toLowerCase() !== FORM_CONTENT_TYPE) {
    return undefined;
  }
  if (body === undefined) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(body)) {
    if (key !== "to" || fields.has(key)) {
      return undefined;
    }
    fields.set(key, value);
  }
  const to = fields.get("to");
  if (to === undefined || !CONNECTION_STATE_VALUES.has(to)) {
    return undefined;
  }
  return to as ConnectionState;
}

function page(content: InternalOsPageContent): OutgoingResponseLike {
  const rendered = renderInternalOsPage(content);
  return { status: rendered.status, headers: { "content-type": rendered.contentType }, body: rendered.html };
}

const STATE_CHANGE_APPLIED_REDIRECT: OutgoingResponseLike = {
  status: 303,
  headers: { location: CONNECTIONS_PATH, "content-type": "text/plain; charset=utf-8" },
  body: "See Other",
};

/**
 * Maps every error `mutateConnectorConnectionStateAsAuthenticatedAdmin`
 * (and everything under it) can throw to a status page. Unknown errors
 * become the generic OS ERROR page (500). None of these pages renders the
 * error.
 *
 * - 401: `StaffUnauthenticatedError`.
 * - 403: membership or access denied (`NoStaffMembershipError`,
 *   `AmbiguousStaffMembershipError`, `InternalOsAccessDeniedError`), the
 *   same `InsufficientAuthorityError` widening the offboarding route's own
 *   mapping already applies, `ProtectedActionNotAuthorizedError` (the
 *   protected-action floor `mutateConnectorConnectionStateAsAdmin` itself
 *   re-checks), `CrossTenantAuthorityError` (structurally unreachable
 *   through this route today, since the `tenantScope` passed to the
 *   boundary is always the authenticated organization's own - mapped
 *   anyway, the same defense-in-depth the offboarding route already
 *   applies to its own structurally-unreachable tenant-mismatch error),
 *   and `ConnectorConnectionAdminMutationNotAuthorizedError`.
 *
 *   `ConnectorConnectionAdminMutationNotAuthorizedError` is deliberately
 *   mapped to 403 UNCONDITIONALLY, never split by message text. The domain
 *   mutation throws this exact error class for two different reasons -
 *   "current access did not resolve GRANTED / wrong tenant / not an
 *   OWNER-or-ADMIN curated access role" (an authorization failure) AND "no
 *   current connection exists for this connectionBindingId" (a not-found
 *   case) - distinguished only by the thrown error's own message text.
 *   Branching the HTTP status on that text (403 vs 404) would hand an
 *   unauthenticated-for-this-connection caller a existence-enumeration
 *   oracle: probing connectionBindingIds and reading 403-vs-404 off the
 *   response would reveal which ids exist in this tenant, independent of
 *   whether the caller may ever act on them. Collapsing both cases to the
 *   same 403 is intentionally MORE secure than a message-sniffing 404
 *   split, not a shortcut - a future reader should not "fix" this into one.
 * - 409: `InvalidConnectionTransitionError` - the requested `to` state is
 *   not a legal transition from the connection's actual current state (see
 *   `CONNECTION_MAIN_TRANSITIONS` in `connection-authority.ts`, the sole
 *   source of truth for that table). Same "something changed since the
 *   page was rendered, or the requested action never made sense" semantics
 *   as the offboarding route's own 409.
 * - 500 (the default/fallthrough, never message-leaking): any other error,
 *   including the store's own `ConnectorConnectionVersionConflictError`
 *   (a concurrent admin mutation raced this one and won),
 *   `ConnectorConnectionOwnershipMismatchError`,
 *   `CorruptedConnectorConnectionFileError`,
 *   `ConnectorConnectionLockTimeoutError`, or any unexpected error.
 */
function mapConnectorConnectionStateError(error: unknown): OutgoingResponseLike {
  if (error instanceof StaffUnauthenticatedError) {
    return page({ kind: "UNAUTHENTICATED" });
  }
  if (
    error instanceof NoStaffMembershipError ||
    error instanceof AmbiguousStaffMembershipError ||
    error instanceof InternalOsAccessDeniedError ||
    error instanceof InsufficientAuthorityError ||
    error instanceof ProtectedActionNotAuthorizedError ||
    error instanceof CrossTenantAuthorityError ||
    error instanceof ConnectorConnectionAdminMutationNotAuthorizedError
  ) {
    return page({ kind: "FORBIDDEN" });
  }
  if (error instanceof InvalidConnectionTransitionError) {
    return page({ kind: "CONFLICT" });
  }
  return page({ kind: "ERROR", reason: "the connection state could not be changed" });
}

export function handleConnectorConnectionStatePost(input: {
  readonly request: IncomingRequestLike;
  readonly connectionBindingId: string;
  readonly sessionToken: string | undefined;
  readonly provider: StaffSessionProvider;
  readonly organization: Organization;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
  readonly decision: ConnectorConnectionStateDecisionDeps;
}): OutgoingResponseLike {
  const { request, organization } = input;

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
    return mapConnectorConnectionStateError(error);
  }

  const nav = resolveNavVisibility(context);
  if (!isDestinationVisible("connections", context)) {
    return page({ kind: "FORBIDDEN", nav });
  }

  const to = parseConnectorConnectionStateForm(request.headers["content-type"], request.body);
  if (to === undefined) {
    return page({ kind: "BAD_REQUEST" });
  }

  try {
    const tenantScope = createTenantScope(organization.tenantId);
    mutateConnectorConnectionStateAsAuthenticatedAdmin({
      tenantScope,
      organization,
      provider: input.provider,
      sessionToken: input.sessionToken,
      grants: input.grants,
      store: input.decision.store,
      connectionBindingId: input.connectionBindingId as ConnectorConnectionInstance["binding"]["connectionBindingId"],
      to,
    });
  } catch (error) {
    return mapConnectorConnectionStateError(error);
  }
  return STATE_CHANGE_APPLIED_REDIRECT;
}
