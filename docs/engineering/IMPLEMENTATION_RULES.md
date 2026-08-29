# IMPLEMENTATION_RULES.md

Read this before writing any implementation code. It is mandatory reading for material implementation tasks, alongside `ACCEPTANCE_CRITERIA.md`.

## DEC-120 — Concrete-first

This repository prohibits speculative abstraction. Specifically prohibited unless the active task's acceptance criteria actually require it:

- `BaseService` / `BaseRepository` / `BaseAgent` / `BaseConnector` style inheritance hierarchies,
- generic frameworks built ahead of a second concrete consumer,
- universal registries or factories,
- catch-all `common/`, `shared/`, or `utils/` layers,
- abstractions written for a future consumer that does not yet exist,
- infrastructure not required by the active task.

Prefer explicit domain code and composition over inheritance or generic frameworks. Small, honest duplication is acceptable and preferred over a wrong or premature abstraction. Only extract a shared abstraction once a real, stable, repeated pattern exists across actual (not hypothetical) call sites — normally the third occurrence, not the second guess.

## Why

Premature abstraction in a multi-agent engineering model (Claude / Codex / ChatGPT) compounds fast: each agent inherits the prior agent's guesses about future needs, and wrong guesses are expensive to unwind across a shared codebase. Concrete code is easier for another engineer — human or AI — to verify, review, and safely modify.

## How this is enforced

- Code review (self-review by the implementing engineer, and independent review by Codex on higher-risk tasks) checks for violations of this rule.
- A violation of an applicable Engineering Invariant (see `ACCEPTANCE_CRITERIA.md`) introduced via premature infrastructure is a build failure or mandatory review reject, not a style note.
- If a task seems to require shared infrastructure, treat that as a scope question and escalate to ChatGPT / AKILTA Brain rather than building it unilaterally.

## Evidence standard

Comments, framework defaults, TypeScript/type annotations, or AI-generated prose describing what code does are not evidence that it does it. Evidence is: a passing test, a passing check, or a reproducible, observed behavior recorded in the execution record's QA Evidence Bundle.
