# ORG-SERVICE-PRINCIPAL-DURABLE-001 — Durable OrganizationServicePrincipal Registry + currentServicePrincipals Wiring

## Provenance

- Governing authority: Brain continuation on PR #145 (comment `6223155547`), issued immediately after `ORG-MEMBERSHIP-DURABLE-001`'s own F1 correction (PR #163) closed. REV216/REV217 (AA-005) remain controlling; Founder gate NONE.
- Reason given: `OrganizationResourceBindingSource` now has real current memberships, Project, and ConnectorConnection truth (`ORG-MEMBERSHIP-DURABLE-001`). Its next unresolved real currentness gate is `currentServicePrincipals`, and `organization-service-principal.ts` already has the canonical `ACTIVE -> REVOKED` domain lifecycle but no durable registry/enumeration — the same consumer-driven pattern as memberships, not speculative persistence coverage.
- Explicit scope boundary from the same comment: no expiry/suspension/reactivation/new worker registry. Leave config/policy/worker-route/knowledge-evidence dimensions truthful and unresolved until each has a genuine source; do not manufacture `READY` with placeholders.

## Reuse surface (read before designing)

- `src/domain/organization-service-principal.ts` — `OrganizationServicePrincipal`/`createOrganizationServicePrincipal`/`revokeOrganizationServicePrincipal`/`isOrganizationServicePrincipalActive` (OS-V0-02, Rev136), reused unmodified. Structurally near-identical to `OrganizationMembership` (same `ACTIVE`/`REVOKED` floor, same factory-bypass concern) except a single `workerRef` field in place of `principalRef`/`role`.
- `src/domain/durable-organization-membership-store.ts` — the exact established discipline cloned verbatim, including its OWN Brain F1 correction (write-boundary `coherenceViolation` check shared by `create` and replay validation) applied here FROM THE START rather than as a later fix.
- `src/domain/organization-resource-binding.ts` — `resolveOrganizationResourceBindingStatus`'s own pre-existing `currentServicePrincipals` gate (`SERVICE_PRINCIPAL_MISSING`/`SERVICE_PRINCIPAL_REVOKED`), reused unmodified.
- `src/web/organization-resource-binding-durable-source.ts` (`ORG-MEMBERSHIP-DURABLE-001`) — extended with a fifth constructor parameter, mirroring `membershipStore`'s own wiring exactly.

## Scope (this checkpoint)

### Part 1 — `DurableOrganizationServicePrincipalStore` (`src/domain/durable-organization-service-principal-store.ts`)

- One JSON file per tenant under `baseDir`, keyed by the plain `servicePrincipalId` (tenant-file scoped, not a global-uniqueness claim — same correction `ORG-MEMBERSHIP-DURABLE-001` F1 made to its own doc comment, applied accurately here from the start).
- `create` is the sole creation path: idempotent on exact-content replay, fails closed on a differing collision. Validates the incoming value against a shared `coherenceViolation` check BEFORE the lock is acquired or any disk I/O — applying `ORG-MEMBERSHIP-DURABLE-001` F1's own lesson proactively rather than waiting for a second correction cycle.
- `revoke` is the sole transition path: optimistic-concurrency `expectedVersion` guard, then delegates the transition itself to `revokeOrganizationServicePrincipal` — no reimplementation of the one-way `ACTIVE -> REVOKED` rule.
- Full replay revalidation on every read, delegating to the SAME shared `coherenceViolation` check the write boundary uses, so the two paths can never diverge.

### Part 2 — `currentServicePrincipals` wiring (`src/web/organization-resource-binding-durable-source.ts`)

- `createDurableOrganizationResourceBindingSource` gains a third positional parameter `servicePrincipalStore`, inserted between `membershipStore` and `projectStore`. `currentServicePrincipals` is now `servicePrincipalStore.listByTenant(organization.tenantId).map(s => s.servicePrincipal)` instead of `[]`.
- `currentEffectiveConfigRefs`/`currentEffectivePolicyRefs`/`currentWorkerRouteDecisions`/`currentKnowledgeEvidenceRefs` remain real, honest empty evidence — no durable registry exists for any of these four dimensions yet, per the Brain's own explicit instruction not to manufacture `READY` with placeholders.

## Explicitly deferred (not fabricated)

- **No expiry/suspension/reactivation.** `create`/`revoke` remain the only two write paths, exactly mirroring `organization-service-principal.ts`'s own surface.
- **No new worker registry.** `workerRef` is carried through opaque and unvalidated against any worker identity source, exactly as `organization-service-principal.ts`'s own doc comment specifies.
- **config/policy/worker-route/knowledge-evidence dimensions stay honestly empty.**
- **Not wired into any live HTTP route.**

## Hard Non-Scope

No modification to `organization-service-principal.ts`, `organization-resource-binding.ts`, or any `/os/admin` route composition file. No new HTTP route. No real billing-provider/IdP/credential anywhere. No production deploy, no DNS, no MAIN mutation, no self-merge.

## Mandatory adversarial witnesses

- `tests/durable-organization-service-principal-store.test.ts` (21 tests): create/get/listByTenant round-trip, idempotent identical-create replay, create-conflict, the ACTIVE -> REVOKED transition, stale-version/nonexistent-revoke rejection, no-reactivation, cross-tenant isolation, restart-reconstruction, 8 corrupted-file adversarial cases, and 3 write-boundary tests (2 adversarial + 1 golden-path).
- `tests/durable-organization-service-principal-store-concurrency.test.ts` (2 tests) + `tests/helpers/org-service-principal-race-worker.ts`: 5-process concurrent-create proof, 5-process concurrent-revoke-race proof.
- `tests/organization-resource-binding-durable-source.test.ts` (+3 new tests, 10 total): `ACTION_REQUIRED` (`SERVICE_PRINCIPAL_MISSING`) when a bound ref has no durable record; `READY` once it is durably saved and active; `ACTION_REQUIRED` (`SERVICE_PRINCIPAL_REVOKED`) once it is revoked.

## Guard-disable sanity

- **Write-boundary coherence check in `create`**: disabled and the suite rebuilt. Exactly 2 tests failed (the 2 adversarial write-boundary tests). No other test regressed. Restored and verified byte-identical via `diff`.
- All other guards (optimistic-concurrency revoke version check, cross-tenant contamination, replay coherence) are direct structural clones of `ORG-MEMBERSHIP-DURABLE-001`'s own already-guard-disable-sanity-confirmed guards, re-proven here by the full adversarial test suite passing against the same invariant logic under different field names.

## Evidence

- Clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`): exit 0.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `node --test dist/tests/*.test.js`: **3027/3027 passing** (3001 pre-existing + 26 new: 21 unit + 2 concurrency + 3 adapter).
- Zero new runtime dependency.

Status: `IMPLEMENTED / SELF-VALIDATED` — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`.
