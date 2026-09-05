# Version Evolution Map

Tracks how the repository's actual implemented surface maps onto the DEC-160 V2→V5 corridor's version capability map (`docs/exec-plans/corridors/V2_TO_V5.md`). This file records what is **actually built**, not aspirational scope — cross-check against `docs/engineering/CURRENT_STATE.md` before trusting a status here over live repo truth.

## V2.0 — Client & Delivery OS (current version)

| Capability slice | Task | Status |
|---|---|---|
| Tenant/customer/project domain kernel | `AKI-BE-001` | Brain `VERIFIED / COMPLETED` |
| Engineering orchestration primitives | `ENG-ORCH-001` | Brain `VERIFIED / COMPLETED` |
| Deterministic project-plan compiler + runtime admission | `DEL-003` (2 slices) | Brain `VERIFIED / COMPLETED` (slice 1); `IMPLEMENTED / SELF-VALIDATED` (slice 2, round-2 correction applied) |
| Project/service status + delivery timeline | `V2-CDO-001` | Brain `VERIFIED / PASS / CLOSED` |
| Delivery Recipe domain contract (`WEBSITE_BUILD_v1`) | `V2-CDO-002` | Brain `VERIFIED / PASS / CLOSED` |
| Customer ownership + project communications | `V2-CDO-003` | Brain `VERIFIED / PASS / CLOSED` |
| Account/connection ownership + admitted capability consumption | `V2-CDO-004` | Brain `VERIFIED / PASS / CLOSED` |
| Customer-safe project & outcome projection contract | `V2-CDO-005` | Brain `PASS / VERIFIED / CLOSED` |
| First-party logged-in application shell + provider-neutral auth/session/tenant bootstrap | `V2-APP-001` | Brain `PASS / VERIFIED / CLOSED` (checkpoint `33f95a3dc1ae1fdae02992b781002b92267f3110`) |
| Minimum logged-in Client Portal UI | `V2-CDO-006` | Brain `PASS / VERIFIED / CLOSED` (same checkpoint, same train) |
| Bounded Delivery Project Advisor (L0 Observe / L1 Recommend) — domain contract + shell presentation layer | `V2-CDO-008` | `IMPLEMENTED / SELF-VALIDATED`, pending Brain verification. `V2-CDO-007` (Delivery Recipe *breadth* beyond `WEBSITE_BUILD_v1`) remains superseded — its own goal was already delivered under `V2-CDO-002`, so it was not separately implemented; see `V2_TO_V5.md` "Current V2 state" for the full reasoning. |
| — remaining V2 outcomes not yet built | Broader provider/model runtime (gated on separate DEC-154/155 admission), production auth/persistence, billing/support/CRM | No canonical task contract exists yet for any of these. (An earlier version of this row also cited "no `V2-CDO-009`-or-later candidate published" as the reason no further V2 work exists at all — Brain's `HANDOFF_HEAD_REV: 10` rejected that as a valid exhaustion predicate; see `V2_TO_V5.md`'s "Current V3 state" for what the corrected progressive-elaboration scan found instead.) |

## V3.0 — Team, Sales & Agency OS

**Workstreams A-F merged; §14 version-end integration audit PASS/CLOSED (Brain Rev34, exact final main `6758de759bf17ecda49da7f4f8e1d07faa526655`)**. Full blueprint at Drive `1joeMcCRtnDSotEmWa63fFG6uxGvbeU1LZApm7_5ap50`.

