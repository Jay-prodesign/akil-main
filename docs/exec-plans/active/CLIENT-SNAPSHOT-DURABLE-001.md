# CLIENT-SNAPSHOT-DURABLE-001 — Real ClientProjectSnapshotSource Adapter

## Provenance

- Governing authority: canonical Handoff REV215 continuous-completion self-selection authority, directly following Brain's own instruction on PR #145 (`6193989189`): "After completion [of `WORK-JOB-SOURCE-001`], fresh-scan the remaining Project-store-unblocked consumers."
- Selection method: an `Explore` sub-agent inventoried every place in the repository that takes a `Project` value as a lookup-port input but has no real backing implementation (excluding the two already-known, already-documented-as-deferred items: `OrganizationResourceBindingSource`'s larger multi-source `currentProject` gate, and `CUS-OFFBOARD-002`'s `PROJECT` delete/export disposition). It found exactly one new genuine candidate: `ClientProjectSnapshotSource` (`src/web/snapshot-view-state.ts`). `node-server-entrypoint.ts`'s own doc comment has stated since `V2-APP-001` that "wiring a real, persistence-backed `ClientProjectSnapshotSource`... is an explicit, disclosed, later decision - not fabricated here, since no such source exists yet," and the only implementation anywhere (`createWebShellFixtureSnapshotSource`) is a single hard-coded in-memory record. `buildClientProjectSnapshot`'s own REQUIRED inputs are exactly `project: Project` and `jobs: ReadonlyArray<OutcomeJob>` - both now have real durable backing from `PROJ-DURABLE-001` and `WORK-JOB-SOURCE-001`. No third new store is needed.

## Reuse surface (read before designing)

- `FileDurableProjectStore` (`PROJ-DURABLE-001`) and `FileDurableOutcomeJobStore` (OS-V0-03, already wired to `WorkJobSource` by `WORK-JOB-SOURCE-001`) - both reused unmodified.
- `buildClientProjectSnapshot`/`ClientProjectSnapshot` (`client-project-snapshot.ts`, V2-CDO-005) - reused unmodified. Its own contract already treats every input beyond `ownership`/`project`/`jobs` as optional-and-absent-by-default.
- `ClientProjectSnapshotSource` port + `resolveProtectedSnapshotView` (`snapshot-view-state.ts`, V2-APP-001) - reused unmodified. `resolveProtectedSnapshotView` already independently re-verifies the returned snapshot's own `ownership` (including `serviceRef`) against the caller's requested ownership before ever reaching `READY`.
- `operational-observability-admin-source.ts`'s "a throwing source degrades to the safe default rather than propagating" precedent - cloned for the one genuinely novel guard this checkpoint adds.

## Scope (this checkpoint)

- New `src/web/client-project-snapshot-durable-source.ts`: `createDurableClientProjectSnapshotSource(projectStore: DurableProjectStore, jobStore: DurableOutcomeJobStore): ClientProjectSnapshotSource`. `getSnapshot(ownership)` looks up the project by `(ownership.tenantId, ownership.customerId, ownership.projectId)`, returns `undefined` if absent, otherwise lists that project's jobs and calls `buildClientProjectSnapshot({ ownership, project, jobs })`.
- Deliberately minimal: only the two REQUIRED `buildClientProjectSnapshot` inputs are supplied. No `ProjectPlanVersion`/`ApprovalReference`/`ProjectCommunicationHistory`/`CapabilityAdmission`/`AuditEvent` lookup capability is invented - `workingArtifact` stays absent, `capabilities`/`recentCommunications` stay empty, `eta` stays `{ status: "UNKNOWN" }`, `nextAction` stays `NO_ACTION_NEEDED`, exactly the honest defaults that function's own contract already specifies for an absent optional input.
- `ownership.serviceRef` (a dimension `Project` itself has no field for) is passed straight through to `buildClientProjectSnapshot` and never used to filter the project lookup, which is by `tenantId`/`customerId`/`projectId` only - the three fields `Project` actually has. `resolveProtectedSnapshotView`'s own existing re-verification of the returned snapshot's `ownership` (service dimension included) is not duplicated here.
- The one genuinely novel guard: `getSnapshot` catches any exception from `projectStore.get`/`jobStore.list` (e.g. a corrupted tenant file) and degrades to `undefined` - the same honest `NOT_FOUND` outcome already used when no snapshot exists - since `resolveProtectedSnapshotView` does not itself catch exceptions from a wired source.
- Tests: `tests/web-client-project-snapshot-durable-source.test.ts` (new, 5 tests) - real snapshot composed from real durable project+jobs; nonexistent project returns `undefined`; cross-tenant isolation; corrupted project-store file degrades to `undefined` instead of throwing (the one novel guard); full end-to-end `resolveProtectedSnapshotView` render to `READY` with a real durably-composed snapshot.
- Full regression: **2909/2909 passing** (2904 pre-existing on PR #159's tip + 5 new), clean strict typecheck, zero new runtime dependency.

## Guard-disable sanity

The one novel guard (try/catch around the store reads in `getSnapshot`) was disabled (the try/catch removed, both calls made directly) and the suite rebuilt: exactly the "corrupted project-store file degrades to `undefined`" adversarial test failed (surfacing the real `CorruptedProjectFileError` uncaught, confirming the guard is load-bearing), and no other test regressed. The guard was then restored and verified byte-identical to the pre-edit source via `diff` before the final regression run.

No second guard was added for cross-tenant/cross-customer isolation: `FileDurableProjectStore.get`'s own exact compound-key lookup already structurally cannot return a different tenant's/customer's project (proven by `PROJ-DURABLE-001`'s own tests), so a redundant filter here would not be guard-disable-sanity provable as load-bearing.

