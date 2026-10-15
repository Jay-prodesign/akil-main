# WORK-JOB-SOURCE-001 — Real WorkJobSource Adapter (OutcomeJob dimension)

## Provenance

- Governing authority: canonical Handoff **REV215**, continuous-completion self-selection authority — this is NOT one of the three persistence candidates the Founder reserved for explicit authorization only (Project store; durable stores for the other 5 in-memory domain types; Customer-lookup store). It is the exact same "wire an existing optional admin/view port to a real, already-accepted store" vein as `OBS-ADMIN-SOURCE-001`, `CUS-OFFBOARD-DURABLE-001`'s own adapter, and `PROJ-DURABLE-001`'s `WorkProjectSource` wiring — all self-selected under REV215 without a routine Brain-review wait.
- Selection method: `PROJ-DURABLE-001`'s own exec-plan explicitly deferred `WorkJobSource` composition as "a separate, later integration decision." Re-examined immediately after PROJ-DURABLE-001 shipped (user continuation signal "Dvm"): `WorkJobSource`'s own doc comment in `internal-os-view-state.ts` already states "a real `DurableOutcomeJobStore`/`AsyncOutcomeJobStore` (OS-V0-03) can satisfy this structurally" — the only missing ingredient was a real `Project` to call `listJobs(project)` with, which `PROJ-DURABLE-001` now supplies. No new persistence, no new query shape, no Founder authorization needed: `DurableOutcomeJobStore.list(tenantId, customerId, projectId)` (OS-V0-03, already-accepted substrate) matches `WorkJobSource.listJobs(project)`'s own shape exactly, since `OutcomeJob.customerId`/`OutcomeJob.projectId` are typed identically to `Project`'s own fields (`outcome-job.ts`).

## Reuse surface (read before designing)

- `DurableOutcomeJobStore`/`FileDurableOutcomeJobStore` (`OS-V0-03`, `durable-outcome-job-store.ts`) — reused unmodified via its existing `list(tenantId, customerId, projectId)` method. Its own `validatePersistedOutcomeJobLine` already fails closed on cross-tenant contamination on every read, and `list` itself already filters to the exact given `customerId`/`projectId`.
- `WorkJobSource` port + `resolveWorkView`/`resolveWorkProjectDetailView` (`internal-os-view-state.ts`) — reused unmodified.
- `work-project-admin-source.ts` (`PROJ-DURABLE-001`) — the exact sibling thin-adapter pattern cloned again: a `src/web/*-admin-source.ts` factory function taking a durable store and returning a port implementation, deliberately left unwired into `internal-os-dev-main.ts`.

## Scope (this checkpoint)

- New `src/web/work-job-admin-source.ts`: `createDurableWorkJobSource(store: DurableOutcomeJobStore): WorkJobSource`. `listJobs(project)` maps directly to `store.list(project.tenantId, project.customerId, project.projectId)` — a direct 1:1 pass-through, zero new logic.
- No additional cross-tenant/cross-project re-verification layered on top of `list`: the store's own existing guarantees already own that, and a redundant filter here would not be guard-disable-sanity provable as load-bearing — this corridor's own established discipline (see `operational-observability-admin-source.ts`'s identical reasoning).
- Tests: `tests/web-work-job-admin-source.test.ts` (new, 4 tests) — real jobs surfaced for the exact project; empty-but-valid list for a project with no jobs; a different project within the same tenant/customer never sees another project's jobs; full end-to-end `resolveWorkView`/`resolveWorkProjectDetailView` render with BOTH `PROJ-DURABLE-001`'s `createDurableWorkProjectSource` and this checkpoint's `createDurableWorkJobSource` composed together over real durable stores.
- No guard-disable sanity performed: this adapter introduces zero genuinely novel guards (a direct pass-through over an already-proven store), consistent with this corridor's own discipline of only guard-disable-sanity-checking logic this checkpoint itself adds.
- Full regression: **2904/2904 passing** (2900 pre-existing on PR #158's tip + 4 new), clean strict typecheck, zero new runtime dependency.

## Explicitly deferred (not fabricated)

- **Not wired into `internal-os-dev-main.ts`.** Mirrors every sibling adapter's own established precedent exactly.
- **`OrganizationResourceBindingSource`'s `currentProject` gate remains unwired.** Still requires a materially larger multi-source composition (current memberships/service-principals/connections/config-policy-refs/worker-route-decisions/knowledge-evidence-refs) this repository has no existing single caller for — unchanged finding from `OBS-ADMIN-SOURCE-001`/`PROJ-DURABLE-001`.
- **`CUS-OFFBOARD-002`'s `PROJECT` disposition remains `BLOCKED_UNSUPPORTED`.** Unchanged — needs a new delete/export mutation capability, not a lookup.

## Hard Non-Scope

No modification to `durable-outcome-job-store.ts`, `outcome-job.ts`, `internal-os-view-state.ts`, `internal-os-request-handler.ts`, `internal-os-http-server.ts`, or `internal-os-render.ts`. No new durable store. No mutation surface of any kind (read-only adapter only). No real billing-provider/IdP/credential anywhere. No change to the existing `/os/admin` route's security boundary.

## Evidence

- Clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`): exit 0.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `node --test dist/tests/*.test.js`: **2904/2904 passing**.
- Zero new runtime dependency.

Status: `IMPLEMENTED / SELF-VALIDATED` — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`.
