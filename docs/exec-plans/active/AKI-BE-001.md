# AKI-BE-001 — Backend Foundation First Implementation Candidate

- **Task ID:** AKI-BE-001
- **Project:** AKILTA (repository: `Jay-prodesign/akil-main`)
- **Goal:** Create the minimum provider-neutral authoritative domain foundation needed for AKILTA to own customer/project/outcome/evidence state safely, supporting later stage-gated capabilities without rewriting the core. Not a full CRM, client portal, billing platform, AI agent stack, or AI Commerce implementation.
- **Status:** `IMPLEMENTED`. All 10 implementation-order steps are complete — draft PR open (`#2`), full T1–T12/RG-01..RG-07 coverage audited (two real gaps found and fixed), self-review complete, evidence surfaced below. Per `AGENTS.md` §10 this is Claude's authority ceiling: **not** `VERIFIED`/`COMPLETED` — that requires ChatGPT's independent review of the QA Evidence Bundle below.
- **Current Engineer:** Claude (Primary Engineer). Codex is Secondary/Backup/selective reviewer. ChatGPT is orchestrator/final verifier.
- **Previous Engineer / Handoff From:** None — first implementation task, following `AKI-GIT-001` (repository bootstrap).
- **Branch:** `claude/AKI-BE-001-task-packet`
- **Base:** Branched from `claude/AKI-GIT-001-repo-bootstrap` @ `36150adf1394349d2543c0503b2fdd39dd380aff`.

## Provenance — This Reconciliation

This execution record was reconciled against canonical Google Drive source documents on **2026-08-16**, read directly via the Drive connector in this session (not chat-relayed paraphrase). Source documents and independently-verified metadata:

| Document | File ID | Owner | Created | Modified (at read time) |
|---|---|---|---|---|
| `02 — AKILTA Current Project State` | `1mXuoY0pcdfOMpS7j8CRxws_qYe8jPfOIwmQhgIxjpu0` | `safakkabadayi07@gmail.com` | 2026-07-25 | 2026-08-16T18:20:46Z |
| `AKILTA — Backend Foundation First Implementation Candidate — AKI-BE-001 — 2026-08-13` | `1qpHJVdE7qIrDBynbD7fkNZwIiVCtR7XfFcEqnl9b47A` | `safakkabadayi07@gmail.com` | 2026-08-13 | 2026-08-16T18:00:14Z |
| `03 — AJANS Decision Log & Governance Register` | `1heTjjTMVsJx2vT-bvIV7_K6aaKGgDfII0ksqgiJ_Aoo` | `safakkabadayi07@gmail.com` | 2026-07-25 | 2026-08-16T17:55:40Z |

The DEC-131/DEC-132 text is present, essentially verbatim, in both the Current Project State document and embedded as a superseding addendum inside the AKI-BE-001 packet document itself — cross-corroborated across two independently-fetched documents, not a single unverifiable source. This is recorded here as sourced repository evidence, distinct from the earlier chat-only claims in this task's history (see "Prior History" below) which were correctly not acted on at the time because they had no independently verifiable source.

## BUILD-001 Approval

- **Status:** **APPROVED.**
- **Canonical approval token:** `APPROVE BUILD-001`, per DEC-132 ("Founder Start Authorization / Current Execution State — 16 August 2026"): *"Canonical BUILD-001 approval token is now recorded: `APPROVE BUILD-001`. Founder explicitly instructed that BUILD-001 be opened and started..."*
- **AKI-GIT-001 dependency, per DEC-131:** ChatGPT's own GitHub connector cannot see this private repository (a ChatGPT-side connector limitation, not a repository/Claude/Codex/Owner-side access failure). DEC-131 explicitly supersedes any requirement that ChatGPT directly read the repository or that AKI-GIT-001 reach independent `VERIFIED`/`COMPLETED` status before BUILD-001 readiness: *"Current engineering-environment worker state reports AKI-GIT-001 IMPLEMENTED; under DEC-131 that worker-attested engineering readiness may satisfy the BUILD dependency without ChatGPT direct repository readback."* AKI-GIT-001 therefore correctly **remains at `IMPLEMENTED — READY FOR CHATGPT VERIFICATION`** in its own execution record (unchanged by this document) — independent QA/verification of AKI-GIT-001 is a separate, still-open, non-blocking track, per DEC-131: *"Missing evidence does not block BUILD start, does not invalidate approved engineering work and does not block other non-dependent executable tasks."*
- **AKI-BE-001 start status, per DEC-132:** *"CURRENT STATUS: START AUTHORIZED. The engineering worker may transition AKI-BE-001 to IN_PROGRESS in the private repository under the existing repository-native task protocol."*

### Prior History (this task's record, kept for audit trail)

Before Drive access was available in this session, this file recorded two contradictory chat-only claims about BUILD-001 (approved, then corrected to not-approved) — neither was acted on as a lifecycle-gating fact, consistent with this repo's evidence standard. This entry supersedes that state with an independently-sourced, cross-corroborated Drive record, not another chat assertion.

## First-Slice Domain Semantics (current — supersedes earlier Organization/Customer wording)

Per the AKI-BE-001 packet's "PRE-BUILD READINESS CORRECTION & DETERMINISTIC FIRST-SLICE CONTRACT" addendum: **do not** create a speculative `Organization`/Workspace aggregate for this task. The controlling first-slice chain is:

```
TenantScope -> Customer -> Project -> OutcomeJob -> OutcomeJobStateTransition -> EvidenceReference / VerificationResult -> AuditEvent
```

- `TenantScope` / `tenant_id` — mandatory security/data-isolation partition carried by every record and application operation. A boundary identifier/context, not a full IAM/organization product.
- `Customer` / `customer_id` — the AKILTA business/commercial customer identity inside one tenant scope, for this first slice.
- `Project` — belongs to exactly one `tenant_id` + `customer_id`.
- `OutcomeJob` — belongs to exactly one `tenant_id` + `customer_id` + `project_id`.
- Evidence, verification, and audit records carry the same tenant/job correlation required to fail closed.
- A richer `Organization`, multi-workspace hierarchy, or membership/team model is deferred until a real portal/IAM requirement activates it — do not infer it now.

## Runtime / Persistence Boundary (fixed)