## Explicitly deferred (not fabricated)

- **Not wired into `node-server-entrypoint.ts`/`internal-os-dev-main.ts`.** Mirrors every sibling adapter's own established precedent (`work-project-admin-source.ts`, `work-job-admin-source.ts`, `operational-observability-admin-source.ts`, `customer-offboarding-admin-source.ts`) exactly - this checkpoint supplies the adapter only, not production route wiring.
- **No `plan`/`latestApproval`/`communicationHistory`/`capabilityAdmissions`/`auditEvents` composition.** Each would require inventing a durable lookup capability this repository does not have yet for that specific domain type (a `ProjectPlanVersion` store, an `ApprovalReference` store, etc.) - out of this checkpoint's scope, and each remains honestly absent per `buildClientProjectSnapshot`'s own already-accepted optional-input contract.
- **`OrganizationResourceBindingSource`'s `currentProject` gate and `CUS-OFFBOARD-002`'s `PROJECT` disposition remain unchanged** - unrelated to this checkpoint, already separately documented as deferred.

## Hard Non-Scope

No modification to `client-project-snapshot.ts`, `snapshot-view-state.ts`, `durable-project-store.ts`, `durable-outcome-job-store.ts`, or any `/portal` route composition file. No new durable store. No mutation surface of any kind (read-only adapter only). No real billing-provider/IdP/credential anywhere.

## Evidence

- Clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`): exit 0.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `node --test dist/tests/*.test.js`: **2909/2909 passing**.
- Zero new runtime dependency.

## Brain correction (F1)

Brain's independent review of exact head `3754cda7a092017309f23df8a0d63a655538786b` (PR #145 comment `6194655851`) found: `getSnapshot` caught every exception from `projectStore.get`/`jobStore.list` - including a genuine storage/data-integrity failure (a corrupted tenant file) - and collapsed it into `undefined`. `resolveProtectedSnapshotView` treats `undefined` as the honest "no such project" `NOT_FOUND` outcome, so this silently relabeled a real operational/data-integrity error as "project does not exist." Worse, this adapter's own original doc comment incorrectly claimed `resolveProtectedSnapshotView` "does not itself catch exceptions from a wired source" - it already does, mapping them to the correct `{ kind: "ERROR", reason }` state.

**Fix**: removed the try/catch entirely. `undefined` is now returned only for the genuine "project absent" case (`projectStore.get` returning `undefined`); any real read/replay-corruption exception propagates uncaught to `resolveProtectedSnapshotView`'s own existing, correct `ERROR` handling.

**Test changes**: the corrupted-file test now asserts the adapter's own `getSnapshot` throws (not returns `undefined`), plus a new end-to-end test proving `resolveProtectedSnapshotView` renders `{ kind: "ERROR" }` (never `NOT_FOUND`) for this exact scenario.

No guard-disable sanity applies here - this correction removes a bug (an over-broad catch), it does not add a new guard.

Full regression after the fix: **2909/2909 passing** (unchanged count - 2 tests rewritten, 1 test added, net +0 adjusted... see Evidence), clean strict typecheck, zero new runtime dependency. New exact head: see PR #160's latest commit.

Status: `IMPLEMENTED / SELF-VALIDATED` — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`.
