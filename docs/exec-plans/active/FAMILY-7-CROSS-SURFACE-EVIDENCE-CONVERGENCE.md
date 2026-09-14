# Family 7 — Cross-Surface Evidence/Outcome Reporting Convergence (Rev98/Rev101 gap)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Rev98/Rev101's Family 7: *"cross-surface evidence/outcome reporting convergence using existing customer-evidence/cross-domain/effect evidence"* with acceptance shape "provenance/comparability/customer-safe projection."
- Had been dispositioned `TRIGGER_NOT_MET` because its prerequisite branches (`cross-domain-intelligence.ts`/`V5-INT-001`, `V4-EFF-001`/PR #42, `OBS-TEL-001`/PR #45) were not all on a common base — however, independent re-verification found `cross-domain-intelligence.ts` (`V5-INT-001`) was already merged into `main` at `839aca0f6dd830c46dcf4576e46035c3fdbd9207` long before this batch, so only two branches (`V4-EFF-001`, `OBS-TEL-001`) actually needed merging, not three. Per the canonical Handoff's "EXECUTION REMINDER — REV101 / NO PARKING" appendix (added 2026-09-12), "a local branch blocker" is not a stop condition, and both remaining branches are this session's own draft branches, so merging them directly is a reversible action within existing authority.
- Branch `claude/family-7-cross-surface-evidence-convergence`: `git merge` of `claude/family-5-website-build-control-adapters` (already contains `CONN-001`+`V4-EFF-001`, exact head `50e6d52...`) and `claude/obs-tel-001-telemetry-floor` (exact head `4117c715b5a0dfe79956f372f2b9e9ecd0247e10`). Both trace to the same `main` ancestor (`3226c76fa338e425e553638e5f5f48924182a1c0`), so every source/test file merged with zero conflict; only `CURRENT_STATE.md`/`V2_TO_V5.md` conflicted, resolved by keeping both branches' independently-true additive narratives in sequence.

## Scope (this checkpoint)

`src/domain/cross-surface-evidence-convergence.ts` — composing, never redefining (type-only imports throughout): `customer-evidence.ts`'s `CustomerEvidenceItem`, `cross-domain-intelligence.ts`'s `ReconciledInsight`, `external-effect-envelope.ts`'s `ExternalEffectAttempt`, and `observability-telemetry.ts`'s `MetricReadModel`:

- **Provenance + comparability**: a shared `ConvergedEvidenceDisposition` (`CONFIRMED`/`UNCERTAIN`/`CONTRADICTED`/`UNAVAILABLE`) that each of the four existing, incomparable status vocabularies projects onto, via four small pure functions (`convergeCustomerEvidenceItem`, `convergeIntelligenceInsight`, `convergeExternalEffectAttempt`, `convergeMetricReadModel`). Every `ConvergedEvidenceItem` preserves the exact original status string (`originalStatus`) and an opaque `sourceRef`, so nothing is blurred or lost — comparability without loss of provenance.
- **Honest mappings, not fabricated ones**: a merely `APPLIED` (not yet `VERIFIED`) effect attempt converges to `UNCERTAIN`, mirroring `external-effect-envelope.ts`'s own "readback is authoritative over a claimed outcome" discipline — it is never treated as `CONFIRMED` just because a provider claimed success. `ROLLED_BACK` converges to `CONTRADICTED` (a deliberate undo of something that did apply). `UNKNOWN` converges to `UNCERTAIN`, never a guessed `FAILED` or `CONFIRMED`. `NOT_MONITORED`/`MISSING` telemetry and `UNKNOWN` customer evidence all converge to `UNAVAILABLE` — an absence of positive evidence is never promoted to a positive claim.
- **Aggregation**: `buildConvergedEvidenceSnapshot` is pure aggregation only (never fetches or re-derives evidence itself) — the caller supplies already-converged items for one `subjectRef`.
- **Customer-safe projection**: `projectCustomerSafeEvidenceSummary` returns `CustomerSafeEvidenceSummary`, which has no field capable of holding `sourceRef`, `originalStatus`, or which internal surface(s) contributed — structurally absent, not omitted by convention. `overallDisposition` is the pessimistic (most severe) disposition across every item — a single `CONTRADICTED` item can never be hidden behind otherwise-confirmed evidence — and an empty snapshot is honestly `UNAVAILABLE`, never a fabricated `CONFIRMED`.
- `tests/cross-surface-evidence-convergence.test.ts` (20 tests: X1-X20) and `tests/family-7-boundary-scan.test.ts` (6 tests).

## Explicitly deferred (not fabricated)

- **No wiring into a real customer-facing UI or report.** This is the read-model/projection layer only.
- **No persistence.** `buildConvergedEvidenceSnapshot` is pure aggregation over caller-supplied, already-converged items; no durable store is built or implied.
- **No new evidence surface.** All four sources reused are exactly the ones Rev98 names — no fifth surface invented.
- **No numeric/statistical confidence scoring.** `ConvergedEvidenceDisposition` is a closed four-value enum, not a probability — inventing a score would fabricate precision none of the four source modules actually provide.

## Architecture / semantic invariants (verified by test)

- Customer evidence: FACT→CONFIRMED (X1), HYPOTHESIS→UNCERTAIN (X2), UNKNOWN→UNAVAILABLE (X3).
- Cross-domain intelligence: CURRENT→CONFIRMED (X4), STALE→UNCERTAIN (X5), CONFLICTING→CONTRADICTED (X6).
- External effect: VERIFIED→CONFIRMED (X7); APPLIED→UNCERTAIN, the readback-authoritative honesty guard (X8); FAILED→CONTRADICTED (X9); ROLLED_BACK→CONTRADICTED (X10); UNKNOWN→UNCERTAIN (X11); NOT_STARTED→UNAVAILABLE (X12).
- Telemetry: REPORTED_FRESH→CONFIRMED (X13); REPORTED_STALE→UNCERTAIN (X14); MISSING→UNAVAILABLE (X15); NOT_MONITORED→UNAVAILABLE (X16).
- Snapshot/summary: rejects an empty subjectRef (X17); empty snapshot is honestly UNAVAILABLE (X18); a single CONTRADICTED item dominates the pessimistic aggregate (X19); the customer-safe summary carries no provenance field (X20).

## Hard Non-Scope

No modification to `customer-evidence.ts`, `cross-domain-intelligence.ts`, `external-effect-envelope.ts`, or `observability-telemetry.ts` (all read-only type dependencies); no real network/DNS call anywhere; no persistence; no admin/UI wiring; no new runtime dependency.

## Evidence

- `npx tsc --noEmit -p .`: exit 0, strict mode.
- `npm run test`: **904/904 pass** (878 pre-existing on the merged Family-5+OBS-TEL-001 base + 26 new: 20 functional + 6 boundary-scan).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/cross-surface-evidence-convergence.ts` (new), `tests/cross-surface-evidence-convergence.test.ts` (new), `tests/family-7-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending fresh Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — this branch is a merge of the Family 5 branch (itself a merge of PR #38 + PR #42) and PR #45's own branch; its own eventual PR should be reviewed alongside all three source PRs. Deferred to the one consolidated end-of-batch Brain review packet alongside PR #32 (SVC-ADM-001), #38, #39, RUNTIME-001, V5-PTN-002 (Handoff-Rev101-corrected), V4-EFF-001 (Handoff-Rev101-corrected), LOCAL-EXEC-001 (Handoff-Rev101-corrected), LOCAL-EXEC-002, LOCAL-EXEC-003, OBS-TEL-001, AUT-OPS-001, DEP-ORCH-001, and Family 5.
