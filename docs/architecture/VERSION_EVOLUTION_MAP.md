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

**Active (Workstream A only)**. Full blueprint at Drive `1joeMcCRtnDSotEmWa63fFG6uxGvbeU1LZApm7_5ap50`.

| Capability slice | Task | Status |
|---|---|---|
| Workstream A: organization membership / role / assignment authority foundation | `V3-ORG-001` | `IMPLEMENTED / SELF-VALIDATED`, pending Brain verification |
| Workstream B: multi-owner sales/account/delivery semantics (LeadOwner/DealOwner/AccountOwner/DeliveryOwner) | `V3-OWN-001` | `IMPLEMENTED / SELF-VALIDATED`, pending Brain verification |
| Workstream C: agency/partner multi-organization boundary | `V3-PTR-001` | `IMPLEMENTED / SELF-VALIDATED`, pending Brain verification (domain contract only — presentation-layer multi-client context switching deferred, see exec-plan) |
| Workstream D: SLA/escalation/attention model | `V3-SLA-001` | `IMPLEMENTED / SELF-VALIDATED`, pending Brain verification (no invented AT_RISK heuristic; `contractualSlaStatus` always `UNKNOWN` — no real source exists) |
| Workstream E: commission/pricing/discount authority read models | `V3-COM-001` (PR #5, open) | `IMPLEMENTED / SELF-VALIDATED`, pending Brain verification (bounded policy-neutral/read-only/fail-closed slice only; `discountAuthorityLevel` always `APPROVAL_REQUIRED`, `commissionLedgerStatus` always `UNKNOWN` — no real DEC-146 pricing-policy/financial-truth source integrated) |
| Workstream F: V3 logged-in frontend / role-aware IA | — not started | Depends on backend workstreams B-E |
| Workstream G: cross-slice integration + V3 exit audit | — not started | Depends on all prior workstreams |

## V4.0 — 360 Digital Operations

**Active (Workstream A only, execution-maturity floor).** Full blueprint at Drive `1M5vANxdfuH7Vro_CAFenioAmWitGPS3TRlzd06d5DNs`.

| Capability slice | Task | Status |
|---|---|---|
| Workstream A: service-to-capability routing (execution-maturity floor: `UNAVAILABLE`/`READ_ONLY` only) | `V4-SVC-001` | `IMPLEMENTED / SELF-VALIDATED`, pending Brain verification — no real provider adapter exists yet, so `MANUAL`/`PROVIDER_NATIVE`/`ENGINEER_ASSISTED`/`DIAGNOSE`/`RECOMMEND`/`DRAFT_PREVIEW`/`APPROVAL_REQUIRED`/`CONTROLLED_APPLY` are declared but not producible by this slice |
| Workstream B: unified operations attention/exception model | — not started | Reuses V3-SLA-001 attention semantics where natural |
| Workstreams C–H (service adapters, approval/effect/recovery, evidence/outcome reporting, optimization loop, account-manager model, frontend IA) | — not started | Each depends on real provider adapters and/or the V4 frontend, none of which exist yet |

## V5.0 — AI-Native Technology Company OS

`PREPARED / NON_SELECTOR`. Full blueprint at Drive `1HfQ8Mzbos63LZPE_vZryd4TiLyfa8GFP_AdtmLR-el8`. Nothing in `src/` implements V5 scope yet (no company-intelligence layer, no cross-client capability learning, no AI Commerce orchestration boundary — `AI Commerce` remains an explicitly separate, isolated project per `AGENTS.md`/`CLAUDE.md`).

## How to keep this current

Update the V2 table row for a task the moment its exec-plan status changes (`IMPLEMENTED` → `VERIFIED`/`PASS` → `CLOSED`, or a correction round). Do not add a V3/V4/V5 row claiming implementation progress unless `src/` actually contains code for it — a Drive blueprint being `PREPARED` is not implementation progress.
