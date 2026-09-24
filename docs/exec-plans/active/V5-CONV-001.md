# V5-CONV-001 — Reference Customer Execution Convergence Candidate

## Provenance

Dispatched by Brain across a sustained multi-revision sequence in AA-005: Rev109 (task selection), Rev110 (topology reconciliation / PR #101 post-closure divergence), Rev111 (Phase-0 topology manifest PASS), Rev112 (Phase-1 repo composition — execute now), Rev113 (read-only composition preflight / latent ADM-PROJ gap), Rev114 (WEBSITE_BUILD_v1 minimum composition / integration-test contract), Rev115 (status/next-action projection clarification), Rev116 (admitted service/recipe binding becomes load-bearing), Rev117 (admitted recipe version authority gap), Rev118 (execution-surface status / no new design work), Rev119 (execution wake / connected-write recheck), Rev120 (PR #101 new post-closure tip review / reference-only disposition), Rev121 (system maturity matrix binding / V5-CONV execution status).

**Founder gate: NONE** across every one of the above revisions.

## Relationship to CXP-ACT-001 / DEC175-CONV-001 (transparency note, not a conflict)

Separately from this task, AA-005 also contains a Rev113 entry titled "DEC-175 REFERENCE COLD-START CONVERGENCE SELECTED / CLAUDE RESUME" dispatching a smaller, evidence-only task (`DEC175-CONV-001`), which was independently completed this session: PR #103 (`claude/dec175-reference-cold-start-convergence`, stacked on PR #102 `claude/cxp-act-001-activation-required-action-projection`, itself stacked on PR #101 `claude/adm-proj-001-project-activation-profile`), IMPLEMENTED/SELF-VALIDATED, OPEN/DRAFT/HOLD_MERGE, awaiting Brain review. That thread's revision numbering happens to overlap with this task's (both used "Rev112/Rev113" independently) but the two are content-distinct and neither supersedes the other in this record. Per Rev109's own explicit warning ("Do not assume ... a Claude-reported forward lineage automatically contains every dependency required by this task"), V5-CONV-001's own Phase-0 manifest (Rev111) independently selected PR #89 as the integration base and does not compose on top of PR #102/#103. Both threads are left standing: PR #102/#103 remain untouched, OPEN/DRAFT/HOLD_MERGE, pending their own independent Brain review; this document tracks only V5-CONV-001.

## Selected integration base (Rev111 Phase-0 manifest)

- **Base:** PR #89 / CXP-001W exact accepted head `394ec5ba3466afadb18c87154644ce90ef990c51`, branch `claude/cxp-001w-customer-repository-key-collision-safe-encoding`. Brain Rev52-lineage PASS/VERIFIED / HIGH-PROTECTED / HOLD_MERGE.
- Independently re-verified via `git fetch` + `git rev-parse` immediately before branch creation: matches exactly, no topology drift since Rev111/Rev121's fresh live rechecks.
- **Why:** the smallest verified forward lineage already carrying accepted `#61` (Local Execution) ancestry, `#65` AI-004A (DeliveryRecipePlanBinding provenance), `#83` CXP-001R (collision-safe/isolation corrections), and later CXP-through-W hardening, without importing unrelated `#98` APP-I18N/APP-SUB launch surfaces.
- **Target branch:** `claude/v5-conv-001-reference-customer-convergence`, created from exact `394ec5ba3466afadb18c87154644ce90ef990c51` (independently verified, this commit's HEAD).
- **Expected DRAFT PR base:** `claude/cxp-001w-customer-repository-key-collision-safe-encoding` (PR #89), unless live topology changes before push.

### Exact dependency dispositions (Rev111)

| Dependency | Exact accepted head | Disposition |
|---|---|---|
| PR #61 (Local Execution) | `29728cfa2ddb93e2b8943f1a33c48a3de0161ec4` | INCLUDED — ancestor of #89 |
| PR #65 / AI-004A (DeliveryRecipePlanBinding) | `11ce716cd923b08682560f7e690269f5b616962b` | INCLUDED — ancestor of #89 |
| PR #83 / CXP-001R (collision-safe/isolation) | `661df0395820744d9f70dbb189a33083bcb5161e` | INCLUDED — ancestor of #89 |
| PR #101 / ADM-PROJ-001 (final reviewed tree) | `79137f94a5149be36d02dc4bc60c25ff1902864c` | MUST COMPOSE — materialize exactly for the 3 files below, adapt separately |
| PR #101 tip | `15815e96397a5a8148c78476769afa80a73ba05b` | EXPLICITLY EXCLUDED — unreviewed/post-closure per Rev110 |
| PR #101 tip (further) | `9ae3063d81169d668f770dd7350907dc9360f464` | EXPLICITLY EXCLUDED — reference-semantics accepted but not an admitted dependency per Rev120 (equivalent F1-F3 correction must be reproduced natively on this lineage instead) |
| PR #98 | `20f4cdb276eee9898f99d6fb7d0244cdfcdeab5f` | EXCLUDED AS WHOLE BASE — later durability fixes may be selected individually only if a concrete dependency is demonstrated |
| PR #99, #100, APP-I18N/APP-SUB | — | EXCLUDED NOW — unrelated production/launch surfaces |
| PR #63 | — | EXCLUDED as runtime composition (governance branch, non-blocking) |

### ADM-PROJ import rule (Rev111)

Do not use the PR #101 branch name/tip. Reproduce/materialize the exact final reviewed tree at `79137f94a5149be36d02dc4bc60c25ff1902864c` for exactly:

1. `docs/exec-plans/active/ADM-PROJ-001.md`
2. `src/domain/project-activation-profile.ts`
3. `tests/project-activation-profile.test.ts`

Prove byte/tree equivalence to `79137f9` before any adaptation. Any `#89`-driven integration conflict is resolved in a **separate**, explicitly-proven V5-CONV-native commit — never by silently importing `15815e9`/`9ae3063`.

## Rev113 latent ADM-PROJ gap (load-bearing correction required)

Independent Brain source inspection of the exact `79137f9` tree found three gaps that must be corrected V5-CONV-natively (not by importing `15815e9`):

- **F1 — early-blocker platform-decision provenance loss:** Step-5/Step-6 blockers call `finish(..., platformDecision: undefined)`, dropping a supplied `MaterialPlatformDecision` from provenance/fingerprint whenever an earlier blocker wins.
- **F2 — connection-provenance loss inside the same loop:** a later required-connection failure resets `verifiedConnections: []`, discarding already-accumulated verified requirements.
- **F3 — plain-interface factory bypass:** `AcceptedCommercialReference`/`MaterialPlatformDecision` are exported plain interfaces; the compiler trusts caller-supplied instances without re-running construction invariants.

Correction must preserve Rev101's structural-mismatch-first blocker priority (Step 1 first, then task-local record revalidation, then the existing commercial/recipe/plan/connection/platform/routing order) — this was the exact ordering mistake found in unreviewed `15815e9`.

## Rev116/Rev117 — admitted service/recipe binding + exact recipe version authority

`ProjectActivationProfile` compilation must make already-existing `ServiceCatalogAdmission` + `bindAdmittedRecipeToPlan` load-bearing (a REVOKED/mismatched admission must block READY), and `ServiceCatalogAdmission` must be extended with an authoritative `recipeVersion` field so a different concrete version of an admitted `recipeId` cannot silently bind without a matching admission. Full detail: AA-005 Rev116/Rev117 verbatim (see provenance section).

## Rev114/115 — WEBSITE_BUILD_v1 composition contract + truthful status semantics

Single-lineage happy path (manual/proposal `AcceptedCommercialReference`, not checkout), same-job governed execution proof (`DRAFT → QUALIFIED → READY → EXECUTING → VERIFYING → VERIFIED`), truthful post-execution snapshot/advisor projection (one verified job never fabricates whole-project completion; `nextAction` keeps its existing narrow communication-required semantics), and the full A-M mandatory negative-witness list. Full detail: AA-005 Rev114/Rev115 verbatim.

## Engineering Invariants (Rev111)

| Invariant | Classification |
|---|---|
| EI-1 effect | IN_SCOPE only if a bounded non-production effect is actually exercised |
| EI-2 idempotency/replay | IN_SCOPE/LOAD-BEARING for any effect-bearing execution |
| EI-3 authority/retry/stale authority | IN_SCOPE/LOAD-BEARING |
| EI-4 tenant/customer/project isolation | IN_SCOPE/LOAD-BEARING |
| EI-5 bulk metered fan-out | NOT_APPLICABLE unless fan-out is introduced |
| EI-6 AKILTA↔AI Commerce isolation | IN_SCOPE/LOAD-BEARING boundary preservation |
| EI-7 learning/training/retrieval promotion | IN_SCOPE/LOAD-BEARING boundary preservation |

## Acceptance matrix (Rev109 A-K, load-bearing)

A. Cold reconstruction — no caller-supplied semantic labels/IDs AKILTA should resolve itself.
B. Provenance — independent commercial/plan/recipe/config/policy/platform-decision/connection/routing provenance; material change alters fingerprint.
C. Fail-closed — every blocker class fails with exact reason/actor, no invented default.
D. Authority — capability never grants business/action authority; protected effects revalidate current authority.
E. Connections — unhealthy/unverified/revoked/degraded states cannot masquerade as ready.
F. Routing — eligibility across capability/tool/policy/data/authority/availability; fallback never widens authority.
G. Evidence/verification — execution/self-report is not verification.
H. Recovery — duplicate/replay/timeout/UNKNOWN uses existing bounded semantics, never blindly duplicates an effect.
I. Tenant/customer/project isolation — negative substitution witnesses for every identity-bearing object.
J. Truthful next action — existing domain truth plus exact next actor/action, no parallel status model.
K. No production activation — no real IdP/KMS/provider secret/email/payment/spend/live federation/public/customer effect.

## Non-goals (hard stop conditions)

- No merge, no MAIN mutation, no deploy.
- No OS V0 source work (V5-CONV-001 is the mandatory predecessor; its PASS does not itself mean OS V0 PASS).
- No CAP-002/CAP-003, PR #63 repair, production IdP/KMS, real provider credentials, email, spend, AI Commerce federation, public Shopify publication.
- No import of PR #101 tip `15815e9` or `9ae3063` as authority — F1-F3 must be reproduced V5-CONV-natively.
- No new Service Catalog, workflow engine, registry, IAM, or billing path — reuse `ServiceCatalogAdmission`/`bindAdmittedRecipeToPlan` exactly.

## Status

**PHASE 0: COMPLETE** (this document, no semantic source mutation in this commit).

**PHASE 1: IN PROGRESS.** Next: materialize the exact ADM-PROJ-001 accepted tree at `79137f94a5149be36d02dc4bc60c25ff1902864c` for the 3 bounded files above, prove byte/tree equivalence, then run strict typecheck/build/targeted tests as the first conflict-discovery checkpoint against `#89`'s customer-scoped types.
