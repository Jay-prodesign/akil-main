# LOCAL-EXEC-006 — Phase L5: Claude Local Adapter

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. §21's Implementation Program names `LOCAL-EXEC-006 / Phase L5` as explicitly "provider-policy gated": *"current-provider-policy recheck at implementation time... If current Anthropic rules/support change materially, mark the adapter POLICY_BLOCKED and leave the rest of Local Execution functional."* Canonical Handoff Rev103's "NEXT GRAPH" text is explicit this recheck must be genuinely current, not fabricated from training-time assumptions.
- A dedicated policy-research pass was run today (2026-09-12) and its findings, plus this checkpoint's own decision, are recorded in `docs/architecture/ADR/0003-local-exec-006-claude-adapter-fit.md` — mirroring exactly the discipline `docs/architecture/ADR/0002-local-exec-003-codex-adapter-fit.md` established for Codex before LOCAL-EXEC-003. **Disposition: `POLICY_SAFE`** for local, single-machine, officially-authenticated `claude -p` CLI automation — not evaluated, and not implied safe, for any future distributed/shared-backend use.
- Branch `claude/local-exec-006-claude-adapter`, cut from `claude/local-exec-005-collaboration-handoff`'s own head (the most complete existing LOCAL-EXEC chain, itself already carrying the Rev106-corrected LOCAL-EXEC-004) rather than a separate `main`-cut branch, since this checkpoint directly composes L0's `local-execution.ts` and L1's `local-execution-bridge.ts` contracts. 940/940 tests pass on that base before this checkpoint's own new code.

## Scope (this checkpoint)

`src/domain/claude-local-adapter.ts`, mirroring LOCAL-EXEC-003's own `codex-local-adapter.ts` shape exactly, composing L0's `DevicePolicy`/`isWorkspaceRootAllowed`/`LocalTaskLease`/`LocalTaskCheckpoint`/`createLocalTaskCheckpoint`/`LocalWorkerAdapterOutcome`/`LocalWorkerAdapterResult`/`DeviceCapabilityReadiness` and L1's `BridgeProtocolMessageKind`/`isRecognizedBridgeMessageKind` unmodified:

- `resolveClaudeAdapterPolicyCheck`/`ClaudeAdapterPolicyCheck` — the packet's own "represent policy compatibility as a capability admission gate" requirement as a real, structural, re-checkable value (not just ADR prose).
- `ClaudePermissionMode` — the CLI's own six real permission-mode values, corroborated against this environment's own live session-creation parameter schema.
- `ClaudeAuthReadinessStatus`/`resolveClaudeRunReadiness` — a locally-reported readiness status only; fails closed whenever the policy check is `POLICY_BLOCKED`, checked strictly *before* auth readiness (a blocked policy short-circuits before a malformed auth value is even inspected).
- `ClaudeRunMode`/`ClaudeRunRequest`/`createClaudeRunRequest` — START/RESUME session semantics, workspace-root validation via the existing unmodified gate, explicit `allowedToolRefs` (never an implicit all-tools default).
- `ClaudeUsageLimitWindowKind`/`resolveClaudeUsageLimitDisposition` — the same dual-window (5-hour + weekly) shape Codex uses, independently real for Claude Pro/Max plans.
- `ClaudeRunEventKind`/`mapClaudeRunEventKindToBridgeMessageKind` — a closed, honestly-scoped repository-native projection onto the existing bridge protocol, never a new bridge message kind.
- `resolveClaudeRunOutcome`/`createClaudeCheckpointRecord` — bind terminal events/checkpoints to the existing, unmodified result/checkpoint shapes.
- `resolveClaudeAdapterCapabilityReadiness` — composes the policy check, auth readiness, and usage-limit disposition into L0's own existing `DeviceCapabilityReadiness` value set (which already reserved `POLICY_BLOCKED` for exactly this situation).
- `tests/claude-local-adapter.test.ts` (34 tests: P1-P2, C1-C32) and `tests/local-exec-006-boundary-scan.test.ts` (9 tests).

