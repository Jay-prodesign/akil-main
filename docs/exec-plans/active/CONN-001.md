# CONN-001 — Integration & Credential Control Plane (architecture/domain-contract slice 1)

## Authorization

Authorized by the canonical Brain Handoff (Rev90, 2026-09-10) as the next large continuation task, to begin immediately after the three bounded Rev90 F1 corrections on PR #35/#36/#37 were pushed (per Brain's own explicit sequencing and its "do NOT stop for another Brain dispatch" instruction). Rev90's own text authorizes, without further Founder relay: "domain contracts, persistence interfaces, admin UI scaffolding, adapters, fixtures/mocks, health/capability discovery, adversarial isolation/secret tests." Real credential entry, account authorization, spend, DNS mutation, and any other customer-impacting production side effect remain protected gates, explicitly out of scope for this slice.

## Goal

CONN-001's full scope (per Rev90's 13-point specification) is large: an admin surface; prebuilt connectors (Google Drive/Workspace, OpenAI, Anthropic, Google AI, GitHub, optionally Meta); a mandatory Generic Custom API Connector with multiple auth modes; a mandatory Generic Custom OAuth Connector; multi-instance tenant/project binding with cross-tenant fail-closed; a `ConnectionRequirement -> ConnectionBinding -> SecretRef` boundary with masked/write-only secrets; lifecycle states `REQUIRED/REQUESTED/CONNECTED_UNVERIFIED/VERIFIED/DEGRADED/REVOKED` plus test/health/reconnect/rotate/revoke operations; AI provider/model-catalog separation; an optional OpenAPI/Swagger import accelerator; and a strict commerce-ownership boundary (no parallel commerce runtime). Rev90's own instruction is to "progressively elaborate from architecture/domain contract -> persistence/secret-ref boundary -> admin UI -> generic adapters -> prebuilt adapters -> adversarial E2E."

This checkpoint is **slice 1**: the architecture/domain-contract layer, plus a first pass at the persistence-shape/secret-ref boundary this task's lifecycle operations need. It deliberately does not yet touch admin UI, real adapters, or any live network call.

## Why this composes on top of `connection-authority.ts` rather than modifying it

`V2-CDO-004` (already merged, Brain **VERIFIED/PASS/CLOSED**) already implemented exactly the `ConnectionRequirement -> ConnectionBinding -> SecretRef` boundary CONN-001's own spec calls for, including opaque `SecretRef` (a single branded id, structurally incapable of holding a real secret value), fail-closed ownership/scope binding, and a `ConnectionState` lifecycle (`REQUESTED -> CONNECTED_UNVERIFIED -> VERIFIED -> DEGRADED -> REVOKED -> HANDOVER_COMPLETE`) with `VERIFIED` reachable only through an explicit, evidence-gated `verifyConnectionBinding`. CONN-001 is a distinct, larger continuation task, not a correction to that already-closed work - so this slice reuses `connection-authority.ts` entirely unmodified (verified by a boundary-scan test below) and adds a new, additive module on top of it.

**`REQUIRED` vs `REQUESTED`**: CONN-001 names `REQUIRED` as the lifecycle's first state. `connection-authority.ts` already structurally represents this distinction via two separate types rather than a status enum value: a `ConnectionRequirement` existing with no corresponding `ConnectionBinding` yet *is* "REQUIRED" (declared, not yet connected); a `ConnectionBinding` always starts at `connectionState: "REQUESTED"`. This slice does not invent a redundant `REQUIRED` enum member - doing so would duplicate an already-correct existing distinction rather than close a real gap.

## Scope (this slice)

New pure domain module: `src/domain/integration-connector-catalog.ts`.

