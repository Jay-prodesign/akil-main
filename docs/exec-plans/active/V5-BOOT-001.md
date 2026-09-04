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
  - `BootstrapTemplateAsset` / `BootstrapTemplateSource` — an asset carries only an opaque `contentRef` pointer plus `sourceProjectRef`/`sourceVersion` provenance; this module never reads, interprets, or executes whatever `contentRef` points to.
  - `resolveProjectBootstrapPlan(request)` — pure function. Fails closed (`InvalidProjectBootstrapRequestError`) on an empty/whitespace `targetProjectNamespace` or one that collides with a caller-supplied `existingProjectNamespaces` list (project identifiers remain unique). Accepts every asset whose `kind` is in the closed set, stamping it `supersedesLocalAuthority: false` (a literal type, not a settable field — a copied asset can never claim authority over the target project's own current truth); rejects (with a reason, not a copy) any asset whose `kind` falls outside the closed set.

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
| No secret material / provider-model hard-coding | general hygiene | `tests/v5-boot-001-boundary-scan.test.ts` |
| Zero imports (no filesystem/child_process/network/sibling-domain coupling) | pure planning, no side effect | `tests/v5-boot-001-boundary-scan.test.ts` |
| No fabricated credential/provider-secret literal anywhere in source | structural, not runtime, enforcement | `tests/v5-boot-001-boundary-scan.test.ts` |
| Module exports exactly the expected planning surface | no execution/mutation function exported | `tests/v5-boot-001-boundary-scan.test.ts` |
| Zero new runtime dependency | dependency delta disclosed | `tests/v5-boot-001-boundary-scan.test.ts` |

## Evidence

- `npx tsc --noEmit -p .`: exit 0, strict mode, zero errors.
- `npm run test`: **597/597 pass**, 0 fail, 0 skipped (584 pre-existing/unchanged + 13 new: 8 in `project-bootstrap-template.test.ts`, 5 in `v5-boot-001-boundary-scan.test.ts`).
- `package.json`: zero new runtime or dev dependency.
- Files touched: `src/domain/project-bootstrap-template.ts` (new), `tests/project-bootstrap-template.test.ts` (new), `tests/v5-boot-001-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`, `docs/architecture/VERSION_EVOLUTION_MAP.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending fresh Brain independent verification at the exact head. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires a separately granted protected owner-gate, never inferred from any prior PR's grant.
