# LOCAL-EXEC-001 — Local Execution / Device Worker: Contracts & Safety Floor (Phase L0)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Brain's Rev99 ("BRAIN FOUNDER DECISION — LOCAL EXECUTION / DEVICE WORKER CAPABILITY") and Rev100 ("FOUNDER APPROVAL CONFIRMATION") — both fresh-read from the canonical Drive Handoff document (`modifiedTime` had advanced twice more since the last verified Rev98 read, to `2026-09-11T11:06:23.408Z`, so the full document was re-fetched and re-verified before acting on any of it) — introduce and then confirm Founder approval for a new capability: "AKILTA Local Execution," letting the Founder and authorized staff register their own computers as isolated AKILTA worker nodes executing through locally authenticated subscription AI coding clients (Codex, Claude Code), without paid API credentials being a prerequisite for every task.
- Rev99 names a dedicated architecture packet — Drive `1vhHCHZYu15IugytGb2O2epe7jgRFQF6vRoZsozjASDU` ("AKILTA — Local Execution Bridge / Subscription Worker System — Architecture & Execution Packet — R1") — and explicitly requires it be fresh-read in full before selecting or implementing any LOCAL-EXEC work. That packet was fetched and read in its entirety (all 756 lines) before this checkpoint began; its own R2 approval note confirms Founder sign-off.
- **Selection reasoning**: the packet's own §21 Implementation Program names `LOCAL-EXEC-001 / Phase L0 — Contracts & Safety Floor` as "dependency-safe immediately when selected... No live PC connection, provider login or network service required for this floor" — the same pure-domain-contract-plus-adversarial-tests shape as every other checkpoint built this session. Rev100's own "CLAUDE CONTINUATION ORDER" explicitly says: "if LOCAL-EXEC L0 is among the largest coherent dependency-safe slices, implement it without another Founder prompt." This branch was started only after the prior coherent Rev98 slice (`V4-EFF-001`, PR #42) was already committed and pushed — per Rev99/100's own explicit instruction not to interrupt a currently-executing coherent branch to start Local Execution.
- Branch: `claude/local-exec-001-contracts-safety-floor`, cut fresh from `main` at `3226c76fa338e425e553638e5f5f48924182a1c0`.

## Scope (this checkpoint)

`src/domain/local-execution.ts` — the full L0 contract set named in the packet's §12/§21:

- **Modes, Local default OFF (§1/§3)**: `ExecutionMode` (`CLOUD_NORMAL`/`PERSONAL_LOCAL`/`TEAM_LOCAL`/`HYBRID`), `CollaborationMode`, `PoolMode`, and `ExecutionPolicy`/`createExecutionPolicy` — defaults to `CLOUD_NORMAL`/`PRIVATE` when unspecified, and the three mode dimensions are structurally independent (no constructor ever derives one from another, directly satisfying "Local Mode must never automatically enable Team Pool or Shared Repo").
- **Device registration/capability model (§6/§7/§12)**: `DeviceRegistration`/`registerDevice` (always born `PENDING`), a closed `DeviceStatus` transition graph (`markDeviceOnline`/`markDeviceOffline`/`revokeDevice`/`quarantineDevice`, `REVOKED` permanently terminal), `DeviceCapabilitySnapshot` (the packet's own "safe capability health values" enum, no raw secret field anywhere), `DevicePolicy`/`createDevicePolicy` (workspace-root allowlist, `maxRiskLevel` reusing `worker-routing-policy.ts`'s own `WorkerRiskLevel` directly, kill switch) and `isWorkspaceRootAllowed`.
- **Adapter port (§8-10/§21 "adapter port and mock adapter")**: `LocalWorkerAdapter`/`LocalWorkerAdapterRequest`/`LocalWorkerAdapterResult` — the port only, mirroring `connector-execution.ts`'s own `ConnectorTransport` boundary discipline (a mock implementation lives only in tests, never in domain code).
- **Composition with the existing worker router, not a second one (§2/§15, the packet's own repeated explicit instruction)**: `LocalWorkerRegistration`/`createLocalWorkerRegistration` carries every field `AdmittedWorker` (`worker-routing-policy.ts`, unmodified) needs, plus the local-specific `poolMode`/`boundProjectOwnerships` dimensions. `toAdmittedWorker` projects a registration into the exact `AdmittedWorker` shape. `resolveEligibleLocalWorkers` is the pool/tenant/project/execution-mode gate that must run *before* a local worker is ever handed to the existing, unmodified `resolveWorkerRoute` — no new eligibility/routing logic is invented inside `resolveWorkerRoute` itself, and none of this module's own logic duplicates what `resolveWorkerRoute` already does (capability/tool/policy/authority/risk filtering remains exclusively that function's job).
- **Task lease + checkpoint contract (§12/§21)**: `LocalTaskLease`/`createLocalTaskLease` (fails closed unless the device is `ONLINE` and the worker's `deviceId` actually matches the given device), a closed `LocalTaskLeaseStatus` transition graph (`transitionLocalTaskLease`), and `LocalTaskCheckpoint`/`createLocalTaskCheckpoint` (only recordable against a lease genuinely `RUNNING`/`CHECKPOINTED`).
- `tests/local-execution.test.ts` (41 tests: L1-L41, covering all ten mandatory acceptance cases A-J from the packet's §22 by letter) and `tests/local-exec-001-boundary-scan.test.ts` (6 tests).

## Explicitly deferred (not fabricated)

- **No device bridge, control channel, or protocol.** §17's WebSocket/TLS control channel and message families (`ENROLL_CHALLENGE`, `HEARTBEAT`, `LEASE_OFFER`, etc.) are Phase L1 (`LOCAL-EXEC-002`, Device Bridge MVP) — this floor has no network code at all (boundary-scan test asserts no `WebSocket`/`fetch`/`node:` import anywhere in the module).
- **No Codex/Claude adapter implementation.** §8/§9's `CodexLocalAdapter`/`ClaudeLocalAdapter` are Phases L2/L5 (`LOCAL-EXEC-003`/`LOCAL-EXEC-006`) — this floor defines only the provider-neutral `LocalWorkerAdapter` port they will eventually implement, with zero references to any real provider SDK (boundary-scan test asserts no OpenAI/Anthropic SDK import).
- **No staff/team authenticated ingress wiring.** §12/§21's `LOCAL-EXEC-004` (Phase L3) explicitly depends on Rev98 Family 2's still-open trusted internal/staff ingress boundary — `ownerMembershipRef`/`requestingOwnerMembershipRef` here are deliberately opaque caller-supplied strings, never resolved against any real authentication system, exactly matching this floor's own stated dependency boundary.
- **No TaskPacket/cross-device handoff contract.** §13/§14's full TaskPacket rehydration and PRIVATE/SHARED_ARTIFACT/SHARED_REPO workspace-collaboration mechanics are Phase L4 (`LOCAL-EXEC-005`) — this floor's `LocalTaskLease`/`LocalTaskCheckpoint` are the minimal durable-progress primitives that phase will build on, not a premature implementation of it.
- **No durable persistence/store.** Every object in this module is an in-memory, pure value — no `FileDurable*` store exists yet for any of these types, matching this floor's own "No live PC connection, provider login or network service required" scope statement; a durable store is L1's concern, once a real caller (the bridge) exists.
- **No admin/product UI surfaces.** §19's dark/internal Settings pages are explicitly gated on Rev98 Family 2 and are not attempted here.

## Architecture / semantic invariants (verified by test)

Every one of the packet's ten mandatory acceptance cases (§22 A-J) is directly proven:

- **B (Local OFF)**: `CLOUD_NORMAL` excludes every local worker unconditionally, regardless of registrations supplied (L21).
- **C (employee isolation)**: `PERSONAL_LOCAL` admits only the requester's own `PRIVATE`-pool worker, never another owner's (L22-L23).
- **D (independent projects)** / **E (shared project opt-in)**: `TEAM_LOCAL` admits an `ORG_POOL` worker only when actually bound to the target project ownership tuple (L25-L26).
- **F (failover)**: a `DEGRADED` primary is skipped and an equally-authorized `AVAILABLE` fallback is selected through the existing, unmodified `resolveWorkerRoute` with no authority relaxation (L31).
- **G (revocation)**: `REVOKED` is permanently terminal on a device; a lease can never be created against a non-`ONLINE` device (L8, L32).
- **J (adversarial device channel)**: cross-tenant worker substitution (L28, sanity-checked — see Evidence), a worker/device `deviceId` mismatch (L33), and an unauthorized workspace root (L15) all fail closed.
- **A/H/I** (personal zero-manual-key path, provider-policy gate, unknown external effect) are structural properties of later phases (L2/L5/L6, and the already-built `V4-EFF-001` envelope respectively) rather than this floor's own testable surface, and are not fabricated here.
- The composition proof (L30): a `LocalWorkerRegistration`, gated through `resolveEligibleLocalWorkers`, routes successfully through the completely unmodified `resolveWorkerRoute` — no second routing engine exists anywhere in this module (boundary-scan test additionally asserts no `LocalWorkerRouter`-shaped symbol is defined).
- Every `LocalTaskLeaseStatus` transition is validated against a strictly closed graph — no direct `QUEUED`→`SUCCEEDED` jump, and no transition is ever permitted out of a terminal status (L35-L37, L39).

## Hard Non-Scope

No modification to any existing merged file (`worker-routing-policy.ts`, `tenant-scope.ts`, `project-ownership.ts` are all read-only dependencies here); no network/bridge/protocol code; no real provider SDK reference; no persistence/durable store; no admin/UI wiring; no new runtime dependency.

## Evidence

- `npm run build` (`tsc -p tsconfig.json`, strict mode incl. `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`): exit 0, zero errors.
- `npm run test`: **755/755 pass**, 0 fail, 0 skipped (708 pre-existing baseline + 47 new: 41 in `tests/local-execution.test.ts`, 6 in `tests/local-exec-001-boundary-scan.test.ts`).
- `npx tsc --noEmit -p .`: exit 0.
- Sanity-checked adversarial test: the cross-tenant isolation guard in `resolveEligibleLocalWorkers` was temporarily removed, confirmed exactly L28 (the test proving that dimension) then failed, then the fix was restored and 755/755 reconfirmed.
- `package.json`: zero new runtime dependency; `clean` script carried forward (same build-hygiene fix already applied on every other branch cut this session).
- Files touched: `src/domain/local-execution.ts` (new), `tests/local-execution.test.ts` (new), `tests/local-exec-001-boundary-scan.test.ts` (new), `package.json` (clean-script fix), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending fresh Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires a separately granted protected owner-gate, never inferred from any prior PR's grant. Per Rev95's continuous-execution batch-mode authorization (still controlling per Rev97/98/99/100), independent Brain exact-head review of this checkpoint is deferred to the one consolidated end-of-batch packet alongside PR #38, PR #39, RUNTIME-001, V5-PTN-002, and V4-EFF-001.
