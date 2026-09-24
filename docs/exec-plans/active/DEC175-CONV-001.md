# DEC175-CONV-001 — WEBSITE_BUILD_v1 Reference Cold-Start Convergence Proof

## Provenance

- **Dispatched by:** Brain Rev113 (`BRAIN REV113 — DEC-175 REFERENCE COLD-START CONVERGENCE SELECTED / CLAUDE RESUME`), read verbatim from AA-005.
- **Task type:** evidence/integration only. No product source implementation authorized.
- **Founder gate:** NONE — Rev113 explicitly authorizes proceeding without waiting for Founder "devam/continue".
- **BASE_PROVENANCE_SHA:** `c00fc23d5e5d20ddd3d6a41e35af19eeae6562cd` (CXP-ACT-001's Rev112-accepted head, itself stacked on ADM-PROJ-001's Rev110 PASS/VERIFIED head `9ae3063d81169d668f770dd7350907dc9360f464`). Independently re-verified via `git fetch` + `git rev-parse` against `origin/claude/cxp-act-001-activation-required-action-projection` immediately before branching — both returned the same SHA, confirming no drift from Rev113's stated dependency.
- **Branch:** `claude/dec175-reference-cold-start-convergence`, created from the exact base SHA above (not from `main`).
- **Dependency lineage:** ADM-PROJ-001 (PR #101, Rev110 PASS/VERIFIED) → CXP-ACT-001 (PR #102, Rev111 PASS/VERIFIED, Rev112 administrative head-advance accepted) → DEC175-CONV-001 (this task).
- **PR:** #103 (`https://github.com/Jay-prodesign/akil-main/pull/103`), OPEN/DRAFT/HOLD_MERGE, base `claude/cxp-act-001-activation-required-action-projection`.
- **BEHAVIORAL_HEAD (test/source content, unchanged since Rev114):** `86ee91a2809052984a140159bf93539570aa527a` — the implementation commit Rev114 reviewed. The convergence test file remains byte-for-byte identical to this commit through every subsequent evidence-only correction.
- **PRE_CORRECTION_REVIEW_HEAD (reviewed by Rev115):** `3118ea0f958cefbbdf89730eeacc1056a303fad4` — the Rev114 F1/F2 evidence correction (boundary/dependency scan added; doc updated), independently re-verified via `git rev-parse HEAD` against `origin/claude/dec175-reference-cold-start-convergence` immediately before this further correction. Rev115 confirmed F1 satisfied here; F2 was not fully resolved (this SHA itself was never named directly in the doc, and the doc still pointed to the PR body for it).
- **POST_PUSH_HEAD_RETURNED_TO_BRAIN:** stated in this task's own status-update message once this doc-only truth-sync commit is pushed — a commit cannot embed its own future SHA, so this field is deliberately left for the out-of-band handoff rather than claimed here (Rev115's own instruction).

## Goal

Prove, with a real end-to-end composition over the actual WEBSITE_BUILD_v1 reference fixtures (no mocks, no hand-built stand-ins for `ProjectActivationProfile`/`ClientProjectSnapshot`/rendered shell HTML), that the full cold-start chain —

`compileProjectActivationProfile` → `buildClientProjectSnapshot` → `renderShellPage`

— converges correctly and customer-safely across the acceptance matrix Rev113 specified (C1–C8), using the exact same domain modules ADM-PROJ-001 and CXP-ACT-001 already implemented and Brain already verified. This task adds no new domain behavior; it is a composed-integration witness over already-verified pieces.

## Scope

In scope: a single new test file exercising the real composed chain against real fixtures, and this exec-plan doc recording the evidence. Out of scope: any change to `src/**`, fixtures, `src/web/shell-render.ts`, config, workflow, package, persistence, IAM, provider, commerce, or AI Commerce files.

## Bounded write surface (exactly two files)

1. `tests/dec175-reference-cold-start-convergence.test.ts`
2. `docs/exec-plans/active/DEC175-CONV-001.md`

