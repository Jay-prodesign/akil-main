import type { SessionProvider } from "./session-provider.js";
import type { IdentityVerifier } from "./identity-verifier.js";
import { createAuthenticatedPrincipal, createSessionContext } from "./session-context.js";

/**
 * V2-APP-001 (IN SCOPE F / Architecture Invariant #8 / A8) established that
 * production admits no real external identity/session provider and always
 * reports "unauthenticated". SITE-INTEGRATION-001 Slice A composes a
 * provider-neutral `IdentityVerifier` onto that same fail-closed shape
 * rather than replacing it: this repository still selects no vendor SDK,
 * and every one of the failure paths below (`deps` omitted, no
 * `verifier` configured, `sessionToken` undefined, `verify` throwing,
 * `verify` returning `undefined`, or the returned assertion failing
 * `createAuthenticatedPrincipal`/`createSessionContext`'s own validation)
 * resolves identically to the original always-unauthenticated behavior.
 * There is no code path here that can be made to return a session no
 * matter what `sessionToken` value is supplied unless a real verifier is
 * explicitly composed in and it explicitly resolves that exact token.
 *
 * The verifier is called with `sessionToken` alone - never a caller-
 * supplied tenantId/customerId/projectId - so only the verifier's own
 * returned `VerifiedIdentityAssertion` can ever supply tenant/customer/
 * project scope; browser-controlled route/query/body/cookie values can
 * never widen it.
 */
export function createProductionSessionProvider(deps?: {
  readonly verifier?: IdentityVerifier;
}): SessionProvider {
  return {
    resolveSession(sessionToken: string | undefined) {
      if (deps?.verifier === undefined || sessionToken === undefined) {
        return undefined;
      }

      let assertion;
      try {
        assertion = deps.verifier.verify(sessionToken);
      } catch {
        return undefined;
      }
      if (assertion === undefined) {
        return undefined;
      }

      try {
        const principal = createAuthenticatedPrincipal({
          principalId: assertion.principalId,
          tenantId: assertion.tenantId,
          customerId: assertion.customerId,
          displayName: assertion.displayName,
        });
        return createSessionContext({
          principal,
          projectId: assertion.projectId,
          issuedAt: assertion.issuedAt,
        });
      } catch {
        return undefined;
      }
    },
  };
}
