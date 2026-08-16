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

**Product/backend implementation is NOT authorized under this packet.** Per `AGENTS.md` §10 and `docs/engineering/PERMISSION_POLICY.md`, this task may not move past `BACKLOG`/`READY` into `IN_PROGRESS` until both of the following are satisfied:

1. **BUILD-001 approval — ✅ CLEARED.** Recorded below under "BUILD-001 Approval."
2. **Concrete scope/requirements — ❌ STILL OPEN.** A real goal, scope, T1–T12 test list, non-scope, implementation order, and evidence requirements for AKI-BE-001 are referenced as existing in a canonical Google Drive AKI-BE-001 task packet, but that document has not been read by, or transcribed to, the implementing engineer in this session: the Google Drive connector is disconnected in this environment, and no document content has been pasted into this session either. Nothing in this section may be filled in from inference or plausible reconstruction — see "Known Limitation" below. Claude must not invent, guess, or backfill business requirements (`CLAUDE.md`: "must not, independently... redefine canonical business requirements").

Until gate 2 clears with actually-sourced content, this file stays a packet, not a plan.

## BUILD-001 Approval

- **Status:** APPROVED.
- **Evidence:** Owner issued the exact authorization phrase `APPROVE BUILD-001` via direct instruction in this Claude session on 2026-08-16. Recorded here, in the repository, as the authoritative trace per `AGENTS.md` §9 (Owner sits at the top of the authority order). This is an Owner attestation transcribed into the repo, not a relayed or inferred third-party claim.
- **Scope of what this clears:** Gate 1 of the two-gate Hard Gate above only. It does not by itself authorize `IN_PROGRESS`/implementation — gate 2 (concrete scope) is independently required and remains open.

## Scope

_Still not transcribed._ The canonical Drive AKI-BE-001 task packet is referenced as authoritative (per Owner instruction) but its content — scope, T1–T12 tests, non-scope, implementation order, evidence requirements — has not been surfaced to the implementing engineer through any accessible channel this session (Drive connector disconnected; no content pasted). See "Known Limitation" below for exactly what is needed to close this out honestly rather than by fabrication.

## Non-Scope (hard, applies regardless of future scope)

No implementation of any kind (backend/product code, `src/`, `package.json`/dependencies, framework/database/CI/deploy infrastructure) until gate 2 clears with real, sourced content. No merge to `main`. No modification of `akilta-commerce` / AI Commerce (Invariant 6, `docs/engineering/ACCEPTANCE_CRITERIA.md`). No secrets/credentials.

## Acceptance Criteria

Not yet defined — depends on the concrete scope, once actually transcribed. Once scope exists, this section must classify all seven Engineering Invariants (`docs/engineering/ACCEPTANCE_CRITERIA.md`) as `IN_SCOPE` / `NOT_APPLICABLE` / `DEFERRED-BY-ACTIVATION`, per `AGENTS.md` §8, before any implementation code is written.

## Authorities / Specs

- Referenced by `docs/exec-plans/active/AKI-GIT-001.md` ("Next Exact Action") as the anticipated next task.
- Canonical requirements are stated (per Owner instruction, 2026-08-16) to exist in a Google Drive AKI-BE-001 task packet. `docs/engineering/REFERENCE_SOURCES.md` still has no Drive link populated for it. Once the link and/or content is provided, it should be mirrored into `docs/specs/` before implementation begins.

## Dependencies

- `AKI-GIT-001` (repository bootstrap) — providing the governance contract this packet is written against. Not yet `VERIFIED`/`COMPLETED` (see `docs/exec-plans/active/AKI-GIT-001.md`); this dependency does not block packet preparation, only implementation.
- `BUILD-001` approval — ✅ cleared, see above.
- Canonical scope transcription — ❌ open, see above.

## Blocked On

1. Actual content of the canonical Drive AKI-BE-001 task packet (scope, T1–T12 tests, non-scope, implementation order, evidence requirements), supplied either by reconnecting Drive access or by pasting the document content directly into session, so it can be transcribed rather than fabricated.

## Known Limitation

This session cannot currently read Google Drive (`mcp__Google_Drive__*` tools are disconnected) and no AKI-BE-001 Drive content has been pasted into the conversation. Referring to "the existing canonical scope, T1–T12 tests..." in an instruction does not make that content available to the implementing engineer — it has to actually be surfaced (reconnected tool access, or pasted text) before it can be projected into this file. Writing plausible-sounding scope/test content here without having read the source would be fabricated content mislabeled as canonical, which violates the evidence standard in `docs/engineering/GOLDEN_PRINCIPLES.md` ("Evidence over assertion... AI-generated prose... is not evidence") and `CLAUDE.md`'s prohibition on independently redefining business requirements.

## Next Exact Action

Owner or ChatGPT / AKILTA Brain to make the canonical AKI-BE-001 Drive packet content actually accessible to the implementing engineer (reconnect Drive access, or paste the document text/link directly into session). Once that content is transcribed into Scope/Acceptance Criteria/Non-Scope above (not paraphrased from memory or invented), the invariant classification in `AGENTS.md` §8 must still be completed before Status can move from `BACKLOG` to `READY`/`IN_PROGRESS` and before any implementation code is written. No implementation is authorized before then.

## Commit / PR / Evidence

- Branch: `claude/AKI-BE-001-task-packet`
- This is a documentation-only packet: BUILD-001 approval recorded, canonical scope still pending actual source content. 0 lines of product/backend code, 0 dependencies introduced.
