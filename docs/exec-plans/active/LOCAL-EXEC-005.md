# LOCAL-EXEC-005 — Phase L4: Collaboration & Cross-Worker Handoff

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Canonical Handoff Rev103's "NEXT GRAPH" text names `LOCAL-EXEC-005 / Phase L4` as following once L0's stable workspace/task/checkpoint primitives exist. The dedicated architecture packet (Drive `1vhHCHZYu15IugytGb2O2epe7jgRFQF6vRoZsozjASDU`) §12-15 was fresh-read in full before any design here — never paraphrased from a one-line summary — per this corridor's own established discipline (the same discipline that required a fresh read before LOCAL-EXEC-001 itself).
- Branch `claude/local-exec-005-collaboration-handoff`, created by merging `claude/local-exec-004-staff-binding` (PR #54, the full LOCAL-EXEC-001→004 chain) with `claude/v4-eff-001-external-effect-envelope` (PR #42, Rev101-corrected) — both trace to the same `main` ancestor (`3226c76fa338e425e553638e5f5f48924182a1c0`), clean merge on every source/test file, doc-only conflicts in `CURRENT_STATE.md`/`V2_TO_V5.md` resolved by keeping both branches' independently-true narratives in sequence. The merge exists specifically so this checkpoint's failover gate can reuse `external-effect-envelope.ts`'s real `ExternalEffectAttemptState` unmodified, per §15's own instruction ("Never automatically fail over an external effect when the effect state is UNKNOWN; use the V4 external-effect recovery/readback envelope first"). 907/907 tests pass on the merged base before this checkpoint's own new code.

## Scope (this checkpoint)

`src/domain/local-execution-collaboration.ts` implements exactly §12-15's named contracts, composing L0's unmodified `CollaborationMode`/`LocalTaskLease`/`LocalTaskCheckpoint`/`LocalWorkerRegistration`, `resolveEligibleLocalWorkers`/`toAdmittedWorker`, V5-WRK-001's unmodified `resolveWorkerRoute`, and V4-EFF-001's unmodified `ExternalEffectAttemptState` — no new routing engine, no new IAM primitive:

- `planCollaborationModeTransition` — §14's PRIVATE/ISOLATED_PROJECT/SHARED_ARTIFACT/SHARED_REPO transition gate. A widening transition (e.g. PRIVATE → SHARED_ARTIFACT) always returns an explicit preflight naming exactly which worker/device refs become newly visible. A narrowing transition always carries the honest, verbatim §14 disclosure that data already legitimately downloaded cannot be forced to be forgotten — this module never pretends narrowing is retroactive.
- `createWorkspaceBinding` / `WorkspaceBinding` — the three §14 binding kinds (`LOCAL_FOLDER`, `GIT_WORKTREE_SHARED_REPO`, `AKILTA_ARTIFACT_SNAPSHOT`); a `GIT_WORKTREE_SHARED_REPO` binding requires a non-empty `branchRef`.
- `createWorkspaceSnapshotPackage` / `WorkspaceSnapshotPackage` — §12/§14's "versioned source/artifact snapshot/diff package and checkpoint"; can only be published under `SHARED_ARTIFACT` collaboration mode, fail-closed otherwise.
- `claimSharedRepoBranch` / `SharedRepoBranchClaim` and `verifySharedRepoBaseBeforeContinuing` — §14's "branch/worktree/lease strategy to avoid uncontrolled simultaneous writes" and "fetch/verify exact base/head before continuing." Exactly one lease may hold a given branch at a time (a second concurrent claim fails closed); a worker switching devices must prove its observed head matches the shared repo's actual current head before continuing.
- `createTaskPacket` / `TaskPacket` — exactly §12's named field list (goal/acceptance criteria, authority/protected-gate refs, base/branch/SHA or snapshot identity, relevant files, completed/remaining work, tests/evidence, blockers, next authorized action, prior worker's final summary). `priorWorkerFinalSummary` is a plain optional string — nothing in this type can carry raw hidden reasoning or a transcript.
- `rehydrateTaskPacketForHandoff` / `TaskPacketHandoff` — §13's "do not copy chat UI." Same-provider (`adapterKind`) + same-device (`deviceId`) with a supplied native thread reference resumes that thread (`RESUME_NATIVE_THREAD`); any other combination — different provider, different device, or no thread reference — always produces `FRESH_HYDRATION` from the TaskPacket alone, never an attempt to copy a conversation database.
- `resolveLocalExecutionFailover` / `LocalFailoverResult` — §15's exact failover sequence: re-derive the SAME eligible candidate set via L0's unmodified `resolveEligibleLocalWorkers` (so a fallback can never be admitted under relaxed requirements), then select among them via V5-WRK-001's unmodified `resolveWorkerRoute`. Fails closed before resolving any candidate when the caller-supplied external-effect state is `UNKNOWN` (§22 case I — never a blind retry on a different worker while an effect's real-world outcome is unverified).