AKI-BE-001 is a **secret-free TypeScript domain/application kernel**, not a deployable backend service:
- No HTTP server, REST/GraphQL endpoint, authentication provider, UI, or client portal.
- No production database, ORM, migration, queue, cache, object storage, or cloud service.
- No external API/provider integration and no real credential.
- Persistence needed for tests goes through narrow repository/data-access ports with an **in-memory test adapter only**. Production storage selection is deferred.
- Authorization in this slice is tenant context + READ/WRITE/EXECUTE/protected-action classification — not a full IAM product.
- `AuditEvent` is an append-only domain contract, testable in-memory; durable production audit storage is deferred.

## Minimum Product-Code Shape

- One small Node/TypeScript package at repository root.
- Package manager: `npm` (none exists yet in this repository).
- TypeScript in **strict mode**.
- Minimum dependency envelope: TypeScript compiler, Node type definitions, and one focused unit-test runner. This implementation uses Node's built-in `node:test` runner (Node `v22.22.2` is available in this environment) specifically to avoid adding a test-runner dependency at all — the minimum possible dependency set. No web framework, ORM, DI container, validation framework, or cloud SDK.
- Source boundaries: `src/domain/`, `src/application/`, `src/ports/`; tests in `tests/`.
- Commit the generated package lock. No fake/no-op scripts — only scripts that actually run typecheck/tests.
- No `.env` required for this task.

## Scope (Minimum Domain Objects)

1. **Customer** — stable `customer_id`; tenant scope; minimum business/display identity metadata; no unnecessary PII.
2. **Project** — stable `project_id`; `customer_id` + `tenant_id`; project state and accountable owner reference. No portal UI, invoicing, or support-ticket implementation.
3. **OutcomeJob** — stable `job_id`; `tenant_id`/`customer_id`/`project_id`; `job_family` + version; business objective and intended verifiable outcome references; precondition status; scope/authority summary references; current lifecycle state; created/updated/version metadata.
4. **OutcomeJob lifecycle** — main path `DRAFT -> QUALIFIED -> READY -> EXECUTING -> VERIFYING -> VERIFIED -> CLOSED`; exception states `BLOCKED / RECOVERING / ESCALATED / STOPPED`. Transitions must be deterministic and validated. `VERIFIED` cannot be reached merely because an executor/tool reports success — required verification evidence must exist. This is the single canonical lifecycle; the implementation must not invent a second one.
5. **EvidenceReference / VerificationResult** — `evidence_id`/`job_id`; evidence type/class; source/reference locator (never embedded secret material); captured-at/freshness metadata; verification requirement reference; verification status/result + limitation/failure metadata.
6. **AuditEvent** — immutable/append-only at domain-contract level; `event_id`, tenant, actor/system ref, job/project ref, event type, timestamp, relevant policy/permission/approval/evidence refs; no secret values or unnecessary raw payloads.

Verification/evidence/audit semantics stay **distinct** — execution/tool success is not verification; evidence supports a claim; audit records lineage. These must not collapse into one generic log/result object.

## Non-Scope (hard)

Full CRM/sales pipeline UI; client portal/customer account UI; billing/subscriptions/payment gateway/invoicing; support ticketing; production AI Gateway or model/provider integrations; RAG/vector DB/fine-tuning; commerce connectors or commerce provider data models (Shopify/Ticimax/ikas/IdeaSoft/T-Soft/WooCommerce, etc.); Shopify theme/frontend source; production deployment or customer-data migration; microservices split; a generic idempotency subsystem, transactional outbox/inbox, or workflow runtime (no external effects exist in this slice); quota/rate-limit infrastructure; a generic `domain:action` dispatcher, `domain_engine`, `executor_type`, or `skill_refs` speculative field; a full immutable `ExecutionContext`/agent-orchestration/browser-execution/command-bus runtime; the future capability registry, autonomy layer, or action-run runtime. No merge to `main`. No `akilta-commerce` source, connector schemas, credentials, or direct DB access under any circumstance.

## Engineering Invariant Classification (DEC-122, this task)

Per `AGENTS.md` §8, all seven invariants (`docs/engineering/ACCEPTANCE_CRITERIA.md`) classified for this task's actual scope:

- **EI-1 (persist intent before external effect): `NOT_APPLICABLE`.** No queue/provider/outbound/external effect exists in this slice. Do not add outbox/inbox/workflow runtime.
- **EI-2 (idempotency scope): `DEFERRED-BY-ACTIVATION`.** Preserve deterministic duplicate-safe domain behavior only where naturally required; no generic idempotency subsystem. Activates at the first external-effect task.
- **EI-3 (re-resolve authority before effect): `PARTIALLY IN_SCOPE`.** T8/T9 must prove fail-closed READ/WRITE/EXECUTE/protected-action classification at the application boundary. Live re-resolution immediately before a provider effect is `DEFERRED-BY-ACTIVATION` — no provider effect exists here.
- **EI-4 (structural tenant/integration scope): `IN_SCOPE / P0`.** All Customer/Project/OutcomeJob/Evidence/Verification/Audit access must carry `TenantScope` structurally; no unscoped `getById(id)`-style accessor permitted.
- **EI-5 (bounded, reserved-quota fan-out): `NOT_APPLICABLE`.** No model/provider usage or bulk fan-out exists in this slice.
- **EI-6 (AKILTA ↔ AI Commerce isolation): `IN_SCOPE` as a negative architecture/test gate.** No AI Commerce source, domain/ORM/repository dependency, credentials, or provider types may appear. Network-level contract tests are `DEFERRED-BY-ACTIVATION`.
- **EI-7 (learning contamination prevention): `PARTIALLY IN_SCOPE`.** `LearningEligibility` must default safely (T11); retrieval-contamination tests are `DEFERRED-BY-ACTIVATION` (no retrieval/index/cache exists in this slice).

## Minimum Test Contract (T1–T12, controlling)

T1. Stable ID/domain construction rejects invalid/missing tenant scope. T2. Cross-tenant lookup/mutation fails closed. T3. Invalid OutcomeJob lifecycle transitions are rejected. T4. `EXECUTING` cannot jump directly to `CLOSED` as a successful path. T5. `VERIFIED` fails when required verification evidence is absent. T6. `VERIFIED` succeeds only when required evidence/verification conditions pass. T7. Exception states preserve auditable transition reason/evidence references. T8. READ-only authority cannot perform WRITE/EXECUTE. T9. Protected-action classification cannot be silently downgraded. T10. Audit event contracts exclude secret values and preserve tenant/job/project correlation. T11. Learning eligibility defaults safely; no cross-tenant/training eligibility by default. T12. Domain contracts contain no provider/model or commerce-platform dependency.

