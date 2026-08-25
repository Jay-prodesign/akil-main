# CURRENT_STATE.md

Last updated: 2026-08-25, by Claude (Primary Engineer), correcting `V2-CDO-004` CR-1 (capability/binding compatibility) after Brain **CHANGES_REQUIRED** at checkpoint `7b48fdcea11fe024cc753649e99a69cd76f91876` — see `docs/exec-plans/active/V2-CDO-004.md`. V1 DEL-003/AKI-GIT-001 state below is unchanged.

## Repository identity

- Owner/name: `Jay-prodesign/akil-main`
- Visibility: Private
- Default branch: `main` (all engineering work below lives on task-scoped branches; nothing has merged to `main`)
- Base commit at bootstrap: `8a95c721024da4bfee99e082a01e34b86321637f` ("Create README.md")

## What exists

- `README.md`, the AKI-GIT-001 governance scaffolding (`AGENTS.md`, `CLAUDE.md`, `docs/engineering/`, `docs/architecture/ADR/`, `docs/specs/`, `docs/exec-plans/`).
- A secret-free TypeScript domain/application kernel under `src/domain/`, `src/application/`, `src/ports/`, `src/fixtures/`, built across three tasks (see "Completed tasks" / "Active tasks" below):
  - `AKI-BE-001` — `TenantScope`, `Customer`, `Project`, `OutcomeJob` (+ lifecycle/transitions), `EvidenceReference`, `VerificationResult`, `AuthorityContext`, `AuditEvent`, plus in-memory ports/adapters.
  - `ENG-ORCH-001` — `EngineeringEventEnvelope`, `EngineeringRunState` (pure reducer, fencing/idempotency/replay), `FileDurableEngineeringStore`, `WorkerInvoker`/`invokeSafely`, DEC-138 provenance.
  - `DEL-003` — `OfferBlueprintVersion`, `SoldScope`, `CustomerEvidenceItem`, `ProjectPlanVersion`/`compilePlan`, `PlanValidationResult`/`validatePlan`, `OutcomeJobSpec`, `ProjectPlanDiff`, `ApprovalReference`; second slice adds `PlanAdmissionResult`/`admitPlan`/`admitJobs`, `EvidenceReadinessAssertion`/`evaluateReadiness`, `wireAdmittedOutcomeJobs`, and durable admission/job stores (`durable-plan-admission-store.ts`, `durable-outcome-job-store.ts`).
- `tests/` — Node's built-in `node:test` runner exercises all of the above (228 tests at the current checkpoint; `npm run test`).
- `package.json`/`package-lock.json`/`tsconfig.json` — strict-mode TypeScript, zero runtime dependencies, `devDependencies` limited to `typescript` + `@types/node`.

## What does not exist yet

- Any HTTP/API server, database, ORM, queue, cache, object storage, or cloud service — this remains a domain/application kernel, not a deployable backend.
- Any CI, cloud, or deployment configuration.
- Any real secret, credential, or vault integration (secret-free by design; see `docs/engineering/PERMISSION_POLICY.md`).
- Any ADRs or specs beyond index scaffolding (see `docs/architecture/ADR/README.md` and `docs/specs/README.md`).
- Durable production runtime dispatch, cross-project (AI Commerce) request/result flows, broad AI/model routing, and FAS-001 S1/S2 adversarial activation — the *broader* forms of INT-001/CONN-001/AI-004 remain stage/trigger/dependency-gated per the canonical roadmap and the DEC-144 V1 Fast Lane contract's anti-scope-creep filter; not pulled forward. (Their minimum V2 slices — first Delivery Recipe, first account/connection-ownership contract — are separately marked `V2 Active Requirement` under the 21 August 2026 DEC-149/150 roadmap reconciliation and consumed only where V2-CDO-series work needs them; see `docs/exec-plans/active/V2-CDO-001.md`.)
- A public-facing website, payment/legal/commercial surface — the live AKILTA commercial website (`akilta.com`) is a separate, already-live Shopify-hosted surface outside this repository's scope; this repository does not build or touch it.

## Active tasks