No `src/**` file was touched. `git diff --stat` against the base SHA shows zero modified/deleted files; `git status --porcelain` shows exactly one untracked file (`tests/dec175-reference-cold-start-convergence.test.ts`) prior to this doc's own creation — both files listed above are the only additions. The proof was completed without needing any source change, so the STOP/ESCALATE branch of Rev113's instruction was never triggered.

## Architecture invariants preserved

- No new domain module, type, or business rule was introduced. `compileProjectActivationProfile` (ADM-PROJ-001), `buildClientProjectSnapshot` (CXP-ACT-001), and `renderShellPage` (pre-existing) are called exactly as their own contracts specify, with real fixture data (`buildWebsiteBuildV1Fixture`, `WEBSITE_BUILD_V1_OWNERSHIP`, `WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT`/`_BINDING`, `WEBSITE_BUILD_V1_RECIPE`) and real helper composition (`compilePlan`, `createApprovalReference`, `createAcceptedCommercialReference`, `buildFullReadinessAssertions`).
- Customer-safe boundary discipline (established across ADM-PROJ-001/CXP-ACT-001) is independently re-witnessed here at the fully-composed level: C5 scans both `JSON.stringify(snapshot)` and the rendered HTML string for every internal provenance term reachable from this chain, including the real literal connection-binding identifiers baked into the WEBSITE_BUILD_v1 fixture (`reference-storefront-provider`, `reference-storefront-workspace`, `reference-storefront-instance-1`), not just field-name placeholders.
- Determinism (C6) is proved over the entire chain, not just one module: two independent runs of the identical happy-path composition produce `deepEqual` `ProjectActivationCompilation` results, `deepEqual` snapshots, and byte-identical rendered HTML strings.

## Hard non-scope

