# AKI-GIT-001 — Pre-Build Repository Bootstrap

- **Task ID:** AKI-GIT-001
- **Project:** AKILTA (repository: `Jay-prodesign/akil-main`)
- **Goal:** Bootstrap the minimum repository-local engineering operating contract (AGENTS.md, CLAUDE.md, `docs/engineering/*`, `docs/architecture/ADR/`, `docs/specs/`, `docs/exec-plans/*`, `.gitignore`, README navigation) required for safe Claude/Codex/ChatGPT continuity. No product/backend code.
- **Status:** IMPLEMENTED
- **Current Engineer:** Claude (Primary Engineer)
- **Previous Engineer / Handoff From:** None — first task in repository.
- **Branch:** `claude/AKI-GIT-001-repo-bootstrap`
- **Base Commit:** `8a95c721024da4bfee99e082a01e34b86321637f` (main, "Create README.md")
- **Latest Pushed Checkpoint SHA:** _(filled in Finish step, after commit — see Commit/PR/Evidence below)_
- **Working Tree State:** Clean at handoff — all changes committed to the task branch via GitHub, nothing staged/uncommitted outside Git.

## Scope

Create/update only:
`AGENTS.md`, `CLAUDE.md`, `docs/engineering/CURRENT_STATE.md`, `docs/engineering/IMPLEMENTATION_RULES.md`, `docs/engineering/ACCEPTANCE_CRITERIA.md`, `docs/engineering/PERMISSION_POLICY.md`, `docs/engineering/MODEL_POLICY.md`, `docs/engineering/GOLDEN_PRINCIPLES.md`, `docs/engineering/KNOWN_ISSUES.md`, `docs/engineering/REFERENCE_SOURCES.md`, `docs/architecture/ADR/README.md`, `docs/specs/README.md`, `docs/exec-plans/active/AKI-GIT-001.md` (this file), `docs/exec-plans/completed/README.md`, `.gitignore`, root `README.md`.

## Non-Scope (hard)

No `src/`, no backend/product/application code, no `package.json` or product dependencies, no framework scaffolding, no database/ORM/migrations, no queues/workers/outbox runtime, no CI/cloud/deployment infrastructure, no fake/no-op scripts, no Shopify or other product source, no touching `akilta-commerce`, no monorepo/shared-core, no real secrets/credentials/customer data, no starting AKI-BE-001, no merge to `main`. `CODEX.md` not created (no stable Codex-only requirement exists yet).

## Acceptance Criteria

- All bootstrap files listed under Scope exist on the task branch with content matching the requirements in this task.
- `AGENTS.md` establishes: repo-as-truth, session order, `continue`/`devam` semantics, Claude↔Codex handoff via Git, no concurrent same-branch mutation, no force-push over others' work, GitHub as engineering authority (Drive not a parallel engineering tree), secrets fail closed, concrete-first, invariants mandatory, invariant violation = build failure/review reject, comments/types/prose are not evidence, and points to `IMPLEMENTATION_RULES.md` + `ACCEPTANCE_CRITERIA.md`.
- `ACCEPTANCE_CRITERIA.md` contains all 7 Engineering Invariants, activation semantics, Reality Gate families, and the `IN_SCOPE / NOT_APPLICABLE / DEFERRED-BY-ACTIVATION` classification scheme.
- `IMPLEMENTATION_RULES.md` encodes DEC-120 (concrete-first, prohibited speculative abstractions list).
- No product/backend source, dependency manifest, database/migration, queue/worker/outbox, CI/cloud/deploy config, or AI Commerce content exists in the diff.
- No secret value exists anywhere in the diff.
- Diff contains only the authorized governance/bootstrap files.
- A fresh worker can reconstruct task/status/branch/SHA/restrictions/next action from repository state alone (this file + `CURRENT_STATE.md` + git log).

### Engineering Invariant classification (this task)

All seven invariants (see `ACCEPTANCE_CRITERIA.md`) are classified **NOT_APPLICABLE** for AKI-GIT-001. Reason: this task adds documentation only — no runtime code, no external effects, no data access, no authority resolution, no fan-out, no cross-project integration, no learning/retrieval system. Nothing in this diff activates any of the seven invariants.