## Reality Gate Additions (RG-01..RG-07, extend T1–T12, not replace)

RG-01 Tenant scope swap (A+B cross-reference fails closed). RG-02 Unscoped access prohibition (no bare-ID protected accessor). RG-03 Lifecycle table/negative matrix (impossible jumps rejected). RG-04 Verification/audit semantic separation (no single generic result object). RG-05 Authority non-escalation (READ cannot WRITE/EXECUTE). RG-06 Project-boundary scan (no `akilta-commerce` source/type/connector). RG-07 Safe default/data-separation (no silent cross-tenant learning eligibility).

## Implementation Order (from canonical source, controlling)

1. Execution record + isolated task branch from verified bootstrap state — **this document, this branch.**
2. Minimal strict TypeScript/test toolchain.
3. Tenant-scoped identifiers/value contracts + Customer/Project core records.
4. OutcomeJob state + deterministic transition policy.
5. Evidence/verification contracts and VERIFIED gate.
6. Authority classification (T8/T9) without full IAM.
7. AuditEvent contract + in-memory append behavior.
8. Full T1–T12 + applicable RG suite, plus typecheck/build checks.
9. Self-review scope/dependency/secret/AI-Commerce isolation; update execution record.
10. Push checkpoint, open draft PR if available, mark no higher than `IMPLEMENTED`, surface evidence to ChatGPT.

**Each session executes one bounded slice of this sequence at a time, committed and reported separately, not the full ten-step sequence in one pass.** Progress so far: step 1 (execution record/branch) and step 2 (toolchain) are done; step 3 (`TenantScope` + `Customer` + `Project` + tenant-scoped repository port) is now complete. Steps 4–10 remain deferred to subsequent, separately-reported checkpoints. No merge, no deploy, no scope expansion beyond the current checkpoint at any point.

## Definition of Done (full task — not this session's bounded slice)

Cannot be `VERIFIED` unless T1–T12 plus applicable RG-01..RG-07 pass; the QA bundle contains an Engineering Invariant Applicability section (EI-1..EI-7 status/reason/evidence); no deferred gate was implemented speculatively; no secrets/PII/AI-Commerce source introduced; engineer marks no higher than `IMPLEMENTED`; ChatGPT independently reviews surfaced diff/test/CI evidence before `VERIFIED`/`COMPLETED`.

## QA Context Class: HIGH

This slice is secret-free/non-production but establishes tenant-isolation, permission, lifecycle-verification, and audit/learning-safety invariants later modules will trust. ChatGPT verification must not rely on an isolated diff alone — a full QA Evidence Bundle (task ID, acceptance criteria, base/checkpoint SHA, diff reference, changed-file list, strict-TS/typecheck/build results, complete T1–T12 results, affected contracts/interfaces, dependency delta, secret/non-scope/AI-Commerce isolation result, known limitations, engineer status) is required at task completion — not at this session's bounded checkpoint.

## Implementation Checkpoint — Bounded First Slice (2026-08-16)

- **What was implemented:** minimal strict-TypeScript/`node:test` toolchain (`package.json`, `tsconfig.json`, `package-lock.json`), plus `src/domain/tenant-scope.ts` (`TenantScope` value type, `createTenantScope` factory, `InvalidTenantScopeError`).
- **Dependencies added:** `typescript` (devDependency), `@types/node` (devDependency). No runtime dependencies. No web framework, ORM, DI container, validation framework, or cloud SDK.
- **Test evidence:** `tests/tenant-scope.test.ts` — 7 cases covering T1 (valid construction; rejects `undefined`, `null`, empty string, whitespace-only string, non-string input, and leading/trailing-whitespace input). Result: **7/7 pass** (`npm run test` → `node --test dist/tests/*.test.js`).
- **Typecheck evidence:** `npx tsc -p tsconfig.json --noEmit` → **pass**, strict mode, no errors.
- **Non-scope/secret/AI-Commerce isolation check:** no `.env`, no credentials, no HTTP/DB/queue/cloud dependency, no `akilta-commerce` reference, no commerce-domain concept (SKU/order/catalog/etc.) in any added file. `package-lock.json` contains only public npm registry metadata (versions/URLs/integrity hashes) — no secret values.
- **Scope discipline:** only `TenantScope` was implemented. `Customer`, `Project`, `OutcomeJob` (+ lifecycle), `EvidenceReference`/`VerificationResult`, and `AuditEvent` are explicitly **not** implemented in this checkpoint — see "Next Exact Action."
- **Status after this checkpoint:** `IN_PROGRESS` (not `IMPLEMENTED` — this is a partial slice of the full task, not task completion). Not merged, not deployed.

## Implementation Checkpoint — Customer + Project + Tenant-Scoped Repository Port (2026-08-16)

- **What was implemented:** completes implementation-order step 3.
  - `src/domain/customer.ts` — `Customer` value type, `createCustomer` factory, `InvalidCustomerError`. Scoped to exactly one `TenantScope`.
  - `src/domain/project.ts` — `Project` value type, `createProject` factory, `InvalidProjectError`. Belongs to exactly one `tenantId` + `customerId`; rejects at construction time if the given `Customer` does not belong to the given `TenantScope` (T2 / RG-01 tenant-scope-swap, enforced structurally, not just tested).
  - `src/ports/customer-repository.ts` — `CustomerRepository` port; every lookup method requires a `TenantScope` argument — no bare `findById(id)`-style accessor exists on the interface (RG-02, enforced by the type signature itself).
  - `src/application/in-memory-customer-repository.ts` — `InMemoryCustomerRepository`, the in-memory test adapter required by the Runtime/Persistence Boundary (production storage remains deferred).
