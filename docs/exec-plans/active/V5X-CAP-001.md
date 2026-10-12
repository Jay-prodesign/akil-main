# V5X-CAP-001 — AKILTA Idea Valuation Vertical Slice

## Authorization

AA-002/AA-012 (DEC-172, REQ-AI-013/014/015/016): V5X-CAP-001 (Idea Valuation) is the current bounded non-production engineering slice. Brain's own GitHub connector returned `403 Resource not accessible by integration` on branch creation, so this implementation resumes on a repo-write-capable Claude/Primary Engineer surface, per AA-002's own instruction. Founder gate NONE for bounded non-production implementation/tests/evidence.

**Exact base:** `Jay-prodesign/akil-main` `main@3226c76fa338e425e553638e5f5f48924182a1c0`, independently re-verified live (`git fetch origin main`) immediately before branching — unchanged since AA-002 was written.

**Target branch:** `claude/v5x-cap-001-idea-valuation`.

**Affected-edge separation:** PR #63 (`claude/authority-migration-001`) remains `CHANGES_REQUIRED / HIGH-PROTECTED / HOLD_MERGE / NOT SAFE_MERGE` (Brain Rev83) on its own branch. This task does not touch, reopen, or depend on that branch or its F1/F2 findings.

## Implementation

**`src/domain/idea-valuation.ts`** (new): a pure, provider-neutral domain module — no HTTP route, no persistence, no new runtime/service/repository, no identity/auth/billing surface.

