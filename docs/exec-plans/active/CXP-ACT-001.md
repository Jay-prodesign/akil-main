# CXP-ACT-001 — Activation Required Action → Client Snapshot Projection

## Provenance

- Governing authority: canonical Handoff REV215 (2026-10-11) — continuous post-V1 engineering, selecting from already-admitted, already-evidenced work rather than inventing scope.
- Not invented scope: this exact change was already specified, implemented, and independently Brain-PASS/VERIFIED (Rev111, `TASK-LOCAL CLOSED`) in a prior session on abandoned PR #102, stacked on PR #101 (`ADM-PROJ-001`) at base `main@3226c76fa338e425e553638e5f5f48924182a1c0`. That stack went stale only because it was superseded chronologically by the much larger OS-V0/OS-V1 corridor landing, not because of any defect in its own content — it carries a clean, zero-correction-round PASS verdict.
- A fresh audit of current `main` found: (1) `src/domain/project-activation-profile.ts` (ADM-PROJ-001's own module) **already exists on `main`** — it landed through a different branch during the 58-PR V1 lineage consolidation, with an identical `ProjectActivationProfile` interface (`ownership`/`state: ActivationState`/`nextRequiredActor: ActivationActor`/`nextRequiredAction?`) to the one PR #102 was written against, so ADM-PROJ-001 itself needs no rescue; (2) `src/domain/client-project-snapshot.ts` on `main` had **no** `activationProfile` wiring at all — PR #102's own specific contribution never landed. This checkpoint re-applies PR #102's Rev111-accepted logic, manually re-integrated against current `main`'s exact function structure (which matches PR #102's own base closely enough to apply directly, verified line-by-line) rather than redesigning it.
- **Explicitly deferred from this checkpoint**: PR #103 (`DEC175-CONV-001`), the pure-integration test proving the full `compileProjectActivationProfile → buildClientProjectSnapshot → renderShellPage` chain end-to-end, is **not** ported here. Its own base (`compileProjectActivationProfile`) has since gained a required `serviceAdmission: ServiceCatalogAdmission` parameter (added by the later `SVC-ADM-001`/Family-1 integration during the OS-V0/V1 corridor) that PR #103's test never supplies — porting it verbatim would not compile. Re-deriving that test against the current, evolved compiler signature is real additional work, not a straight port, and is left as an explicit follow-up candidate rather than attempted speculatively here.
- Branch: `claude/cxp-act-001-activation-projection`, cut fresh from `main` at `5dcbee99e3f0a0455915a7785ac939b069c1e33a` (same tip as `APP-SUB-001`/PR #140 and `ORG-ONBOARD-001`/PR #141 — independent of, and disjoint from, both).

## Scope (this checkpoint)

- `src/domain/client-project-snapshot.ts`: `buildClientProjectSnapshot` gains one new optional input, `activationProfile?: ProjectActivationProfile` (type-only import from `./project-activation-profile.js` — no value/runtime dependency on that module's compiler). When supplied, `activationProfile.ownership` must exactly match the snapshot's own `ownership` tuple (reusing the existing `ownershipEquals` helper, unmodified) — any mismatch throws `InvalidClientProjectSnapshotError`. The two fields this projection actually consumes are independently re-validated for internal consistency (never trusting the caller's own construction): `state === "READY"` requires `nextRequiredActor === "NONE"` and no `nextRequiredAction`; `state === "ACTION_REQUIRED"` requires a non-`"NONE"` actor and a present action. `nextRequiredActor` maps explicitly (`"CUSTOMER"` → `CLIENT_ACTION_REQUIRED`; `"AKILTA"`/`"HUMAN_REVIEW"` → `AKILTA_ACTION_REQUIRED`, both AKILTA-internal from the customer's point of view) — any other runtime value throws rather than falling through to a default. When `ACTION_REQUIRED`, the resulting `nextAction` **replaces** any communication-derived value entirely and never carries a `relatedCommunicationId`; when `READY`, the existing communication-derived logic is left completely untouched. No new `ClientProjectSnapshot` public field was needed — the existing `CLIENT_ACTION_REQUIRED`/`AKILTA_ACTION_REQUIRED` literals already cover both activation-derived cases.
- `tests/client-project-snapshot.test.ts`: 11 new tests (A1–A10, A7 split across two tests), appended to the existing suite, none of which were modified.
- `IMPLEMENTED / SELF-VALIDATED`: clean build, clean strict typecheck, full regression **2675/2675 passing** (2664 pre-existing + 11 new), zero new runtime dependency.

## Explicitly deferred (not fabricated)

- No new `ClientProjectSnapshot` output field.
- No web/shell file change — the existing shell already renders `snapshot.nextAction` generically; no route/admin UI change is needed or attempted.
- No re-implementation of `project-activation-profile.ts`'s own compiler, authority, or fingerprint logic — this module treats `ProjectActivationProfile` purely as an already-computed, structurally-typed input.
- No production activation, execution/approval authority, `OutcomeJob`/`ProjectPlan`/communication-state mutation, or persistence/network/provider action.
- `DEC175-CONV-001`'s end-to-end integration proof is not re-derived here (see Provenance) — a real, separately-scoped follow-up given the compiler's evolved `serviceAdmission` requirement.

## Architecture / semantic invariants (verified by test)

- Activation readiness (`ACTION_REQUIRED`) always takes precedence over a conflicting communication-derived `nextAction`; `READY` never disturbs existing communication-derived behavior (A4, A5).
- `CUSTOMER` always maps to `CLIENT_ACTION_REQUIRED`; both `AKILTA` and `HUMAN_REVIEW` map to `AKILTA_ACTION_REQUIRED` (A1–A3).
- An `activationProfile` belonging to a different customer, project, or `serviceRef` is rejected exactly like every other cross-tenant input this module already guards (A6).
- A hand-built or tampered `ProjectActivationProfile`-shaped object can never manufacture a client action: `READY` with a non-`NONE` actor or a present action rejects; `ACTION_REQUIRED` with actor `NONE`, a missing action, or an unrecognized actor/state value all reject (A7 ×2) — this module's own independent re-validation, not trust of the caller's construction.
- An activation-derived `nextAction` never carries a `relatedCommunicationId` (A8), and the serialized snapshot never contains any `ProjectActivationProfile`-internal provenance field (A9).
- Identical inputs remain fully deterministic, and omitting `activationProfile` entirely reproduces pre-existing behavior exactly — an additive, backward-compatible input, not a behavior change to any existing caller (A10).

## Hard Non-Scope

No modification to `project-activation-profile.ts` (consumed type-only, unmodified) or any other existing domain file beyond `client-project-snapshot.ts`'s own additive input. No new runtime dependency. No web/shell file touched. No MAIN mutation, merge, or deploy.

## Evidence

- `npx tsc -p tsconfig.json` (clean `dist/` rebuild): exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2675/2675 passing** (2664 pre-existing on this `main` tip + 11 new).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/client-project-snapshot.ts`, `tests/client-project-snapshot.test.ts`, this exec-plan, `docs/engineering/CURRENT_STATE.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10; Claude's authority ends at this status. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`. Risk classification: LOW — a purely additive, optional, backward-compatible input to an already-customer-safe projection function, with no IAM/authority/payment/provider coupling.