## Authorities / Specs

- This task's instructions (Owner/ChatGPT-issued directive, AKI-GIT-001), reproduced in scope/non-scope above.
- No product spec applies — this is infrastructure/governance, not product implementation.

## Relevant Paths

`AGENTS.md`, `CLAUDE.md`, `docs/engineering/*.md`, `docs/architecture/ADR/README.md`, `docs/specs/README.md`, `docs/exec-plans/active/AKI-GIT-001.md`, `docs/exec-plans/completed/README.md`, `.gitignore`, `README.md`.

## Dependencies

None. First task in the repository beyond the pre-existing `README.md`.

## Checks Required

No CI, lint, or test infrastructure exists yet in this repository (by design — non-scope). Required checks for a documentation-only bootstrap: manual structural review against this task's validation checklist (below), and confirmation that the diff contains no code, dependency, secret, or cross-project content.

## Checks Run + Results

- Live repository inspection (pre-change): confirmed `Jay-prodesign/akil-main`, Private, default branch `main`, 1 branch, 0 tags, 1 commit (`8a95c72…`), no open PRs, no pre-existing governance files, no unexplained product source. Result: **no conflict found**, safe to proceed.
- Post-change self-review against the Validation checklist in the task instructions (file-by-file, see QA Evidence Bundle). Result: **pass**.

## QA Context Class

Documentation/governance bootstrap — no runtime, no UI, no data. Standard structural + content review is proportional; no automated test suite applies.

## QA Evidence Bundle

- Screenshot/read of live repo state prior to change (owner/name/visibility/branch/commit/PR count) captured via browser inspection on 2026-08-14.
- File-by-file diff on the task branch, reviewed against Scope/Non-Scope lists above (see Commit/PR/Evidence for the PR link containing the actual diff).
- Grep-equivalent manual check: no `package.json`, no `src/`, no `.env` with real values, no framework/database/queue references, no AI Commerce/Shopify content introduced.

## Implementation Notes

- Used Claude in Chrome (GitHub web UI) to create the branch and commit files directly, since no GitHub MCP connector or `gh`/git credential was available in the execution sandbox (direct `git clone` over the sandbox network was blocked; no GitHub connector exists in the connector registry). This was confirmed with the Owner before proceeding. Model tier: Tier B (normal engineering work) per `MODEL_POLICY.md` — this task is mechanical/structural, not deep-reasoning.
- Root `README.md` content was extended (not replaced) to preserve the pre-existing description line.

## Known Limitations / Issues

- `docs/engineering/REFERENCE_SOURCES.md` has no Google Drive links populated yet — Claude does not have and should not guess canonical Drive URLs; ChatGPT/Owner should populate these.
- No CI/lint/test tooling exists to mechanically enforce any of this — enforcement is currently manual/review-based until a real implementation task introduces tooling.
- No `CODEX.md` overlay was created, per instructions (no stable Codex-only requirement exists yet). If Codex needs role-specific guidance beyond `AGENTS.md`, that's a future scoped task.

## Blocked On

Nothing — task is implemented and ready for ChatGPT verification.

## Next Exact Action

**Repository-native Codex continuity readback** (not product coding): the next engineer (Codex or Claude) picking this up should read, in order, `AGENTS.md` → `docs/engineering/CURRENT_STATE.md` → this execution record → `git log` on `claude/AKI-GIT-001-repo-bootstrap`, and confirm branch name, checkpoint SHA, and scope match what's recorded here. No further action is authorized on this task until ChatGPT/Owner verification moves it to `VERIFIED`/`COMPLETED`, or until ChatGPT/Owner assigns a new task (e.g. AKI-BE-001). Do not begin backend/product work.

## Commit / PR / Evidence

- Branch: `claude/AKI-GIT-001-repo-bootstrap`
- PR: _(filled in Finish step below, once opened)_
- Checkpoint SHA: _(filled in Finish step below, once committed)_
- Changed files: see Scope list above (full list committed on the task branch).

## ChatGPT Verification

_Pending — not yet reviewed. Placeholder for ChatGPT / AKILTA Brain verification against requirements, repository changes, and evidence above._