## Explicitly deferred (not fabricated)

- **No real Claude Code CLI process, Agent SDK client, or local session-file access anywhere** — every test uses caller-supplied mock inputs; no Founder machine, no CLI installation, no credentials required.
- **No modification to `local-execution.ts`, `local-execution-bridge.ts`, or `codex-local-adapter.ts`.** All three are read-only dependencies/precedent; Claude's own types are deliberately not shared with Codex's (different real dimensions — permission modes vs. sandbox+approval).
- **No device/staff/worker-identity binding (LOCAL-EXEC-004's own scope) and no collaboration/handoff wiring (LOCAL-EXEC-005's own scope).** This checkpoint is the adapter port implementation only.
- **No activation of the policy-safe finding into a live installation/login step.** Per the packet's own "just-in-time real-user step later" discipline (§24), installing/using the real CLI remains a separate, later, explicitly-gated step.

## Architecture / semantic invariants (verified by test)

- `resolveClaudeAdapterPolicyCheck` builds a valid check and rejects an unrecognized disposition (P1-P2).
- `resolveClaudeRunReadiness` is READY for both real auth statuses under a POLICY_SAFE check (C1-C2), NOT_READY when unauthenticated (C3), fails closed on an unrecognized/credential-shaped auth value (C4-C5), and — critically — is NOT_READY whenever the policy check is POLICY_BLOCKED regardless of auth state, checked strictly before auth is even validated (C6, C6b).
- `createClaudeRunRequest` enforces START/RESUME session-ref requirements (C7-C10), the existing workspace allowlist gate (C11), a closed `permissionMode` enum (C12), and an explicit, always-array `allowedToolRefs` (C13-C14).
- `resolveClaudeUsageLimitDisposition` fails closed on a malformed fraction (C15-C18).
- Every `ClaudeRunEventKind` maps onto an existing, recognized `BridgeProtocolMessageKind` (C19).
- `resolveClaudeRunOutcome` binds terminal events correctly and fails closed on a non-terminal kind or empty evidence (C20-C25).
- `createClaudeCheckpointRecord` delegates entirely to the unmodified `createLocalTaskCheckpoint`, including its own fail-closed gate on a non-`RUNNING`/`CHECKPOINTED` lease (C26-C27).
- `resolveClaudeAdapterCapabilityReadiness` produces `AVAILABLE`/`POLICY_BLOCKED`/`AUTH_REQUIRED`/`USAGE_LIMITED` in the same fail-closed order (policy → auth → usage), and a `POLICY_BLOCKED` disposition short-circuits before a malformed auth value is even inspected (C28-C32).
- Boundary scan confirms structurally: no credential/token/cookie-shaped field or session-file path reference anywhere in this module; imports only from `local-execution.js`/`local-execution-bridge.js`; no `fetch`/`child_process`/`node:` coupling; no redefinition of `LocalTaskCheckpoint`/`LocalWorkerAdapterResult`/`BridgeProtocolMessageKind`/`DeviceCapabilityReadiness`; both readiness functions check policy strictly before auth in their own source text.

## Hard Non-Scope

No modification to `local-execution.ts`, `local-execution-bridge.ts`, `codex-local-adapter.ts`, `local-execution-collaboration.ts`, `external-effect-envelope.ts`, or any `src/web/staff-*`/local-execution-staff-binding.ts file (all read-only dependencies); no real network/CLI/subprocess call anywhere; no persistence; no HTTP route wiring; no new runtime dependency; no `AuthorityContext` composition; no live CLI installation or login.

## Evidence

