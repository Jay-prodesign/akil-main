---
name: akilta-context-compiler
description: AKILTA-only executable context compiler. Use for material AKILTA tasks before implementation, verification, provider/theme/repository writes, context resume, compaction recovery, or when stale/current-state drift is possible. Resolves the existing AA-004 Session Bootstrap / Context Compiler workflow into a minimal Execution Capsule without creating new governance.
---

# AKILTA Context Compiler

Use this skill before every material AKILTA action. Do not use it for BestPrintsCo, AI Commerce / Akilta Commerce, FVCKU, or any other project.

## Canonical Sources

Resolve current sources in this order, using live provider/file reads when available:

1. `02 - AKILTA Current Project State` (AA-002, sole mutable selector).
2. `AKILTA - Session Bootstrap Resolver` (AA-004).
3. `03 - AJANS Decision Log & Governance Register`, tabs `Active Authority` and `Execution Capsule`.
4. `AKILTA - AI Engineering Operating System - v1.0` (AA-003).
5. `AKILTA - Current Engineering Handoff` (AA-005) only for the current engineering cursor/task.
6. Repository authority, when engineering: live repo/branch/head -> `AGENTS.md` -> worker overlay -> `docs/engineering/CURRENT_STATE.md` -> active task/corridor record.

Historical archives, cold snapshots, old handoffs, conversation memory, and files whose only proof is a word such as `CURRENT`, `LATEST`, `CONTROLLING`, or `APPROVED` are evidence only. They do not enter runtime authority unless the current active authority explicitly re-admits the specific fact.

## Workflow

1. Resolve `PROJECT=AKILTA` and reject cross-project execution.
2. Resolve actor: Brain, Claude, Codex, Founder, or reviewer.
3. Fresh-read or reuse AA-002 and the relevant Active Authority / Execution Capsule fingerprints.
4. Read only the relevant current handoff/task/corridor records.
5. Add live evidence only when decision-relevant.
6. Compile or update only the affected fields of the Execution Capsule.

## Execution Capsule Fields

Return only these fields:

`PROJECT`, `OBJECTIVE`, `CURRENT_STATE`, `TASK`, `ACTOR`, `ACTIVE_DECISIONS`, `CONSTRAINTS`, `RELEVANT_EVIDENCE_POINTERS`, `OWNER_GATES`, `DEFINITION_OF_DONE`, `NEXT_ACTION`, `CAPSULE_FINGERPRINT`.

## Invalidation

Reuse a capsule only while decision-relevant fingerprints are unchanged. Recompile only changed fields when objective, task, actor, scope, permission, target, source revision/head, provider state, or material evidence changes.

Missing `continue` / `devam` is never a lack of permission. A connector outage blocks only actions depending on that connector; continue unrelated authorized work if available.

Never hard-code mutable theme IDs, PR numbers, SHAs, branches, checksums, provider revisions, leases, or task IDs into this skill. Treat observed mutable values as current evidence only.
