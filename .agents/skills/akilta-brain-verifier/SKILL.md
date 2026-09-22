---
name: akilta-brain-verifier
description: AKILTA-only Brain verification workflow. Use when ChatGPT/Brain or Codex must verify AKILTA repository/provider/theme work, exact PR heads, diffs, tests, CI, provider readback, acceptance criteria, risk, HOLD_MERGE or SAFE_MERGE status, or decide PASS / CHANGES_REQUIRED / BLOCKED without confusing IMPLEMENTED, VERIFIED, COMPLETED, RELEASED, and LIVE.
---

# AKILTA Brain Verifier

Use after `akilta-context-compiler`. This skill standardizes verification; it does not create project scope.

## Required Inputs

Resolve these from current authority and live evidence:

- Governing requirement/current authority.
- Exact repository PR/head/base/diff when repository work is involved.
- Tests, CI, build/typecheck, and relevant focused/adversarial checks.
- Provider/theme/runtime readback when provider claims are made.
- Risk classification: `LOW`, `MEDIUM`, `HIGH`, or `PROTECTED`.
- Acceptance criteria and explicit exclusions.

## Workflow

1. Fresh-read the current authority and exact target.
2. Compare the exact head/revision against any previously reviewed head/revision.
3. Invalidate old PASS if a material SHA/revision/provider fingerprint changed.
4. Review only the affected diff and relevant invariants; reuse accepted evidence when fingerprints are unchanged.
5. Classify the result as `PASS`, `CHANGES_REQUIRED`, or `BLOCKED`.
6. Write or prepare a bounded canonical result only through the existing writeback owner.
7. Resolve the next executable edge if no owner gate is required.

## Required Distinctions

- `IMPLEMENTED` is not `VERIFIED`.
- `VERIFIED` is not `COMPLETED`.
- `COMPLETED` is not `RELEASED`.
- `RELEASED` is not `LIVE`.
- `SOURCE_PASS`, `PROVIDER_PASS`, `RENDER_PASS`, `VISUAL_PASS`, and Founder acceptance are separate claims.

Honor current `HOLD_MERGE`, `NOT SAFE_MERGE`, `SAFE_MERGE`, independent-review, and exact-head requirements. Do not end with a bare PASS when the next authorized action can already be resolved.