- No merge of any PR (#100, #101, #102, or this task's PR) is authorized by this task or by any prior PASS/VERIFIED verdict.
- No change to `main`.
- No new `NextActionOwner` literal, no new `ShellPageContent` variant, no new fixture, no change to `shell-render.ts`'s rendering logic.
- No touch to PR #63 (`claude/authority-migration-001`), which remains held per standing Founder instruction.

## Acceptance matrix (C1–C8) — evidence mapping

| # | Acceptance criterion | Evidence |
|---|---|---|
| C1 | Happy cold-start composes end-to-end to a READY, customer-safe rendered shell | Test `C1` — real fixture chain reaches `state: "READY"`, `nextRequiredActor: "NONE"`, at least one wired `OutcomeJob` in `DRAFT`, snapshot `nextAction.owner === "NO_ACTION_NEEDED"`, `workingArtifact.isCurrentVersionApproved === true`, rendered HTML status 200 containing "NO ACTION NEEDED". |
| C2 | Missing required VERIFIED connection binding fails closed to a customer-safe CLIENT_ACTION_REQUIRED with zero jobs | Test `C2` — omits `WEBSITE_BUILD_V1_CONNECTION_BINDING`; profile resolves ACTION_REQUIRED/CUSTOMER, zero `result.jobs`, snapshot `CLIENT_ACTION_REQUIRED`, rendered HTML shows "YOUR ACTION" without leaking the internal `CONNECTION_NOT_VERIFIED` code or any connection-binding identifier. |
| C3 | Missing readiness/approval evidence fails closed to AKILTA_ACTION_REQUIRED with zero jobs | Test `C3` — omits `readinessAssertions` and `approval`; profile resolves ACTION_REQUIRED/HUMAN_REVIEW/`PLAN_ADMISSION_BLOCKED`, zero jobs, snapshot `AKILTA_ACTION_REQUIRED`, rendered HTML shows "AKILTA WORKING". |
| C4a | Structural cross-tenant contamination is rejected by the compiler itself, before any profile/snapshot/shell is produced | Test `C4` (first) — fixture project paired with a customer from a different tenant throws `InvalidProjectActivationProfileError` out of `compileProjectActivationProfile`. |
| C4b | A legitimate READY profile cannot be silently reattached to a foreign project's snapshot | Test `C4` (second) — the happy-path READY profile, attached via `buildClientProjectSnapshot` to a snapshot for a different project's ownership (with `jobs: []` to isolate the activation-profile/ownership boundary from the already-separately-proven jobs/project boundary `computeDeliveryStatus` enforces earlier in the same function), throws `InvalidClientProjectSnapshotError`. |
| C5 | Neither the serialized snapshot nor the rendered HTML ever exposes internal activation/connection/provider provenance | Test `C5` — forbidden-term scan (`nextRequiredAction`, `unresolvedGates`, `platformDecision`, `verifiedConnections`, `consumedRoutes`, `connectionBindingId`, `secretRef`, `sourceFingerprint`, `acceptedCommercialReference`, `effectiveConfigRefs`, `effectivePolicyRefs`, and the real literal `reference-storefront-provider`/`-workspace`/`-instance-1` fixture identifiers) across `JSON.stringify(snapshot)` and `rendered.html` — none present. |
| C6 | Determinism: identical inputs produce identical outputs across the whole chain | Test `C6` — two independent happy-path runs produce `deepEqual` `ProjectActivationCompilation`, `deepEqual` snapshots, and byte-identical rendered HTML strings. |
| C7 | Zero regressions; ADM-PROJ-001/CXP-ACT-001 behavior unchanged | Full regression run below: 765/765 passing, including all pre-existing ADM-PROJ-001 (`project-activation-profile.test.ts`) and CXP-ACT-001 (`client-project-snapshot.test.ts`) suites, unmodified and still green. |
| C8 | Bounded write surface honored; no source-file change required; boundary/dependency scan passes | `git diff --stat` / `git status --porcelain` evidence above — exactly the two files this doc names were added, nothing else — **plus** the dedicated boundary/dependency scan in "Validation performed" below (Rev114 F1 correction: diff/status alone is not a scan). |

## Validation performed

```
cd /home/user/akil-main
npx tsc --noEmit                     # clean, no errors
rm -rf dist && npm run build         # clean rebuild, no errors
node --test dist/tests/dec175-reference-cold-start-convergence.test.js
  # 7/7 passing (C1, C2, C3, C4 x2, C5, C6)
node --test dist/tests/*.test.js
  # 765/765 passing — zero regressions across the full suite
git status --short / git diff --stat
  # only tests/dec175-reference-cold-start-convergence.test.ts and this doc
  # were ever added — no src/** or fixture change
```

One test-design defect was found and corrected during validation (not a product-code defect): the first draft of the C4b test passed `jobs: result.jobs` (jobs belonging to the real fixture project) alongside a `project` argument for a foreign project, which caused `computeDeliveryStatus`'s own jobs/project boundary check to throw `InvalidDeliveryStatusError` before the activation-profile/ownership check under test was ever reached. Corrected to `jobs: []` so the test isolates and actually witnesses the intended boundary (`InvalidClientProjectSnapshotError` from the activationProfile/ownership check in `buildClientProjectSnapshot`). Re-run after the fix: 7/7 passing.

### Boundary/dependency scan (Rev114 F1 correction)

`git diff --stat`/`git status --porcelain` alone prove the two-file write boundary but are not a boundary/dependency scan. Run separately against this exact branch/head:

```
git diff c00fc23d5e5d20ddd3d6a41e35af19eeae6562cd..HEAD -- package.json package-lock.json
  # empty — zero new/changed runtime or dev dependency

grep -inE "password|api[_-]?key|secret[_-]?value|private[_-]?key|bearer\s+[a-z0-9]|-----BEGIN" \
  tests/dec175-reference-cold-start-convergence.test.ts
  # no match — no secret/credential material in the new test

grep -inE "ai[_-]?commerce|shopify|stripe|openai|anthropic\.com|@anthropic-ai|aws-sdk|google-cloud" \
  tests/dec175-reference-cold-start-convergence.test.ts
  # no match — no AI Commerce/provider-SDK coupling

grep -inE "\bfetch\(|node:child_process|node:http\b|node:fs\b|Date\.now\(\)|Math\.random\(\)" \
  tests/dec175-reference-cold-start-convergence.test.ts
  # no match — no network/filesystem/process/wall-clock/randomness call
  # (consistent with the C6 determinism proof)

grep -n "^import" tests/dec175-reference-cold-start-convergence.test.ts
  # every import resolves to an existing repository module under
  # src/domain/, src/web/, src/fixtures/, or tests/helpers/ — no new
  # external package, no cross-project (AI Commerce) import
```

All five scans pass with zero findings, independently confirming the same source-boundary conclusion the diff/status evidence already showed, from a dependency/coupling angle rather than a file-list angle.

## Status

Brain Rev114 (`BRAIN REV114 — DEC175-CONV-001 EXACT-HEAD REVIEW — CHANGES_REQUIRED`) reviewed `BEHAVIORAL_HEAD` `86ee91a2809052984a140159bf93539570aa527a`: the composed integration implementation itself materially satisfies Rev113 C1-C7 on the diff (no source-code correction admitted), but returned CHANGES_REQUIRED, evidence/handoff only, on two findings (F1: missing boundary/dependency scan; F2: stale doc/HEAD_SHA/next-action). F1 was resolved by the dedicated scan section above; F2 was addressed but not fully — Brain's independent review of that correction follows.

Brain Rev115 (`BRAIN REV115 — DEC175-CONV-001 EXACT-HEAD REVIEW — CHANGES_REQUIRED`) reviewed `PRE_CORRECTION_REVIEW_HEAD` `3118ea0f958cefbbdf89730eeacc1056a303fad4`:

- **Rev114 F1: SATISFIED.** The five-part boundary/dependency scan is confirmed distinct from diff/status write-boundary evidence, zero findings. No new source/behavioral defect admitted.
- **Rev114 F2: NOT FULLY RESOLVED (resolved by this correction).** The doc recorded only `BEHAVIORAL_HEAD` and deferred the full new HEAD_SHA to the PR body instead of naming `3118ea0f958cefbbdf89730eeacc1056a303fad4` directly, and NEXT EXACT ACTION still said "push ... and return the exact new head" even though that push had already happened. Resolved by this doc-only truth-sync: the Provenance section now names `PRE_CORRECTION_REVIEW_HEAD` explicitly and separates it from the not-yet-known `POST_PUSH_HEAD_RETURNED_TO_BRAIN` (per Rev115's own instruction that a commit cannot embed its own future SHA), and NEXT EXACT ACTION below reflects the truthful current state.

This correction is doc-only — no test/source change, no rerun required, no new branch/task. `git status`/`git diff --stat` at this exact head show only this file modified.

Brain Rev116 (`BRAIN REV116 — DEC175-CONV-001 EXACT-HEAD REVIEW — PASS/VERIFIED / TASK-LOCAL CLOSED`) reviewed `POST_PUSH_HEAD_RETURNED_TO_BRAIN` `649b0aac5e4f10388f6f56f5a514b846b9a526dc`: confirmed as one signed doc-only child of `3118ea0`, modifying only this file (+11/-7), explicitly recording `BEHAVIORAL_HEAD`/`PRE_CORRECTION_REVIEW_HEAD`/live PR state and the Rev115-authorized out-of-band handoff pattern rather than an invented self-hash. Rev113 C1-C7 composition evidence remains accepted on `BEHAVIORAL_HEAD` `86ee91a`; Rev114 F1's five-part boundary/dependency scan evidence remains satisfied at `3118ea0`.

**VERDICT: PASS/VERIFIED / TASK-LOCAL CLOSED at exact head `649b0aac5e4f10388f6f56f5a514b846b9a526dc`.** Scope/claim boundary (Rev116, explicit): this proves only the bounded non-production DEC-175 reference convergence chain — it does not authorize or imply integrated production readiness, MAIN merge, release promotion, deploy/publication, real provider/customer effect, credentials/secrets, payment/legal/spend, or AI Commerce mutation. PR #103 remains OPEN/DRAFT/HOLD_MERGE; task-local closure does not imply SAFE_MERGE or merge authorization.

## Next exact action

None for DEC175-CONV-001 — task is closed per Rev116. Do not make further edits to this branch/PR. Maintain the standing self-paced canonical watch; resume only when a later canonical decision admits a new bounded dependency-safe source edge via a deterministic task packet.
