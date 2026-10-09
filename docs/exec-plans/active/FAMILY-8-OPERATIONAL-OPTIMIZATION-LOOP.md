# Family 8 — Bounded Operational Optimization Loop (Rev98/Rev101 gap)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Rev98/Rev101's Family 8: *"bounded operational optimization loop, distinct from V5-EVAL-001, with authority/risk/reversibility/policy/budget and stop/escalate behavior."*
- Had been dispositioned `TRIGGER_NOT_MET` on the reasoning "no live telemetry stream to optimize against" — on closer inspection this is the same objection that would have wrongly blocked `OBS-TEL-001` itself, which was built as a pure caller-supplied-evidence contract rather than a live telemetry pipeline. Reversed per the same discipline already applied to Family 5 and Family 7: the genuine gap is a *decision function*, not a live system, and can be built and tested exactly like every other pure `src/domain/` module in this corridor.
- Distinctness from `V5-EVAL-001` (`governed-evaluation-loop.ts`) independently verified by reading that module's exact source (`git show` against `origin/claude/v5-eval-001-governed-evaluation-loop`) before writing any code: `governed-evaluation-loop.ts` governs discrete, independently-reviewed *change proposals* to policy/routing/prompts (`PROPOSED → CLASSIFIED → TESTED → REVIEWED → ADOPTED/REJECTED`, with human-review-required for `MATERIAL` classification). This module instead governs one already-authorized policy's live, per-action operational execution loop — a running worker deciding whether to continue, stop, or escalate its *next* bounded action. No shared types, no shared lifecycle, no overlap.
- Branch `claude/family-8-operational-optimization-loop`, cut directly from `claude/family-7-cross-surface-evidence-convergence` (already carries `OBS-TEL-001`'s `observability-telemetry.ts`, this checkpoint's only non-`main` dependency). `WorkerRiskLevel` (from `worker-routing-policy.ts`) is already on `main`.

## Scope (this checkpoint)

`src/domain/operational-optimization-loop.ts` — composing, never redefining (type-only imports): `worker-routing-policy.ts`'s `WorkerRiskLevel`, `observability-telemetry.ts`'s `MetricReadModel`/`MetricReadModelStatus`.

- **Authority**: `OptimizationPolicy` cannot be constructed without a non-empty `authorizedByWorkerId` — a loop can never run under a policy nobody declared authority over. This module does not itself validate that worker's standing (that is `worker-routing-policy.ts`'s job); it only refuses to construct a policy with no authority binding at all.
- **Risk**: `evaluateOptimizationCandidate` escalates whenever a candidate's `riskLevel` exceeds the policy's `maxRiskLevel`, regardless of cost or budget remaining — reuses `WorkerRiskLevel` unmodified rather than inventing a parallel risk taxonomy.
- **Reversibility**: escalates whenever the policy requires reversibility and the candidate is not reversible, regardless of risk tier.
- **Policy/Budget**: only once telemetry/risk/reversibility all clear does running cost matter; exceeding `budgetLimit` stops the loop outright (a hard resource ceiling, never something a reviewer waves through the way an escalation can be).
- **Stop/Escalate**: closed three-value `OptimizationDecision` (`CONTINUE`/`STOP`/`ESCALATE`) with closed, non-fabricated `OptimizationEscalationReason`/`OptimizationStopReason` enums — never free text a caller could mistake for evidence.
- **Telemetry honesty gate** (not itself named in Rev98's five dimensions, but required to make risk/budget judgments genuine rather than blind): reuses the exact "absence of evidence is never promoted to a positive claim" discipline already established in `cross-surface-evidence-convergence.ts`/Family 7 — `MISSING`/`NOT_MONITORED` telemetry escalates rather than silently continuing, and `REPORTED_STALE` telemetry is never trusted as current.
- `tests/operational-optimization-loop.test.ts` (21 tests: O1-O21), `tests/family-8-boundary-scan.test.ts` (6 tests).

## Explicitly deferred (not fabricated)

- **No persistence.** `evaluateOptimizationCandidate` is a pure decision function; the caller supplies `spentSoFar` on every call rather than this module maintaining a durable running ledger.
- **No real optimization/search.** This module evaluates exactly one caller-supplied candidate action per call against a policy — it does not generate, rank, or search over candidate actions itself, matching Rev98's own "bounded" framing.
- **No monitoring wiring.** Same discipline as `V5-EVAL-001`'s explicitly-not-modeled `MONITOR` step: telemetry is read via a caller-supplied `MetricReadModel`, never fetched or re-derived here.
- **No numeric risk/cost scoring beyond what the two source modules already provide.** `WorkerRiskLevel` and `estimatedCost`/`budgetLimit` are used exactly as declared; no fabricated composite score is invented.

## Architecture / semantic invariants (verified by test)

- Policy construction fails closed on empty `policyRef`/`authorizedByWorkerId`, invalid `maxRiskLevel`, non-positive `budgetLimit`, non-boolean `reversibilityRequired` (O1-O5).
- Candidate construction fails closed on empty `actionRef`, invalid `riskLevel`, negative `estimatedCost`; zero `estimatedCost` is valid (O6-O9).
- Telemetry gate: `MISSING`/`NOT_MONITORED` → `ESCALATE(TELEMETRY_UNAVAILABLE)` (O10-O11); `REPORTED_STALE` → `ESCALATE(TELEMETRY_STALE)` (O12).
- Risk gate: risk exceeding policy escalates even with ample budget and reversibility (O13); an authorized `HIGH_RISK` policy permits a `HIGH_RISK` candidate (O14).
- Reversibility gate: irreversible action under a reversibility-required policy escalates regardless of risk tier (O15); irreversible is fine when not required (O16).
- Budget gate: strictly-over stops (O17); landing exactly on the limit does not (O18); budget is never checked ahead of risk/reversibility/telemetry (O19).
- Happy path: `CONTINUE` only when every gate clears (O20). `spentSoFar` itself is validated as a finite, non-negative number (O21).

## Hard Non-Scope

No modification to `worker-routing-policy.ts` or `observability-telemetry.ts` (both read-only type dependencies); no real network/DNS call anywhere; no persistence; no admin/UI wiring; no new runtime dependency; no free-text reason field.

## Evidence

- `npx tsc --noEmit -p .`: exit 0, strict mode.
- `npm run test`: **931/931 pass** (904 pre-existing on the Family 7 base + 27 new: 21 functional + 6 boundary-scan).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/operational-optimization-loop.ts` (new), `tests/operational-optimization-loop.test.ts` (new), `tests/family-8-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending fresh Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — this branch is cut from the Family 7 branch (itself a merge of Family 5 + OBS-TEL-001); its own eventual PR should be reviewed alongside all upstream source PRs. Deferred to the one consolidated end-of-batch Brain review packet alongside PR #32 (SVC-ADM-001), #38, #39, RUNTIME-001, V5-PTN-002, V4-EFF-001, LOCAL-EXEC-001, LOCAL-EXEC-002, LOCAL-EXEC-003, OBS-TEL-001, AUT-OPS-001, DEP-ORCH-001, Family 5, and Family 7.
