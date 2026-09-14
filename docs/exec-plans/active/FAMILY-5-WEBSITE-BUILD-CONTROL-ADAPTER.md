# Family 5 — Website-Build Reference Service-Specific Control Adapter (Rev98/Rev101 gap)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Rev98/Rev101's Family 5: *"V4 reference service-specific control-adapter floor for the Website Build path on top of CONN-001, using mocks/injected transports and no duplicate AI Commerce runtime,"* with acceptance shape "READ→DIAGNOSE→RECOMMEND→DRAFT/PREVIEW→APPROVAL-BOUND APPLY→VERIFIED EFFECT, composing CONN-001 + V4 effect envelope."
- This is exactly the gap `service-capability-routing.ts`'s own doc comments already name: *"V4 §7 Workstream C, 'Service-Specific Control Adapters,' is not started... this module can only ever honestly resolve two rungs: UNAVAILABLE ... and READ_ONLY."* Family 5 is that Workstream C's first real adapter, for one bounded path.
- Had been dispositioned `TRIGGER_NOT_MET` because its two prerequisite branches (`CONN-001`/PR #38 and `V4-EFF-001`/PR #42) were not merged to a common base. The canonical Handoff's own "EXECUTION REMINDER — REV101 / NO PARKING" appendix (added 2026-09-12) explicitly names "a local branch blocker" as not a stop condition — since both prerequisite branches are this session's own draft branches, merging them is a reversible action within existing authority, so this disposition is corrected here.
- Branch `claude/family-5-website-build-control-adapters`: `git merge` of `claude/conn-001-integration-control-plane` (exact head `41b2b16a6e2ed6f63039d3486313e929f31d16c5`, Rev94-corrected) and `claude/v4-eff-001-external-effect-envelope` (exact head `c60210362ef9ce709abe4fcc27e4785542fe77ea`, Rev101-corrected). Both branches shared the same `main` ancestor (`3226c76fa338e425e553638e5f5f48924182a1c0`), so every source/test file merged with zero conflict; only `CURRENT_STATE.md`/`V2_TO_V5.md` conflicted, resolved by keeping both branches' independently-true additive narratives in sequence (no content dropped, no claim removed).

## Scope (this checkpoint)

`src/domain/website-build-control-adapter.ts` — composing, never redefining: `service-capability-routing.ts`'s `ExecutionMaturity` (type-only), `connector-execution.ts`'s `executeConnectorCapability`/`ConnectorExecutionResult`/`ConnectorExecutionTransportError`, and `external-effect-envelope.ts`'s `createExternalEffectIntent`/`startExternalEffectAttempt`/`reportExternalEffectOutcome`/`ExternalEffectIntent`/`ExternalEffectAttempt`:

- **READ_ONLY**: `readWebsiteBuildSignal` — a thin, unmodified pass-through to `executeConnectorCapability`, tagged with the existing `ExecutionMaturity` literal.
- **DIAGNOSE**: `diagnoseWebsiteBuildSignal` — binds a caller-declared `severity`/`evidenceRef` to the exact prior signal. No real content-analysis/website-inspection intelligence exists anywhere in this repository, so this function never infers a severity itself — same "declared, not yet producible" honesty already established by `service-capability-routing.ts` itself.
- **RECOMMEND**: `recommendWebsiteBuildAction` — binds a caller-declared `actionRef`/`rationale` to the exact prior diagnosis; fails closed against recommending any action for a `HEALTHY` diagnosis.
- **DRAFT_PREVIEW**: `draftWebsiteBuildEffectIntent` — composes `createExternalEffectIntent` with `requiresApproval` hard-coded `true` (not a caller-settable field) — every effect this adapter can produce is a real customer-facing website mutation.
- **APPROVAL_REQUIRED**: `startWebsiteBuildEffectAttempt` — a thin, unmodified pass-through to `startExternalEffectAttempt`; since the draft always requires approval, a granted authority + evidence are always mandatory here.
- **CONTROLLED_APPLY**: `controlledApplyWebsiteBuildEffect` — the only function that calls the injected connector transport for a write; composes `executeConnectorCapability` + `reportExternalEffectOutcome`, mapping a successful execution to `APPLIED`, a `ConnectorExecutionTransportError` (ambiguous — the write may or may not have taken effect) to `UNKNOWN`, and every other connector error (definitively did not execute) to `FAILED`.
- **VERIFIED EFFECT**: not a wrapped function — `ExecutionMaturity` has no eleventh literal for it, so this checkpoint does not invent one. The final step is exactly `external-effect-envelope.ts`'s own `verifyExternalEffectReadback`, called directly by the caller against `controlledApplyWebsiteBuildEffect`'s output; a passthrough wrapper with no added logic would be pointless indirection.
- `tests/website-build-control-adapter.test.ts` (14 tests: W1-W14, including a full end-to-end chain proof reaching `VERIFIED`) and `tests/family-5-boundary-scan.test.ts` (6 tests).

## Explicitly deferred (not fabricated)

- **No real content-inspection, crawling, or website-analysis capability.** `diagnoseWebsiteBuildSignal`/`recommendWebsiteBuildAction` never infer their own severity/action — a caller (a future real diagnostic engine, or a human) must supply them, evidenced.
- **No new `ExecutionMaturity` literal, `ConnectorTransport` implementation, or effect-envelope state.** Every type this module returns is either an existing type reused verbatim or a small wrapper carrying an existing `ExecutionMaturity` tag.
- **No real HTTP/DNS/network call anywhere** — every write and read goes through the caller-injected `ConnectorTransport`, exactly as `connector-execution.ts` itself requires.
- **No wiring into a real Website Build recipe/job/worker.** This is the control-adapter layer only; binding it into `delivery-recipe.ts`'s actual step execution is separate, later, still-unbuilt work.

## Architecture / semantic invariants (verified by test)

- READ: tagged `READ_ONLY`, returns the connector's result (W1); fails closed exactly like the underlying connector call (W2).
- DIAGNOSE: binds to the exact prior signal (W3); rejects an unrecognized severity (W4) and an empty evidenceRef (W5).
- RECOMMEND: binds to the exact prior diagnosis (W6); refuses to recommend against a `HEALTHY` diagnosis (W7).
- DRAFT_PREVIEW: `requiresApproval` is always `true`, never caller-settable (W8).
- APPROVAL_REQUIRED: requires and records approval evidence (W9); fails closed on an unauthorized authority via the unmodified `startExternalEffectAttempt` (W10).
- CONTROLLED_APPLY: success → `APPLIED` (W11); connector authorization failure → `FAILED` (W12); transport-level ambiguity → `UNKNOWN`, never a guessed `FAILED` (W13).
- Full chain: READ→DIAGNOSE→RECOMMEND→DRAFT_PREVIEW→APPROVAL_REQUIRED→CONTROLLED_APPLY→`verifyExternalEffectReadback` reaches `VERIFIED` (W14).

## Hard Non-Scope

No modification to `connector-execution.ts`, `external-effect-envelope.ts`, or `service-capability-routing.ts` (all read-only dependencies); no real network/DNS/provider SDK call anywhere; no new `ExecutionMaturity` literal; no admin/UI wiring; no new runtime dependency.

## Evidence

- `npx tsc --noEmit -p .`: exit 0, strict mode.
- `npm run test`: **845/845 pass** (825 pre-existing on the merged CONN-001+V4-EFF-001 base + 20 new: 14 in `tests/website-build-control-adapter.test.ts`, 6 in `tests/family-5-boundary-scan.test.ts`).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/website-build-control-adapter.ts` (new), `tests/website-build-control-adapter.test.ts` (new), `tests/family-5-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending fresh Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — this branch is a merge of PR #38's and PR #42's own branches, not a normal single-parent task branch; its own eventual PR should be reviewed alongside both source PRs. Deferred to the one consolidated end-of-batch Brain review packet alongside PR #32 (SVC-ADM-001), #38, #39, RUNTIME-001, V5-PTN-002 (Handoff-Rev101-corrected), V4-EFF-001 (Handoff-Rev101-corrected), LOCAL-EXEC-001 (Handoff-Rev101-corrected), LOCAL-EXEC-002, LOCAL-EXEC-003, OBS-TEL-001, AUT-OPS-001, and DEP-ORCH-001.
