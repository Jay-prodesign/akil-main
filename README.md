# akil-main

> ## ⚠️ Proprietary Software — Not Open Source
>
> This repository contains proprietary software owned by 7T Tekstil
> Sanayi ve Ticaret Limited Şirketi. It is **not** open source. No
> permission is granted to use, copy, modify, distribute, or otherwise
> deal in this software without prior written authorization.
>
> See [`LICENSE`](./LICENSE), [`NOTICE.md`](./NOTICE.md),
> [`TRADEMARKS.md`](./TRADEMARKS.md), and
> [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for the complete
> terms.

AKILTA main engineering repository.

## Status

Active backend/domain engineering, now operating inside the DEC-160 V2→V5 Autonomous Engineering Corridor (see `docs/exec-plans/corridors/V2_TO_V5.md`). Governance scaffolding from `AKI-GIT-001` is in place, and the repository holds a secret-free TypeScript domain/application kernel plus a minimal first-party web shell:

- `AKI-BE-001`, `ENG-ORCH-001` — backend foundation (tenant/customer/project/`OutcomeJob` lifecycle, evidence/verification, authority, audit) and the durable event-driven engineering orchestration bridge. Both Brain **VERIFIED / COMPLETED**.
- `DEL-003` — project intelligence & delivery compilation (blueprint → sold scope → compiled plan → `OutcomeJobSpec`s), both bounded slices implemented.
- `V2-CDO-001` through `V2-CDO-005` — the V2.0 Client & Delivery OS domain slices (delivery status/timeline, Delivery Recipe contract, customer ownership/communications, account/connection ownership, customer-safe project/outcome projection). Each Brain **VERIFIED / PASS / CLOSED**.
- `V2-APP-001` / `V2-CDO-006` — the first-party logged-in application shell (provider-neutral auth/session/tenant boundary) plus the minimum Client Portal UI on top of it. Brain **PASS / VERIFIED / CLOSED**.
- `V2-CDO-008` — the Delivery Project Advisor (L0 Observe / L1 Recommend), domain contract plus its presentation-layer wiring into the shell. **IMPLEMENTED / SELF-VALIDATED**, pending Brain verification.

See `docs/engineering/CURRENT_STATE.md` for the live detail and `docs/exec-plans/` for full per-task execution records. No merge to `main`, no deploy, no production/customer-facing surface — this remains a domain kernel plus an internal engineering-checkpoint web shell, not a deployed service.

## Engineering navigation

- [`AGENTS.md`](./AGENTS.md) — engineering operating contract (start here).
- [`CLAUDE.md`](./CLAUDE.md) — Claude (Primary Engineer) role overlay.
- [`docs/engineering/CURRENT_STATE.md`](./docs/engineering/CURRENT_STATE.md) — live repository state summary.
- [`docs/engineering/IMPLEMENTATION_RULES.md`](./docs/engineering/IMPLEMENTATION_RULES.md) — concrete-first implementation rules.
- [`docs/engineering/ACCEPTANCE_CRITERIA.md`](./docs/engineering/ACCEPTANCE_CRITERIA.md) — the seven mandatory Engineering Invariants and Reality Gate families.
- [`docs/engineering/PERMISSION_POLICY.md`](./docs/engineering/PERMISSION_POLICY.md) — roles, task lifecycle, secret authority.
- [`docs/engineering/MODEL_POLICY.md`](./docs/engineering/MODEL_POLICY.md) — model/cost tiering.
- [`docs/engineering/GOLDEN_PRINCIPLES.md`](./docs/engineering/GOLDEN_PRINCIPLES.md) — high-level guiding principles.
- [`docs/engineering/KNOWN_ISSUES.md`](./docs/engineering/KNOWN_ISSUES.md) — known issues log.
- [`docs/engineering/REFERENCE_SOURCES.md`](./docs/engineering/REFERENCE_SOURCES.md) — authoritative source map.
- [`docs/architecture/ADR/`](./docs/architecture/ADR/README.md) — architecture decision records.
- [`docs/specs/`](./docs/specs/README.md) — engineering-facing specs.
- [`docs/exec-plans/active/`](./docs/exec-plans/active/) — in-progress task execution records.
- [`docs/exec-plans/completed/`](./docs/exec-plans/completed/README.md) — completed task records.

## Project boundary

This repository is AKILTA only. AKILTA Commerce / AI Commerce is a separate project with a separate repository — see `docs/engineering/ACCEPTANCE_CRITERIA.md` (Invariant 6) and `CLAUDE.md`.
