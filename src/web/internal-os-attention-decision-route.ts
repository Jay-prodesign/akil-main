import type { Organization } from "../domain/organization.js";
import { createTenantScope } from "../domain/tenant-scope.js";
import {
  InvalidProtectedDecisionRecordError,
  ProtectedDecisionRecordTransitionError,
  type ProtectedDecisionOutcome,
} from "../domain/protected-decision-record.js";
import { InsufficientAuthorityError, ProtectedActionNotAuthorizedError, CrossTenantAuthorityError } from "../domain/authority.js";
import {
  InvalidDurableProtectedDecisionRecordStoreError,
  type DurableProtectedDecisionRecordStore,
} from "../domain/durable-protected-decision-record-store.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import { StaffUnauthenticatedError } from "./staff-route-guard.js";
import { NoStaffMembershipError, AmbiguousStaffMembershipError } from "./staff-membership-guard.js";
import { requireInternalOsAccess, InternalOsAccessDeniedError, type StaffAccessGrant } from "./internal-os-access.js";
import { isDestinationVisible, resolveNavVisibility } from "./internal-os-view-state.js";
import { renderInternalOsPage, type InternalOsPageContent } from "./internal-os-render.js";
import {
  createProtectedDecisionRecordAsAuthenticatedStaff,
  reviseProtectedDecisionRecordAsAuthenticatedStaff,
} from "./protected-decision-record-admin-access.js";
import { isSameOriginMutationRequest } from "./internal-os-offboarding-decision-route.js";
import type { IncomingRequestLike, OutgoingResponseLike } from "./request-handler.js";

/**
 * C4 slice 3 (gap scan 2026-10-23, third `/os` mutation route): an HTTP POST
 * wrapper around the already-reviewed Rev188 F3-item4 boundaries,
 * `createProtectedDecisionRecordAsAuthenticatedStaff` and
 * `reviseProtectedDecisionRecordAsAuthenticatedStaff`
 * (`protected-decision-record-admin-access.ts`), exactly the way
 * `internal-os-connector-connection-decision-route.ts` wraps its own Rev188
 * F2 boundary - the second `/os` mutation route (C4 slice 2). It adds no new
 * authentication or authority logic: both wrapped functions call
 * `requireInternalOsAccess` themselves, and the domain functions under them
 * (`createProtectedDecisionRecord`/`reviseProtectedDecisionRecord`) re-prove
 * EXECUTE permission and protected-action authority before returning a
 * record. Unlike either prior slice, neither domain function persists
 * anything - this module is the one that calls the durable store
 * (`DurableProtectedDecisionRecordStore`) directly, immediately after each
 * domain function returns.
 *
 * Route: `POST /os/attention/decisions/<decisionRef>`. Body:
 * `application/x-www-form-urlencoded`, exactly two fields (`outcome`,
 * `evidenceRef`), parsed with the built-in `URLSearchParams`, matching the
 * other two routes' own form convention. No `expectedVersion` field: the
 * durable store's `putIfAbsentDecisionRecord`/`reviseDecisionRecord` are
 * both internally race-safe (atomic `linkSync`-based single-winner claims),
 * so there is no caller-supplied version for a form to go stale against -
 * the same reasoning slice 2 used for its own missing `expectedVersion`.
 *
 * Order of checks (each one fails closed, and none touches the store):
 * 1. Same-origin check (`isSameOriginMutationRequest`, reused unchanged) -> 403.
 * 2. `requireInternalOsAccess`, mapped exactly as the GET path maps it
 *    (401 / 403) - called directly here (not only inside the wrapped
 *    functions) so this route has a `context` to evaluate the destination
 *    gate below, exactly like both prior slices' own routes.
 * 3. The `/os/attention` destination gate (EXECUTE or protected-action
 *    authority), because the controls live on that page: a viewer who
 *    cannot reach the page cannot post from it either (Rev170 F1's
 *    deep-link rule, same as both prior routes' own step 3) -> 403. WRITE
 *    and EXECUTE/protected-action authority are deliberately NOT
 *    pre-checked here - the wrapped domain functions already re-prove
 *    EXECUTE + protected-action authority themselves, so pre-checking would
 *    only duplicate, never change, the outcome (the same reasoning slice 2
 *    used for not pre-checking its own authority floor).
 * 4. Form parsing -> 400. This runs after authentication, so an
 *    unauthenticated caller learns nothing about the expected form shape.
 * 5. A fresh read of the current decision record (if any) for this
 *    `decisionRef`, then exactly one of:
 *    - no current record: `createProtectedDecisionRecordAsAuthenticatedStaff`,
 *      then `store.putIfAbsentDecisionRecord`. A submitted `outcome` of
 *      `"REVOKED"` is rejected here before either domain function or the
 *      store is ever touched (see the dedicated comment on that check
 *      below) - the two decision forms a fresh row ever renders are
 *      Approve/Deny (`internal-os-attention-decision-controls.ts`), never
 *      Revoke.
 *    - a current record: `reviseProtectedDecisionRecordAsAuthenticatedStaff`,
 *      then `store.reviseDecisionRecord`. The domain function itself throws
 *      `ProtectedDecisionRecordTransitionError` unless `current.outcome`
 *      is `"APPROVED"` and the requested `outcome` is `"REVOKED"` - this is
 *      exactly how "someone tried to approve/deny a decisionRef that's
 *      already decided" gets rejected too, with no special-case branching
 *      needed here: this branch is always taken when a current record
 *      exists, and the domain function's own transition-shape check does
 *      the rejecting.
 * 6. Success -> 303 See Other to `/os/attention` (POST/redirect/GET, so a
 *    refresh never resubmits the decision).
 *
 * No response from this route contains an error message, a decisionRef, a
 * tenant id, or any other submitted value.
 */