- `npx tsc --noEmit -p .` / `npm run build`: exit 0, strict mode.
- `npm run test`: **983/983 pass** (940 pre-existing on the LOCAL-EXEC-005 base + 43 new: 34 functional + 9 boundary-scan).
- Sanity-checked: temporarily reordered `resolveClaudeRunReadiness` and `resolveClaudeAdapterCapabilityReadiness` to validate `authReadiness` before consulting the policy check, and confirmed exactly the 3 tests proving this dimension (C6b, C29b, and the boundary-scan ordering test) then failed; restored the fix and reconfirmed 983/983 pass. A second, earlier sanity pass (a false-positive credential-pattern match on the word "cookie" inside a doc comment) was independently caught and fixed by rewording the comment, not by weakening the scan.
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/claude-local-adapter.ts` (new), `docs/architecture/ADR/0003-local-exec-006-claude-adapter-fit.md` (new), `tests/claude-local-adapter.test.ts` (new), `tests/local-exec-006-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Rev109 correction (F1 — permission-mode sourcing; F2 — Consumer Terms citation)

- Brain's Rev109 periodic HIGH-RISK sweep (canonical Handoff, fresh-read 2026-09-12) reviewed PR #57's head `17fc3e8398c23135e8e4a760b826e298b3dc17f5` and returned `CHANGES_REQUIRED / PROVIDER-POLICY-SENSITIVE` on two findings, both independently re-checked before responding.
- **F1**: the ADR sourced the six `ClaudePermissionMode` values from this environment's own live session-creation tool schema rather than the actual official Claude Code CLI documentation, and Brain's own check of official documentation at review time found only four values (`default`/`acceptEdits`/`plan`/`bypassPermissions`) established, flagging `dontAsk`/`auto` as unverified. Rev109's own remedy explicitly allowed either narrowing or confirming via "fresh official Claude Code documentation." Independently re-fetched the current official page ([Choose a permission mode](https://code.claude.com/docs/en/permission-modes), 2026-09-12) directly rather than relying on search-result paraphrases: it names all six config values verbatim in its modes table — `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` — matching this module's set exactly. This satisfies Rev109's own fallback condition, so no value was removed or narrowed; instead the ADR and the module's own doc comment were corrected to cite this direct official source (replacing the prior session-schema sourcing) and to note that `auto`/`dontAsk`/`bypassPermissions` availability is plan/version-gated at real runtime, which this checkpoint does not itself negotiate (no real CLI invocation exists anywhere in this module). No type/behavior change was needed since the original six-value set was, in fact, correct — only its provenance was insufficiently sourced.
- **F2**: the ADR's Consumer Terms claim (that the restriction targets third-party credential reuse, not first-party local CLI automation) was asserted without a citable source. Independently researched and found a real, dated, sourced clarification: Anthropic's compliance page, clarified 2026-02-20 (covered contemporaneously by The Register), states OAuth tokens from Claude subscriptions are "only intended for Claude Code and Claude.ai" and that using them "in any other product, tool, or service — including the Agent SDK — is not permitted," describing this as clarifying pre-existing policy rather than a new restriction. This directly substantiates, with a citation, exactly the narrow distinction the ADR already drew (third-party credential reuse is restricted; running the official CLI itself under a real account is not). The ADR now cites this source explicitly and states only the narrow, sourced conclusion — no broader legal/terms safe-harbor is inferred beyond it.
- No test changes were required (this correction is ADR/doc-comment sourcing only, not a behavior or type change); typecheck remains clean and 997/997 tests pass (995 prior + 2 new carried forward from the merged LOCAL-EXEC-005 Rev109 fix).

## Status

**IMPLEMENTED / SELF-VALIDATED (Rev109-corrected)** — pending independent verification per canonical Handoff Rev105 (self-review alone does not qualify as delegated VERIFY). This checkpoint's own port/type-shape work does not itself touch authentication/authority/tenant isolation, but it composes L0-L2's identity-adjacent worker/device contracts and its eventual production wiring (LOCAL-EXEC-004's staff binding) is auth/IAM-adjacent, so — matching every other LOCAL-EXEC checkpoint this session — it is treated as `SAFE_MERGE`-excluded pending explicit Brain classification rather than assumed safe. `MERGE_DISPOSITION: HOLD_MERGE` — cut from the LOCAL-EXEC-005 chain; its own eventual PR should be reviewed alongside the full LOCAL-EXEC-001→005 chain as part of the one consolidated end-of-batch Brain review packet.
