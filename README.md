# akil-main

AKILTA main engineering repository.

## Status

Active backend/domain engineering. Governance scaffolding from `AKI-GIT-001` is in place, and the repository now holds a secret-free TypeScript domain/application kernel built across three engineering tasks:

- `AKI-BE-001` — backend foundation (tenant/customer/project/OutcomeJob lifecycle, evidence/verification, authority, audit). Brain **VERIFIED / COMPLETED**.
- `ENG-ORCH-001` — durable event-driven engineering orchestration bridge (fencing, idempotent replay, WAITING/ANSWER/RESUME). Brain **VERIFIED / COMPLETED**.
- `DEL-003` — project intelligence & delivery compilation (blueprint → sold scope → compiled plan → OutcomeJobSpecs). First bounded slice Brain **VERIFIED / COMPLETED**; second bounded slice (runtime admission + OutcomeJob wiring) **IMPLEMENTED**, pending Brain re-verification under the DEC-144 V1 Fast Lane.

See `docs/engineering/CURRENT_STATE.md` for the live detail and `docs/exec-plans/` for full per-task execution records. No merge to `main`, no deploy, no production/customer-facing surface — this remains a domain kernel, not a deployed service.

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