### Connector catalog
- `ConnectorAuthMode`: `"API_KEY" | "OAUTH2" | "BASIC" | "BEARER_TOKEN" | "CUSTOM_HEADER"`.
- `ConnectorKind`: the closed prebuilt list (`GOOGLE_DRIVE`, `GOOGLE_WORKSPACE`, `OPENAI`, `ANTHROPIC`, `GOOGLE_AI`, `GITHUB`, `META`) plus `GENERIC_CUSTOM_API` and `GENERIC_CUSTOM_OAUTH`.
- `ConnectorDescriptor`: `connectorKind`, `displayName`, `supportedAuthModes`, `capabilityRefs` (reusing `offer-blueprint.ts`'s `RequirementId`), `isAiModelProvider` (explicit boolean, AI provider/model-catalog separation), `requiresOAuthRedirect`.
- `createConnectorDescriptor` fail-closed rules: `connectorKind` must be recognized; `supportedAuthModes` non-empty, each recognized, no duplicates; `GENERIC_CUSTOM_OAUTH` must declare exactly `["OAUTH2"]` and `requiresOAuthRedirect: true`; `GENERIC_CUSTOM_API` must declare `requiresOAuthRedirect: false`, must not declare `OAUTH2` at all, and must declare **at least two** auth modes (CONN-001's own "multiple auth modes" requirement).
- `buildConnectorCatalog` fail-closed rejects a duplicate `connectorKind`.
- `resolveConnectorDescriptor` fail-closed throws for an unregistered kind - **never** returns `undefined` - so nothing downstream can treat a non-existent connector as "not found, proceed anyway." This is what makes "an available connector must actually work against its declared contract" true by construction at this layer: there is no path to a connection instance for a kind that was never actually registered.
- `listAiModelProviderConnectors` / `listIntegrationConnectors`: the queryable AI-provider/model-catalog separation.

### Connection lifecycle (test/health/reconnect/rotate/revoke)
- `ConnectorConnectionInstance`: pairs an unmodified `ConnectionBinding` with the `connectorKind`/`authMode` it was actually requested against (`providerRef` is always set to `connectorKind` verbatim - never a free-form caller string - so every binding is traceable to a real catalog entry).
- `requestConnectorConnection`: fail-closed requires the connector to declare the requirement's `requiredCapabilityRef` in its own `capabilityRefs`, and the caller's `authMode` to be one the connector actually supports; delegates construction to the unmodified `createConnectionBinding`.
- `transitionConnectorConnection` / `verifyConnectorConnection`: thin delegation to `connection-authority.ts`'s own, unmodified transition/verification functions, preserving the `connectorKind`/`authMode` wrapper fields.
- `rotateConnectorSecret` ("rotate"): fail-closed requires a genuinely different `newSecretRef` (reusing `V5-LAB-001`'s `reusableAssetRef` distinctness discipline) and only applies to a binding that already has a secret (`CONNECTED_UNVERIFIED`/`VERIFIED`/`DEGRADED`). A **`VERIFIED` binding is demoted to `DEGRADED`** on rotation (via the already-existing, unmodified `VERIFIED -> DEGRADED` transition edge) - a rotated secret must be independently re-verified before the binding can be `VERIFIED` again; it can never silently stay `VERIFIED` against an unverified credential.
- `reconnectConnectorConnection` ("reconnect"): only valid from a genuinely `REVOKED` binding (`HANDOVER_COMPLETE` is permanently terminal). Fail-closed cross-tenant check: the caller-supplied `ownershipContext` must exactly match both the (unchanged) requirement's ownership and the previous binding's own ownership. Because `connection-authority.ts`'s own transition table has no edge out of `REVOKED`, this necessarily constructs a brand-new `ConnectionBinding` (fresh id, `REQUESTED`) rather than reviving the old one - matching this repository's existing "revoked requires an entirely new record, never resurrection" discipline (`partner-capability-admission.ts`). The old binding's id is recorded only as `supersedesConnectionBindingId` lineage.
- `recordConnectorHealthCheck` ("test"/"health"): pure recording only - returns a `ConnectorHealthCheckRecord`, never mutates the connection instance. Rejected against `REQUESTED`/`REVOKED`/`HANDOVER_COMPLETE` (nothing live to check). Promoting/demoting state based on a health finding remains an explicit, separate caller decision via `transitionConnectorConnection`/`verifyConnectorConnection` - this function does not fabricate an automatic state-transition authority from a health signal alone.
- "revoke" reuses the existing, unmodified `transitionConnectionBinding(..., "REVOKED")` directly - no new code needed.

## Explicitly deferred (not fabricated)

- **Real credential entry, OAuth authorization-code exchange, or any live network/HTTP call to a provider** - this remains a pure, in-memory domain contract, exactly like every other module in `src/domain/`. A caller-supplied `SecretRef`/evidence/timestamp is the only way any real-world fact enters it.
- **Admin UI** - no HTTP route, page, or session type. Genuinely the next elaboration step per Rev90's own sequencing, not attempted here.
- **Prebuilt adapter implementations** - `GOOGLE_DRIVE`/`OPENAI`/`ANTHROPIC`/`GOOGLE_AI`/`GITHUB`/`META` exist here only as catalog *descriptors* (declared capability/auth-mode contracts), not working adapters. Building a real adapter without a real provider account/credential to test against would be exactly the kind of "speculative provider breadth" Rev90's own text warns against.
- **OpenAPI/Swagger import accelerator** - no such capability exists in this repository; not fabricated.
- **Persistence/durable storage** - this slice is pure, in-memory domain logic only, matching every other `src/domain/` module; a durable store (mirroring `durable-outcome-job-store.ts`'s pattern) is a natural next elaboration step, not attempted here.
- **Real AI model catalog** (specific model IDs, context windows, pricing) - `isAiModelProvider` is a structural boolean flag only; no model-catalog data is invented.
- **Commerce-ownership boundary**: by omission - this module has zero import, reference, or literal coupling to Shopify/AI Commerce/any commerce platform (verified by the boundary scan below), preserving Invariant 6.
- **Two mandatory E2E acceptance cases** (Generic Connection flow, Prebuilt Connection flow) named in Rev90's spec - these require the admin UI and at least a mocked adapter layer to exercise meaningfully; deferred to a later slice per the progressive-elaboration instruction.

## Adversarial test coverage

`tests/integration-connector-catalog.test.ts`, 21 tests (K1-K21):
- Catalog validation: unrecognized connector kind, empty/duplicate auth modes, `GENERIC_CUSTOM_OAUTH`/`GENERIC_CUSTOM_API` cross-field auth-mode rules, explicit-boolean requirement (no default), duplicate-kind catalog rejection, fail-closed unregistered-kind resolution, AI-provider/integration partitioning.
- Lifecycle: capability-mismatch rejection, unsupported-auth-mode rejection, catalog-bound `providerRef`, transition/verify delegation.
- **Adversarial (K14, K16)**: a secret rotation on a `VERIFIED` binding demotes it to `DEGRADED` rather than silently remaining `VERIFIED` against an unverified credential; rotating to an identical secret, or rotating a `REQUESTED`/`REVOKED` binding, is rejected.
- **K17**: health-check recording never mutates the connection instance (byte-for-byte snapshot comparison) and is rejected against a binding with no live connection.
- **K18-K20**: reconnection is rejected unless the previous binding is genuinely `REVOKED`, and always produces a genuinely new `connectionBindingId` (never resurrects the old one).
- **K19 (cross-tenant fail-closed)**: reconnection is rejected when the caller-supplied `ownershipContext` does not match the requirement/binding's own tenant scope, and succeeds only with the matching context.
- **K21 (multi-instance isolation)**: two connection instances for the same `connectorKind` under different tenants never share secret/state - mutating one leaves the other completely untouched.

`tests/conn-001-boundary-scan.test.ts`, 5 tests: no secret material or commerce-platform coupling; no real OAuth/HTTP-client runtime dependency; exactly one runtime (value) import from `connection-authority.ts`, reusing its existing exported functions only; no new `package.json` dependency; no re-declaration of any of `connection-authority.ts`'s own exported symbols (confirming it is reused, not duplicated or forked).

## Rev93 correction (Brain CHANGES_REQUIRED — BOUNDED, exact head `b525f6f7f1d2da08041f142e3896337963a60e55`)

Brain's exact-head review found (F1): `reconnectConnectorConnection` verified `previousInstance` was `REVOKED`, matched the same requirement id and ownership, and used a new binding id - but never checked `previousInstance.connectorKind === connectorDescriptor.connectorKind`. Two descriptors declaring the same `requiredCapabilityRef` could therefore let a revoked provider-A connection be silently "reconnected" as provider-B, weakening provider lineage and making reconnect semantics non-deterministic.

Fix: `reconnectConnectorConnection` now fail-closed rejects whenever the reconnect `connectorDescriptor`'s `connectorKind` differs from `previousInstance.connectorKind`, before any other work happens. Genuine provider switching, if ever needed, remains a separate, explicit rebinding/new-connection operation - never hidden inside reconnect. One new adversarial test, K22: two connector descriptors (`GITHUB`, `GOOGLE_DRIVE`) deliberately declaring the identical capability ref prove a cross-connector "reconnect" is rejected, while a same-connector reconnect still succeeds.

## Test coverage (Rev93-corrected)

`tests/integration-connector-catalog.test.ts`, 22 tests (K1-K22, adding K22's cross-connector reconnect rejection to the K1-K21 set described above).

## Evidence (Rev93 correction)

- Branch: `claude/conn-001-integration-control-plane`, cut fresh from `main` at `3226c76fa338e425e553638e5f5f48924182a1c0`.
- Build: `npm run test` (self-cleaning `dist/` build) -> clean `tsc` build (strict, `exactOptionalPropertyTypes: true`), full regression **735/735 pass** (708 true pre-existing + 27 new: 22 K-tests + 5 boundary-scan tests).
- Zero new npm dependency. Same import surface as slice 1 (no new imports needed for this fix).
- No filesystem/network/child_process/HTTP coupling; pure functions only.

## Slice 2: persistence interface (durable connector-connection store)

Per Rev93's own next-action instruction, after the F1 correction above, the corridor continues automatically into CONN-001's next progressive-elaboration step: "persistence/secret-ref boundary." New module: `src/domain/durable-connector-connection-store.ts`.

- `DurableConnectorConnectionStore`: `save(instance, expectedVersion?)`, `get(tenantId, connectionBindingId)`, `list(tenantId)`.
- Unlike `durable-outcome-job-store.ts`'s `putIfAbsent`-only, never-mutated record (an `OutcomeJob` is written once and never changes), a `ConnectorConnectionInstance`'s whole point is to change state over its lifecycle - so this store supports genuine updates, gated by **optimistic concurrency** rather than blind overwrite. Contract (reusing this session's own artifact-database `if_version` idiom): no record + no `expectedVersion` -> create at version 1; no record + `expectedVersion` supplied -> fail-closed conflict; a record exists + `expectedVersion` matches -> update, version+1; a record exists + `expectedVersion` missing/stale -> fail-closed conflict (`ConnectorConnectionVersionConflictError`). This prevents a lost update between two concurrent lifecycle operations on the same binding (e.g. a health-check-driven `DEGRADED` transition racing a `rotateConnectorSecret` call).
- `FileDurableConnectorConnectionStore`: reference/local implementation using only `node:fs`/`node:path` (zero new runtime dependency), one JSON file per tenant keyed by `connectionBindingId`, mirroring `FileDurableOutcomeJobStore`/`FileDurablePlanAdmissionStore`'s existing "read the full file, no separate in-memory index that could diverge" discipline. Cross-tenant isolation is structural, not a runtime check: a connection can only ever be looked up under the exact tenant file its own `binding.ownership.tenantId` was saved under.
- The persisted record includes the instance's `secretRef` field verbatim - but that field, per `connection-authority.ts`'s own `SecretRef` contract, structurally can never hold anything but an opaque reference id (a single branded string), never real secret material. Persisting the full instance therefore never persists a real credential - the masked/write-only secret-handling contract holds transitively through this store without any extra redaction logic needed.
- Admin read-model surface, generic/prebuilt adapters, and the OpenAPI import accelerator remain deferred to later slices, per Rev90's own progressive-elaboration sequencing.

### Test coverage (slice 2)

`tests/durable-connector-connection-store.test.ts`, 7 tests (M1-M7): create-at-version-1, fail-closed rejection of an `expectedVersion` on a not-yet-existing record, correct-version update incrementing by exactly 1, **adversarial lost-update prevention** (a missing or stale `expectedVersion` against an existing record is rejected and the stored record is provably untouched), unknown-id/cross-tenant `get()` isolation, cross-tenant `list()` isolation, and restart-safety (a fresh store instance over the same directory reconstructs the identical record, version included).

### Evidence (slice 2)

- Build: `npm run test` -> clean `tsc` build (strict, `exactOptionalPropertyTypes: true`), full regression **742/742 pass** (708 true pre-existing + 34 new: 22 K-tests + 7 M-tests + 5 boundary-scan tests, the boundary-scan file list now also covering the new store module).
- Zero new npm dependency (`node:fs`/`node:path` only, matching every other durable store in this repository).
- No network/child_process/HTTP coupling.

## Slice 3: admin read-model surface

Per Rev90/93's own sequencing, the next progressive-elaboration step after persistence is the admin surface: "Settings -> Integrations / AI & Providers with provider catalog, connection instances, status/health, ownership and tenant/project binding." New module: `src/domain/integration-admin-view.ts`.

- `buildIntegrationsAdminView({ catalog, connections })` -> `IntegrationsAdminView { availableConnectors, connections }`. Pure aggregation, no independent judgment.
- **Same disclosed genuine boundary as `V5-CMD-001`** (`internal-command-projection.ts`): this repository has no internal/staff authentication concept anywhere, so this module has zero HTTP/session/route wiring - exactly the boundary Rev90's own text already accepts for the admin-UI step at this stage. Deliberately cross-tenant, matching that same precedent: an internal company-wide integrations view is exactly the case where seeing across every tenant is the intended, authorized behavior.
- **Structural secret-masking guarantee**: `IntegrationConnectionSummary` has no field capable of holding a `SecretRef`/`secretRefId` at all - not merely omitted by convention, but structurally absent from the type, so this admin view can never leak a connection's secret reference even to an authorized administrator. Only the existing evidence-gated `verificationEvidenceRef` (an audit pointer, never a credential) passes through, and only when present.

### Test coverage (slice 3)

`tests/integration-admin-view.test.ts`, 5 tests (N1-N5): catalog-entry field mapping, **adversarial secret-masking proof** (a connection with a real `secretRef` set never has that field present in its summary, checked both structurally and by scanning the full serialized view for the literal secret value), connection-state/ownership/version/evidence-ref field mapping, deliberate cross-tenant aggregation (matching `V5-CMD-001`'s precedent), and no-mutation-of-inputs.

### Evidence (slice 3)

- Build: `npm run test` -> clean `tsc` build (strict, `exactOptionalPropertyTypes: true`), full regression **747/747 pass** (708 true pre-existing + 39 new: 22 K-tests + 7 M-tests + 5 N-tests + 5 boundary-scan tests, boundary-scan file list now also covering this module).
- Zero new npm dependency; zero runtime imports beyond the already-established catalog/store types (type-only imports only).
- No filesystem/network/child_process/HTTP coupling; pure function only.

## Slice 4: Generic Custom API / OAuth connector definitions

Per Rev90/93's own sequencing, the next progressive-elaboration step: "generic adapters." New module: `src/domain/generic-connector-definition.ts`. Still a pure, in-memory data contract with fail-closed validation only - no real HTTP call, no DNS resolution, no request ever executed, matching every other module in `src/domain/`.

- `GenericApiConnectorDefinition`: `baseUrl` (validated as an absolute http/https URL), `authMode` restricted to `API_KEY`/`BEARER_TOKEN`/`BASIC`/`CUSTOM_HEADER` (CONN-001's own "multiple auth modes," `OAUTH2` structurally excluded - that is exclusively the OAuth connector's territory), `endpoints` (non-empty, each with a unique `capabilityRef`, a recognized HTTP method, and a `/`-prefixed path), an optional `validationEndpointCapabilityRef` fail-closed required to reference a real declared endpoint (CONN-001's "Test Connection" acceptance point), and optional `rateLimitPerMinute`/`retryMaxAttempts`.
- `GenericOAuthConnectorDefinition`: `authorizationUrl`/`tokenUrl` (both validated absolute URLs), non-empty deduplicated `scopes`, and the same endpoint-validation discipline. `authMode` is not a settable field at all - it is `OAUTH2` by construction, the same "structural, not settable" discipline `project-bootstrap-template.ts` uses for `supersedesLocalAuthority: false`.
- `resolveEndpointForCapability` - fail-closed throws for an undeclared capability, matching `resolveConnectorDescriptor`'s own never-`undefined` discipline; this is the function a real adapter/router would call to find which endpoint satisfies a capability, still without making any call.
- `bindGenericApiDefinition`/`bindGenericOAuthDefinition` - fail-closed reject a definition binding to the wrong `connectorKind`, the wrong `connectionBindingId`, or a mismatched `authMode`; a definition can never be silently attached to a connection it does not describe.
- `requestMapping`/`responseMapping` remain opaque, uninterpreted pointers - this module never invents a parallel mapping/execution engine.

### Test coverage (slice 4)

`tests/generic-connector-definition.test.ts`, 11 tests (P1-P11): invalid-baseUrl rejection, **adversarial OAUTH2-on-API-connector rejection**, duplicate-capabilityRef rejection, method/path validation, validation-endpoint-must-exist enforcement, positive-integer rate-limit/retry validation with clean omission when absent, fail-closed capability resolution, OAuth URL/scope validation, fail-closed definition-to-instance binding (connector kind, binding id, and auth mode all independently checked) for both connector families, and multi-instance independence (two definitions for different `connectionBindingId`s never share state or resolve each other's capabilities).

### Evidence (slice 4)

- Build: `npm run test` -> clean `tsc` build (strict, `exactOptionalPropertyTypes: true`), full regression **758/758 pass** (708 true pre-existing + 50 new: 22 K-tests + 7 M-tests + 5 N-tests + 11 P-tests + 5 boundary-scan tests, boundary-scan file list now covering all four slice-1/2/3/4 modules).
- Zero new npm dependency; only type-only imports of the already-established catalog types plus the global `URL` constructor (no new package).
- No filesystem/network/child_process/HTTP coupling; pure functions only.

## Status

**IMPLEMENTED / SELF-VALIDATED (slice 4 added)** (slices 1-4 of CONN-001). Pending Brain independent exact-head re-review. `MERGE_DISPOSITION: HOLD_MERGE` (no `MAIN` mutation). Next dependency-safe steps per Rev90/93's own sequencing: prebuilt adapters (as catalog descriptors, still no real network call), then the Rev91/92/93 SALE-TO-CLOSE E2E acceptance floor (P0 adversarial tests only - duplicate/replay/crash convergence, tenant isolation, revoked/wrong connection fail-closed, temporary provider recovery, cancellation/refund/chargeback governed disposition, verification-gated CLOSED), without a further Brain dispatch.
