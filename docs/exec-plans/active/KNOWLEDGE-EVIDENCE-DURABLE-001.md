# KNOWLEDGE-EVIDENCE-DURABLE-001 — Durable currentKnowledgeEvidenceRefs Wiring

## Provenance

- Governing authority: REV216-CONTINUOUS-COMPLETION parent execution contract (Brain PR #145 comment `6237782556`), continuation of the `OrganizationResourceBindingSource` currentness-gate series after `ORG-CONFIG-POLICY-CURRENTNESS-001`'s own PR #165. REV215/REV216/REV217 (AA-005) remain controlling; Founder gate NONE for this bounded internal primitive.
- `ORG-CONFIG-POLICY-CURRENTNESS-001`'s own execution record (PR #164 comment `6237784269`, PR #165) flagged two remaining honest-empty `OrganizationResourceBindingSource` currentness dimensions: `currentWorkerRouteDecisions` and `currentKnowledgeEvidenceRefs`. A fresh dependency scan of both found real, bounded, non-speculative buildable scope for exactly one: `evidence.ts`'s `EvidenceReference` already has the canonical domain shape (`createEvidenceReference`) and `resolveOrganizationResourceBindingStatus`'s own doc comment already names the exact contract this adapter must satisfy ("plain evidence-id presence"); it only lacks a durable registry/enumeration. `currentWorkerRouteDecisions` still has no genuine durable source: it would require inventing a new durable "admitted worker candidates per route" registry and a routeRef-to-`WorkerRoutingRequest` mapping that does not exist anywhere in this repository today, which is exactly the kind of speculative infrastructure-for-coverage the parent contract's "reuse-first, do not create infrastructure merely for coverage" instruction forbids absent a concrete consumer shape — left truthful and unresolved, as a named follow-up.

## Reuse surface (read before designing)

- `src/domain/organization-resource-binding.ts` — `resolveOrganizationResourceBindingStatus`'s own doc comment (lines 279-308) and its `KNOWLEDGE_EVIDENCE_MISSING` gate (lines 467-477) are reused unmodified; `currentKnowledgeEvidenceRefs: ReadonlyArray<string>` is a flat tenant-scoped id list, not further scoped by customer/project in the domain gate itself.
- `src/domain/evidence.ts` — `EvidenceReference`/`createEvidenceReference` reused unmodified as the canonical shape; this checkpoint adds no new field and no new construction path.
- `src/domain/durable-organization-service-principal-store.ts` — exact structural template mirrored (file-per-tenant, `linkSync` mutual-exclusion lock, one shared `coherenceViolation` check at both the write boundary and replay, `Object.create(null)` dictionary). `EvidenceReference` has no lifecycle, so unlike service principals/memberships there is no `revoke`/version guard — `record` is the sole, idempotent-on-identical-replay write path.
- `src/web/organization-resource-binding-durable-source.ts` (`ORG-MEMBERSHIP-DURABLE-001`/`ORG-SERVICE-PRINCIPAL-DURABLE-001`/`ORG-CONFIG-POLICY-CURRENTNESS-001`) — extended with a seventh constructor parameter, mirroring every prior store's own wiring exactly.

## Scope (this checkpoint)

- New `src/domain/durable-evidence-reference-store.ts`: `DurableEvidenceReferenceStore` interface (`record`, `get`, `listByTenant`) + `FileDurableEvidenceReferenceStore` reference implementation.
- `createDurableOrganizationResourceBindingSource` gains a seventh positional parameter `evidenceReferenceStore: DurableEvidenceReferenceStore`.
- `resolveStatus` lists every evidence reference currently recorded for the binding's own tenant (`evidenceReferenceStore.listByTenant(organization.tenantId)`, the same tenant-scoped-list convention `currentServicePrincipals`/`currentConnections` already use — the domain gate itself only checks flat `evidenceId` membership, not a further customer/project scope) and supplies their `evidenceId`s as `currentKnowledgeEvidenceRefs`.
- This adapter does **not** itself call `createEvidenceReference` or record anything — it has no independent source of raw evidence to manufacture, and recording evidence remains whatever other, already-authorized caller's own responsibility it already was. It only reads what has already been durably recorded.
- `currentWorkerRouteDecisions` remains real, honest empty evidence — unchanged, still genuinely unresolved pending its own future task (needs a durable "admitted worker candidates per route" registry that does not yet exist).

## Explicitly deferred (not fabricated)

- No new `createEvidenceReference`/evidence-producing call site anywhere in this checkpoint.
- No durable "admitted worker candidates per route" registry — remains open, a named follow-up, exactly as `ORG-CONFIG-POLICY-CURRENTNESS-001` left it.
- Not wired into any live HTTP route, matching every sibling adapter's own established precedent.

## Hard Non-Scope

No modification to `organization-resource-binding.ts`, `evidence.ts`, `worker-routing-policy.ts`. No new HTTP route. No real billing-provider/IdP/credential anywhere. No production deploy, no DNS, no MAIN mutation, no self-merge.

## Mandatory adversarial witnesses

- `tests/organization-resource-binding-durable-source.test.ts`: 3 new tests — "never fabricates READY" (`ACTION_REQUIRED`/`KNOWLEDGE_EVIDENCE_MISSING` persists when no evidence is ever recorded for a bootstrap-time-referenced `knowledgeEvidenceRefs` entry); READY once matching evidence is durably recorded for the binding's own tenant; cross-tenant isolation (an evidence reference recorded under a *different* tenant, even reusing the same `evidenceId` string, does not satisfy this binding's own bound ref).

## Guard-disable sanity

- The new wiring (`currentKnowledgeEvidenceRefs` sourced from `evidenceReferenceStore.listByTenant(...)`) was temporarily reverted to the old hardcoded `[]`, rebuilt, and the suite re-run. Exactly 1 test failed — the new READY test, proving the wiring load-bearing. No other test regressed (the never-fabricates and cross-tenant tests both still pass against `[]`, as expected — they assert `ACTION_REQUIRED`, which an empty list still correctly produces). Restored and verified byte-identical via `diff`.

## Evidence

- Clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`): exit 0.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `node --test dist/tests/*.test.js`: **3033/3033 passing** (3030 pre-existing + 3 new).
- Zero new runtime dependency.

Status: `IMPLEMENTED / SELF-VALIDATED` — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`.