export interface AttentionDecisionDeps {
  readonly store: DurableProtectedDecisionRecordStore;
  /** Server clock for `decidedAt`. Defaults to `new Date().toISOString()`. Never read from the request. */
  readonly clock?: () => string;
}

const ATTENTION_PATH = "/os/attention";

/**
 * Same segment-split discipline as `parseConnectorConnectionStatePath`
 * (empty segments dropped): 4 segments total - `os`, `attention`,
 * `decisions`, the id. Returns the raw, caller-supplied `decisionRef`
 * segment, never yet passed through any further validation (the handler
 * below hands it to the wrapped domain functions, which validate it as a
 * non-empty string themselves).
 */
export function parseAttentionDecisionPath(path: string): string | undefined {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[0] !== "os" || segments[1] !== "attention" || segments[2] !== "decisions") {
    return undefined;
  }
  const decisionRef = segments[3];
  if (decisionRef === undefined || decisionRef.length === 0) {
    return undefined;
  }
  return decisionRef;
}

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** The exact three `ProtectedDecisionOutcome` literals, never duplicated as a transition table here. */
const OUTCOME_VALUES: ReadonlySet<string> = new Set<ProtectedDecisionOutcome>(["APPROVED", "DENIED", "REVOKED"]);

export interface ParsedAttentionDecisionForm {
  readonly outcome: ProtectedDecisionOutcome;
  readonly evidenceRef: string;
}

/**
 * Allow-list parsing. Returns `undefined` (-> 400) unless:
 * - the content type is `application/x-www-form-urlencoded` (parameters
 *   such as `charset` are ignored, exactly like the other two routes);
 * - the body carries exactly the two allow-listed fields (`outcome`,
 *   `evidenceRef`), each appearing exactly once (an unknown or repeated
 *   field is rejected, never silently picked);
 * - `outcome` is exactly one of the three recognized `ProtectedDecisionOutcome`
 *   literals;
 * - `evidenceRef` is non-empty after trimming - mirrors the offboarding
 *   route's `reason` field's trim-and-require-non-empty handling exactly.
 *   Surrounding whitespace typed into the text box is trimmed before it
 *   reaches `createProtectedDecisionRecord`/`reviseProtectedDecisionRecord`,
 *   which reject untrimmed text.
 *
 * No `decisionRef` field is accepted here - it travels in the URL, never
 * the form body, matching `internal-os-connection-state-controls.ts`'s own
 * `connectionBindingId`-in-the-URL convention. No `expectedVersion` field
 * is accepted either - see this module's own top doc comment for why none
 * is needed.
 */
export function parseAttentionDecisionForm(
  contentType: string | undefined,
  body: string | undefined,
): ParsedAttentionDecisionForm | undefined {
  if (contentType === undefined || contentType.split(";")[0]?.trim().toLowerCase() !== FORM_CONTENT_TYPE) {
    return undefined;
  }
  if (body === undefined) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(body)) {
    if ((key !== "outcome" && key !== "evidenceRef") || fields.has(key)) {
      return undefined;
    }
    fields.set(key, value);
  }
  const outcome = fields.get("outcome");
  if (outcome === undefined || !OUTCOME_VALUES.has(outcome)) {
    return undefined;
  }
  const evidenceRef = fields.get("evidenceRef")?.trim();
  if (evidenceRef === undefined || evidenceRef.length === 0) {
    return undefined;
  }
  return { outcome: outcome as ProtectedDecisionOutcome, evidenceRef };
}

function page(content: InternalOsPageContent): OutgoingResponseLike {
  const rendered = renderInternalOsPage(content);
  return { status: rendered.status, headers: { "content-type": rendered.contentType }, body: rendered.html };
}

const DECISION_APPLIED_REDIRECT: OutgoingResponseLike = {
  status: 303,
  headers: { location: ATTENTION_PATH, "content-type": "text/plain; charset=utf-8" },
  body: "See Other",
};

