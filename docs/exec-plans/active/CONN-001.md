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

## Status

**IMPLEMENTED / SELF-VALIDATED (Rev93-corrected)** (slice 1 of CONN-001). Pending Brain independent exact-head re-review. `MERGE_DISPOSITION: HOLD_MERGE` (no `MAIN` mutation). Per Rev93's own explicit next-action instruction, after this correction is pushed the corridor continues automatically into CONN-001 slice 2 and, at the first dependency-safe integration point, the Rev91/92/93 SALE-TO-CLOSE E2E acceptance floor (P0 adversarial tests only - duplicate/replay/crash convergence, tenant isolation, revoked/wrong connection fail-closed, temporary provider recovery, cancellation/refund/chargeback governed disposition, verification-gated CLOSED), without a further Brain dispatch.