## Explicitly deferred (not fabricated)

- No real Git plumbing (no `child_process`/`simple-git`/`isomorphic-git`), no real snapshot/diff byte encoding — `WorkspaceSnapshotPackage`/`WorkspaceBinding` are contract shapes only, exactly like `LocalWorkerAdapter`'s own established port-only discipline.
- No live device transport, no HTTP route wiring, no `AuthorityContext` composition — this is the domain contract layer only, matching every other LOCAL-EXEC phase's own scope discipline (L0 through L3 all deferred these identically).
- No modification to `local-execution.ts`, `local-execution-bridge.ts`, `worker-routing-policy.ts`, or `external-effect-envelope.ts` — all four are read-only dependencies, reused unmodified.
- No quota-circumvention/account-rotation logic anywhere (§15's own explicit non-goal).

## Architecture / semantic invariants (verified by test)

- A widening `CollaborationMode` transition always discloses the exact newly-visible refs (C1); a narrowing transition always states, verbatim, that already-downloaded data cannot be forgotten (C2); same-mode is `UNCHANGED` (C3); an unrecognized mode fails closed (C4).
- `GIT_WORKTREE_SHARED_REPO` requires a `branchRef`; `LOCAL_FOLDER` does not (C5-C6).
- A `WorkspaceSnapshotPackage` can only be created under `SHARED_ARTIFACT` (C7) with a valid positive-integer `snapshotVersion` (C8).
- A branch can be claimed by only one lease at a time — a second concurrent claim fails closed (C9-C10); the same lease re-claiming its own branch is idempotent (C11).
- A base/head mismatch fails closed before a device may continue on a shared branch (C12-C13).
- `TaskPacket` carries exactly §12's fields and rejects malformed required arrays (C14-C15).
- Handoff resumes a native thread only for the exact same provider + device + an actual thread reference (C16); any mismatch — device (C17), provider (C18), or a missing thread reference (C19) — always yields a fresh hydration.
- Failover selects the next equally-eligible worker under the identical required dimensions (F1); fails closed while the external-effect state is `UNKNOWN`, before any candidate is even resolved (F2, and structurally confirmed by the boundary scan); fails closed when no other eligible worker exists (F3); never silently selects a different employee's `PRIVATE` worker (F4); requires a non-empty evidence reference (F5).
- Boundary scan confirms structurally: this module never redefines `CollaborationMode`/`LocalTaskLease`/`LocalTaskCheckpoint`/`LocalWorkerRegistration`/`ExternalEffectAttemptState`; failover routes only through the existing `resolveWorkerRoute`, never a second router; the `UNKNOWN` external-effect gate is checked strictly before candidate resolution in the module's own source text; no `fetch`, `node:` builtin, or system clock call anywhere; no real Git plumbing or credential-shaped literal anywhere.

## Hard Non-Scope

No modification to `local-execution.ts`, `local-execution-bridge.ts`, `worker-routing-policy.ts`, `external-effect-envelope.ts`, `codex-local-adapter.ts`, or any `src/web/staff-*` file (all read-only dependencies); no real Git/transport/crypto/network call anywhere; no persistence; no HTTP route wiring; no new runtime dependency; no `AuthorityContext` composition.

## Evidence

- `npx tsc --noEmit -p .` / `npm run build`: exit 0, strict mode.
- `npm run test`: **938/938 pass** (907 pre-existing on the merged Family-2 + LOCAL-EXEC-001→004 + V4-EFF-001 base + 31 new: 24 functional + 7 boundary-scan).
- Sanity-checked: temporarily removed the `externalEffectState === "UNKNOWN"` fail-closed gate from `resolveLocalExecutionFailover` and confirmed exactly the 2 tests proving that dimension (F2 functional + the boundary-scan ordering test) then failed; restored, reconfirmed 938/938 pass.
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/local-execution-collaboration.ts` (new), `tests/local-exec-005-collaboration-handoff.test.ts` (new), `tests/local-exec-005-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending independent verification per canonical Handoff Rev105 (self-review alone does not qualify as delegated VERIFY). This checkpoint composes worker/task/device identity and the same authority-adjacent primitives as every other LOCAL-EXEC checkpoint, so it is `SAFE_MERGE`-excluded (auth/IAM/authority) per Execution Contract §9, regardless of verification outcome. `MERGE_DISPOSITION: HOLD_MERGE` — this branch merges PR #54 and PR #42; its own eventual PR should be reviewed alongside both upstream source PRs as part of the one consolidated end-of-batch Brain review packet.
