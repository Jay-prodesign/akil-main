# CURRENT_STATE.md

This file is the compact current-cursor/current-state record for this repository's engineering work. It is not an append-only log: it is mutated in place as state changes. The full historical narrative (every Brain revision, correction, and per-checkpoint account that produced this state) is preserved verbatim, unmodified, in `docs/engineering/CURRENT_STATE_HISTORY.md` — consult it for provenance/evidence detail, but it is not runtime authority. Per-task detail lives in `docs/exec-plans/active/*.md` and `docs/exec-plans/completed/*.md`; this file does not duplicate it.

Repo engineering policy epoch: see `AGENTS.md` §11.

## Current engineering baseline

- `main` = `3226c76fa338e425e553638e5f5f48924182a1c0`.
- PR #60 (`claude/rev98-corridor-consolidation`) = `6836fb5697483d637134f7bedd4d194d9f91eac7` — OPEN/DRAFT, `HOLD_MERGE` (HIGH/PROTECTED consolidated surface — a scope classification, not an open finding).
- PR #61 (`claude/local-exec-007-hybrid-hardening`) = `29728cfa2ddb93e2b8943f1a33c48a3de0161ec4` — OPEN/DRAFT, based on PR #60's exact head, `HOLD_MERGE`.
- PR #62 (`claude/local-exec-005-collaboration-rank-failclosed`) = `ce315e2574d92e70ad4a6e3f6b6d764291a65d96` — OPEN/DRAFT, `HOLD_MERGE`.
- All three PRs are bounded-PASSed at their live exact heads with nothing pending; no MAIN mutation is authorized by this record. Update this section (and only this section) when any of these heads changes.

## Active corridor

This repository operates inside the DEC-160 V2→V5 Autonomous Engineering Corridor. See `docs/exec-plans/corridors/V2_TO_V5.md` for the repo-native corridor contract (condensed; Drive `113M8-J5mYAUPM_BbMlOp0-EgDD4OpCVhNad2yk4crVA` is canonical) and `docs/architecture/VERSION_EVOLUTION_MAP.md` for what is actually built per version.

Every Rev98 mandatory gap family (1–12) and the founder-approved LOCAL-EXEC-001…007 family are `IMPLEMENTED/EVIDENCED` on their own exact heads — see each task's own record under `docs/exec-plans/active/`. This work is not yet on `main`: it sits on open PR #60/#61/#62 (`HOLD_MERGE`, see "Current engineering baseline" above). LOCAL-EXEC-007 is additionally the one partial exception on substance: its bounded dark/internal floor is implemented, with the following remainder explicitly OPEN/trigger-gated, not silently deferred: authoritative Local Execution safe-switch/migration preflight beyond supplied-facts checks; real per-user/device `SHARED_REPO` access admission; Anthropic live/commercial activation (`POLICY_REVIEW_REQUIRED`); real customer-approval identity/admission provenance. None of these has real infrastructure anywhere in this repository to build against without fabricating it.

## Repository identity

- Owner/name: `Jay-prodesign/akil-main`
- Visibility: Private
- Default branch: `main`, currently at `3226c76fa338e425e553638e5f5f48924182a1c0` (see `docs/engineering/CURRENT_STATE_HISTORY.md` for the full merge-chain ancestry from bootstrap).

## What exists

- `README.md`; governance/operating scaffolding (`AGENTS.md`, `CLAUDE.md`, `docs/engineering/`, `docs/architecture/`, `docs/exec-plans/`).
- A secret-free TypeScript domain/application kernel under `src/domain/`, `src/application/`, `src/ports/`, `src/web/`, `src/fixtures/`. On `main` today: identity/session/tenant boundaries, delivery/outcome-job lifecycle, evidence/verification, organization/ownership/partner authority, commercial/attention/operations read-models, worker/routing policy, cross-domain intelligence, and internal command projection. Additionally implemented/evidenced on open PR #60/#61/#62 heads, not yet on `main`: connector/integration control-plane primitives and the founder-approved Local Execution Bridge (LOCAL-EXEC-001…007). See `docs/exec-plans/active/` and `docs/exec-plans/completed/` for the authoritative per-module record and exact merge disposition.
- `tests/` — Node's built-in `node:test` runner exercises the kernel (`npm run build && npm test`; run for the current count, do not trust a number recorded here).
- `package.json`/`package-lock.json`/`tsconfig.json` — strict-mode TypeScript, zero runtime dependencies, `devDependencies` limited to `typescript` + `@types/node`.

## What does not exist yet

- Any HTTP/API server, database, ORM, queue, cache, object storage, or cloud service — this remains a domain/application kernel, not a deployable backend.
- Any CI, cloud, or deployment configuration.
- Any real secret, credential, or vault integration (secret-free by design; see `docs/engineering/PERMISSION_POLICY.md`).
- Durable production runtime dispatch, cross-project (AI Commerce) request/result flows, broad AI/model routing, and FAS-001 S1/S2 adversarial activation remain stage/trigger/dependency-gated per the canonical roadmap; not pulled forward.
- A public-facing website, payment/legal/commercial surface — the live AKILTA commercial website (`akilta.com`) is a separate, already-live Shopify-hosted surface outside this repository's scope.

## Task record

Every task's live status, branch, evidence, and merge disposition lives in its own file under `docs/exec-plans/active/` (open) or `docs/exec-plans/completed/` (Brain `VERIFIED`/`PASS`/`CLOSED`). This file does not duplicate that record. `docs/engineering/CURRENT_STATE_HISTORY.md` preserves the full chronological account of how each task reached its current state.

## Known conflicts / blockers

None blocking ordinary dependency-safe engineering continuation. LOCAL-EXEC-007's remainder (above) and the protected/live edges named in "What does not exist yet" remain just-in-time gates, not global stops.
