# AKI-BE-001 — Backend Build: Task Packet (Not Started)

- **Task ID:** AKI-BE-001
- **Project:** AKILTA (repository: `Jay-prodesign/akil-main`)
- **Goal:** _Not yet defined._ No canonical product/technical spec for AKI-BE-001 exists in this repository (`docs/specs/` is empty scaffolding — see `docs/specs/README.md`) or has been provided to the implementing engineer. This packet is a placeholder execution record only, created so the task exists as a trackable repository artifact ahead of scoping — it does not itself authorize or define implementation.
- **Status:** `BACKLOG`
- **Current Engineer:** Unassigned — no implementation work has started, and none is authorized to start under this packet.
- **Previous Engineer / Handoff From:** None. Follows `AKI-GIT-001` (repository bootstrap) as the next task named in that task's execution record, per Owner instruction.
- **Branch:** `claude/AKI-BE-001-task-packet` (this packet only; a fresh implementation branch would be created separately once/if this task moves to `IN_PROGRESS`)
- **Base:** Branched from `claude/AKI-GIT-001-repo-bootstrap` @ `36150adf1394349d2543c0503b2fdd39dd380aff`, since the governance/doc scaffolding this packet depends on (`AGENTS.md`, `docs/engineering/`, `docs/exec-plans/`) currently exists only on that branch and has not yet merged to `main`.
- **Working Tree State:** Clean — this file is the only change on this branch.

## Hard Gate — Read Before Any Further Action

**Product/backend implementation is NOT authorized under this packet.** Per `AGENTS.md` §10 and `docs/engineering/PERMISSION_POLICY.md`, this task may not move past `BACKLOG`/`READY` into `IN_PROGRESS` until both of the following are satisfied and recorded as live repository/PR evidence (not chat assertion):

1. **BUILD-001 approval.** This repository has no record of a `BUILD-001` task or approval gate (confirmed absent from `AGENTS.md`, `CLAUDE.md`, all of `docs/engineering/`, and every existing exec-plan). Whatever `BUILD-001` refers to as an approval mechanism, it must be resolved and its approval evidenced in this repository (e.g. as a linked task record, an Owner/ChatGPT sign-off recorded here or on the relevant PR) before implementation starts.
2. **Concrete scope/requirements.** A real goal, scope, and acceptance criteria for AKI-BE-001 — supplied by the Owner or ChatGPT / AKILTA Brain per the authority order in `AGENTS.md` §9 — must replace the placeholders in this packet. Claude must not invent, guess, or backfill business requirements (`CLAUDE.md`: "must not, independently... redefine canonical business requirements").

Until both gates clear, this file stays a packet, not a plan.

## Scope

_Not yet defined._ To be filled in once a concrete spec/requirement is supplied (see `docs/specs/README.md` for where the engineering-facing spec copy should live once one exists).

## Non-Scope (hard, applies regardless of future scope)

No implementation of any kind (backend/product code, `src/`, `package.json`/dependencies, framework/database/CI/deploy infrastructure) until both gates above clear. No merge to `main`. No modification of `akilta-commerce` / AI Commerce (Invariant 6, `docs/engineering/ACCEPTANCE_CRITERIA.md`). No secrets/credentials.

## Acceptance Criteria

Not yet defined — depends on the concrete scope above. Once scope exists, this section must classify all seven Engineering Invariants (`docs/engineering/ACCEPTANCE_CRITERIA.md`) as `IN_SCOPE` / `NOT_APPLICABLE` / `DEFERRED-BY-ACTIVATION`, per `AGENTS.md` §8, before any implementation code is written.

## Authorities / Specs

- Referenced by `docs/exec-plans/active/AKI-GIT-001.md` ("Next Exact Action") as the anticipated next task.
- No product spec exists yet for this task. Canonical requirements, when available, live in Google Drive per `docs/engineering/REFERENCE_SOURCES.md` (not yet populated) and should be mirrored into `docs/specs/` before implementation begins.

## Dependencies

- `AKI-GIT-001` (repository bootstrap) — providing the governance contract this packet is written against. Not yet `VERIFIED`/`COMPLETED` (see `docs/exec-plans/active/AKI-GIT-001.md`); this dependency does not block packet preparation, only implementation.
- `BUILD-001` approval — status unknown/unresolved in this repository (see Hard Gate above).

## Blocked On

1. BUILD-001 approval evidence (repository-recorded, not chat assertion).
2. Concrete scope/requirements from Owner or ChatGPT / AKILTA Brain.

## Next Exact Action

Owner or ChatGPT / AKILTA Brain to supply (a) BUILD-001 approval evidence and (b) concrete AKI-BE-001 scope/requirements, recorded in or linked from this file. Only once both are present may an implementing engineer move this task's Status from `BACKLOG` to `READY`/`IN_PROGRESS` and begin scoping actual implementation work — still subject to the full session-order, invariant-classification, and concrete-first rules in `AGENTS.md` before any code is written. No implementation is authorized before then.

## Commit / PR / Evidence

- Branch: `claude/AKI-BE-001-task-packet`
- This is a documentation-only packet: 1 file added, 0 lines of product/backend code, 0 dependencies introduced.
