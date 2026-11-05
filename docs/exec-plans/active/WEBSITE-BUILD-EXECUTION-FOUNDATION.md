# WEBSITE_BUILD execution foundation — real-content artifact store + real AI-provider transport

## Provenance

Founder directive (2026-11-05): complete AKILTA's approved canonical scope as a genuinely working product, not just domain code — specifically, a real end-to-end flow where a customer buys a package, AKILTA executes real work via Claude/ChatGPT, the customer reviews the output, and delivery happens. Explicit instruction: don't wait for a live public site; build real integrations and end-to-end flows in a secure test environment, within current authority; don't turn technical implementation choices into Founder decisions; only real authority/spend/credential/commercial-policy/production-activation decisions need Founder approval.

## Why this is dependency-safe (no owner gate crossed)

Investigation (this checkpoint, not re-litigating prior gap-scans) found the `WEBSITE_BUILD` job family's domain-layer lifecycle is already fully composed and tested end to end — `tests/cxp-001a-composed-lifecycle.test.ts` proves DRAFT→QUALIFIED→READY→(`ServiceCatalogAdmission` with `executionRoutingPolicy: "MANUAL_EXECUTION_ALLOWED"`)→EXECUTING→VERIFYING→VERIFIED using real fixtures (`website-build-v1-recipe-binding.ts`). The `MANUAL_EXECUTION_ALLOWED` admission path does **not** require D15 (worker-admission root-of-trust) to be resolved for production — it only requires an already-reviewed Family 1 `ServiceCatalogAdmission`, which this checkpoint does not touch or decide.

What was genuinely missing, confirmed by direct inspection, not assumption:
1. No HTTP entry point anywhere exposes this composed lifecycle to a caller (`grep` across `src/web/` for order intake: zero matches).
2. `EvidenceReference` (`evidence.ts`) is deliberately a locator-only type ("source/reference locator rather than embedded secret material") — there was nowhere to put the actual generated content a real execution step produces.
3. `ConnectorTransport` (`connector-execution.ts`) is a real, already-reviewed execution boundary with a concrete `ANTHROPIC` connector definition already defined (`prebuilt-connector-definitions.ts`, `baseUrl: https://api.anthropic.com/v1`, `/messages` endpoint) — but zero real adapter implementing it exists; every existing test uses a mock.

