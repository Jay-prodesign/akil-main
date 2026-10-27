import { requireStaffSession } from "./staff-route-guard.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import type { TenantScope } from "../domain/tenant-scope.js";
import {
  authorizeBreakGlassSupportAccess,
  type BreakGlassAccessGrant,
  type BreakGlassSupportAccessAudit,
  type BreakGlassSupportAccessDecision,
} from "../domain/break-glass-support-access.js";

/**
 * C7 (gap scan 2026-10-23): the application boundary OS-V1-09.md's own
 * design decisions call for. `authorizeBreakGlassSupportAccess`
 * (`break-glass-support-access.ts`) requires `currentPrincipalRef` to match
 * `grant.grantedToRef` exactly, but treats `currentPrincipalRef` as
 * caller-supplied evidence, like every other domain resolver here - it
 * never authenticates it. Without this wrapper, a caller holding a grant
 * object could simply assert `grant.grantedToRef` as `currentPrincipalRef`.
 *
 * This mirrors `authenticated-delegated-access.ts` (OS-V1-02) exactly:
 * authenticate the session first with `requireStaffSession` - deliberately
 * NOT the heavier `requireInternalOsAccess`, because a break-glass support
 * principal, exactly like a delegate, may hold no `OrganizationMembership`
 * in the target organization at all - so `currentPrincipalRef` is ALWAYS
 * `session.principal.principalId`, never a request/body/header value. There
 * is no `currentPrincipalRef` field anywhere in this function's input for a
 * caller to assert one with.
 *
 * A forged/absent/expired/revoked staff session throws
 * `StaffUnauthenticatedError` inside `requireStaffSession` itself, before
 * the grant is ever consulted - never converted to a `DENIED` result here,
 * exactly like both precedents, so the HTTP layer maps it to 401 uniformly.
 *
 * Audit-before-return: on a `GRANTED` decision, the decision's own
 * mandatory `BreakGlassSupportAccessAudit` is appended to `auditStore`
 * BEFORE the decision is returned. If the append throws (a duplicate
 * `auditRef`, a store failure), the error propagates and the caller never
 * receives a `GRANTED` decision whose evidence was not durably recorded.
 * A `DENIED` decision appends nothing.
 *
 * Domain code never depends on `src/web/`, so the frozen domain gate stays
 * exactly as OS-V1-09 left it; this module is the thin web-layer
 * composition a real caller uses instead.
 */

/**
 * Minimal append-only audit port. `FileDurableBreakGlassSupportAccessAuditStore`
 * satisfies it structurally; this web module never imports the concrete class.
 */
export interface BreakGlassSupportAccessAuditSink {
  append(audit: BreakGlassSupportAccessAudit): void;
}

/**
 * Minimal grant-lookup port. `FileDurableBreakGlassAccessGrantStore`
 * satisfies it structurally; the web layer never imports the concrete class.
 */
export interface BreakGlassAccessGrantLookup {
  getGrant(targetTenantScope: TenantScope, grantId: string): BreakGlassAccessGrant | undefined;
}

export function authorizeBreakGlassSupportAccessAsAuthenticatedStaff(input: {
  readonly grant: BreakGlassAccessGrant;
  readonly targetTenantScope: TenantScope;
  readonly provider: StaffSessionProvider;
  readonly sessionToken: string | undefined;
  readonly requestedView: unknown;
  readonly consentRef?: unknown;
  readonly auditRef: unknown;
  /**
   * Optional. Passed to `requireStaffSession` exactly as given (its own
   * optional `now`, see `staff-route-guard.ts`). The domain gate needs a
   * real clock to evaluate the grant's mandatory `expiresAt`, so when `now`
   * is omitted it defaults to `new Date().toISOString()` - the same
   * server-clock default the `/os` decision routes use for `decidedAt`.
   */
  readonly now?: string;
  readonly auditStore: BreakGlassSupportAccessAuditSink;
}): BreakGlassSupportAccessDecision {
  const session = requireStaffSession(input.provider, input.sessionToken, input.now);
  const decision = authorizeBreakGlassSupportAccess({
    grant: input.grant,
    targetTenantScope: input.targetTenantScope,
    currentPrincipalRef: session.principal.principalId,
    requestedView: input.requestedView,
    ...(input.consentRef !== undefined ? { consentRef: input.consentRef } : {}),
    auditRef: input.auditRef,
    now: input.now ?? new Date().toISOString(),
  });
  if (decision.outcome === "GRANTED") {
    input.auditStore.append(decision.audit);
  }
  return decision;
}
