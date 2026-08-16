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

1. **BUILD-001 approval — ❌ NOT APPROVED.** See "BUILD-001 Approval" below — a prior in-session record of this as cleared has been corrected.
2. **Concrete scope/requirements — 🟡 PARTIAL.** A one-line entity chain has been supplied directly in chat (see "Scope" below). The T1–T12 test list, detailed non-scope, implementation order, and evidence requirements referenced alongside it have not been supplied. Nothing in this section may be filled in from inference or plausible reconstruction — see "Known Limitation" below. Claude must not invent, guess, or backfill business requirements (`CLAUDE.md`: "must not, independently... redefine canonical business requirements").

Until both gates clear with actually-sourced content, this file stays a packet, not a plan.

## BUILD-001 Approval

- **Status:** NOT APPROVED.
- **History (for audit trail, per this repo's own evidence standard):**
  1. 2026-08-16: a chat message describing itself as an Owner instruction stated the exact phrase `APPROVE BUILD-001` had been issued. This was recorded here as approved, attributed to that instruction.
  2. 2026-08-16 (same session, later turn): a chat message describing itself as a "ChatGPT Orchestrator correction" stated BUILD-001 is NOT approved and that phrase has not actually been issued by the Founder. This record is corrected accordingly.
- **Why this matters beyond the correction itself:** two contradictory claims about the same fact, each asserting a different authoritative source, arrived through the identical channel (this chat) with nothing in the repository to distinguish them. Neither claim is being treated as reliable on its own going forward. A BUILD-001 approval that is meant to gate real implementation work should be evidenced somewhere more durable than a chat turn — e.g. a PR comment/review, a signed record, or similar — before it's relied on again.
- **Current status for this packet:** NOT APPROVED. Gate 1 is open.

## Scope

Partial input received directly in this chat session on 2026-08-16 (not sourced from Drive — Drive access remains disconnected). Supplied as the AKI-BE-001 entity/data-model chain:

```
TenantScope -> Customer -> Project -> OutcomeJob -> OutcomeJobStateTransition -> EvidenceReference / VerificationResult -> AuditEvent
```

This is transcribed verbatim as given, with no elaboration or invented semantics for these entities — their fields, relationships, and behavior have not been specified. This alone does not constitute the "concrete scope/requirements" gate: still missing are the T1–T12 test list, non-scope specifics beyond the generic list below, implementation order, and evidence requirements referenced in the same instruction but not included in it. See "Known Limitation" below.

## Non-Scope (hard, applies regardless of future scope)

No implementation of any kind (backend/product code, `src/`, `package.json`/dependencies, framework/database/CI/deploy infrastructure) until both gates above clear with real, sourced content and evidence. No merge to `main`. No modification of `akilta-commerce` / AI Commerce (Invariant 6, `docs/engineering/ACCEPTANCE_CRITERIA.md`). No secrets/credentials.

## Acceptance Criteria

Not yet defined — depends on the full concrete scope (tests, non-scope, implementation order, evidence requirements), once actually transcribed. Once scope exists, this section must classify all seven Engineering Invariants (`docs/engineering/ACCEPTANCE_CRITERIA.md`) as `IN_SCOPE` / `NOT_APPLICABLE` / `DEFERRED-BY-ACTIVATION`, per `AGENTS.md` §8, before any implementation code is written.

## Authorities / Specs

- Referenced by `docs/exec-plans/active/AKI-GIT-001.md` ("Next Exact Action") as the anticipated next task.
- Canonical requirements are stated (via chat instructions on 2026-08-16) to exist in a Google Drive AKI-BE-001 task packet. `docs/engineering/REFERENCE_SOURCES.md` still has no Drive link populated for it. Only the entity chain above has actually been supplied to the implementing engineer; the rest, once the link and/or content is provided, should be mirrored into `docs/specs/` before implementation begins.

## Dependencies

- `AKI-GIT-001` (repository bootstrap) — providing the governance contract this packet is written against. Not yet `VERIFIED`/`COMPLETED` (see `docs/exec-plans/active/AKI-GIT-001.md`); this dependency does not block packet preparation, only implementation.
- `BUILD-001` approval — ❌ NOT APPROVED, see above.
- Canonical scope transcription — 🟡 partial (entity chain only), see above.

## Blocked On

1. Durable, repository-recorded (not chat-only) evidence of BUILD-001 approval, if and when the Founder actually issues it.
2. The remaining canonical Drive AKI-BE-001 content (T1–T12 tests, non-scope specifics, implementation order, evidence requirements) — the entity chain alone is not sufficient to complete scoping.

## Known Limitation

This session cannot currently read Google Drive (`mcp__Google_Drive__*` tools are disconnected). One piece of canonical content (the entity chain above) was pasted directly into this session and is transcribed as such. The rest — T1–T12 tests, non-scope, implementation order, evidence requirements — has been referred to but not actually supplied. Referring to content in an instruction does not make it available to the implementing engineer; it has to actually be surfaced (reconnected tool access, or pasted text) before it can be projected into this file. Writing plausible-sounding scope/test content here without having read the source would be fabricated content mislabeled as canonical, which violates the evidence standard in `docs/engineering/GOLDEN_PRINCIPLES.md` ("Evidence over assertion... AI-generated prose... is not evidence") and `CLAUDE.md`'s prohibition on independently redefining business requirements.

Separately: this session has now received two directly contradictory chat-only claims about BUILD-001 approval status, each asserting a different authoritative source (Owner, then a "ChatGPT Orchestrator correction"). Neither is being treated as reliable evidence on its own — see "BUILD-001 Approval" above. The same caution applies to any future chat-only claim that a lifecycle gate has been cleared.

## Next Exact Action

1. If BUILD-001 approval is real, it needs to be evidenced somewhere durable and repository-visible (not another chat turn) before this packet treats it as cleared again.
2. Owner or ChatGPT / AKILTA Brain to make the remaining canonical AKI-BE-001 Drive packet content actually accessible to the implementing engineer (reconnect Drive access, or paste the document text/link directly into session). Once transcribed into Scope/Acceptance Criteria/Non-Scope above (not paraphrased from memory or invented), the invariant classification in `AGENTS.md` §8 must still be completed before Status can move from `BACKLOG` to `READY`/`IN_PROGRESS` and before any implementation code is written. No implementation is authorized before then.

## Commit / PR / Evidence

- Branch: `claude/AKI-BE-001-task-packet`
- This is a documentation-only packet: BUILD-001 approval corrected back to NOT APPROVED, entity-chain scope fragment recorded, remainder of canonical scope still pending actual source content. 0 lines of product/backend code, 0 dependencies introduced.