This checkpoint closes gaps 2 and 3 only (the two pieces of genuinely new, bounded infrastructure). Gap 1 (HTTP wiring) and the service-catalog-admission/execution-routing composition are explicitly **not** done here — tracked as the next checkpoints in the same initiative (tasks #50-52, #54-55).

## A real synchronous HTTP transport, honoring the existing interface exactly

`ConnectorTransport.execute()` is synchronous (`(request) => ConnectorTransportResponse`, not `Promise`) — every existing caller and mock in this repository already relies on that. Node has no built-in synchronous network I/O, so a real adapter against this exact interface cannot use `fetch`/`node:https` without either an unsupported event-loop block or widening the interface to `Promise` — which would be a new architecture decision touching an already multiply-Brain-reviewed module (`connector-execution.ts`) and every existing caller, not "dark/internal adapter implementation" (Rev94 F3's own stated floor). Instead, `HttpConnectorTransport` (`src/domain/connector-transport-http.ts`) shells out to `curl` via `node:child_process.execFileSync` — one real, genuinely synchronous HTTP request per call, zero new runtime dependency (a subprocess, not an npm package), zero change to `connector-execution.ts` or any existing caller. No credential is wired in by this module; `authSecretValue` arrives from the caller's own `SecretResolver` at the moment of execution, same as every other transport.

`EnvSecretResolver` (`src/domain/connector-secret-resolver-env.ts`) is the simplest real `SecretResolver` honest for this repository's current durability tier: resolves a `secretRef` id to the identically-named environment variable. No KMS/Vault exists yet (D2/D3's own gap) — swappable later for a real secret-manager-backed resolver without any caller changing.

**No credential is activated by this checkpoint.** `HttpConnectorTransport`'s default `runCurl` is never invoked by this checkpoint's own tests (a deterministic double is injected in every test); nothing in this PR sets `ANTHROPIC_API_KEY` or any other secret, and no route in this PR calls `executeConnectorCapability` at all yet. This is the real adapter, inert until D3 supplies a credential and a later checkpoint wires a real `ConnectorConnectionInstance`/route to it.

## WorkArtifact — the real deliverable content

`src/domain/work-artifact.ts` (`WorkArtifact`/`createWorkArtifact`) and `src/domain/durable-work-artifact-store.ts` (`FileDurableWorkArtifactStore`) hold the actual generated content an execution step produces — the piece `EvidenceReference` deliberately never holds. `workArtifactLocator()` mints the `artifact://{tenantId}/{artifactId}` string an `EvidenceReference.sourceLocator` is expected to point at once a `WorkArtifact` exists for a job, reusing the exact composed verification step `cxp-001a-composed-lifecycle.test.ts` already proves (`createEvidenceReference` → `createVerificationResult` → `authorizedVerifyOutcomeJob`) without inventing a second one.

The store mirrors `durable-evidence-reference-store.ts`'s exact established discipline verbatim (per-tenant JSON file, `linkSync` cross-process lock, shared `coherenceViolation` check at both write and replay, full structural revalidation, `Object.create(null)` prototype-pollution defense, stale-lock reclaim) — one deliberate difference: `content` is validated only as "non-empty after trim," never required to already be canonically pre-trimmed itself, since real generated text legitimately carries interior whitespace and a trailing newline.

## Test coverage

- `tests/durable-work-artifact-store.test.ts` (12 tests): constructor validation, round-trip, idempotent replay, conflict on a differing record, invalid-record rejection (zero bytes committed), `listByTenant`, cross-tenant isolation, restart-safety, a 10-case adversarial corrupted-line sweep, poisoned-file isolation, stale-lock reclaim.
- `tests/connector-transport-http.test.ts` (12 tests): successful 2xx round-trip with parsed JSON data; exact curl invocation shape (method/URL/headers/payload); per-connector-kind auth header selection (`ANTHROPIC` `x-api-key`+`anthropic-version` vs. Bearer default); 401/403 → `AUTHORIZATION_FAILED` (never `TRANSPORT_ERROR`, never surfaces the body as `data`); any other non-2xx → `TRANSPORT_ERROR`; empty-body 2xx; non-JSON body; missing status delimiter; no `baseUrl`; a throwing `runCurl` never leaks its own message (adversarially planted secret value confirmed absent from the returned error); `extractAnthropicMessageText`'s happy path plus 10 shape-deviation cases, all returning `undefined` rather than throwing.
- `tests/connector-secret-resolver-env.test.ts` (3 tests): resolves a set env var, throws `MissingEnvSecretError` on unset/empty, error message never includes the secret value (there is none to include — only the var name).

## Evidence

- `rm -rf dist && npx tsc -p tsconfig.json`: exit 0, strict mode, zero errors.
- `node --test dist/tests/*.test.js`: **3597/3597 pass** (3570 baseline + 27 new), after one confirmed pre-existing flake re-run clean (`KNOWLEDGE-EVIDENCE-DURABLE-001` CI correction's own real-OS-process concurrency witness — the exact known-flake class the standing mandate's own operational lessons name, unrelated to this PR's files).
- Zero new npm dependency (`package.json`/`package-lock.json` untouched).

## Status

**IMPLEMENTED / SELF-VALIDATED** — requesting independent fresh-context review (isolated worktree) per REV216/REV218 before merge; this is real code, not docs-only. `MERGE_DISPOSITION`: self-merge on independent PASS, per the standing mandate's established pattern — no security/authority/commercial/spend/provider/live-activation decision was made unilaterally (no credential is activated; the HTTP transport's real path is never exercised by any test or route in this PR).

Next checkpoints in the same initiative (not done here): dark/test order-intake HTTP route, test-fixture `ServiceCatalogAdmission` authority, `ExecutionRoutingRequirement` wiring, closure-approval route, end-to-end composed test.

## Checkpoint 2 — the real DRAFT→VERIFIED→CLOSED orchestration

Investigation (this checkpoint) found that dynamically re-compiling a blueprint into a plan/recipe/job set per incoming customer request is its own large, separate subsystem (`plan-admission.ts`, `delivery-recipe-plan-binding.ts`, `outcome-job-wiring.ts`, each composing `project-plan.ts`/`project-plan-validation.ts`/`admission-readiness.ts`/`approval-reference.ts`) - genuinely out of scope for proving the execution/review/delivery loop itself. This repository's own "DEL-003 Reference Proof" convention already settles this the same way: "exactly one bounded WEBSITE_BUILD_v1 blueprint/fixture... without implementing any of those downstream systems." `src/fixtures/website-build-v1-recipe-binding.ts` already exports the one, real, admission/wiring-proven lineage (`WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START`, `_SPECS`, `_ADMISSION`, `WEBSITE_BUILD_V1_BOUND_JOBS`) that `tests/cxp-001a-composed-lifecycle.test.ts` already carries through DRAFT→VERIFIED. This checkpoint reuses that exact lineage rather than re-deriving a general dynamic compiler - "the customer's business info" maps onto the AI prompt's own input content, not a freshly-compiled plan.

`src/application/website-build-dark-execution.ts` (`runWebsiteBuildDarkExecution`, `approveWebsiteBuildDarkDelivery`) sequences, in the exact order `cxp-001a-composed-lifecycle.test.ts` already proves, only ALREADY-REVIEWED boundaries: `authorizedTransitionOutcomeJob` (DRAFT→QUALIFIED→READY→EXECUTING→VERIFYING), `admitManualExecutionAllowedFromServiceCatalogAdmission`, checkpoint 1's real `executeConnectorCapability`/`HttpConnectorTransport`, `createWorkArtifact`/`FileDurableWorkArtifactStore`, `createEvidenceReference`, `createVerificationResult`, `authorizedVerifyOutcomeJob`, and - extending the proof one step further than the existing test does - `createClosureApprovalReference`/`authorizedCloseOutcomeJobWithApproval` for the real "customer reviews and approves delivery" step. No new authority rule is added; nothing existing is relaxed.

Test coverage (`tests/website-build-dark-execution.test.ts`, 4 tests): the full successful chain (DRAFT→...→VERIFIED→CLOSED) with a real `WorkArtifact` recorded carrying the mock-provider's generated text, the resolved secret reaching the transport but never leaking into the result; no-extractable-text failure (throws, nothing recorded); a wrong-tenant authority failing closed before any connector call; the closure-approval step.

Evidence: clean rebuild, **3601/3601 passing** (3597 baseline + 4 new, one confirmed pre-existing flake re-run clean), zero new dependency.

Still not done, next checkpoints: the dark/test HTTP route wrapper around this orchestration (so it is reachable at all) and an actual customer-facing "submit a brief" surface - this checkpoint proves the orchestration function itself, not yet its HTTP exposure.

## Checkpoint 3 — the dark/test HTTP route, reachable at all

`src/web/website-build-dark-route.ts` (`createWebsiteBuildDarkRequestHandler`) is the thin HTTP surface this initiative was still missing: a transport-agnostic handler (`IncomingRequestLike` -> `OutgoingResponseLike`, the same shapes `request-handler.ts` already established - this module never imports `node:http`) over two routes, `POST /dark/website-build/execute` and `POST /dark/website-build/approve`. It adds no new domain/application logic - every call still goes straight through checkpoint 2's `runWebsiteBuildDarkExecution`/`approveWebsiteBuildDarkDelivery`, unmodified.

`requirementId` selects among the fixed, already-admitted `WEBSITE_BUILD_v1` reference jobs (`website-build-v1-recipe-binding.ts`); the customer-supplied `briefText` becomes the AI prompt's own input content - this still does not dynamically compile a blueprint/plan per request, matching checkpoint 2's own DEL-003 Reference Proof reasoning. A single fixed, full-access `darkAuthority()` stands in for session/customer authentication - there is none here, deliberately, matching `internal-os-review-fixtures.ts`'s own "review fixtures only reachable from the dev entrypoint" discipline.

**DELIBERATELY DARK, NEVER PRODUCTION.** `tests/website-build-dark-route-boundary.test.ts` proves `src/web/http-server.ts` and `src/runtime/node-server-entrypoint.ts` never import this module, mirroring the existing `OS-V0-08` boundary-scan convention for `internal-os-review-fixtures.ts`.

The one genuinely new piece of state: an in-process `Map<jobId, OutcomeJob>` holding a job once it reaches `VERIFIED`, awaiting the separate approval call. This is intentionally NOT durable - a real "pending customer review" durable primitive is its own, separately-scoped future checkpoint; losing it on restart is an accepted, disclosed limitation of a single-process test harness, not a silent gap.

Test coverage:
- `tests/website-build-dark-route.test.ts` (6 tests): the full execute -> approve round trip over HTTP-shaped requests reaching CLOSED; 400 for a malformed body / missing `requirementId` / missing or blank `briefText`; 404 for an unknown `requirementId`; 502 when the connector response carries no extractable text (and nothing is left stored for approval); 400 for a malformed approve body / missing `jobId` / missing `approverRef`, 404 for an unknown `jobId`; 404 for an unmatched path/method and for a second approve on an already-closed job.
- `tests/website-build-dark-route-boundary.test.ts` (4 tests): `http-server.ts` and `node-server-entrypoint.ts` never import this module; the module itself never imports `node:http` and only imports the shared transport-agnostic types from `request-handler.ts`; its exported surface is exactly the three expected names.

Evidence: clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`, exit 0), **3612/3612 passing** (3602 baseline + 10 new), zero new dependency.

Still not done: an actual dev-main bootstrap script wiring a real `ANTHROPIC_API_KEY` end to end over a real socket (D3 - a real credential - remains the one genuinely Founder-gated decision for that). The full order -> admission -> real-shaped execution -> AI output -> review -> delivery loop is now provably complete and HTTP-reachable in the dark/test environment with a mock transport; swapping the mock for `HttpConnectorTransport` plus a real `EnvSecretResolver`-backed `ANTHROPIC_API_KEY` is the only remaining step to make it genuinely live, and that step is exactly D3.