- **Versioned capability identity**: `CAPABILITY_ID`, `CAPABILITY_VERSION`, `METHODOLOGY_VERSION`, `RUBRIC_VERSION`, `WORKFLOW_VERSION`, `PROMPT_VERSION` — explicit constants, never inferred.
- **Anonymous-first minimal input**: `IdeaValuationInput` (`ideaSummary` required, `targetAudience`/`problemStatement` optional) — no identity/tenant/customer binding accepted or required. `validateIdeaValuationInput` fails closed on missing/empty/whitespace-only/oversized fields.
- **Weighted rubric totaling 100**: `IDEA_VALUATION_RUBRIC` — six fixed criteria (`problemClarity` 20, `audienceSpecificity` 15, `differentiation` 15, `feasibility` 20, `monetizationClarity` 15, `riskAwareness` 15). A module-load guard throws immediately if the weights ever stop summing to exactly 100, so a future edit cannot silently desync the acceptance invariant.
- **Provider-neutral reasoner port**: `IdeaValuationReasoner.evaluate(input)` returns an opaque `workerRef` (never a real vendor SDK reference) plus structured `criterionAssessments`. `evaluateIdea` calls it exactly once per evaluation — no internal retry, no hidden second call.
- **Fail-closed structured-output validation** (`scoreIdeaValuation`): rejects a missing, duplicate, or unrecognized criterion; rejects a non-finite or out-of-`[0,100]` rating; rejects an empty/non-string rationale; rejects any `evidenceKind` outside the currently reachable set.
- **Evidence-kind vocabulary** (`IdeaValuationEvidenceKind`): `USER_PROVIDED | INFERENCE | RESEARCHED | UNKNOWN` is the full declared type (mirrors `Customer.LearningEligibility`'s forward-compatible-vocabulary pattern), but **`RESEARCHED` is rejected at validation time** in this slice — there is no admitted research tool wired to a reasoner, so a claim of researched evidence would be unbacked by construction (DEC-153 "no invented business rule"). Only `USER_PROVIDED`, `INFERENCE`, and `UNKNOWN` are reachable today.
- **Deterministic scoring**: the final 0–100 score is always computed in `scoreIdeaValuation` from validated per-criterion ratings × weights; the reasoner's output shape carries no score/final-result field at all, so there is nothing for it to override even if a caller tried.
- **Deterministic next-action/CTA policy** (`resolveNextActionPolicy`): score ≥ 70 → `STRONG_SIGNAL_CONSIDER_NEXT_STEPS`; 40–69 → `MODERATE_SIGNAL_REFINE`; < 40 → `WEAK_SIGNAL_RECONSIDER`. Computed from the final score in code, never reasoner-authored.
- **Learning/research disposition, fixed fail-closed**: `learningEligibility: "NONE"` and `researchPolicy: "NONE"` are hard-coded into every `IdeaValuationReport` — there is no constructor input path to set either to anything else, matching `createCustomer`'s existing `learningEligibility: "NONE"` pattern in this repo.
- **Execution trace**: every report carries `workerRef`, all six version fields, the validated input, and the full per-criterion result set (rating, weight, weighted contribution, rationale, evidence kind) — sufficient lineage without inventing a persistence layer.

## Mandatory invariant classification

- **EI-1 NOT_APPLICABLE** — no material external effect (pure in-process computation).
- **EI-2 NOT_APPLICABLE** — no effect-idempotency surface (nothing is written/retried).
- **EI-3 NOT_APPLICABLE** — no external-effect authority/retry surface.
- **EI-4 NOT_APPLICABLE** for this anonymous/non-persistent slice — no protected persistence is introduced; reintroducing persistence later would reopen this classification.
- **EI-5 NOT_APPLICABLE** — no metered/bulk fan-out.
- **EI-6 IN_SCOPE / LOAD-BEARING** — AKILTA ↔ AI Commerce isolation: zero commerce-domain/source/credential coupling; no file in this task references any commerce provider by name (repo-wide boundary-scan tests already enforce this).
- **EI-7 IN_SCOPE / LOAD-BEARING** — execution cannot self-promote learning/training eligibility: `learningEligibility` is fixed to `"NONE"` with no accepted input path, exactly like `Customer`'s existing pattern.

## Locked adversarial proof — evidence

All covered by `tests/idea-valuation.test.ts`:

1. Valid input → exactly one reasoner invocation → validated criterion assessments → deterministic weighted 0–100 result → structured report.
2. Rubric weights total exactly 100 (module-load guard + explicit test).
3. Missing required criterion → rejected.
4. Duplicate criterion → rejected.
5. Unknown/unrecognized criterion → rejected.
6. Out-of-range and non-finite ratings → rejected.
7. Empty/non-string rationale → rejected.
8. `RESEARCHED` evidence kind → rejected (no admitted research tool in this slice).
9. Unrecognized evidence-kind string → rejected.
10. Final score is always recomputed by code; a reasoner cannot supply or override it (no such field exists on the accepted input shape).
11. `learningEligibility`/`researchPolicy` are always `"NONE"` on every report, regardless of input.
12. Next-action policy is deterministic across score-band boundaries (0, 39, 40, 69, 70, 100).
13. Two independent evaluations never share or leak state (no module-level mutable state).
14. Anonymous input (no identity/tenant/customer fields anywhere in `IdeaValuationInput`) — structurally impossible to supply one.
15. Input validation: missing/empty/whitespace-only/oversized `ideaSummary` rejected; optional fields validated the same way when present.

## Non-scope (explicitly excluded from this slice)

Real provider/model SDK integration or credentials; any research/live-data/domain-validation tool; persistence of any evaluation record; HTTP route or public exposure; account/identity/auth system; billing/entitlement; new runtime/service/repository/registry/factory; multi-capability orchestration (V5X-CAP-002/003 remain gated on this slice's evidence); AI Commerce merchant truth, connectors, or actions; promotion of any evaluation to global learning/training eligibility.

## Validation

- `npx tsc --noEmit -p .` — clean.
- `npm run build` on a **fully removed `dist/`** — clean rebuild. This repo's `build` script (`tsc -p tsconfig.json`) does not clean `dist/` first, so a `dist/` carried over from other branches/sessions accumulates stale compiled `.test.js` files with no corresponding source; a first regression run against that stale `dist/` reported 1652 tests / 141 failing, which was entirely stale-artifact contamination, not a real regression. Removing `dist/` and rebuilding from this exact branch head gives the true count.
- **`npm test` (`node --test dist/tests/*.test.js`) on the clean rebuild: 729/729 pass** — 708 pre-existing on `main@3226c76` (independently reconfirmed by rebuilding `main` alone with `dist/` removed) plus 21 new in `idea-valuation.test.ts`. Zero regressions, zero failures.
- AI Commerce / cross-project boundary-scan tests included in the 729 and passing — no provider name referenced anywhere in this task's files.

## Status

**IMPLEMENTED / SELF-VALIDATED.** Returning exact head for independent Brain verification. No MAIN mutation, no merge/topology change, no production/provider/credential/customer/payment effect authorized or performed by this task.
