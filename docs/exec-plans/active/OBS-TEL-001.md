# OBS-TEL-001 — Provider-Neutral Observability / Telemetry Floor (Rev98 Family 6)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Brain's Rev98 Handoff revision lists twelve "MANDATORY POST-FOUNDATION REOPEN / DISPOSITION FAMILIES." This checkpoint is Family 6: *"PROVIDER-NEUTRAL OBSERVABILITY / TELEMETRY FLOOR. This is a prerequisite exposed by current implementation: V5-EVAL-001 explicitly deferred post-adoption monitor because no telemetry/observability system exists, while V4 evidence/outcome and optimization semantics require freshness/comparable evidence. Implement the smallest repo-native telemetry/health/evidence contract and read model needed to represent source, metric definition/unit/window, freshness, quality/confidence, missing-vs-zero and monitored state without fabricating provider data. No vendor monitoring account or live ingestion is required for the dark floor."*
- **Selection reasoning**: with Rev101's three bounded corrections (PR #41/#42/#43) applied and LOCAL-EXEC-002 (Device Bridge MVP) implemented, this checkpoint continues Rev101's own "AFTER BOUNDED CORRECTIONS" dependency scan across Rev98 Families 1,2,5-12. Family 6 was selected next because, unlike `LOCAL-EXEC-003` (which requires a fresh dependency-fit ADR against the *current* official OpenAI Codex CLI/SDK behavior — genuinely external, time-sensitive research this checkpoint is not positioned to safely fabricate) and Families 1/2/5/7-12 (each of which composes or depends on this very telemetry floor, or on the still-open Family 2 trusted-ingress boundary), Family 6 is self-contained, requires no external provider research, and is explicitly named by Rev98 as the prerequisite several other families and the already-merged `V5-EVAL-001` are blocked on.
- Branch: `claude/obs-tel-001-telemetry-floor`, cut fresh from `main` at `3226c76fa338e425e553638e5f5f48924182a1c0` — an independent Rev98 family with no dependency on any in-review branch, so the standard "fresh from main" convention applies (unlike `LOCAL-EXEC-002`, which directly composed `LOCAL-EXEC-001`'s own not-yet-merged contracts).

## Scope (this checkpoint)

`src/domain/observability-telemetry.ts` — the smallest repo-native contract set proving every acceptance dimension Rev98 names, without ever fabricating a value the caller did not supply:

- **Source**: `sourceRef` is an opaque, caller-supplied pointer to wherever an observation actually came from (a connector, a manual entry, an internal computation) — this module never interprets it, matching this codebase's established "opaque ref" discipline.
- **Metric definition/unit/window**: `MetricDefinition`/`createMetricDefinition` binds a `metricRef` to exactly one `MetricUnit` (a closed vocabulary: `COUNT`/`CURRENCY_MINOR_UNITS`/`PERCENTAGE`/`DURATION_MS`/`RATIO`/`BYTES`) for its lifetime — "incomparable-metric separation" (V4 Workstream E's own phrasing for the same concern): two observations are only comparable if they share the same definition, never merely the same string ref. `MetricWindow`/`createMetricWindow` requires `windowEnd` strictly after `windowStart`.
- **Quality/confidence**: `MetricQuality` (`VERIFIED`/`ESTIMATED`/`UNVERIFIED`/`DEGRADED`) is always caller-declared on `recordMetricObservation`, never inferred — a module that inferred confidence would itself be fabricating provider data.
- **Missing-vs-zero**: `MetricValuePresence` (`REPORTED`/`MISSING`) is the discriminator on every `MetricObservation`. A `MISSING` observation can never carry a `value`; a `REPORTED` observation must carry one, and `0` is a fully valid, distinct `REPORTED` value, never conflated with "nothing was reported" — the central invariant this floor exists to enforce, repeated verbatim in the Rev98 handoff for both this family and V4 Workstream E.
- **Freshness**: `resolveMetricFreshness` is computed, never stored, always relative to a caller-supplied `asOf` (this module never reads the system clock) — `FRESH` when `asOf - capturedAt <= maxAgeMs`, else `STALE`.
- **Monitored state**: `MonitoringState` (`MONITORED`/`MONITORING_PAUSED`/`NOT_MONITORED`, `NOT_MONITORED` terminal) is its own governed registration (`MetricMonitoringRegistration`/`createMetricMonitoringRegistration`/`pauseMetricMonitoring`/`resumeMetricMonitoring`/`stopMetricMonitoring`), distinct from any individual observation — a caller must never infer "monitored" merely from a past observation's existence.
- **The read model**: `projectMetricReadModel` composes all five dimensions above into one customer/ops-safe projection (`MetricReadModelStatus`: `REPORTED_FRESH`/`REPORTED_STALE`/`MISSING`/`NOT_MONITORED`) — a paused/stopped registration gates visibility even if a `REPORTED` observation exists (never leaked), and the absence of any observation (or an observation whose own `presence` is `MISSING`) is always its own explicit `MISSING` status, never silently rendered as a fabricated `0`. Fails closed on any cross-reference mismatch (definition/registration/observation tenant or `metricRef` mismatch, or an observation's `sourceRef` not matching its registration's own).
- `tests/observability-telemetry.test.ts` (28 tests: T1-T28) and `tests/observability-telemetry-boundary-scan.test.ts` (5 tests).

## Explicitly deferred (not fabricated)

- **No vendor monitoring account or live ingestion**, exactly as Rev98 requires — this module never calls a real monitoring vendor, never opens a network connection, and has zero runtime dependency.
- **No durable persistence/store.** Every object in this module is an in-memory, pure value — no `FileDurable*`/store exists yet for any of these types, matching this floor's own "smallest repo-native contract" scope; a durable store is a later concern once a real caller (e.g. Family 7's cross-surface evidence convergence) exists.
- **No wiring into `V5-EVAL-001`, CONN-001, or any other existing module.** This checkpoint deliberately stays a standalone, reusable contract set — `V5-EVAL-001`'s own post-adoption monitor (which this family unblocks) is a separate, not-yet-scheduled wiring task.
- **No customer-facing UI/admin surface.** Rev98's own dark/internal-first sequencing defers any presentation layer to the later role-aware command-frontend family (Family 10).

## Architecture / semantic invariants (verified by test)

- Missing-vs-zero: a `REPORTED` value of exactly `0` is accepted and distinct from `MISSING` (T4); `REPORTED` without a `value` is rejected (T5); `MISSING` with a `value` also supplied is rejected as contradictory input, sanity-checked (T6); a genuinely `MISSING` observation carries no `value` (T7).
- Freshness: correctly resolves `FRESH`/`STALE` relative to `asOf` and `maxAgeMs` (T10-T11); fails closed on an `asOf` before the observation's own `capturedAt` (a genuine caller anomaly), sanity-checked (T12); rejects a non-positive `maxAgeMs` (T13).
- Monitoring lifecycle: always born `MONITORED` (T14); pause/resume round-trips correctly (T15); `stopMetricMonitoring` is terminal — a second stop fails closed (T16); `resumeMetricMonitoring`/`pauseMetricMonitoring` reject a registration not in the required prior state (T17-T18).
- The read model: `REPORTED_FRESH`/`REPORTED_STALE` correctly reflect freshness (T19-T20); the absence of any observation, or an observation whose own `presence` is `MISSING`, always yields `MISSING` — never a fabricated value (T21-T22); a paused or stopped registration always yields `NOT_MONITORED` and surfaces no value even when a `REPORTED` observation exists, proving monitored state is a real visibility gate, not mere metadata (T23-T24); cross-tenant, cross-metric, forged-observation, and source-substitution references all fail closed (T25-T28, source-substitution sanity-checked).
- Sanity-checked: three representative adversarial guards (T6's contradictory-input guard, T12's time-travel guard, T28's source-substitution guard) were each temporarily disabled together and the build/tests rerun — exactly those three tests failed, with every other test (including the corresponding positive cases) still passing; the guards were then restored and 741/741 reconfirmed.

## Hard Non-Scope

No modification to any existing merged file (`tenant-scope.ts` is the only, read-only dependency here); no real vendor monitoring SDK or network call; no persistence/durable store; no admin/UI wiring; no new runtime dependency; no wiring into `V5-EVAL-001` or any other existing module.

## Evidence

- `npm run build` (`tsc -p tsconfig.json`, strict mode incl. `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`): exit 0, zero errors.
- `npm run test`: **741/741 pass**, 0 fail, 0 skipped (708 pre-existing baseline + 33 new: 28 in `tests/observability-telemetry.test.ts`, 5 in `tests/observability-telemetry-boundary-scan.test.ts`).
- `npx tsc --noEmit -p .`: exit 0.
- Sanity-checked adversarial tests: T6's contradictory-input guard, T12's time-travel guard, and T28's source-substitution guard were each temporarily disabled together, confirmed exactly those 3 tests then failed (with all other tests, including the corresponding positive cases, still passing), then all three were restored and 741/741 reconfirmed.
- `package.json`: zero new runtime dependency; `clean` script carried forward (same build-hygiene fix already applied on every other branch cut this session).
- Files touched: `src/domain/observability-telemetry.ts` (new), `tests/observability-telemetry.test.ts` (new), `tests/observability-telemetry-boundary-scan.test.ts` (new), `package.json` (clean-script fix), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending fresh Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires a separately granted protected owner-gate, never inferred from any prior PR's grant. Per Rev95/97/98/99/100/101's continuous-execution batch-mode authorization, independent Brain exact-head review of this checkpoint is deferred to the one consolidated end-of-batch packet alongside PR #38, PR #39, RUNTIME-001, V5-PTN-002 (Rev101-corrected), V4-EFF-001 (Rev101-corrected), LOCAL-EXEC-001 (Rev101-corrected), and LOCAL-EXEC-002.
