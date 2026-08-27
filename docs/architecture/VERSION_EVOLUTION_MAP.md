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
| — remaining V2 outcomes not yet built | Delivery Recipe *breadth* beyond `WEBSITE_BUILD_v1`, bounded AI Project Advisor, broader provider runtime, production auth/persistence, billing/support/CRM | `V2-CDO-007` / `V2-CDO-008` referenced as `PREPARED / NON_SELECTOR / NOT START_AUTHORIZED` in canonical Drive sources — **no detailed dependency-safe task contract exists yet** for either, so neither is an executable subcursor as of this writing (see `V2_TO_V5.md` "Current V2 state") |

## V3.0 — Team, Sales & Agency OS

`PREPARED / NON_SELECTOR`. Full blueprint at Drive `1joeMcCRtnDSotEmWa63fFG6uxGvbeU1LZApm7_5ap50`. Nothing in `src/` implements V3 scope yet (no roles/ownership model, no agency/partner org model, no multi-org controls).

## V4.0 — 360 Digital Operations

`PREPARED / NON_SELECTOR`. Full blueprint at Drive `1M5vANxdfuH7Vro_CAFenioAmWitGPS3TRlzd06d5DNs`. Nothing in `src/` implements V4 scope yet (no operational routing/approval/reporting surface, no connector/adapter framework for the named external capability surfaces).

## V5.0 — AI-Native Technology Company OS

`PREPARED / NON_SELECTOR`. Full blueprint at Drive `1HfQ8Mzbos63LZPE_vZryd4TiLyfa8GFP_AdtmLR-el8`. Nothing in `src/` implements V5 scope yet (no company-intelligence layer, no cross-client capability learning, no AI Commerce orchestration boundary — `AI Commerce` remains an explicitly separate, isolated project per `AGENTS.md`/`CLAUDE.md`).

## How to keep this current

Update the V2 table row for a task the moment its exec-plan status changes (`IMPLEMENTED` → `VERIFIED`/`PASS` → `CLOSED`, or a correction round). Do not add a V3/V4/V5 row claiming implementation progress unless `src/` actually contains code for it — a Drive blueprint being `PREPARED` is not implementation progress.
