# ORG-MEMBERSHIP-DURABLE-001 — Durable OrganizationMembership Registry + OrganizationResourceBindingSource Wiring

## Provenance

- Governing authority: Brain continuation on PR #145 (comment `6218736597`), issued immediately after PR #162's own F1 correction closed. REV216/REV217 (AA-005) remain controlling; Founder gate NONE.
- Reason given: `OrganizationResourceBindingSource`'s own doc comment (`internal-os-view-state.ts`) and `resolveOrganizationResourceBindingStatus` (`organization-resource-binding.ts`) both already require a `currentMemberships: ReadonlyArray<OrganizationMembership>` evidence input, but `organization-membership.ts` has never had any durable registry. `Project` (`PROJ-DURABLE-001`) and `ConnectorConnection` (`durable-connector-connection-store.ts`) both already have durable stores, so membership is the next load-bearing primitive this gap closes, not speculative store coverage.
- Explicit scope boundary from the same comment: do not invent an invitation/suspension/role-change lifecycle — preserve the existing `OrganizationMembership` domain contract exactly. For any independently missing current-evidence dimension (service principals, effective config/policy, worker routes, knowledge evidence), supply only real evidence (honestly empty, since no durable registry exists for any of them yet) — never fabricate "currently valid" to manufacture `READY`.

## Reuse surface (read before designing)

