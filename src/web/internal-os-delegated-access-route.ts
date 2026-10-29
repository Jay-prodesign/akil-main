import { randomUUID } from "node:crypto";
import type { Organization } from "../domain/organization.js";
import { createTenantScope } from "../domain/tenant-scope.js";
import {
  InsufficientAuthorityError,
  ProtectedActionNotAuthorizedError,
  CrossTenantAuthorityError,
  type Permission,
} from "../domain/authority.js";
import {
  createDelegatedAccessGrant,
  revokeDelegatedAccessGrant,
  InvalidDelegatedAccessGrantError,
  InvalidDelegatedAccessGrantTransitionError,
} from "../domain/delegated-access-grant.js";
import {
  InvalidDurableDelegatedAccessGrantStoreError,
  DuplicateDelegatedAccessGrantError,
  DelegatedAccessGrantNotFoundError,
  type DurableDelegatedAccessGrantStore,
} from "../domain/durable-delegated-access-grant-store.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import { StaffUnauthenticatedError } from "./staff-route-guard.js";
import { NoStaffMembershipError, AmbiguousStaffMembershipError } from "./staff-membership-guard.js";
import { requireInternalOsAccess, InternalOsAccessDeniedError, type StaffAccessGrant } from "./internal-os-access.js";
import { isDestinationVisible, resolveNavVisibility } from "./internal-os-view-state.js";
import { renderInternalOsPage, type InternalOsPageContent } from "./internal-os-render.js";
import { isSameOriginMutationRequest } from "./internal-os-offboarding-decision-route.js";
import { DELEGATED_ACCESS_MINT_PATH, DELEGATED_ACCESS_REVOKE_PATH } from "./internal-os-delegated-access-controls.js";
import type { IncomingRequestLike, OutgoingResponseLike } from "./request-handler.js";

/**
 * D12 (delegated-access half, unblocked once C7 landed - see
 * `durable-delegated-access-grant-store.ts`'s own doc comment): mint/revoke
 * HTTP wrappers around the existing OS-V1-02 boundaries
 * (`createDelegatedAccessGrant`/`revokeDelegatedAccessGrant`,
 * `delegated-access-grant.ts`). Mirrors
 * `internal-os-attention-decision-route.ts`'s own route shape exactly.
 *
 * Minting delegates a SUBSET of the AUTHENTICATED CALLER's own current
 * authority to another principal ref - `createDelegatedAccessGrant` itself
 * fails closed if the request asks for more than the caller currently
 * holds, so no new authority/policy decision is made by this route: "you
 * may delegate what you already, provably have" is already the domain
 * module's own approved design (OS-V1-02), not invented here. Revocation is
 * intentionally narrower than it could be: only the ORIGINAL delegator (the
 * authenticated caller's own `membershipId` must equal
 * `grant.delegatorMembershipId`) may revoke a delegation here - "you can
 * always take back what you gave" needs no new policy either, unlike "who
 * else may revoke someone else's delegation," which is not decided by this
 * route and is not built here.
 *
 * Routes: `POST /os/admin/delegations` (mint) and
 * `POST /os/admin/delegations/revoke` (revoke, `delegationId` carried in the
 * form body rather than the path, since - unlike every other `/os` mutation
 * - there is no durable list of delegations to read `delegationId` off of
 * before this page; the caller pastes it in, see
 * `internal-os-delegated-access-controls.ts`). Body:
 * `application/x-www-form-urlencoded`.
 *
 * Order of checks (each one fails closed, and none touches the store):
 * 1. Same-origin check (`isSameOriginMutationRequest`) -> 403.
 * 2. `requireInternalOsAccess`, mapped exactly as the GET path maps it
 *    (401 / 403).
 * 3. The `/os/admin` destination gate (READ, already proven by step 2's own
 *    `requireInternalOsAccess` - `isDestinationVisible` here only checks
 *    the viewer is not hidden from the Admin nav entry at all), mirroring
 *    every other `/os` mutation route's own deep-link rule.
 * 4. Form parsing -> 400.
 * 5. Mint: `createDelegatedAccessGrant` using the AUTHENTICATED CALLER's own
 *    `context.membership`/`context.grant.authority` as the delegator -
 *    never a caller-supplied delegator identity - then
 *    `store.putIfAbsentGrant`. Revoke: a fresh `store.getGrant`, a
 *    same-delegator-membership check (403 if the caller does not match),
 *    then `revokeDelegatedAccessGrant` and `store.reviseGrant`.
 * 6. Mint success -> 200 confirmation page showing the new `delegationId`
 *    (the only place it is ever shown - there is no list page to recover it
 *    from later). Revoke success -> 303 See Other to `/os/admin`
 *    (POST/redirect/GET, so a refresh never resubmits the revocation).
 *
 * No response from this route contains an error message, a delegationId
 * (except the mint confirmation's own, freshly-created one), a tenant id,
 * or any other submitted value.
 */