/**
 * Maps every error the two REV188 F3-item4 boundaries (and the store under
 * them) can throw to a status page. Unknown errors become the generic OS
 * ERROR page (500). None of these pages renders the error.
 *
 * - 401: `StaffUnauthenticatedError`.
 * - 403: membership or access denied (`NoStaffMembershipError`,
 *   `AmbiguousStaffMembershipError`, `InternalOsAccessDeniedError`),
 *   `InsufficientAuthorityError` / `ProtectedActionNotAuthorizedError` /
 *   `CrossTenantAuthorityError` (thrown directly by
 *   `resolveAuthenticatedDecisionAccess`'s own `requirePermission`/
 *   `requireProtectedActionAuthorization`/`requireSameTenant` calls - a
 *   real, reachable path: the `/os/attention` destination gate only
 *   requires EXECUTE *or* protected-action authority, either alone, so a
 *   viewer who clears it with just one of the two still fails the domain
 *   function's own floor, which requires both), and
 *   `InvalidProtectedDecisionRecordError` - the remaining authority floor
 *   `resolveAuthenticatedDecisionAccess` enforces (access not GRANTED /
 *   no real membership), plus defensively an invalid outcome literal even
 *   though `parseAttentionDecisionForm` already allow-lists it.
 * - 409: `ProtectedDecisionRecordTransitionError` (the illegal-transition
 *   case, including "tried to approve/deny a decisionRef that's already
 *   decided") and `InvalidDurableProtectedDecisionRecordStoreError` (a
 *   genuine store-level conflict - a concurrent caller already
 *   created/revised this exact decisionRef with different content). Same
 *   "something changed, reload and retry" semantics as every other
 *   conflict in this corridor.
 * - 500 (the default/fallthrough, never message-leaking): any other error,
 *   including `CorruptedProtectedDecisionRecordLineError` or any
 *   unexpected error.
 */
function mapAttentionDecisionError(error: unknown): OutgoingResponseLike {
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
    error instanceof InvalidProtectedDecisionRecordError
  ) {
    return page({ kind: "FORBIDDEN" });
  }
  if (error instanceof ProtectedDecisionRecordTransitionError || error instanceof InvalidDurableProtectedDecisionRecordStoreError) {
    return page({ kind: "CONFLICT" });
  }
  return page({ kind: "ERROR", reason: "the protected decision could not be recorded" });
}

export function handleAttentionDecisionPost(input: {
  readonly request: IncomingRequestLike;
  readonly decisionRef: string;
  readonly sessionToken: string | undefined;
  readonly provider: StaffSessionProvider;
  readonly organization: Organization;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
  readonly decision: AttentionDecisionDeps;
}): OutgoingResponseLike {
  const { request, decisionRef, organization } = input;

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
    return mapAttentionDecisionError(error);
  }

  const nav = resolveNavVisibility(context);
  if (!isDestinationVisible("attention", context)) {
    return page({ kind: "FORBIDDEN", nav });
  }

  const form = parseAttentionDecisionForm(request.headers["content-type"], request.body);
  if (form === undefined) {
    return page({ kind: "BAD_REQUEST" });
  }

  const decidedAt = input.decision.clock !== undefined ? input.decision.clock() : new Date().toISOString();
  try {
    const tenantScope = createTenantScope(organization.tenantId);
    const current = input.decision.store.getDecisionRecord(tenantScope.tenantId, decisionRef);
    if (current === undefined) {
      /**
       * Judgment call (not specified by the route design this module
       * otherwise follows exactly): `createProtectedDecisionRecord` places
       * no restriction of its own on a brand-new record's `outcome` - it
       * would happily create a fresh `"REVOKED"` record out of nothing.
       * That is never a legitimate decision: a decisionRef can only be
       * revoked after it was first recorded `APPROVED`
       * (`reviseProtectedDecisionRecord`'s own one legitimate transition),
       * and the pending-decision row never offers a Revoke control
       * (`internal-os-attention-decision-controls.ts` only renders
       * Approve/Deny for a `decisionRef` with no current record). Rejected
       * here, before either domain function or the store is ever touched,
       * as the same kind of illegal-transition conflict
       * `ProtectedDecisionRecordTransitionError` already represents for
       * every other "no legitimate transition exists" case in this module.
       */
      if (form.outcome === "REVOKED") {
        throw new ProtectedDecisionRecordTransitionError(decisionRef, "NONE", "REVOKED");
      }
      const record = createProtectedDecisionRecordAsAuthenticatedStaff({
        tenantScope,
        decisionRef,
        outcome: form.outcome,
        decidedAt,
        evidenceRef: form.evidenceRef,
        organization,
        provider: input.provider,
        sessionToken: input.sessionToken,
        grants: input.grants,
        authority: context.grant.authority,
      });
      input.decision.store.putIfAbsentDecisionRecord(tenantScope.tenantId, decisionRef, record);
    } else {
      const revision = reviseProtectedDecisionRecordAsAuthenticatedStaff({
        current,
        tenantScope,
        outcome: form.outcome,
        decidedAt,
        evidenceRef: form.evidenceRef,
        organization,
        provider: input.provider,
        sessionToken: input.sessionToken,
        grants: input.grants,
        authority: context.grant.authority,
      });
      input.decision.store.reviseDecisionRecord(tenantScope.tenantId, decisionRef, revision);
    }
  } catch (error) {
    return mapAttentionDecisionError(error);
  }
  return DECISION_APPLIED_REDIRECT;
}