- `src/domain/organization-membership.ts` — `OrganizationMembership`/`createOrganizationMembership`/`revokeOrganizationMembership`/`isOrganizationMembershipActive` (Phase C, Rev131), reused unmodified. The one-way `ACTIVE -> REVOKED` transition rule and "no reactivation" precondition are enforced by `revokeOrganizationMembership` itself — the new store delegates to it rather than reimplementing the rule.
- `src/domain/durable-project-store.ts` (`PROJ-DURABLE-001`) — the exact established discipline cloned for the new module: one JSON file per tenant under `baseDir`, a cross-process `linkSync` mutual-exclusion lock (Rev94 F1's own primitive), full structural revalidation of persisted JSON on every read, optimistic-concurrency versioned transitions.
- `src/application/durable-customer-repository.ts` — the precedent for a plain (non-compound) storage key when the domain identity (`membershipId`) is already globally-unique-by-contract, unlike `Project`'s own composite `(customerId, projectId)` identity.
- `src/domain/organization-resource-binding.ts` — `resolveOrganizationResourceBindingStatus`'s own pre-existing `currentMemberships`/`currentServicePrincipals`/`currentConnections`/`currentProject`/`currentEffectiveConfigRefs`/`currentEffectivePolicyRefs`/`currentWorkerRouteDecisions`/`currentKnowledgeEvidenceRefs` contract, reused unmodified — no resolver logic is touched.
- `src/domain/durable-organization-resource-binding-store.ts` and `src/domain/durable-connector-connection-store.ts` — the other two durable stores this checkpoint's new adapter composes alongside the new membership store and `DurableProjectStore`.
- `src/web/client-project-snapshot-durable-source.ts` (`CLIENT-SNAPSHOT-DURABLE-001`) — the established "compose N durable stores into one existing optional-source port" precedent, mirrored exactly for `OrganizationResourceBindingSource`.

## Scope (this checkpoint)

### Part 1 — `DurableOrganizationMembershipStore` (`src/domain/durable-organization-membership-store.ts`)

- One JSON file per tenant under `baseDir`, keyed by the plain `membershipId` (a plain key, not compound — `membershipId` is already globally-unique-by-contract identity, the same reasoning `FileDurableCustomerRepository` already documented for its own plain `customerId` key).
- `create` is the sole creation path: idempotent on an exact content replay (safe no-op, never a version bump), fails closed on any differing collision under the same `membershipId`.
- `revoke` is the sole transition path: optimistic-concurrency `expectedVersion` guard (closes the one real concurrency hazard `revokeOrganizationMembership` alone cannot — two processes racing to revoke the SAME membership at the same time), then delegates the transition itself to `revokeOrganizationMembership` — a stale/incoherent/already-`REVOKED` record is rejected by that function's own pre-existing precondition, not reimplemented here. No invitation/suspension/role-change lifecycle is invented.
- Full replay revalidation on every read: non-empty canonically-trimmed `membershipId`/`tenantId`/`principalRef`, a `role` among the four values `createOrganizationMembership` can legitimately produce, cross-tenant contamination check, stored-key-vs-embedded-`membershipId` consistency, and `ACTIVE`/`REVOKED` lifecycle coherence (an `ACTIVE` record carrying stale revocation metadata, or a `REVOKED` record missing `revokedAt`/`revokedReason`, is corruption).

### Part 2 — `OrganizationResourceBindingSource` wiring (`src/web/organization-resource-binding-durable-source.ts`)

- `createDurableOrganizationResourceBindingSource` composes the durable `OrganizationResourceBinding`, `OrganizationMembership` (new), `Project`, and `ConnectorConnection` stores into the smallest coherent `OrganizationResourceBindingSource`. `resolveStatus` returns `undefined` (never bootstrapped) only when no binding exists — the pre-existing contract, never fabricated.
- `currentServicePrincipals`/`currentEffectiveConfigRefs`/`currentEffectivePolicyRefs`/`currentWorkerRouteDecisions`/`currentKnowledgeEvidenceRefs` are each passed as real, honest empty evidence — no durable "current" registry exists anywhere in this repository for any of these five dimensions yet. `resolveOrganizationResourceBindingStatus`'s own gates already handle this correctly: a binding that never referenced one of these dimensions (`*Refs` is `[]`) skips that gate and can still reach `READY`; a binding that DID reference one (bootstrap-time provenance only) truthfully blocks on that gate forever via this adapter, exactly the Brain's own "let the existing resolver return its truthful BLOCKED/ACTION_REQUIRED state" instruction.

## Explicitly deferred (not fabricated)

- **No invitation/suspension/role-change lifecycle.** `create`/`revoke` remain the only two write paths, exactly mirroring `organization-membership.ts`'s own surface.
- **`currentServicePrincipals`/config/policy/worker-route/knowledge-evidence dimensions stay honestly empty.** No durable registry for any of these five is invented by this checkpoint.
- **Not wired into any live HTTP route.** Mirrors every sibling adapter's own established precedent exactly.

## Hard Non-Scope

No modification to `organization-membership.ts`, `organization-resource-binding.ts`, or any `/os/admin` route composition file. No new HTTP route. No real billing-provider/IdP/credential anywhere. No production deploy, no DNS, no MAIN mutation, no self-merge.

## Mandatory adversarial witnesses

- `tests/durable-organization-membership-store.test.ts` (19 tests): create/get/listByTenant round-trip, idempotent identical-create replay, create-conflict on differing content, the ACTIVE -> REVOKED transition (version bump, revokedAt/revokedReason persisted), stale-version revoke rejection, revoke-of-nonexistent rejection, no-reactivation (double revoke at the correct version still fails via `revokeOrganizationMembership`'s own precondition), cross-tenant isolation, restart-reconstruction, and 9 corrupted-file adversarial cases.
- `tests/durable-organization-membership-store-concurrency.test.ts` (2 tests) + `tests/helpers/org-membership-race-worker.ts`: 5 real OS-level spawned processes creating 5 different memberships into the same shared tenant file concurrently (every worker's create survives); 5 real OS-level spawned processes racing to revoke the SAME membership at the SAME `expectedVersion` (exactly one wins, every other fails closed with `OrganizationMembershipVersionConflictError`).
- `tests/organization-resource-binding-durable-source.test.ts` (7 tests): `undefined` when never bootstrapped; `READY` end-to-end over all four real durable stores; `BLOCKED` (`NO_ACTIVE_BOUND_MEMBERSHIP`) once the bound membership is revoked; `BLOCKED` (`PROJECT_NOT_CURRENT`) when the project was never durably created; `ACTION_REQUIRED` (`CONNECTION_MISSING`) when a bound connection has no durable record, then `READY` once it is saved; and the "never fabricates READY" witness — a binding bootstrapped with non-empty `effectiveConfigRefs` provenance blocks `ACTION_REQUIRED` (`CONFIG_NOT_CURRENT`) forever since the adapter always supplies real empty current-config evidence.

## Guard-disable sanity

- **Optimistic-concurrency version check in `revoke`**: disabled and the suite rebuilt. Exactly 2 tests failed — the stale-`expectedVersion` unit test, and the concurrent-revoke-race test (whose failing workers now throw `InvalidOrganizationMembershipTransitionError` instead of the expected `OrganizationMembershipVersionConflictError`, since `revokeOrganizationMembership`'s own "coherent ACTIVE record" precondition still independently closes the race — confirming defense-in-depth, not a redundant guard). No other test regressed. Restored and verified byte-identical via `diff`.
- **Cross-tenant contamination check in replay validation**: disabled and the suite rebuilt. Exactly 1 test failed (the dedicated cross-tenant-contamination adversarial test). No other test regressed. Restored and verified byte-identical via `diff`.
- **"Never fabricate READY" discipline in the adapter**: temporarily wired `currentEffectiveConfigRefs` to echo `binding.effectiveConfigRefs` instead of real empty evidence, and the suite rebuilt. Exactly 1 test failed (the dedicated "never fabricates READY" adversarial test). No other test regressed. Restored and verified byte-identical via `diff`.

## Evidence

- Clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`): exit 0.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `node --test dist/tests/*.test.js`: **2997/2997 passing** (2969 pre-existing + 28 new: 19 unit + 2 concurrency + 7 adapter).
- Zero new runtime dependency.

## Brain correction (F1)

Brain's independent review of exact head `6b24cbecd153eebea106575a9f44a14f6110d333` (PR #163 comment `6223152039`) found a write-boundary validation gap: `FileDurableOrganizationMembershipStore.create()` persisted the caller-supplied `OrganizationMembership` without revalidating it first. `OrganizationMembership` is an exported structural interface (`organization-membership.ts`'s own documented factory-bypass concern), so a hand-built malformed value — an `ACTIVE` record carrying stale revocation metadata, an unrecognized `role`, a non-canonically-trimmed identity string — could be accepted by `create()`, written to disk, and only surface as `CorruptedOrganizationMembershipFileError` on a later read/restart. Brain also correctly flagged the module's own doc comment as misleading: it claimed `membershipId` is "globally-unique-by-contract," when the implementation is actually tenant-file SCOPED (the same `membershipId` in two different tenants' files is two independent, non-colliding records).

**Fix**: extracted a single shared `coherenceViolation` check — the exact same structural/lifecycle invariants (`membershipId`/`tenantId`/`principalRef` non-empty canonically-trimmed, recognized `role`, `ACTIVE`/`REVOKED` coherence) `validatePersistedOrganizationMembership` already enforced on replay — and now run it in `create()` BEFORE the lock is even acquired, so a rejected call commits zero bytes and zero state. `validatePersistedOrganizationMembership` itself was refactored to delegate to the same shared check rather than duplicating the invariant logic inline, so write-boundary and replay validation can never semantically diverge. The misleading "globally-unique-by-contract" doc-comment claim was corrected to the accurate tenant-file-scoped framing (matching `FileDurableCustomerRepository`'s own correct reasoning for its plain-key choice).

**Test changes**: 4 new write-boundary tests — 3 adversarial (ACTIVE+revocation-metadata, unrecognized role, canonical-trim violation on `principalRef`), each asserting `InvalidOrganizationMembershipStoreError` is thrown AND zero state is committed (`get` still returns `undefined`, no tenant file was ever written to disk) — plus 1 golden-path regression check confirming a genuinely well-formed `create()` call still succeeds after the new check.

**Guard-disable sanity**: the new write-boundary check was disabled and the suite rebuilt. Exactly the 3 new adversarial tests failed, precisely the tests depending on it. No other test regressed. Restored and verified byte-identical to the pre-edit source via `diff`.

Full regression after the fix: **3001/3001 passing** (2997 pre-existing + 4 new), clean strict typecheck, zero new runtime dependency.

Status: `IMPLEMENTED / SELF-VALIDATED` — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`.
