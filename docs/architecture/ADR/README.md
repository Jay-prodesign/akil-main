# Architecture Decision Records (ADR)

This folder holds Architecture Decision Records for AKILTA. An ADR captures a significant, hard-to-reverse architectural decision: what was decided, why, what alternatives were considered, and what tradeoffs were accepted.

## When to write one

Write an ADR when a decision is structural and expensive to reverse — e.g. choice of framework/runtime, data storage model, tenant isolation strategy, cross-project contract shape (AKILTA ↔ AI Commerce). Don't write one for routine implementation choices already covered by `docs/engineering/IMPLEMENTATION_RULES.md`.

## Format

`NNNN-short-title.md`, numbered sequentially. Suggested sections: Status (proposed/accepted/superseded), Context, Decision, Consequences, Alternatives considered.

## Index

- [0001 — V2-APP-001 web-application shell: framework and placement](0001-v2-app-001-web-shell-framework.md) — Accepted 2026-08-26. Build the shell on `node:http` + a hand-written pure request handler; no third-party web framework introduced.
- [0002 — LOCAL-EXEC-003: Codex Local Adapter dependency-fit against current official Codex CLI/app-server behavior](0002-local-exec-003-codex-adapter-fit.md) — Accepted 2026-09-11. Sourced research on Codex CLI/App Server sandbox/approval/network/resume/auth/usage-limit behavior; model it as closed types composing the existing LOCAL-EXEC-001/002 ports, never a second worker/protocol system.