| Capability slice | Task | Status |
|---|---|---|
| Workstream A: organization membership / role / assignment authority foundation | `V3-ORG-001` | `IMPLEMENTED / SELF-VALIDATED`, Brain PASS, merged (PR #4, `4ba5231309ac2fc72dd089cc947030a958eab77e`) |
| Workstream B: multi-owner sales/account/delivery semantics (LeadOwner/DealOwner/AccountOwner/DeliveryOwner) | `V3-OWN-001` | `IMPLEMENTED / SELF-VALIDATED`, Brain PASS, merged (PR #4, `4ba5231309ac2fc72dd089cc947030a958eab77e`) |
| Workstream C: agency/partner multi-organization boundary | `V3-PTR-001` | `IMPLEMENTED / SELF-VALIDATED`, Brain PASS, merged (PR #4, `4ba5231309ac2fc72dd089cc947030a958eab77e`) (domain contract only — presentation-layer multi-client context switching deferred, see exec-plan) |
| Workstream D: SLA/escalation/attention model | `V3-SLA-001` | `IMPLEMENTED / SELF-VALIDATED`, Brain PASS, merged (PR #4, `4ba5231309ac2fc72dd089cc947030a958eab77e`) (no invented AT_RISK heuristic; `contractualSlaStatus` always `UNKNOWN` — no real source exists) |
| Workstream E: commission/pricing/discount authority read models | `V3-COM-001` | `IMPLEMENTED / SELF-VALIDATED`, Brain PASS, merged (PR #5, `5c91f18034a7ec435a4d83fccac856d354f8394f`) (bounded policy-neutral/read-only/fail-closed slice only; `discountAuthorityLevel` always `APPROVAL_REQUIRED`, `commissionLedgerStatus` always `UNKNOWN` — no real DEC-146 pricing-policy/financial-truth source integrated; commission %, discount thresholds, payout, reseller/wholesale economics and binding SLA terms remain unimplemented per canonical hard non-scope) |
| Workstream F: V3 logged-in frontend / role-aware IA (team/attention floor slice only) | `V3-F-001` | `IMPLEMENTED / SELF-VALIDATED`, Brain PASS, merged (PR #8, `837214dc863970bdb05f29bf8611a3438735b3f4`). Surfaces organization/client context, viewer role, and LeadOwner/DealOwner/AccountOwner/DeliveryOwner separately in the existing shell, using only already-merged V3 A-D substrate; commercial state renders as a fixed "Unavailable" literal (does not consume `V3-COM-001`). |
| V3 exit audit (blueprint §3 spine item H) | N/A — Brain review activity, not a Claude engineering task | **PASS / VERSION_END_INTEGRATION_EDGE_CLOSED** (Brain Rev34, exact final main `6758de759bf17ecda49da7f4f8e1d07faa526655`) — Brain's own §14 comprehensive integration audit against the accumulated evidence of Workstreams A-F plus the PR #5-#9 post-merge transferable evidence package; not a Claude-authored source module. See `docs/exec-plans/corridors/V2_TO_V5.md` "V3 §14 version-end integration audit — CLOSED" for the full record. |

## V4.0 — 360 Digital Operations

**Active (floor slices of Workstreams A and B only)**. Full blueprint at Drive `1M5vANxdfuH7Vro_CAFenioAmWitGPS3TRlzd06d5DNs`.

| Capability slice | Task | Status |
|---|---|---|
| Workstream A: service-to-capability routing (10-rung `ExecutionMaturity` ladder declared; only the `UNAVAILABLE`/`READ_ONLY` floor is producible — no real provider adapter exists yet) | `V4-SVC-001` | `IMPLEMENTED / SELF-VALIDATED`, Brain PASS, merged (PR #6, `c93a9cc1e8caf5da3c13d102bdb9fa7c778a5982`) |
| Workstream B: unified operations attention/exception model (single real source domain, `DELIVERY_OUTCOME_JOB`, out of 11 blueprint-named candidate families) | `V4-OPS-001` | `IMPLEMENTED / SELF-VALIDATED`, Brain PASS, merged (PR #7, `6f403db130434b0228783584487dfdf43f3544f7`) |
| Workstreams C-H | — not started | Each depends on a real external provider/connector adapter that does not exist anywhere in this repository yet; not pulled forward without one |

## V5.0 — AI-Native Technology Company OS

**Workstream A now fully satisfies its blueprint §5 acceptance list (see finding below); Workstream F floor landed.** Full blueprint at Drive `1HfQ8Mzbos63LZPE_vZryd4TiLyfa8GFP_AdtmLR-el8`.

| Capability slice | Task | Status |
|---|---|---|
| Workstream A/D floor: CHECKPOINT-after-PASS stale-approval invalidation, extending ENG-ORCH-001's `engineering-run-state.ts` | `V5-ENG-001` | `IMPLEMENTED / SELF-VALIDATED`, Brain Rev40 PASS, merged (PR #12, `19df961498896427223842f7de82df2d9f6a8304`; includes the Rev39 equal-fencing correction). Enforces "stale SHA approval cannot merge" / "post-review push invalidates old merge approval" as a tested domain invariant; no second orchestration engine. |
| Workstream A: RESOLVE authority separation, extending the same `engineering-run-state.ts` reducer | `V5-ENG-002` | `IMPLEMENTED / SELF-VALIDATED`, Brain Rev46 PASS, merged (PR #16, `460871cba43273f89bbf8004e547664c40b90794`). Enforces "agent cannot self-mark final VERIFIED" — a `RESOLVE` event is rejected unless `fromRole` is `BRAIN` or `OWNER`; empirically confirmed as a real, exploitable gap before the fix (a `WORKER`-authored `RESOLVE(PASS)` was previously accepted). No new event type, no second orchestration engine. **Note**: with this slice landed, all five of Workstream A's blueprint §5 acceptance bullets are now satisfied across `ENG-ORCH-001`/`V5-ENG-001`/`V5-ENG-002` — a Claude-recorded finding, not a `VERIFIED`/`CLOSED` status (that remains Brain's determination per `AGENTS.md` §10). |
| Workstream C: project/repository bootstrap template resolution (pure planning function; no filesystem/network side effect) | `V5-BOOT-001` | `IMPLEMENTED / SELF-VALIDATED`, Brain Rev44 PASS, merged (PR #14, `1c254ada2a5178099d4b7a1a3b8a2fc3289ee4fb`; includes the Rev43 provenance/local-applicability correction). Reconsidered from Rev35's `ELIGIBLE_NOT_SELECTED` finding — cross-project isolation and secret/credential-cloning prohibition proven with synthetic project namespaces, no real second live repository required. |
| Workstream F: cross-domain company intelligence reconciliation floor (pure aggregation function; no persistent "strategic company memory" store) | `V5-INT-001` | `IMPLEMENTED / SELF-VALIDATED`, pending Brain exact-head review. Combines opaque cross-domain insight pointers (closed six-surface enum matching §10's own text) into a governed per-subject snapshot — fails closed on tenant/project scope mismatch, resolves `STALE`/`CONFLICTING`/`CURRENT` by caller-supplied freshness, never blurs `OBSERVED` into `DERIVED`. No real cross-domain data source invented; reuses the existing `TenantScope` isolation primitive only. |
| Workstream B, E, G-L | — not started | No worker/model routing policy, no cross-client reusable capability learning, no infrastructure/provider orchestration, no AI Commerce orchestration boundary — `AI Commerce` remains an explicitly separate, isolated project per `AGENTS.md`/`CLAUDE.md`. |

## How to keep this current

Update the V2 table row for a task the moment its exec-plan status changes (`IMPLEMENTED` → `VERIFIED`/`PASS` → `CLOSED`, or a correction round). Do not add a V3/V4/V5 row claiming implementation progress unless `src/` actually contains code for it — a Drive blueprint being `PREPARED` is not implementation progress.
