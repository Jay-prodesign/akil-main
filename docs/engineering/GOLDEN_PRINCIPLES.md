# GOLDEN_PRINCIPLES.md

High-level principles that everything else in `docs/engineering/` operationalizes. When a specific rule doesn't cover a situation, fall back to these.

1. **Live repository state is truth.** Not memory, not chat history, not assumption. Verify before acting.

2. **Concrete-first.** Build what the current task needs. Don't build for a future consumer that doesn't exist yet. See `IMPLEMENTATION_RULES.md`.

3. **Evidence over assertion.** A passing check/test/reproduction is evidence. Comments, types, and prose describing behavior are not. "Done" is never sufficient on its own.

4. **Secrets fail closed.** No real secret ever lives in Git, chat, or governance docs. If a secret isn't available through an approved channel, stop and escalate — don't substitute.

5. **Isolation over shortcuts.** One material task per branch/worktree. No concurrent mutation of the same branch by two engineers. No shared source/domain/credential authority between AKILTA and AI Commerce.

6. **Escalate conflicts, don't resolve them unilaterally.** Product, architecture, security, scope, or priority conflicts discovered during implementation go to ChatGPT / AKILTA Brain (or the Owner for irreversible/production/security/legal/financial matters) — not silently decided by the implementing engineer.

7. **Validation depth matches risk.** Mechanical validation (format, lint, types, tests, build, CI, secret scanning) where available. More scrutiny for higher-risk changes; successful compilation alone is never sufficient when rendering or runtime behavior matters.

8. **Minimum sufficient context.** Read what the task needs, not the whole repository, to keep cost and context pollution down.

9. **An engineer's authority has a ceiling.** Implementation ends at `IMPLEMENTED`. Verification and completion are a separate authority (ChatGPT), and irreversible/production/security/legal/financial calls are the Owner's alone.