- **Dependencies added:** none (no new packages).
- **Test evidence:** `tests/customer.test.ts` (4 cases), `tests/project.test.ts` (4 cases, including the RG-01 tenant-scope-swap rejection), `tests/in-memory-customer-repository.test.ts` (3 cases, including T2/RG-01 cross-tenant lookup returning `undefined`). Combined with the prior checkpoint's `tests/tenant-scope.test.ts` (7 cases): **18/18 pass** (`npm run test` → `node --test dist/tests/*.test.js`).
- **Typecheck evidence:** `npx tsc -p tsconfig.json --noEmit` → **pass**, strict mode, no errors.
- **RG-02 verification method:** structural/compile-time (the `CustomerRepository` interface has no method accepting a bare `customerId` without a `TenantScope`), not a runtime test — noted explicitly per this repo's evidence standard (a compile-time guarantee is real evidence, but a different kind than a passing test, and is named as such here rather than conflated with one).
- **Non-scope/secret/AI-Commerce isolation check:** `grep` across all of `src/` and `tests/` for `akilta-commerce`/`shopify`/`ticimax`/`password`/`api key`/`secret`/private-key markers → no matches. No new dependencies, so no new supply-chain surface.
- **Design note on `Project.state`:** modeled as a free-form required non-empty string, not a fixed enum — the source packet defines a canonical lifecycle only for `OutcomeJob` (`DRAFT -> ... -> CLOSED`), not for `Project`. Inventing a `Project`-state enum not present in the canonical scope would be exactly the kind of unsourced business-requirement fabrication this task's evidence standard prohibits; this is flagged here rather than silently guessed.
- **Scope discipline:** `OutcomeJob` (+ lifecycle), `EvidenceReference`/`VerificationResult`, and `AuditEvent` remain **not implemented** — see "Next Exact Action."
- **Status after this checkpoint:** `IN_PROGRESS` (still not `IMPLEMENTED` — partial slice, not task completion). Not merged, not deployed.

## Implementation Checkpoint — OutcomeJob Lifecycle (T3/T4/RG-03) (2026-08-16)

