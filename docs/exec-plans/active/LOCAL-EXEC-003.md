# LOCAL-EXEC-003 — Codex Local Adapter (Phase L2, Rev98/Rev101 Local Execution family)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor, Rev99/100's Founder-approved Local Execution / Device Worker capability, and Handoff Rev101's own explicit continuation: *"LOCAL-EXEC-002 Device Bridge MVP and LOCAL-EXEC-003 Codex Local Adapter are explicitly dependency-safe dark/internal candidates and must not wait for Founder PC login."* Rev101's own L2 scope line: *"fresh dependency-fit ADR against current official OpenAI Codex CLI/SDK/app-server behavior, local ChatGPT-authenticated readiness without uploading subscription credentials, start/resume/working-directory/sandbox/approval/network policy, structured events, cancellation, usage-limit mapping, checkpoint/evidence return; tests use mocks and require no Founder credentials."*
- This is explicitly genuine, time-sensitive external research, not something this session may fabricate from memory. `docs/architecture/ADR/0002-local-exec-003-codex-adapter-fit.md` records that research (web search of `developers.openai.com/codex` and related public documentation, dated 2026-09-11) before any implementation began.
- Branch: `claude/local-exec-003-codex-adapter`, cut from `claude/local-exec-002-device-bridge-mvp` (PR #44) at its exact head `c28349226c72f61e7990a716c1fa93afe099ff74` — a direct dependent of L1's own `local-execution-bridge.ts` protocol, matching the same stacking precedent as `LOCAL-EXEC-002` on `LOCAL-EXEC-001` and `DEP-ORCH-001` on `RUNTIME-001`.
- No-duplication check: `LOCAL-EXEC-001` already defines the generic `LocalWorkerAdapter` port; `LOCAL-EXEC-002` already defines the generic bridge control-channel protocol and `BridgeProtocolMessageKind`. Rev99/100's own instruction ("no second worker router/IAM/workflow engine") means this checkpoint's job is to translate real, sourced Codex CLI/App Server concepts onto those two existing surfaces, never to invent a third protocol or adapter system.

## Scope (this checkpoint)

`src/domain/codex-local-adapter.ts` — composing `local-execution.ts`'s `DevicePolicy`/`isWorkspaceRootAllowed`/`LocalTaskLease`/`LocalTaskCheckpoint`/`createLocalTaskCheckpoint`/`LocalWorkerAdapterOutcome`/`LocalWorkerAdapterResult` and `local-execution-bridge.ts`'s `BridgeProtocolMessageKind`/`isRecognizedBridgeMessageKind`, all unmodified:

- **Sandbox/approval/network policy**: `CodexSandboxMode` (`READ_ONLY`/`WORKSPACE_WRITE`/`DANGER_FULL_ACCESS`) and `CodexApprovalPolicy` (`UNTRUSTED`/`ON_REQUEST`/`NEVER`) are direct 1:1 projections of Codex's own three real, independent dimensions (ADR-0002). `CodexNetworkPolicy` (`DISABLED`/`ENABLED`) fails closed to the real CLI's own default-off posture — no function can produce `ENABLED` implicitly.
- **Local ChatGPT-authenticated readiness without uploading subscription credentials**: `CodexAuthReadinessStatus` (`READY_CHATGPT_SESSION`/`READY_API_KEY`/`NOT_AUTHENTICATED`) is a locally-reported status only; `resolveCodexRunReadiness` fails closed unless it is one of the two `READY_*` values. No field anywhere in this module can carry a token, session marker, or the contents of the device's own local authentication-state file.
- **Start/resume/working-directory**: `CodexRunMode` (`START`/`RESUME`) + `createCodexRunRequest` — a `RESUME` without a `priorSessionRef`, or a `START` carrying one, both fail closed (mirrors the real CLI's own `codex exec resume <id>` semantics: a resume must reference something real, a fresh start must never silently inherit a stale one). `workingDirectoryRef` is validated via the existing, unmodified `isWorkspaceRootAllowed` — no second workspace-authorization check is added.
- **Structured events / cancellation**: `CodexRunEventKind` — a closed, honestly-scoped repository-native projection of Codex's documented structural event categories (task lifecycle, agent output, approval request/response, usage reporting), explicitly not a claim of the literal undisclosed App Server JSON-RPC method names. `mapCodexRunEventKindToBridgeMessageKind` deterministically projects each onto an existing `BridgeProtocolMessageKind` (never a new one), asserted via the bridge module's own `isRecognizedBridgeMessageKind`. `TASK_CANCELLED` maps onto the bridge's existing `CANCEL` kind — no separate cancellation protocol.
- **Usage-limit mapping**: `CodexUsageLimitWindowKind` (`FIVE_HOUR`/`WEEKLY`, the real two windows Codex tracks) + `resolveCodexUsageLimitDisposition`, fail-closed on a malformed remaining-fraction.
- **Checkpoint/evidence return**: `resolveCodexRunOutcome` binds a terminal `CodexRunEventKind` to the existing, unmodified `LocalWorkerAdapterResult` shape. `createCodexCheckpointRecord` delegates the checkpoint itself entirely to the existing `createLocalTaskCheckpoint`, adding only the one Codex-specific `codexSessionRef` field needed to make a checkpoint resumable later via `CodexRunRequest`'s own `priorSessionRef` — never by redefining `LocalTaskCheckpoint`.
- `tests/codex-local-adapter.test.ts` (27 tests: C1-C27) and `tests/local-exec-003-boundary-scan.test.ts` (6 tests).

## Explicitly deferred (not fabricated)

- **No real Codex CLI process, JSON-RPC client, or filesystem/`~/.codex` access anywhere.** Every function accepts caller-supplied inputs only; tests use mocks and require no Founder machine, Codex installation, or credential.
- **No literal claim of the undisclosed App Server wire protocol.** `CodexRunEventKind`'s naming is this repository's own honest structural projection (see ADR-0002's "Alternatives considered"); if the real protocol's exact method names are later confirmed via direct SDK integration, only the mapping table and enum spellings need correction.
- **No wiring into a real device bridge transport, `BridgeControlChannel` implementation, or `LocalWorkerAdapter` concrete implementation.** This checkpoint is the Codex-specific validation/mapping layer only; an actual adapter class implementing `LocalWorkerAdapter.execute()` by invoking a real Codex process is a separate, later, explicitly-gated activation step (Rev99/100: "physical-PC installation/native provider login ... only when live activation actually reaches them").
- **No expiry/rotation model for `CodexAuthReadinessStatus`.** A caller reports current readiness each time; this module does not cache, store, or infer readiness across calls.

## Architecture / semantic invariants (verified by test)

- Auth readiness: `READY` for both authenticated statuses (C1-C2), `NOT_READY` for unauthenticated (C3), rejects an unrecognized status (C4), and structurally cannot accept a credential-shaped value as a status (C5).
- Run request: valid `START` (C6) and `RESUME` (C7); rejects `RESUME` without `priorSessionRef` (C8) and `START` with one (C9); rejects a disallowed working directory via the existing gate (C10); rejects unrecognized `sandboxMode`/`approvalPolicy`/`networkPolicy` (C11-C13).
- Usage limits: `AVAILABLE` for a positive fraction (C14), `EXHAUSTED` at exactly zero (C15); rejects a negative (C16) or >1 (C17) fraction.
- Event mapping: every `CodexRunEventKind` projects onto an existing, recognized `BridgeProtocolMessageKind` (C18).
- Run outcome: binds all three terminal events to the correct `LocalWorkerAdapterOutcome` (C19-C21); rejects a non-terminal event (C22) and empty evidence (C23); carries an optional `checkpointRef` through (C24).
- Checkpoint record: delegates correctly and adds `codexSessionRef` (C25); fails closed on a non-`RUNNING`/`CHECKPOINTED` lease via the existing unmodified gate (C26); rejects an empty `codexSessionRef` (C27).

## Hard Non-Scope

No modification to `local-execution.ts` or `local-execution-bridge.ts` (both read-only dependencies here); no real network/process/filesystem call anywhere; no new bridge message kind; no new adapter result shape; no admin/UI wiring; no new runtime dependency.

## Evidence

- `npx tsc --noEmit -p .`: exit 0, strict mode.
- `npm run test`: **835/835 pass** (802 pre-existing on the LOCAL-EXEC-002 base + 33 new: 27 in `tests/codex-local-adapter.test.ts`, 6 in `tests/local-exec-003-boundary-scan.test.ts`).
- `package.json`: zero new runtime dependency; `clean` script already present (carried forward from the LOCAL-EXEC-002 base).
- Sourced research: `docs/architecture/ADR/0002-local-exec-003-codex-adapter-fit.md`, with citations to `developers.openai.com/codex/app-server`, `developers.openai.com/codex/agent-approvals-security`, `developers.openai.com/codex/cli/reference`, `openai.com/index/unlocking-the-codex-harness`, and `help.openai.com` (Codex/ChatGPT plan usage).
- Files touched: `src/domain/codex-local-adapter.ts` (new), `tests/codex-local-adapter.test.ts` (new), `tests/local-exec-003-boundary-scan.test.ts` (new), `docs/architecture/ADR/0002-local-exec-003-codex-adapter-fit.md` (new), `docs/architecture/ADR/README.md` (index entry), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending fresh Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — this branch's base is LOCAL-EXEC-002's own branch (PR #44), not `main`; its own eventual PR is stacked on PR #44. Deferred to the one consolidated end-of-batch Brain review packet alongside PR #32 (`SVC-ADM-001`), #38, #39, RUNTIME-001, V5-PTN-002 (Handoff-Rev101-corrected), V4-EFF-001 (Handoff-Rev101-corrected), LOCAL-EXEC-001 (Handoff-Rev101-corrected), LOCAL-EXEC-002, OBS-TEL-001, AUT-OPS-001, and DEP-ORCH-001, per Current Project State Rev90/95/97/98/99/100's continuous-execution batch-mode authorization, reaffirmed and extended by canonical Handoff Rev101's own "CONTINUOUS EXECUTION / NO PARKING" dispatch and BATCH END CONTRACT.
