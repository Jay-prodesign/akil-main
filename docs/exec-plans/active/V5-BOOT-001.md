# V5-BOOT-001 — Project/Repository Bootstrap Template Resolution

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor; V5 Full Blueprint (Drive `1HfQ8Mzbos63LZPE_vZryd4TiLyfa8GFP_AdtmLR-el8`, R22 + R32 hot-buffer overlay) §7 Workstream C (Project / Repository Bootstrap & Durable Execution State).
- **Selection reasoning**: Brain Rev42 (independently fresh-read from the canonical Handoff document before acting) confirmed the standing authorization to run a fresh DEC-160/V5 dependency scan after PR #12's post-merge acceptance and select the highest-value dependency-safe unit. That scan reconfirmed V4 Workstreams C-H remain blocked (no real external provider/effect adapter, OAuth connector, or SDK exists anywhere in `src/`) and V5 Workstream B (Worker/Model Routing) remains blocked (`EngineeringRole` only distinguishes `WORKER`/`BRAIN`/`OWNER`; DEC-142 still forbids Codex admission pre-V1; no multi-provider capability registry or evaluation evidence exists to route against). V5 Workstream C, previously recorded by Brain Rev35 as `ELIGIBLE_NOT_SELECTED` on the reasoning that it was "architecturally larger" than the V5-A/D floor, is reconsidered here: its §7 acceptance criteria (cross-project state contamination tests, stale-template-cannot-override-truth, secret/customer-cloning prohibition, unique project identifiers) can be modeled and adversarially tested as a **pure planning function** over synthetic project namespaces — a real second live repository was never actually a stated entry predicate (the same correction Rev35 already made when it withdrew the "only one project/repository exists" BLOCKED reasoning).
- Branch: `claude/v5-boot-001-bootstrap-template`, cut fresh from merged `main` after PR #12.
- `BASE_PROVENANCE_SHA`: `19df961498896427223842f7de82df2d9f6a8304` (merged main, PR #12).

## Goal

Provide a pure, side-effect-free planning function that resolves what a new project may reuse from an existing project's structural scaffolding (navigation docs, state/map/contract files, task templates, evidence/review schemas, registry pointers) without ever copying mutable project truth, customer data, secrets, or authority, and without requiring a real second live repository to exist in order to prove the acceptance criteria.

## Scope (this checkpoint)

- `src/domain/project-bootstrap-template.ts`:
  - `BootstrapAssetKind` — a closed union of exactly the eleven reusable asset categories the blueprint's §7 text names verbatim (AGENT_NAVIGATION, CURRENT_STATE, SYSTEM_MAP, VERSION_EVOLUTION_MAP, DEPENDENCY_MAP, EXECUTION_CONTRACT, TASK_TEMPLATE, EVIDENCE_MANIFEST, REVIEW_FINDING_SCHEMA, PROVIDER_CAPABILITY_REGISTRY_POINTER, PROTECTED_GATE_MAP). No "credential" or "provider secret" kind exists in the enum — the closed set is itself the enforcement mechanism for "bootstrap never creates production credentials/providers/release authority by default."
  - `BootstrapTemplateAsset` / `BootstrapTemplateSource` — an asset carries only an opaque `contentRef` pointer, `sourceProjectRef`/`sourceVersion` provenance, and a `localApplicability` decision (`"ACCEPTED" | "NOT_APPLICABLE"`, see Rev43 correction below); this module never reads, interprets, or executes whatever `contentRef` points to.
  - `resolveProjectBootstrapPlan(request)` — pure function. Fails closed (`InvalidProjectBootstrapRequestError`) on an empty/whitespace `targetProjectNamespace` or one that collides with a caller-supplied `existingProjectNamespaces` list (project identifiers remain unique). An asset is accepted into `copiedAssets`, stamped `supersedesLocalAuthority: false` (a literal type, not a settable field — a copied asset can never claim authority over the target project's own current truth), only if all three hold: its `kind` is in the closed set, its `sourceProjectRef`/`sourceVersion` provenance is non-empty, and its `localApplicability` decision is `"ACCEPTED"`. Any asset failing one of these is rejected with a reason, never copied.

## Rev43 correction (post-submission, same branch)

Brain Rev43 exact-head review of the original submission (head `4df83393002c62323fb5c277c5b1766eb5d14b62`) returned `CHANGES_REQUIRED — MATERIAL ACCEPTANCE COMPLETENESS`, independently confirmed against the actual source before acting:

- **F1 — provenance fail-closed gap**: the original per-asset loop validated `kind` recognition only; an asset with a recognized `kind` but empty/whitespace `sourceProjectRef`/`sourceVersion` could be copied and presented as accepted reusable structure, even though positive test B6 only proved verbatim preservation, not fail-closed rejection of missing provenance. Fixed by rejecting any asset whose provenance fields are empty/whitespace (tests B9, B10).
- **F2 — local applicability not modeled**: the original contract only stamped `supersedesLocalAuthority: false`; no field represented the §7-required "revalidated for local applicability" decision, so a recognized `kind` alone was sufficient for acceptance — the doc comments claimed revalidation but the executable contract did not enforce it. Fixed by adding a required `localApplicability: "ACCEPTED" | "NOT_APPLICABLE"` field on `BootstrapTemplateAsset`; only `"ACCEPTED"` assets can enter `copiedAssets` (tests B11, B12). No external I/O, no provider coupling, no second state system — the decision is supplied by the caller and enforced deterministically by the existing pure function.

Both findings were empirically verified against the live source (not just accepted from Brain's framing) before implementing the fix, consistent with this corridor's standing verification discipline.

## Explicitly deferred (not invented)

No filesystem write, no repository/project creation, no network call, no destination-repo mutation of any kind — the module has zero imports and is pure planning output only. No registry lookup for existing project namespaces (the caller supplies them; this module has no independent registry access, matching every other domain module's `src/domain/` isolation). No secret/credential asset kind exists to select, so "never creates production credentials/providers/release authority by default" is enforced structurally, not by a runtime check that could be bypassed.

## Architecture / semantic invariants (verified by test)

- Every copied asset is stamped `supersedesLocalAuthority: false`, a literal `false` type — no caller input can make a copied asset claim current authority over a target project.
- An unrecognized/fabricated asset `kind` (e.g. a hypothetical `PRODUCTION_CREDENTIAL`) is rejected into `rejectedAssets`, never copied.
- `targetProjectNamespace` uniqueness is enforced against the caller-supplied `existingProjectNamespaces` list; a collision throws rather than silently reusing or colliding with an existing project's state.
- Two projects bootstrapped from the same shared template source produce fully independent plan objects (no shared mutable array/object reference) — proves cross-project isolation without needing two real repositories.
- `contentRef` is forwarded verbatim, including a string shaped like executable code, proving the module never interprets or executes it.
- `sourceProjectRef`/`sourceVersion` provenance survives unchanged on every copied asset.

## Hard Non-Scope

No filesystem/child_process/network import (verified by boundary scan); no provider/model hard-coding; no secret/credential material; no execution of the resolved plan (a separate, explicitly protected concern if ever built); no merge/deploy/release/production/publication/customer-binding/legal/financial action anywhere in this checkpoint's source.

## Test Coverage

| Test | §7 acceptance direction | Covered in |
|---|---|---|
| Valid request copies every recognized asset kind, each stamped `supersedesLocalAuthority: false` | reusable structure only, no authority transfer | `tests/project-bootstrap-template.test.ts` (B1) |
| Colliding `targetProjectNamespace` fails closed | project identifiers remain unique | `tests/project-bootstrap-template.test.ts` (B2) |
| Unrecognized/fabricated asset kind rejected, not copied | secret/customer artifact cloning prohibited | `tests/project-bootstrap-template.test.ts` (B3) |
| Two projects sharing a template produce isolated, non-shared plan objects | cross-project state contamination tests | `tests/project-bootstrap-template.test.ts` (B4) |
| `contentRef` forwarded verbatim, never interpreted | opaque pointer, not executable content | `tests/project-bootstrap-template.test.ts` (B5) |
| Source/version provenance preserved on every copied asset | imported decisions identify source/version | `tests/project-bootstrap-template.test.ts` (B6) |
| Empty/whitespace namespace fails closed | input validation, fail-closed discipline | `tests/project-bootstrap-template.test.ts` (B7) |
| Zero-asset template resolves an empty plan, not an error | no fabricated minimum-asset requirement | `tests/project-bootstrap-template.test.ts` (B8) |
| Empty `sourceProjectRef` rejected despite recognized kind (Rev43 F1) | imported decisions identify source/version, fail-closed | `tests/project-bootstrap-template.test.ts` (B9) |
| Whitespace-only `sourceVersion` rejected despite recognized kind (Rev43 F1) | imported decisions identify source/version, fail-closed | `tests/project-bootstrap-template.test.ts` (B10) |
| `localApplicability: "NOT_APPLICABLE"` rejected despite recognized kind + valid provenance (Rev43 F2) | revalidated for local applicability, not kind-alone acceptance | `tests/project-bootstrap-template.test.ts` (B11) |
| `localApplicability: "ACCEPTED"` asset retains provenance + `supersedesLocalAuthority: false` (Rev43 F2) | revalidated-and-accepted assets remain correctly structured | `tests/project-bootstrap-template.test.ts` (B12) |
| No secret material / provider-model hard-coding | general hygiene | `tests/v5-boot-001-boundary-scan.test.ts` |
| Zero imports (no filesystem/child_process/network/sibling-domain coupling) | pure planning, no side effect | `tests/v5-boot-001-boundary-scan.test.ts` |
| No fabricated credential/provider-secret literal anywhere in source | structural, not runtime, enforcement | `tests/v5-boot-001-boundary-scan.test.ts` |
| Module exports exactly the expected planning surface | no execution/mutation function exported | `tests/v5-boot-001-boundary-scan.test.ts` |
| Zero new runtime dependency | dependency delta disclosed | `tests/v5-boot-001-boundary-scan.test.ts` |

## Evidence

- Original submission (head `4df8339`): `npx tsc --noEmit -p .` exit 0; `npm run test` 597/597 pass (584 pre-existing + 13 new).
- Rev43-corrected head: `npx tsc --noEmit -p .` exit 0, strict mode, zero errors. `npm run test`: **601/601 pass**, 0 fail, 0 skipped (597 prior + 4 new: B9, B10, B11, B12 in `project-bootstrap-template.test.ts`).
- `package.json`: zero new runtime or dev dependency (unchanged by Rev43 correction).
- Files touched (Rev43 round): `src/domain/project-bootstrap-template.ts`, `tests/project-bootstrap-template.test.ts`, this exec-plan.

## Status

**IMPLEMENTED / SELF-VALIDATED** (Rev43-corrected) — pending fresh Brain independent exact-head re-review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires a separately granted protected owner-gate, never inferred from any prior PR's grant.