export interface DelegatedAccessDeps {
  readonly store: DurableDelegatedAccessGrantStore;
  /** Server clock for `issuedAt`/`revokedAt`. Defaults to `new Date().toISOString()`. Never read from the request. */
  readonly clock?: () => string;
}

function page(content: InternalOsPageContent): OutgoingResponseLike {
  const rendered = renderInternalOsPage(content);
  return { status: rendered.status, headers: { "content-type": rendered.contentType }, body: rendered.html };
}

const ADMIN_PATH = "/os/admin";

const REVOKE_REDIRECT: OutgoingResponseLike = {
  status: 303,
  headers: { location: ADMIN_PATH, "content-type": "text/plain; charset=utf-8" },
  body: "See Other",
};

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const VALID_PERMISSIONS: ReadonlySet<string> = new Set(["READ", "WRITE", "EXECUTE"]);

export interface ParsedMintForm {
  readonly delegatePrincipalRef: string;
  readonly permissions: ReadonlyArray<Permission>;
  readonly canPerformProtectedActions: boolean;
  readonly projectId?: string;
  readonly expiresAt: string;
}

/**
 * Allow-list parsing. `permissions` may appear zero or more times (an HTML
 * checkbox group); any value outside the three real `Permission` literals
 * -> 400. `projectId` is optional; every other field is required.
 */
export function parseDelegatedAccessMintForm(contentType: string | undefined, body: string | undefined): ParsedMintForm | undefined {
  if (contentType === undefined || contentType.split(";")[0]?.trim().toLowerCase() !== FORM_CONTENT_TYPE) {
    return undefined;
  }
  if (body === undefined) {
    return undefined;
  }
  let delegatePrincipalRef: string | undefined;
  let canPerformProtectedActions = false;
  let projectId: string | undefined;
  let expiresAt: string | undefined;
  const permissions: Permission[] = [];
  for (const [key, value] of new URLSearchParams(body)) {
    switch (key) {
      case "delegatePrincipalRef":
        if (delegatePrincipalRef !== undefined) {
          return undefined;
        }
        delegatePrincipalRef = value;
        break;
      case "permissions":
        if (!VALID_PERMISSIONS.has(value)) {
          return undefined;
        }
        permissions.push(value as Permission);
        break;
      case "canPerformProtectedActions":
        canPerformProtectedActions = true;
        break;
      case "projectId":
        if (projectId !== undefined) {
          return undefined;
        }
        projectId = value;
        break;
      case "expiresAt":
        if (expiresAt !== undefined) {
          return undefined;
        }
        expiresAt = value;
        break;
      default:
        return undefined;
    }
  }
  const trimmedDelegate = delegatePrincipalRef?.trim();
  if (trimmedDelegate === undefined || trimmedDelegate.length === 0) {
    return undefined;
  }
  const trimmedExpiresAt = expiresAt?.trim();
  if (trimmedExpiresAt === undefined || trimmedExpiresAt.length === 0) {
    return undefined;
  }
  const trimmedProjectId = projectId?.trim();
  return {
    delegatePrincipalRef: trimmedDelegate,
    permissions,
    canPerformProtectedActions,
    ...(trimmedProjectId !== undefined && trimmedProjectId.length > 0 ? { projectId: trimmedProjectId } : {}),
    expiresAt: trimmedExpiresAt,
  };
}

export interface ParsedRevokeForm {
  readonly delegationId: string;
  readonly reason: string;
}

