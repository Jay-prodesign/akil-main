# ACCEPTANCE_CRITERIA.md — Engineering Invariants and Reality Gates

Read this before writing any implementation code, alongside `IMPLEMENTATION_RULES.md`.

## How to use this document

For any material implementation task, classify each of the seven invariants below as one of:

- `IN_SCOPE` — the task implements or touches behavior this invariant governs; the invariant's check/test must pass before the task can move past `IMPLEMENTED`.
- `NOT_APPLICABLE` — the task's behavior never triggers this invariant's concern. Give a short, specific reason.
- `DEFERRED-BY-ACTIVATION` — the invariant will apply once a specific future capability is built, but that capability is not part of this task. Name the activating capability.

Never mark a gate `NOT_APPLICABLE` if the task actually implements the behavior that activates it. When in doubt, mark it `IN_SCOPE` or `DEFERRED-BY-ACTIVATION` and escalate the ambiguity rather than silently waiving it.

Record the classification and reasoning in the task's active execution record.

## The seven mandatory Engineering Invariants

1. **Committed intent before external effect.** Persist committed intent (e.g. via a transactional outbox/inbox) before any material external effect. This mechanism activates only when a task actually produces external effects (calls to third-party APIs, provider writes, customer-visible side effects); it is not required for purely internal or read-only work.

2. **Idempotency scope.** Idempotency keys/guards must bind to the full scope: tenant/workspace + integration/provider-account + canonical operation + logical action. A key that omits any of these dimensions is not a valid idempotency guard under this invariant.

3. **Re-resolve authority before effect.** Re-resolve current authority (auth/session/permission/credential validity) immediately before an external effect, retry, or resume — never rely on authority resolved earlier in a long-running or resumed flow.

4. **Structural tenant/integration scope.** Tenant and integration scope must be structural (enforced by the data/query shape), not incidental. A protected, unscoped `getById(id)`-style accessor that relies on the caller to apply scoping is prohibited.

5. **Bounded, reserved-quota fan-out.** Before metered bulk fan-out, reserve quota/cost and use bounded concurrency. Uncontrolled merchant-scale `Promise.all` (or equivalent unbounded parallel fan-out) against a metered or rate-limited resource is prohibited.

6. **AKILTA ↔ AI Commerce isolation.** AKILTA and AI Commerce (AKILTA Commerce) stay isolated behind versioned contracts. No shared database, credential, domain, repository, or source authority merge between the two projects, under any task.

7. **Learning contamination prevention.** Inactive, unapproved, superseded, or revoked learning/knowledge must never enter active truth retrieval. Promotion to active truth, data-use, and training eligibility are separate decisions/gates — passing one does not imply the others.

## Reality Gate families (reusable test/verification categories)

These are recorded here as reusable categories for future test design. **None of these mechanisms are implemented by AKI-GIT-001** — this is a documentation record of the families, not an implementation task.

- Crash-window / failure injection — does the system recover correctly if it crashes mid-operation?
- Double-worker concurrency — do two workers/agents acting on the same resource concurrently produce a correct, non-corrupting outcome?
- Scope-swap — does the system reject or correctly isolate operations when tenant/integration scope changes mid-flow?
- Authority-race — does re-resolved authority correctly win over stale authority in a race?
- Lifecycle/state-machine + verification — does state transition only occur with valid preconditions and produce verifiable evidence?
- Learning contamination — does inactive/revoked knowledge stay out of active retrieval under adversarial conditions?
- AKILTA ↔ AI Commerce replay/version compatibility — do versioned contracts between the two projects remain compatible under replay?
- Quota reservation/fairness — does quota reservation prevent starvation and stay fair under concurrent bulk operations?

## AKI-GIT-001 classification (this task)

This task is a documentation-only bootstrap. It introduces no runtime code, no external effects, no idempotency, no authority resolution, no data access, no fan-out, no cross-project integration, and no learning/retrieval system. All seven invariants are classified `NOT_APPLICABLE` for this task specifically — reason: no code or runtime behavior was introduced that could activate any of them. See `docs/exec-plans/active/AKI-GIT-001.md` for the full classification record.