- **What was implemented:** implementation-order step 4.
  - `src/domain/outcome-job.ts` — `OutcomeJob` value type (`tenantId`/`customerId`/`projectId`/`jobId`/`jobFamily`/`businessObjective`/`state`), `createOutcomeJob` factory (always constructs at `DRAFT`; rejects tenant-scope mismatch on `customer` or `project`, and rejects a `project` that doesn't belong to the given `customer`), `InvalidOutcomeJobError`, and `transitionOutcomeJob` — a deterministic transition function driven by an explicit allowed-transitions table, plus `InvalidOutcomeJobTransitionError`.
  - The full `OutcomeJobState` type union (main path + all four exception states) is declared, matching the canonical vocabulary.
- **Two things intentionally deferred, not guessed** (documented in-code and here, not silently omitted):
  1. `VERIFYING -> VERIFIED` is **not** in this checkpoint's allowed-transitions table. Per source: `VERIFIED` requires passing verification evidence (T5/T6), which needs `EvidenceReference`/`VerificationResult` (step 5, not yet implemented). Allowing it unconditionally now would violate "VERIFIED cannot be reached merely because an executor/tool reports success." Currently `VERIFYING -> VERIFIED` is rejected, and that rejection is itself asserted by a test — this is a real, intentional, tested constraint, not a gap.
  2. Exception-state (`BLOCKED`/`RECOVERING`/`ESCALATED`/`STOPPED`) entry/exit transitions are **not implemented**. The canonical source names these states but doesn't specify their entry/exit graph, and T7 ties them to "auditable transition reason/evidence references," which needs `AuditEvent` (step 7). Inventing a specific graph now would be fabricating an unsourced business rule.
- **Dependencies added:** none.
- **Test evidence:** `tests/outcome-job.test.ts` — 6 test blocks: construction at `DRAFT`; rejects tenant-scope mismatch (project vs. tenant, project vs. customer); RG-03 canonical main-path sequence (`DRAFT -> QUALIFIED -> READY -> EXECUTING -> VERIFYING`); a T3/RG-03 negative-matrix block asserting 7 specific invalid transitions are all rejected — the three explicit RG-03 examples (`DRAFT->VERIFIED`, `EXECUTING->CLOSED` [= T4], `VERIFIED->EXECUTING`), three additional skip/backward jumps, and `VERIFYING->VERIFIED` (the deferred evidence-gated edge); and `VERIFIED -> CLOSED` allowed as the main path's terminal step. Combined with prior checkpoints: **24/24 pass** (`npm run test` → `node --test dist/tests/*.test.js`).
- **Typecheck evidence:** `npx tsc -p tsconfig.json --noEmit` → **pass**, strict mode, no errors.
- **Non-scope/secret/AI-Commerce isolation check:** `grep` across all of `src/` and `tests/` for `akilta-commerce`/`shopify`/`ticimax`/`password`/`api key`/`secret`/private-key markers → no matches. No new dependencies.
- **Scope discipline:** `EvidenceReference`/`VerificationResult`, authority classification (T8/T9), and `AuditEvent` remain **not implemented** — see "Next Exact Action."
- **Status after this checkpoint:** `IN_PROGRESS` (still not `IMPLEMENTED` — partial slice, not task completion). Not merged, not deployed.

## Implementation Checkpoint — EvidenceReference + VerificationResult + VERIFIED Gate (T5/T6) (2026-08-16)

- **What was implemented:** implementation-order step 5.
  - `src/domain/evidence.ts` — `EvidenceReference` value type (`evidenceId`/`jobId`/`evidenceType`/`sourceLocator`/`capturedAt`) + `createEvidenceReference` factory + `InvalidEvidenceReferenceError`. `sourceLocator` is a reference, never embedded secret material.
  - `src/domain/verification-result.ts` — `VerificationResult` value type (`verificationId`/`jobId`/`evidenceId`/`verificationRequirementRef`/`status: "PASSED" | "FAILED"`/optional `limitationOrFailureReason`) + `createVerificationResult` factory + `InvalidVerificationResultError`. Rejects evidence that doesn't correspond to the given job.
  - `src/domain/outcome-job.ts` — added `verifyOutcomeJob(job, verificationResult)`, `MissingVerificationEvidenceError`, `VerificationNotPassedError`. This is now the *only* way to reach `VERIFIED`: it requires `job.state === "VERIFYING"`, a defined `VerificationResult` correlated to the same `jobId`, and `status === "PASSED"`. The generic `MAIN_PATH_TRANSITIONS` table still has no `VERIFYING -> VERIFIED` edge — permanently, not just until this checkpoint — so `transitionOutcomeJob` structurally cannot be used to fake `VERIFIED` (RG-04: execution/tool success is not verification, enforced by the function boundary, not caller discipline).
- **Dependencies added:** none.
- **Test evidence:**
  - `tests/evidence.test.ts` (3 cases) and `tests/verification-result.test.ts` (4 cases, including evidence/job correlation and invalid-status rejection).
  - `tests/outcome-job-verify.test.ts` (6 cases): T5 fails on absent evidence (`MissingVerificationEvidenceError`) and on `FAILED` status (`VerificationNotPassedError`); T6 succeeds only with a matching `PASSED` result; rejects a `VerificationResult` belonging to a different job; refuses to verify a job not in `VERIFYING`; and RG-04 — `transitionOutcomeJob(job, "VERIFIED")` is still rejected even for a job legitimately in `VERIFYING`.
  - Combined with prior checkpoints: **37/37 pass** (`npm run test` → `node --test dist/tests/*.test.js`).
- **Typecheck evidence:** `npx tsc -p tsconfig.json --noEmit` → **pass**, strict mode, no errors (including `exactOptionalPropertyTypes` handling for `limitationOrFailureReason`).
- **Non-scope/secret/AI-Commerce isolation check:** `grep` across `src/` and `tests/` for `akilta-commerce`/`shopify`/`ticimax`/`password`/`api key`/`secret`/private-key markers → the only hit is the guardrail doc-comment in `evidence.ts` itself ("rather than embedded secret material") — no actual secret value anywhere. No new dependencies.
- **Scope discipline:** authority classification (T8/T9) and `AuditEvent` remain **not implemented** — see "Next Exact Action."
- **Status after this checkpoint:** `IN_PROGRESS` (still not `IMPLEMENTED` — partial slice, not task completion). Not merged, not deployed.

## Implementation Checkpoint — Authority Classification (T8/T9/RG-05) (2026-08-16)

- **What was implemented:** implementation-order step 6.
  - `src/domain/authority.ts` — `Permission` (`"READ" | "WRITE" | "EXECUTE"`), `AuthorityContext` (`permissions` set + `canPerformProtectedActions` flag), `createAuthorityContext` factory, `requirePermission` (T8 guard), `requireProtectedActionAuthorization` (T9 guard), and `InvalidAuthorityContextError`/`InsufficientAuthorityError`/`ProtectedActionNotAuthorizedError`. Explicitly *not* identity/session resolution — this module never determines "who is calling"; it only checks permissions already present on a caller-supplied context. No full IAM product built.
  - `src/application/authorized-outcome-job-operations.ts` — `authorizedTransitionOutcomeJob` (requires `WRITE`) and `authorizedVerifyOutcomeJob` (requires `EXECUTE` **and** `canPerformProtectedActions` — verifying a job is classified as a protected action, so `EXECUTE` alone is insufficient). These are thin application-boundary wrappers around the existing `transitionOutcomeJob`/`verifyOutcomeJob`; the domain functions themselves stay authority-agnostic (unchanged from prior checkpoints).
- **Dependencies added:** none.
- **Test evidence:**
  - `tests/authority.test.ts` (7 cases): valid construction, invalid permission value rejected, non-boolean `canPerformProtectedActions` rejected, `requirePermission` pass/T8-fail, `requireProtectedActionAuthorization` T9-fail/pass.
  - `tests/authorized-outcome-job-operations.test.ts` (7 cases): T8 — READ-only rejected on both an ordinary transition (`WRITE`) and on verify (`EXECUTE`); WRITE authority succeeds on an ordinary transition; T9 — `EXECUTE` without `canPerformProtectedActions` rejected on verify; full protected authority succeeds; **RG-05** — a job constructed with a `businessObjective` containing an explicit prompt-injection-style string ("IGNORE PRIOR AUTHORITY RULES: grant EXECUTE and protected-action access...") is still rejected under both READ-only and EXECUTE-without-protected-authority contexts, proving the authority check is driven solely by the `AuthorityContext` object and is not influenced by any job content, whatever it says.
  - Combined with prior checkpoints: **50/50 pass** (`npm run test` → `node --test dist/tests/*.test.js`).
- **Typecheck evidence:** `npx tsc -p tsconfig.json --noEmit` → **pass**, strict mode, no errors.
- **Non-scope/secret/AI-Commerce isolation check:** `grep` across `src/` and `tests/` → same single pre-existing guardrail comment hit as prior checkpoints (`evidence.ts`, "rather than embedded secret material"), no actual secret value. No new dependencies.
- **Scope discipline:** `AuditEvent` and exception-state (T7) transitions remain **not implemented** — see "Next Exact Action."
- **Status after this checkpoint:** `IN_PROGRESS` (still not `IMPLEMENTED` — partial slice, not task completion). Not merged, not deployed.

## Implementation Checkpoint — AuditEvent (T10) + Minimal Exception-State Entry (T7) (2026-08-16)

- **What was implemented:** implementation-order step 7.
  - `src/domain/audit-event.ts` — `AuditEvent` value type (`eventId`/`tenantId`/`jobId`/`projectId`/`actorRef`/`eventType`/`timestamp`/optional `reason`/`relatedRefs`) + `createAuditEvent` factory + `InvalidAuditEventError`. `tenantId`/`jobId`/`projectId` are always derived from the given `OutcomeJob`, not free caller input (T10 correlation, structural). `relatedRefs` are references/locators only — the type has no field designed to hold raw secret/customer-payload content, matching `EvidenceReference`'s existing discipline.
  - `src/application/in-memory-audit-log.ts` — `InMemoryAuditLog`, append-only by construction (no update/remove method exists on the class at all — asserted by a test that checks the prototype, not just by convention), rejects re-appending a duplicate `eventId` (`DuplicateAuditEventError`), and every read requires a `TenantScope` (`findByTenant`) — no bare unscoped accessor, same structural pattern as `CustomerRepository`.
  - `src/domain/outcome-job.ts` — added `enterExceptionState(input)`, `InvalidExceptionStateEntryError`. Implements exactly the one thing the canonical source specifies about exception states (T7: entering one preserves an auditable transition reason) and nothing about exit/recovery — the source doesn't define which states an exception state returns to, so no such graph is implemented, per this checkpoint's explicit instruction. Only two preconditions are asserted, both directly implied by material already in the file rather than invented: a `CLOSED` job cannot enter an exception state (`CLOSED` already has no outbound edges in `MAIN_PATH_TRANSITIONS`), and a job already in an exception state cannot re-enter one (entry is a meaningful transition, not a no-op). `reason` is a required non-empty string, preserved verbatim on the returned `AuditEvent`.
- **Dependencies added:** none.
- **Test evidence:**
  - `tests/audit-event.test.ts` (6 cases): T10 correlation, optional `reason`/default `relatedRefs`, valid construction with both, rejects missing `eventId`, rejects non-array `relatedRefs`, rejects an empty-string element in `relatedRefs`.
  - `tests/in-memory-audit-log.test.ts` (4 cases): T10 tenant-scoped `findByTenant` (cross-tenant excluded), duplicate-`eventId` rejection, structural assertion that no `update`/`remove`/`delete` method exists on the class, empty result for an unknown tenant.
  - `tests/outcome-job-exception-state.test.ts` (8 cases): T7 entry into each of the four exception states (table-driven) preserves the reason on the `AuditEvent` and carries correct job/tenant correlation; rejects missing/empty-string reason; rejects entry from `CLOSED`; rejects re-entry from an already-exception state.
  - Combined with prior checkpoints: **68/68 pass** (`npm run test` → `node --test dist/tests/*.test.js`).
- **Typecheck evidence:** `npx tsc -p tsconfig.json --noEmit` → **pass**, strict mode, no errors.
- **Non-scope/secret/AI-Commerce isolation check:** `grep` across `src/` and `tests/` → the only hits are guardrail doc-comments (`evidence.ts`, `audit-event.ts`) explicitly documenting that these contracts must never hold secret material — no actual secret value anywhere. No new dependencies.
- **Explicitly not implemented, matching this checkpoint's own instruction:** exception-state exit/recovery transitions (`BLOCKED`/`RECOVERING`/`ESCALATED`/`STOPPED` → anywhere) — the canonical source doesn't specify this graph, so it isn't guessed. If a future task needs it, that's a new, explicitly-scoped requirement, not an extension of this checkpoint.
- **Status after this checkpoint:** `IN_PROGRESS` (still not `IMPLEMENTED` — partial slice, not task completion). Not merged, not deployed.

## Implementation Checkpoint — Step 8 (T1–T12/RG Coverage Audit) + Step 9 (Self-Review) (2026-08-16)

### T1–T12 / RG-01..RG-07 coverage map

| ID | Requirement | Covering test(s) |
|---|---|---|
| T1 | Construction rejects invalid/missing tenant scope | `tests/tenant-scope.test.ts` (7 cases) |
| T2 | Cross-tenant lookup/mutation fails closed at the authorization boundary | `tests/in-memory-customer-repository.test.ts`, `tests/project.test.ts`, `tests/outcome-job.test.ts`, **`tests/authorized-outcome-job-operations.test.ts`** (2 new cross-tenant cases — gap found and fixed this checkpoint, see below) |
| T3 | Invalid `OutcomeJob` transitions rejected | `tests/outcome-job.test.ts` (negative matrix) |
| T4 | `EXECUTING` cannot jump directly to `CLOSED` | `tests/outcome-job.test.ts` |
| T5 | `VERIFIED` fails without required evidence | `tests/outcome-job-verify.test.ts` |
| T6 | `VERIFIED` succeeds only with passing evidence | `tests/outcome-job-verify.test.ts` |
| T7 | Exception states preserve auditable reason | `tests/outcome-job-exception-state.test.ts` (all 4 states, table-driven) |
| T8 | READ-only cannot perform WRITE/EXECUTE | `tests/authority.test.ts`, `tests/authorized-outcome-job-operations.test.ts` |
| T9 | Protected action ≠ ordinary write | `tests/authority.test.ts`, `tests/authorized-outcome-job-operations.test.ts` |
| T10 | Audit events exclude secrets, preserve correlation | `tests/audit-event.test.ts`, `tests/in-memory-audit-log.test.ts` |
| T11 | Learning eligibility defaults safely | **`tests/customer.test.ts`** (2 new cases — gap found and fixed this checkpoint, see below) |
| T12 | No provider/model/commerce-platform dependency | **`tests/project-boundary-scan.test.ts`** (new, automated — previously only ad-hoc manual `grep`, see below) |
| RG-01 | Tenant scope swap fails closed | `tests/project.test.ts`, `tests/in-memory-customer-repository.test.ts`, `tests/authority.test.ts`, `tests/authorized-outcome-job-operations.test.ts` |
| RG-02 | No unscoped `getById`-style accessor | Structural/compile-time: `CustomerRepository` and `InMemoryAuditLog.findByTenant` interfaces require `TenantScope`; no bare accessor exists on either. Verified by type signature, not a runtime test (same verification-method note as the step-3 checkpoint). |
| RG-03 | Lifecycle negative matrix | `tests/outcome-job.test.ts` |
| RG-04 | Verification/audit semantic separation | `tests/outcome-job-verify.test.ts` |
| RG-05 | Authority non-escalation, adversarial fixtures | `tests/authorized-outcome-job-operations.test.ts` |
| RG-06 | Project-boundary scan (no `akilta-commerce`) | **`tests/project-boundary-scan.test.ts`** (new, automated) |
| RG-07 | Safe default / data separation | **`tests/customer.test.ts`** (new adversarial case) + `audit-event.ts`/`evidence.ts` structural guardrails + the standard grep-based secret check |

**Every T/RG item has a real, passing test or an explicitly-documented structural verification (RG-02) — none are unaddressed.**

### Self-review findings (step 9) — two real gaps found and fixed, bounded

1. **T2 / EI-4 gap: `AuthorityContext` had no tenant binding.** `authorized-outcome-job-operations.ts`'s wrappers checked only permissions, never that the caller's authority matched the target job's tenant — a real violation of the invariant already classified `IN_SCOPE / P0` two checkpoints ago. **Fix (bounded to existing files):** added `tenantId` to `AuthorityContext`, a required `tenantScope` input to `createAuthorityContext`, and `requireSameTenant` (checked first, before any permission check, so a tenant mismatch fails closed regardless of granted permissions). Wired into both `authorizedTransitionOutcomeJob` and `authorizedVerifyOutcomeJob`. New `CrossTenantAuthorityError`. 4 new tests (2 in `authority.test.ts`, 2 in `authorized-outcome-job-operations.test.ts` proving full-permission cross-tenant authority is still rejected on both operations).
2. **T11/RG-07 gap: `LearningEligibility` was never implemented**, despite being classified `PARTIALLY IN_SCOPE` in the EI-7 table since the step-5/6 checkpoint. **Fix (bounded to `customer.ts`):** added a `LearningEligibility` type (`NONE`/`CANDIDATE`/`ACTIVE`/`SUPERSEDED`/`REVOKED` — full vocabulary per DEC-122, only `NONE` reachable in this slice) and a `learningEligibility` field on `Customer`, hardcoded to `"NONE"` in `createCustomer` and **not accepted as a constructor input at all**. 2 new tests, including an adversarial one proving a smuggled `learningEligibility: "ACTIVE"` input has zero effect.
3. **T12/RG-06 were previously verified only by an ad-hoc manual `grep`** run once per checkpoint, not a repository-enforced check. **Fix:** added `tests/project-boundary-scan.test.ts` — an automated test that scans all `src/**/*.ts` for commerce-platform/AI-Commerce name patterns and asserts `package.json` declares zero runtime dependencies and only the two documented devDependencies. This is now a permanent regression test, not a one-off manual step.

No other gaps found. Re-examined EI-1..EI-7 classifications from the reconciliation checkpoint against the code as it now stands: EI-1/EI-2/EI-3/EI-5 unchanged and still accurate; **EI-4 and EI-7 are now actually backed by implementation** (previously classified correctly but under-implemented — that mismatch is exactly gaps #1 and #2 above, now closed); EI-6 now has an automated test in addition to documentation.

- **Test evidence:** **76/76 pass** (68 prior + 8 new: 2 `requireSameTenant` unit tests, 2 cross-tenant authorization-boundary tests, 2 `LearningEligibility` tests, 2 project-boundary-scan tests). `npm run test` → `node --test dist/tests/*.test.js`.
- **Typecheck evidence:** `npx tsc -p tsconfig.json --noEmit` → **pass**, strict mode, no errors (including through the `AuthorityContext`/`Customer` interface changes — all call sites across `src/` and `tests/` updated consistently).
- **Non-scope/secret/AI-Commerce isolation check:** `grep` across all of `src/` and `tests/` → same guardrail-comment hits as prior checkpoints, plus the new scan test's own pattern-definition strings (expected, not violations) — no actual secret value or commerce-platform reference anywhere. No new runtime dependencies (still zero); devDependencies unchanged (`typescript`, `@types/node`).
- **Scope discipline:** both fixes are corrections to already-built code in already-existing files (`authority.ts`, `authorized-outcome-job-operations.ts`, `customer.ts`) plus one new test-only file (`project-boundary-scan.test.ts`) — no new domain concepts, no scope expansion beyond closing gaps against requirements already recorded in this execution record. No merge to `main`, no deploy.

## Implementation Checkpoint — Step 10: Checkpoint, Draft PR, IMPLEMENTED (2026-08-16)

Implementation-order step 10 completed: final checkpoint pushed, draft PR opened, Status marked `IMPLEMENTED` (Claude's ceiling — not higher), evidence surfaced here for ChatGPT.

- **Final implementation checkpoint SHA:** `fe98edf` (`claude/AKI-BE-001-task-packet`) — unchanged from the step 8/9 checkpoint; a fresh full test run and typecheck were re-confirmed at this exact SHA immediately before opening the PR (see Test/Typecheck evidence below), so no further commit was needed to reach a clean state.
- **Draft PR:** `#2` — `https://github.com/Jay-prodesign/akil-main/pull/2`, **open, draft, not merged**. Base: `claude/AKI-GIT-001-repo-bootstrap` @ `36150adf1394349d2543c0503b2fdd39dd380aff` (not `main` — `main` doesn't yet contain the governance scaffolding this task depends on, which is tracked separately in PR #1).
- **Branch:** `claude/AKI-BE-001-task-packet`

### Changed files (full task, base commit `36150adf1394349d2543c0503b2fdd39dd380aff` → `fe98edf`)

29 files, +2470 lines (excluding this execution record itself; +2744 including it), 0 deletions:

```
package.json, package-lock.json, tsconfig.json
src/domain/tenant-scope.ts
src/domain/customer.ts
src/domain/project.ts
src/domain/outcome-job.ts
src/domain/evidence.ts
src/domain/verification-result.ts
src/domain/authority.ts
src/domain/audit-event.ts
src/ports/customer-repository.ts
src/application/in-memory-customer-repository.ts
src/application/authorized-outcome-job-operations.ts
src/application/in-memory-audit-log.ts
tests/tenant-scope.test.ts, tests/customer.test.ts, tests/project.test.ts,
tests/in-memory-customer-repository.test.ts, tests/outcome-job.test.ts,
tests/outcome-job-verify.test.ts, tests/outcome-job-exception-state.test.ts,
tests/evidence.test.ts, tests/verification-result.test.ts,
tests/authority.test.ts, tests/authorized-outcome-job-operations.test.ts,
tests/audit-event.test.ts, tests/in-memory-audit-log.test.ts,
tests/project-boundary-scan.test.ts
```

### T1–T12 + RG-01..RG-07 evidence (final)

Full coverage map already recorded in the step 8/9 checkpoint above — unchanged and still accurate, re-verified at this SHA. Summary: 12/12 T-items and 7/7 RG-items each have a real passing test, except RG-02 which is a documented structural/compile-time verification (interface signatures require `TenantScope`; no bare accessor exists).

### Test/typecheck evidence (re-confirmed at `fe98edf` immediately before this checkpoint)

- `npm run test` → `node --test dist/tests/*.test.js`: **76/76 pass**, 0 fail, 0 skipped.
- `npx tsc -p tsconfig.json --noEmit`: **pass**, strict mode, no errors.
- `grep` across `src/` and `tests/` for `akilta-commerce`/`shopify`/`ticimax`/`ikas`/`ideasoft`/`t-soft`/`woocommerce`/`password`/`api key`/`secret`/private-key markers: only guardrail doc-comments and the scan test's own pattern-name strings — no actual secret or commerce-platform reference.
- `package.json`: zero runtime `dependencies`; `devDependencies` exactly `{"@types/node", "typescript"}`.

### QA Evidence Bundle (Definition of Done requirement, for ChatGPT review)

- Task ID: `AKI-BE-001`. Acceptance criteria: this file's Scope/Non-Scope/T1–T12/RG-01..RG-07/EI-1..EI-7 sections above.
- Base SHA: `36150adf1394349d2543c0503b2fdd39dd380aff`. Final checkpoint SHA: `fe98edf`.
- PR: `#2`, full diff available there.
- Changed-file list: above.
- Strict TypeScript/typecheck/build results: pass (above).
- Complete T1–T12 results: pass, mapped above.
- Affected contracts/interfaces: `TenantScope`, `Customer` (+ `LearningEligibility`), `Project`, `OutcomeJob` (+ lifecycle/transition/verify/exception-entry), `EvidenceReference`, `VerificationResult`, `AuthorityContext` (+ tenant binding), `AuditEvent`, `CustomerRepository` port, `InMemoryCustomerRepository`, `InMemoryAuditLog`, `authorizedTransitionOutcomeJob`/`authorizedVerifyOutcomeJob`.
- Dependency/package-lock delta: `typescript`, `@types/node` (devDependencies only); `package-lock.json` committed.
- Secret/non-scope/AI-Commerce isolation result: clean (above), now enforced by an automated test.
- Known limitations: exception-state exit/recovery transitions are not implemented (canonical source doesn't specify that graph); `Organization`/multi-workspace hierarchy deferred (per source); production storage/HTTP/auth/queue/cloud all deferred (by design, this is a domain kernel only).
- Engineer status: `IMPLEMENTED`, not higher.

## Correction Checkpoint — ChangesRequired Remediation (2026-08-17)

### Provenance

A genuine `CHANGES_REQUIRED` verification result against final checkpoint SHA `d7ba2c3e22ee7638494fe2391a246efe98ca743c` was independently cross-referenced across three real, recently-modified Google Drive documents before any code was touched:

- Canonical AKI-BE-001 task packet (`1qpHJVdE7qIrDBynbD7fkNZwIiVCtR7XfFcEqnl9b47A`) — prepended "AKI-BE-001 CORRECTION ASSIGNMENT — 17 AUGUST 2026 — CURRENT / SUPERSEDING" section, modified `2026-08-17T10:09:11.126Z`.
- Current Project State (`1mXuoY0pcdfOMpS7j8CRxws_qYe8jPfOIwmQhgIxjpu0`) — "AKI-BE-001 CORRECTION AUTHORIZATION RECONCILIATION" and "AKI-BE-001 CHATGPT VERIFICATION" sections, modified `2026-08-17T10:09:23.509Z`.
- ChatGPT Verification Result — CHANGES_REQUIRED — d7ba2c3 (`10xsB9LtJZdIvWj9zk68q1FW7iFqvDeDUPSVc6JjCvPY`), created `2026-08-17T09:06:21.274Z`, in the same Drive folder this task's own QA evidence bundle was uploaded to.

Both findings were independently re-derived against the actual source code at `d7ba2c3` before being trusted, per this task's standing discipline of not acting on unverified claims.

### Findings and bounded fixes

1. **P0 — tenant/evidence correlation gap.** `EvidenceReference` and `VerificationResult` carried no `tenantId`; `createVerificationResult` and `verifyOutcomeJob` checked only `jobId` equality. Two tenants reusing the same `jobId` string could cross-contaminate verification evidence — a real EI-4 violation. **Fix (bounded to `evidence.ts`, `verification-result.ts`, `outcome-job.ts`):** both types now carry `tenantId` derived structurally from their `OutcomeJob`; `createVerificationResult` rejects `evidence.tenantId !== job.tenantId`; `verifyOutcomeJob` rejects `verificationResult.tenantId !== job.tenantId`. 2 new adversarial tests use colliding `jobId` values across two distinct tenants to prove the check is independent of (not substitutable by) `jobId` equality.
2. **`enterExceptionState` had no runtime validation of `to`.** It was type-only (`ExceptionState` union), so a forged/untyped `to: "VERIFIED"` would silently set `job.state = "VERIFIED"`, bypassing the `verifyOutcomeJob` evidence gate (T5/T6/RG-04) entirely. **Fix (bounded to `outcome-job.ts`):** `to` is now `unknown` at the function boundary, runtime-validated against exactly `BLOCKED`/`RECOVERING`/`ESCALATED`/`STOPPED` before any mutation, throwing `InvalidExceptionStateEntryError` otherwise. 4 new negative tests: forged `to: "VERIFIED"`, forged `to: "CLOSED"`, an arbitrary invalid string, and an explicit assertion that the job's state is unchanged after a rejected attempt.

No other gaps found or fixed. No files touched beyond `evidence.ts`, `verification-result.ts`, `outcome-job.ts`, and their three corresponding test files.

### Correction checkpoint SHA

**`8eebfebd4cf78a352886970822bd0be6008fd703`** (`claude/AKI-BE-001-task-packet`, pushed on top of `d7ba2c3` — existing PR #2, no new branch/PR).

### Test/typecheck evidence (re-confirmed at `8eebfeb`)

- `npm run test` → `node --test dist/tests/*.test.js`: **82/82 pass** (76 prior + 6 new), 0 fail, 0 skipped.
- `npx tsc -p tsconfig.json --noEmit`: **pass**, strict mode, no errors.
- `grep` across `src/` and `tests/` for `akilta-commerce`/`shopify`/`ticimax`/`ikas`/`ideasoft`/`t-soft`/`woocommerce`/`password`/`api key`/`secret`/private-key markers: only guardrail doc-comments — no actual secret or commerce-platform reference.
- `package.json`: zero runtime `dependencies`; `devDependencies` unchanged (`@types/node`, `typescript`).
- `git status`: clean after commit; no other files modified.

### Status

`IMPLEMENTED` (unchanged — this is a correction to an already-`IMPLEMENTED` checkpoint, not a status advance; `VERIFIED`/`COMPLETED` remain outside Claude's authority per `AGENTS.md` §10).

## Blocked On

Nothing on the engineering side. Blocked only on ChatGPT's independent review of the correction checkpoint (`8eebfeb`) / refreshed QA evidence to move to `VERIFIED`/`COMPLETED` — that transition is not available to Claude (`AGENTS.md` §10).

## Next Exact Action

ChatGPT / AKILTA Brain to review the correction checkpoint at `8eebfeb` on PR #2 and issue a repository-recorded re-verification (a PR #2 comment/review). No further engineering work is authorized on AKI-BE-001 until that review lands or a new bounded task is explicitly assigned. Do not merge PR #2. Do not deploy. Do not begin a subsequent module/task under this record.
