# SITE-INTEGRATION-001 — Client Platform Production Identity + Customer-Safe Hydration Adapter

## Authorization

AA-005 (Brain, "AUTHORIZED IMPLEMENTATION"): the Founder's final-site directive requires the completed repository to connect to the prepared AKILTA commerce-site Client Platform. Fresh repository+site reconciliation found two concrete integration gaps, previously trigger-gated rather than implementation defects: `createProductionSessionProvider()` intentionally always returns unauthenticated, and the existing request-handler transport renders HTML only — the live `client-platform-v1` shell contract requires a real trusted identity/session binding plus a customer-safe JSON hydration transport. TASK STATUS: READY / IMPLEMENTATION AUTHORIZED. RISK: HIGH/PROTECTED identity/tenant/customer/project boundary. MERGE_DISPOSITION: HOLD_MERGE / NOT SAFE_MERGE until independent Brain exact-head verification. FOUNDER GATE: NONE for bounded branch implementation, tests, push and DRAFT PR — no MAIN mutation, production deploy, live Client Platform publication/customer activation or credential commitment is authorized by this packet.

**Exact base selection:** branched from PR #91 (`APP-I18N-001`) exact Brain PASS/VERIFIED head `51944ba8ea35b20e90487ca21270f006898daeb3` — the smallest dependency-correct Client Portal lineage, independently re-verified live before branching (still OPEN/DRAFT/mergeable, exact head unchanged). Not stacked on PR #93/#95/#98.

## Implementation

**Slice A — Trusted production identity/session linkage** (`src/web/identity-verifier.ts`, `src/web/production-session-provider.ts`, `src/web/http-server.ts`): a new provider-neutral `IdentityVerifier` port (`verify(sessionToken): VerifiedIdentityAssertion | undefined`) that receives only the caller's session token — never a route/query/body/cookie value. `createProductionSessionProvider` now accepts an optional `{ verifier }` dependency; when composed in, a resolved assertion is converted to a real `SessionContext` via the existing, unmodified `createAuthenticatedPrincipal`/`createSessionContext` (so tenant/customer scope is still derived only from the trusted principal, per V2-APP-001 A6). Every failure path — no `deps`, no `verifier`, missing token, `verify` throwing, `verify` returning `undefined`, or the returned assertion failing existing validation — resolves identically to the original always-unauthenticated behavior. `createHttpServer` accepts an optional `identityVerifier` and composes it in only for the production session provider; the dev-fixture path is untouched.

**Slice B — Customer-safe hydration transport** (`src/web/client-platform-hydration.ts`, plus a new JSON route in `src/web/request-handler.ts`): `resolveClientPlatformHydration` converts an already-authorized `ClientProjectSnapshot` into the site's closed `client-platform-v1` state/payload contract (`signed-out | ready | empty | unauthorized | error | unsupported` — `loading`/`unavailable` are the site theme's own pre-hydration states and are never emitted server-side). It reuses `requireSession` and `resolveProtectedSnapshotView` verbatim — the exact same auth/ownership/snapshot gate order the existing HTML `/portal/...` route already uses — rather than re-implementing authorization for a second route. A new sibling path, `/client-platform/:tenantId/:customerId/:projectId`, is wired into the existing `createRequestHandler` (distinct top-level segment from `/portal/...`, so it can never be confused with or fall through into the HTML route) and returns JSON with a status code mirroring the equivalent HTML `ShellPageContent` kind.

**State mapping:** unauthenticated→`signed-out`; forbidden tenant/customer/project scope→`unauthorized`; `NOT_STARTED`→`empty`; source/runtime failure→`error` (no message — see below); unsupported HTTP method→`unsupported`; valid `IN_PROGRESS`/`BLOCKED`/`COMPLETE`→`ready` (`BLOCKED` stays `ready` with a truthful status, not a new lifecycle, per the task's own instruction). `NOT_FOUND` (no snapshot for an otherwise-authorized scope, or a source-returned snapshot whose ownership doesn't match the request) has no dedicated literal in the site's state enum; per this repository's existing DEC-153 "no invented business rule" discipline it is mapped to `empty` rather than fabricating a new state or overclaiming `error`.

**Customer-readable status, not a raw enum:** `ShellCopy` gained one new field, `deliveryStatusLabel: Record<DeliveryStatusLabel, string>` (EN + TR), matching the existing `timelineCategory` pattern — the JSON hydration contract must never present a raw `DeliveryStatusLabel` literal, unlike the pre-existing HTML shell's own `overallStatusLabel`, which predates this requirement and still interpolates the raw enum value. `nextAction` reuses the existing translated `nextAction[owner].label` catalog unmodified.

**Deliberately not fabricated:** `project.title`/`project.summary`/`identity.name`'s email are never populated — `ClientProjectSnapshot` has no trusted source for a title/summary/email, and the live theme already supplies a safe UI fallback when these are absent. `identity.name` resolves only from the trusted `AuthenticatedPrincipal.displayName`. `projects[]` (account-level project list) is structurally absent from `ClientPlatformHydratePayload` — not merely omitted by convention — because this repository has no trusted account-level list projection. `error.message` is deliberately never populated from a caught exception's own `.message`: that text originates from whatever the snapshot source threw and could carry internal detail (tenant/customer identifiers, connection strings, etc.); there is no existing customer-safe error-message catalog to sanitize it against, so the field is omitted entirely rather than passed through unsanitized.