export function parseDelegatedAccessRevokeForm(contentType: string | undefined, body: string | undefined): ParsedRevokeForm | undefined {
  if (contentType === undefined || contentType.split(";")[0]?.trim().toLowerCase() !== FORM_CONTENT_TYPE) {
    return undefined;
  }
  if (body === undefined) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(body)) {
    if ((key !== "delegationId" && key !== "reason") || fields.has(key)) {
      return undefined;
    }
    fields.set(key, value);
  }
  const delegationId = fields.get("delegationId")?.trim();
  const reason = fields.get("reason")?.trim();
  if (delegationId === undefined || delegationId.length === 0 || reason === undefined || reason.length === 0) {
    return undefined;
  }
  return { delegationId, reason };
}

function mapDelegatedAccessError(error: unknown): OutgoingResponseLike {
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
    error instanceof InvalidDelegatedAccessGrantError ||
    error instanceof InvalidDelegatedAccessGrantTransitionError
  ) {
    return page({ kind: "FORBIDDEN" });
  }
  if (error instanceof DuplicateDelegatedAccessGrantError || error instanceof InvalidDurableDelegatedAccessGrantStoreError) {
    return page({ kind: "CONFLICT" });
  }
  if (error instanceof DelegatedAccessGrantNotFoundError) {
    return page({ kind: "FORBIDDEN" });
  }
  return page({ kind: "ERROR", reason: "the delegation could not be recorded" });
}

export function handleDelegatedAccessMintPost(input: {
  readonly request: IncomingRequestLike;
  readonly sessionToken: string | undefined;
  readonly provider: StaffSessionProvider;
  readonly organization: Organization;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
  readonly decision: DelegatedAccessDeps;
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
    return mapDelegatedAccessError(error);
  }

  const nav = resolveNavVisibility(context);
  if (!isDestinationVisible("admin", context)) {
    return page({ kind: "FORBIDDEN", nav });
  }

  const form = parseDelegatedAccessMintForm(request.headers["content-type"], request.body);
  if (form === undefined) {
    return page({ kind: "BAD_REQUEST" });
  }

  const issuedAt = input.decision.clock !== undefined ? input.decision.clock() : new Date().toISOString();
  try {
    const tenantScope = createTenantScope(organization.tenantId);
    const grant = createDelegatedAccessGrant({
      tenantScope,
      organization,
      delegatorMembership: context.membership,
      delegatorAuthority: context.grant.authority,
      delegationId: `delegation-${randomUUID()}`,
      delegatePrincipalRef: form.delegatePrincipalRef,
      permissions: form.permissions,
      canPerformProtectedActions: form.canPerformProtectedActions,
      ...(form.projectId !== undefined ? { projectId: form.projectId } : {}),
      issuedAt,
      expiresAt: form.expiresAt,
    });
    input.decision.store.putIfAbsentGrant(grant);
    return page({ kind: "DELEGATION_CREATED", delegationId: grant.delegationId });
  } catch (error) {
    return mapDelegatedAccessError(error);
  }
}

export function handleDelegatedAccessRevokePost(input: {
  readonly request: IncomingRequestLike;
  readonly sessionToken: string | undefined;
  readonly provider: StaffSessionProvider;
  readonly organization: Organization;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
  readonly decision: DelegatedAccessDeps;
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
    return mapDelegatedAccessError(error);
  }

  const nav = resolveNavVisibility(context);
  if (!isDestinationVisible("admin", context)) {
    return page({ kind: "FORBIDDEN", nav });
  }

  const form = parseDelegatedAccessRevokeForm(request.headers["content-type"], request.body);
  if (form === undefined) {
    return page({ kind: "BAD_REQUEST" });
  }

  const revokedAt = input.decision.clock !== undefined ? input.decision.clock() : new Date().toISOString();
  try {
    const tenantScope = createTenantScope(organization.tenantId);
    const current = input.decision.store.getGrant(tenantScope, form.delegationId);
    if (current === undefined) {
      return page({ kind: "FORBIDDEN" });
    }
    /**
     * Only the original delegator may revoke their own delegation here -
     * see this module's own top doc comment for why that needs no new
     * policy, unlike "who else may revoke someone else's delegation,"
     * which is not decided or built here.
     */
    if (current.delegatorMembershipId !== context.membership.membershipId) {
      return page({ kind: "FORBIDDEN" });
    }
    const revision = revokeDelegatedAccessGrant({ grant: current, revokedAt, revokedReason: form.reason });
    input.decision.store.reviseGrant({
      tenantScope,
      delegationId: form.delegationId,
      revise: () => revision,
    });
  } catch (error) {
    return mapDelegatedAccessError(error);
  }
  return REVOKE_REDIRECT;
}
