# V5X-CAP-001 — AKILTA Idea Valuation Vertical Slice (bounded, non-production)

## Provenance

- Original authorization: AA-002/AA-012 (DEC-172, REQ-AI-013/014/015/016) — "V5X-CAP-001 (Idea Valuation)" was the canonical bounded non-production engineering slice at the time this module was first implemented (2026-09-23), on abandoned PR #100.
- Rescued under REV215 (2026-10-11): a repo-wide audit of every orphaned open PR found this module fully implemented, fully self-validated (729/729 tests passing in its own prior validation), and — unlike the other rescued checkpoints this session — **structurally self-contained with zero imports of any kind**: `src/domain/idea-valuation.ts` imports nothing from the rest of this repository, so there is no dependency-staleness risk to check at all. It never landed on `main` purely because PR #100's own base (`main@3226c76fa338e425e553638e5f5f48924182a1c0`) was superseded by the much larger OS-V0/V1 corridor landing before it could be merged — not because of any defect.
- Branch: `claude/v5x-cap-001-idea-valuation-v2`, cut fresh from `main` at `5dcbee99e3f0a0455915a7785ac939b069c1e33a` (same tip as `APP-SUB-001`/PR #140, `ORG-ONBOARD-001`/PR #141, and `CXP-ACT-001`/PR #142 — independent of, and disjoint from, all three).
- Re-applies PR #100's exact original content verbatim (`git show <exact head>:<path>` against commit `f1db400bbf4e4bb302f28c3afa6bdbf365b06d1c`) — zero modification, since zero adaptation was needed.

## Scope (this checkpoint)

`src/domain/idea-valuation.ts` (new, 330 lines) — a pure, provider-neutral domain module with no HTTP route, no persistence, no new runtime/service/repository, no identity/auth/billing surface:

- **Versioned capability identity**: `CAPABILITY_ID`, `CAPABILITY_VERSION`, `METHODOLOGY_VERSION`, `RUBRIC_VERSION`, `WORKFLOW_VERSION`, `PROMPT_VERSION` — explicit constants, never inferred.
- **Anonymous-first minimal input**: `IdeaValuationInput` (`ideaSummary` required, `targetAudience`/`problemStatement` optional) — no identity/tenant/customer binding accepted or required.
- **Weighted rubric totaling 100**: `IDEA_VALUATION_RUBRIC` — six fixed criteria. A module-load guard throws immediately if the weights ever stop summing to exactly 100.
- **Provider-neutral reasoner port**: `IdeaValuationReasoner.evaluate(input)` returns an opaque `workerRef` (never a real vendor SDK reference) plus structured `criterionAssessments`. `evaluateIdea` calls it exactly once per evaluation.
- **Fail-closed structured-output validation** (`scoreIdeaValuation`): rejects a missing, duplicate, or unrecognized criterion; rejects a non-finite or out-of-`[0,100]` rating; rejects an empty/non-string rationale; rejects any `evidenceKind` outside the currently reachable set.
- **Evidence-kind vocabulary**: `USER_PROVIDED | INFERENCE | RESEARCHED | UNKNOWN` is the full declared type, but `RESEARCHED` is rejected at validation time in this slice — there is no admitted research tool wired to a reasoner, so a claim of researched evidence would be unbacked by construction.
- **Deterministic scoring**: the final 0–100 score is always computed in code from validated per-criterion ratings × weights; the reasoner's output shape carries no score/result field at all.
- **Deterministic next-action/CTA policy** (`resolveNextActionPolicy`): score ≥ 70 → `STRONG_SIGNAL_CONSIDER_NEXT_STEPS`; 40–69 → `MODERATE_SIGNAL_REFINE`; < 40 → `WEAK_SIGNAL_RECONSIDER`.
- **Learning/research disposition, fixed fail-closed**: `learningEligibility: "NONE"` and `researchPolicy: "NONE"` are hard-coded into every `IdeaValuationReport` — no constructor input path can set either to anything else.

`tests/idea-valuation.test.ts` (new, 21 tests) — covers happy-path scoring, rubric-weight invariant, missing/duplicate/unrecognized criterion rejection, out-of-range/non-finite/malformed rating rejection, empty-rationale rejection, `RESEARCHED`/unrecognized evidence-kind rejection, reasoner-score-override impossibility, fixed learning/research disposition, deterministic next-action band boundaries, cross-evaluation state isolation, anonymous-input structural proof, and input-validation edge cases.

`IMPLEMENTED / SELF-VALIDATED`: clean build, clean strict typecheck, full regression **2685/2685 passing** (2664 pre-existing + 21 new), zero new runtime dependency.

## Explicitly deferred (not fabricated)

Real provider/model SDK integration or credentials; any research/live-data/domain-validation tool; persistence of any evaluation record; HTTP route or public exposure; account/identity/auth system; billing/entitlement; new runtime/service/repository/registry/factory; multi-capability orchestration; AI Commerce merchant truth, connectors, or actions; promotion of any evaluation to global learning/training eligibility.

## Architecture / semantic invariants (verified by test)

- Rubric weights total exactly 100, enforced at module load (TEST 2).
- A reasoner cannot supply or override the final score — the accepted output shape carries no such field, and a smuggled `finalScore` is never read (TEST 10).
- `learningEligibility`/`researchPolicy` are always `"NONE"` regardless of input — no constructor path sets either otherwise (TEST 11).
- `RESEARCHED` evidence is rejected unconditionally — no admitted research tool exists in this slice (TEST 8).
- Input is structurally anonymous — no `tenantId`/`customerId`/`accountId`/`userId` field exists anywhere on `IdeaValuationInput` (TEST 14).
- Two independent evaluations never share or leak state — no module-level mutable state (TEST 13).
- No commerce-platform/AI-Commerce reference anywhere in this module, re-confirmed by this repository's own permanent `tests/project-boundary-scan.test.ts` T12/RG-06 guard (included in the full regression above).

## Hard Non-Scope

No modification to any existing file — this checkpoint is purely additive (two new files). No new runtime dependency. No route/application-boundary wiring. No real provider/model credential or account anywhere.

## Evidence

- `npx tsc -p tsconfig.json` (clean `dist/` rebuild): exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2685/2685 passing** (2664 pre-existing on this `main` tip + 21 new).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/idea-valuation.ts` (new), `tests/idea-valuation.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10; Claude's authority ends at this status. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`. Risk classification: LOW — a pure, zero-dependency, zero-persistence, anonymous-input computation module with no IAM/authority/payment/provider coupling of any kind.
