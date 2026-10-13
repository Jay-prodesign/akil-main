# SITE-INTEGRATION-001 Slice A V2 — trusted production identity/session linkage (rescue)

## Provenance

Rescued from abandoned PR #99 (`SITE-INTEGRATION-001`), which Brain independently reviewed and returned **Rev78: PASS/VERIFIED — task-local CLOSED** (HIGH/PROTECTED classification, exact head `cc8d773`), but which was never merged and sat open/stale since 2026-09-18. PR #99's own base was PR #91's (`APP-I18N-001`) head — itself never merged.

Before porting anything, each dependency was independently re-verified against current `main` (`5dcbee99e3f0a0455915a7785ac939b069c1e33a`), not assumed from the old PR's own claim:

- **Slice A** (`identity-verifier.ts` + `production-session-provider.ts` rewrite + `http-server.ts` wiring): has **zero dependency** on PR #91's i18n work. Every signature it touches — `SessionProvider.resolveSession(sessionToken)`, `createAuthenticatedPrincipal({principalId, tenantId, customerId, displayName})`, `createSessionContext({principal, projectId, issuedAt})` — is byte-for-byte unchanged on current `main` versus when PR #99 was authored a month ago. Confirmed clean.
- **Slice B** (`client-platform-hydration.ts` + its new route + `shell-copy.ts` modification): depends on `src/web/shell-copy.ts`, which **does not exist on `main` at all** — `APP-I18N-001`/PR #91 (the file's own origin) never merged. Porting Slice B would mean resurrecting an entire never-merged portal-localization foundation, a substantially larger and more architecturally significant undertaking than this checkpoint. **Explicitly out of scope here** — see Non-Scope below.
- A separate candidate investigated in the same pass, **PR #101 (`ADM-PROJ-001`)**, was found to be **fully superseded**: it adds `src/domain/project-activation-profile.ts` as a new 885-line file, but that exact file already exists on `main` in an independently-evolved form (`compileProjectActivationProfile` now takes `serviceAdmission`/`effectiveConfigRefs`/`effectivePolicyRefs`, none of which PR #101's version has) — landed via a different path (the V1 lineage merge), not derived from PR #101's own lineage. PR #101 is stale and should simply be closed; nothing to rescue.

Branch: `claude/site-integration-001-slice-a-v2`, cut fresh from `main` at `5dcbee99e3f0a0455915a7785ac939b069c1e33a`.

## What this checkpoint does

Composes a provider-neutral `IdentityVerifier` port onto the existing fail-closed `createProductionSessionProvider` (established by `V2-APP-001`'s Architecture Invariant #8: production admits no real external identity provider and always reports "unauthenticated"), without replacing that invariant:

- New `src/web/identity-verifier.ts`: `VerifiedIdentityAssertion` (principalId/tenantId/customerId/displayName/optional projectId/issuedAt) + `IdentityVerifier.verify(sessionToken)`. `verify` receives **only** the caller-supplied session token — never a route/query/body/cookie value naming a tenant, customer, or project. This repository still selects no vendor SDK; the interface only defines the trust boundary a future provider-specific adapter must satisfy.
- `src/web/production-session-provider.ts`: `createProductionSessionProvider` now accepts an optional `{ verifier?: IdentityVerifier }`. Every failure path (`deps` omitted, no verifier configured, `sessionToken` undefined, `verify` throwing, `verify` returning `undefined`, or the returned assertion failing `createAuthenticatedPrincipal`/`createSessionContext`'s own validation) resolves identically to the original always-unauthenticated behavior. No code path here can return a session unless a real verifier is explicitly composed in and it explicitly resolves that exact token.
- `src/web/http-server.ts`: `createHttpServer` gains an optional `identityVerifier?: IdentityVerifier` dep, passed through to `createProductionSessionProvider`. `node-server-entrypoint.ts` passes no `identityVerifier` — today's always-unauthenticated production behavior is unchanged.

## Scope (this checkpoint)

- `src/web/identity-verifier.ts` (new).
- `src/web/production-session-provider.ts` (modified): optional `verifier` composition.
- `src/web/http-server.ts` (modified): optional `identityVerifier` dep, purely additive.
- `tests/identity-verifier-production-session.test.ts` (new, 5 tests): A8-preservation (no deps/no verifier still always unauthenticated), missing/invalid/throwing verifier never resolves, a valid assertion resolves the verifier's own tenant/customer/project/displayName exactly, a malformed assertion (empty field) fails closed, two distinct assertions resolve independently (no substitution).
- `IMPLEMENTED / SELF-VALIDATED`: clean build, clean strict typecheck, full regression **2669/2669 passing** (2664 pre-existing on this `main` tip + 5 new), zero new runtime dependency.

## Honest disclosure

A guard-disable sanity check succeeded this time (not blocked by the environment's permission classifier, unlike some earlier checkpoints this session): temporarily short-circuited the `deps?.verifier === undefined || sessionToken === undefined` guard with `false &&` — confirmed exactly 1 of the 5 new tests then failed (the no-token-supplied case), and the guard's removal also surfaced two genuine TypeScript strict-null errors downstream, independently confirming the guard is load-bearing from two directions. Reverted immediately; full regression reconfirmed **2669/2669 passing** after revert.

## Hard Non-Scope

- **Slice B** (customer-safe hydration transport, `/client-platform/:tenantId/:customerId/:projectId` route, `shell-copy.ts` EN/TR `deliveryStatusLabel`): not ported. Depends on `APP-I18N-001`/PR #91's `shell-copy.ts`, which does not exist on `main`. Rescuing it would require first resurrecting that entire never-merged localization foundation — a separate, larger checkpoint, not undertaken here without further Founder/Brain direction on whether portal localization is still in scope.
- No real external identity provider is selected, instantiated, or connected. `IdentityVerifier` remains an uninstantiated port, exactly as PR #99 itself specified. No vendor SDK, no credential shape, no production composition.
- PR #101 (`ADM-PROJ-001`) is not touched by this checkpoint; it is flagged here as confirmed-stale/superseded and a candidate for the Founder to simply close.

## Evidence

- `rm -rf dist && npx tsc -p tsconfig.json`: exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2669/2669 passing**, 0 fail/cancelled/skipped/todo.
- `node --test dist/tests/identity-verifier-production-session.test.js`: 5/5 passing standalone.
- `git diff --stat origin/main -- package.json package-lock.json`: empty, zero new dependency.
- Guard-disable sanity (see Honest disclosure above): exactly 1 test failed with the guard short-circuited; reverted and reconfirmed green.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`. Risk classification: HIGH/PROTECTED (identity/session boundary, per the original PR #99's own framing) but LOW actual risk surface — purely additive optional composition, zero behavior change for any caller that does not supply a verifier (the only caller in this repo, `node-server-entrypoint.ts`, does not).

PR #99 remains open/stale and should be closed once this independent re-derivation (Slice A only) is reviewed. PR #101 should also be closed as superseded by `main`'s own evolved `project-activation-profile.ts`.
