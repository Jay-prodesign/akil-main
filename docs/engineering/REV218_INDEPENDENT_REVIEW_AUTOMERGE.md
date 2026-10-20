# REV218 — Independent-Review Auto-Merge Policy

## Authority

Canonical source: AA-005 REV218 (2026-10-20).

This repository projection removes routine Founder merge waiting for eligible bounded internal engineering work while preserving independent verification and all production/live/commercial protected gates.

## Flow

1. Primary Engineer implements, self-reviews, tests, and records an exact-head `MERGE_READY` recommendation.
2. A distinct independent reviewer reviews that exact SHA and records `PASS / VERIFIED` or `CHANGES_REQUIRED`.
3. If PASS and all eligibility conditions below hold, a merge executor may merge the reviewed candidate to `main` without a separate Founder approval.
4. Read back `main`, observe configured CI, reconcile/close superseded stacked PRs only after the integrated content is confirmed, then continue the active completion corridor.

The implementing Claude session is not the independent reviewer of its own code. An eligible reviewer is ChatGPT / AKILTA Brain, Codex, or another separately-contexted reviewer explicitly acting in that role.

## Exact-head rule

Independent PASS applies only to the reviewed commit SHA. Any source, test, documentation, merge-base, or candidate-content change after PASS invalidates the disposition and requires a fresh exact-head independent review.

## Auto-merge eligibility

All must be true:

- work is already inside current canonical AKILTA product/engineering scope;
- repository change is operationally reversible through normal version control;
- required build/typecheck/tests and configured CI are green, or an unavailable check is explicitly reconciled;
- no unresolved security, tenant-isolation, authority, or data-integrity finding remains;
- branch/base/ancestry and stacked-PR disposition are understood;
- the merge itself does not trigger or authorize any protected production/live effect;
- independent reviewer PASS explicitly names the exact candidate SHA.

## Stacked PRs

A final integration branch may be merged as one candidate when independent review proves all intended ancestor content is contained, corrected, and cleanly based on current `main`. Earlier stacked PRs may be closed as superseded only after `main` readback confirms the integrated content. Unreviewed or separate PRs must never be implicitly included, verified, or closed.

## Still Founder-protected

REV218 does not authorize:

- production deployment or release;
- DNS/domain/public release;
- live credentials, secrets, provider activation, or OAuth/account grants;
- real billing/payment/spend/financial commitments;
- legal/commercial terms, contracts, or pricing commitments;
- public signup, real external-customer activation, or GA;
- destructive production/customer-data actions;
- genuine product/business strategy or material architecture decisions.

If merging to `main` is mechanically coupled to a protected effect, auto-merge is not eligible unless that effect is safely disabled/separated first.

## Current candidate

Superseded by this repo-native projection's own continuation: the `CHANGES_REQUIRED` finding at head `3cca9d034752cdfffd9574294f8fb4f77f367664` (Brain comment `6280195112`) was closed on head `47fbea90166375e688e02ff46e783b40768716a3` (CI green, full regression 3037/3037 — see `docs/exec-plans/active/KNOWLEDGE-EVIDENCE-DURABLE-001-SYSTEMIC-TORN-READ-CORRECTION.md`). That corrected head is the current `MERGE_READY` recommendation, awaiting independent PASS/VERIFIED before any merge.

## Continuation

After an eligible reviewed merge, Claude immediately fresh-reads canonical + live repository truth and continues the REV216 completion loop. Routine merge success is not a Founder stop.