- `V2-CDO-004` (First Bounded Account/Connection Ownership & Admitted Capability Consumption Contract, CONN-001 Minimum V2 Slice) — Status: **IMPLEMENTED / SELF-VALIDATED / PENDING BRAIN RE-AUDIT (CR-1)**, branch `claude/V2-CDO-004-task-packet`, checkpoint `abfb2a1c8487df8e3e240752286b1207989773cb`. Brain CHANGES_REQUIRED at prior checkpoint `7b48fdc`: `createCapabilityAdmission()` never proved the supplied `ConnectionBinding` actually corresponded to the `requiredCapabilityRef` being admitted, so a VERIFIED binding for one capability could be reused to admit a different capability under the same ownership tuple. Corrected by requiring `VERIFIED_AVAILABLE` construction to also receive the exact `ConnectionRequirement` and validating both `requirement.requiredCapabilityRef` and `binding.connectionRequirementId` linkage. 329/329 tests pass. See `docs/exec-plans/active/V2-CDO-004.md`.
- `DEL-003` (second bounded slice: runtime admission + OutcomeJob wiring) — Status: **IMPLEMENTED / SELF-VALIDATED / PENDING NEXT V1 BRAIN AUDIT** at commit `72e2d614e8a6347ca9f3a75f6f0558593caff637`, branch `claude/DEL-003-runtime-admission-task-packet`. Round-1 correction closed Brain's F1–F4 CHANGES_REQUIRED findings; the DEC-144 final Brain verification pass then accepted F2/F3/F4 and VQA-001's Contact correction but found one remaining F1 defect (readiness gate could treat any current-version FACT as positive readiness regardless of what it actually asserted), closed by the round-2 correction (structural `readinessOutcome` field). See `docs/exec-plans/active/DEL-003.md`. Not reopened by V2-CDO-001 absent concrete regression evidence.
- `AKI-GIT-001` — Status: **IMPLEMENTED — READY FOR CHATGPT VERIFICATION**, draft PR `#1` open, not merged. See `docs/exec-plans/active/AKI-GIT-001.md`.

## Completed tasks

- `V2-CDO-003` (First Bounded Customer Ownership & Project Communications Contract, OPS-010 Minimum V2 Slice) — Brain **VERIFIED / PASS / CLOSED** at `b9430b74fdc580ce66530899e1510bc4c5ddf2cb` after CR-1 correction. See `docs/exec-plans/completed/V2-CDO-003.md`.
- `V2-CDO-002` (First Bounded Delivery Recipe Contract, `WEBSITE_BUILD_v1`) — Brain **VERIFIED / PASS / CLOSED** at `f99cd2f46b178d2190ac94ff6052c955d3e5cd43`. See `docs/exec-plans/completed/V2-CDO-002.md`.
- `V2-CDO-001` (first bounded V2 Client & Delivery OS slice: project/service status + unified delivery timeline) — Brain **VERIFIED / PASS / CLOSED** at `b5a8c4fd422b61c91ba656e910a73ba6165727b7`. See `docs/exec-plans/completed/V2-CDO-001.md`.
- `AKI-BE-001` — Brain **VERIFIED / COMPLETED** at `c2e7e7dee579b2fab614485631fa3cd1f53c6070`. See `docs/exec-plans/completed/AKI-BE-001.md`.
- `ENG-ORCH-001` — Brain **VERIFIED / COMPLETED** at `a804ebe73822883122f3dfabd869a4651f94dd38`. See `docs/exec-plans/completed/ENG-ORCH-001.md`.
- `DEL-003` first bounded slice (project compiler) — Brain **VERIFIED / COMPLETED** at `abb5ea954e338d82cf1583d83359e469d6959599`. Recorded inside `docs/exec-plans/active/DEL-003.md` (the DEL-003 parent task itself remains active/stage-gated; only its first slice is closed).

## Known conflicts / blockers

- None found. `git status` is clean at every checkpoint above; the full history is one linear chain from bootstrap through the current checkpoint (`AKI-GIT-001` → `AKI-BE-001` → `ENG-ORCH-001` first slice → `DEL-003` first slice → `ENG-ORCH-001` round-3 correction → `DEL-003` second slice round-1 correction (`3253439`) → V1 Fast Lane Stage B documentation pass (`ff832ce`) → `DEL-003` second slice round-2 correction (`72e2d61`), current HEAD `72e2d61`), verifiable via `git log --oneline` on this branch.