**AKILTA/commerce-provider boundary:** no source file added or touched by this task names the connected commerce platform by product name — this repository already enforces that boundary as a repo-wide regression test (`tests/project-boundary-scan.test.ts`, `tests/v2-app-001-boundary-scan.test.ts`); an early draft of this task's own doc comments violated it and was caught immediately by the existing test suite, then corrected to provider-neutral language ("the live commerce-site client-platform-v1 shell").

## Mandatory invariant classification

- **EI-1 NOT_APPLICABLE** — this bounded task introduces no material third-party write/external effect.
- **EI-2 NOT_APPLICABLE** — no effect idempotency/fan-out operation is introduced.
- **EI-3 IN_SCOPE** as fresh protected-read authority/session resolution — the new `IdentityVerifier` composition never reuses caller/browser-supplied values as trusted scope; only the verifier's own returned assertion can supply tenant/customer/project identity.
- **EI-4 IN_SCOPE / LOAD-BEARING** — tenant/customer/project scope remains structural and exact throughout both slices; `resolveClientPlatformHydration` reuses (never re-implements) the existing exact-match ownership check.
- **EI-5 NOT_APPLICABLE** — no metered/bulk fan-out.
- **EI-6 IN_SCOPE boundary preservation** — AKILTA-only; no AI Commerce repo/domain/credential coupling, no commerce-provider product name in source (see above).
- **EI-7 NOT_APPLICABLE** — no learning/training/retrieval eligibility surface.

## Locked adversarial proof — evidence

All ten proofs are covered by `tests/identity-verifier-production-session.test.ts` and `tests/client-platform-hydration.test.ts`/`tests/client-platform-hydration-request-handler.test.ts`:

1. Missing/invalid external identity never resolves a session — `createProductionSessionProvider` tests (no deps, no verifier, missing token, verifier throws, verifier returns `undefined`).
2. A valid external identity cannot substitute another tenant/customer/project — two independent verified assertions resolve independently; a foreign-tenant hydration request resolves `unauthorized`.
3. Caller-controlled route/body/query/hydrate fields cannot widen scope — the `IdentityVerifier.verify` signature accepts only `sessionToken`; the hydration adapter's `requestedOwnership` is checked against the trusted session, never merged into it.
4. Snapshot source is never called before auth/ownership gates — spy-source test for both the signed-out and unauthorized paths.
5. A faulty/foreign-scope snapshot never reaches `ready` — a self-consistent snapshot for a genuinely different project, returned by a compromised source, resolves `empty`.
6. Hydrate output contains no tenant/customer ids, principal id, secrets/provider refs or internal-only fields — structural JSON-string assertions on the `ready`/`error` payloads; `error.message` is proven absent even when the underlying exception carries sensitive text.
7. `NOT_STARTED`/`IN_PROGRESS`/`BLOCKED`/`COMPLETE` mapping is deterministic — one test per literal, including the BLOCKED-stays-`ready`-not-a-new-lifecycle case and its customer-safe (never raw internal reason) status text.
8. No `projects[]` without a trusted account-level list source — asserted structurally absent (`hasOwnProperty` false) across every emitted state.
9. No email/title/summary fabrication — asserted `undefined` on the `ready` payload.
10. Existing portal/session/snapshot + APP-I18N locale regression remains green — full suite (1711/1711) passes, including all pre-existing session/route-guard/snapshot/i18n/request-handler tests unchanged.

## Sanity-check disclosure

Focused load-bearing sanity per the task's own instruction: the new fail-closed guard in `createProductionSessionProvider` (returning `undefined` on a missing/throwing/undefined verifier assertion) was temporarily disabled — replaced with a fallback synthetic assertion whenever the verifier didn't resolve one — and the full suite re-run. Exactly the two tests exercising that guard failed (`adversarial proof 1: missing/invalid external identity never resolves a session`; the unknown-token branch of the two-independent-assertions test), nothing else. The guard was restored and the full suite reconfirmed green (1711/1711).

## Validation

**1711/1711 tests pass** (1683 pre-existing on PR #91's base + 28 new: 6 identity-verifier/production-session tests, 15 client-platform-hydration unit tests, 7 request-handler integration tests). Strict `tsc --noEmit -p .` clean. Clean `dist/` rebuild. Zero new runtime dependency (`package.json` unchanged). Full regression run due to the identity-boundary change, not merely targeted tests.

## Non-scope (unchanged from the task packet)

Payment gateway activation; invoices/tax; commerce-site theme publication; Client Platform page publication; customer activation; account-level multi-project discovery; new project lifecycle; new IAM model; new customer/project identity scheme; unrelated V2→V5 hardening; subscription commerce; AI Commerce scope. No real external identity provider is selected or connected by this task — `IdentityVerifier` remains an uninstantiated port, exactly like the pre-existing `SessionProvider` port it composes with.

## Status

`IMPLEMENTED / SELF-VALIDATED` only. Per `AGENTS.md`/`CLAUDE.md`, Claude's authority ends here — PASS/VERIFIED/SAFE_MERGE can only be declared by Brain or the Founder. `HOLD_MERGE` / `NOT SAFE_MERGE` (HIGH/PROTECTED identity/tenant/customer/project boundary, per the task's own framing). Founder gate: NONE for the bounded branch/tests/push/DRAFT PR already completed by this document.
