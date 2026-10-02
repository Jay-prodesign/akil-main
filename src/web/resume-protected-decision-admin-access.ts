import { requireInternalOsAccess, type StaffAccessGrant } from "./internal-os-access.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import type { Organization } from "../domain/organization.js";
import {
  resumeProtectedDecisionAndExecuteConnectorEffect,
  type ResumeAndExecuteConnectorEffectResult,
} from "../domain/resume-protected-decision-for-connector-effect.js";

type DomainInput = Parameters<typeof resumeProtectedDecisionAndExecuteConnectorEffect>[0];

/**
 * Rev188 F3-item2 (authenticated resume ingress): `resumeProtectedDecisionAndExecuteConnectorEffect`
 * (`resume-protected-decision-for-connector-effect.ts`) re-resolves
 * `EffectiveAccessResolution` fresh immediately before authorizing the
 * resume (Rev188 item2's own fix to that domain function), but - exactly
 * like `resolveEffectiveOrganizationAccess`'s own doc comment already
 * states for every other consumer - it never authenticates
 * `currentPrincipalRef` itself; it only proves the supplied membership
 * belongs to the identity the caller currently ASSERTS. A caller could
 * therefore still pass an arbitrary, unauthenticated `currentPrincipalRef`/
 * `membership` pair straight into the domain function.
 *
 * This is that missing application boundary, mirroring
 * `connector-connection-admin-access.ts`'s own Rev188 F2 fix exactly:
 * authenticate the staff session first (`requireInternalOsAccess`, OS-V0-08's
 * existing staff ingress chain), THEN hand the domain function the
 * now-proven `membership`/`currentPrincipalRef`/`roleContext` for its own
 * independent re-resolution immediately before the resume. Domain code
 * never depends on `src/web/` (this repository's own established
 * layering), so `resumeProtectedDecisionAndExecuteConnectorEffect` itself
 * stays exactly as Rev188 item2/item3/item5 left it; this module is the
 * thin web-layer composition a real caller uses instead. A forged identity
 * (no matching session) fails inside `requireInternalOsAccess` itself,
 * before the domain function is ever reached; a stale role or a membership
 * revoked since an earlier resolution fails inside the domain function's
 * own re-resolution - either way, zero durable claim and zero transport
 * invocation.
 */
export async function resumeProtectedDecisionAndExecuteConnectorEffectAsAuthenticatedStaff(
  input: Omit<DomainInput, "organization" | "membership" | "currentPrincipalRef" | "roleContext"> & {
    readonly organization: Organization;
    readonly provider: StaffSessionProvider;
    readonly sessionToken: string | undefined;
    readonly grants: ReadonlyArray<StaffAccessGrant>;
  },
): Promise<ResumeAndExecuteConnectorEffectResult> {
  // Deliberately `async` (not a plain function returning the domain
  // call's own Promise): `requireInternalOsAccess` throws synchronously on
  // a forged/unauthenticated session, and an `async` function body turns
  // that synchronous throw into a rejected Promise automatically - the
  // correct, caller-expected contract for every other branch of this
  // function, which already only ever resolves or rejects a Promise.
  const context = requireInternalOsAccess({
    provider: input.provider,
    sessionToken: input.sessionToken,
    organization: input.organization,
    grants: input.grants,
  });
  const { provider, sessionToken, grants, organization, ...rest } = input;
  return resumeProtectedDecisionAndExecuteConnectorEffect({
    ...rest,
    organization,
    membership: context.membership,
    currentPrincipalRef: context.session.principal.principalId,
    ...(context.grant.roleContext !== undefined ? { roleContext: context.grant.roleContext } : {}),
  });
}
