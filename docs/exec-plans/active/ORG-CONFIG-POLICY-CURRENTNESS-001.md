# ORG-CONFIG-POLICY-CURRENTNESS-001 — Durable currentEffectiveConfigRefs/currentEffectivePolicyRefs Wiring

## Provenance

- Governing authority: continuation of the `OrganizationResourceBindingSource` currentness-gate series (`ORG-MEMBERSHIP-DURABLE-001`, `ORG-SERVICE-PRINCIPAL-DURABLE-001`), following Brain's independent review confirmation on PR #164 (comment `6237721816`, "no new blocking defect ... this milestone is not a stop under REV216") and the Founder's explicit instruction to continue autonomous engineering to completion. REV215/REV216/REV217 (AA-005) remain controlling; Founder gate NONE for this bounded internal primitive.
- A fresh dependency scan of the three remaining `OrganizationResourceBindingSource` currentness gaps (`currentEffectiveConfigRefs`/`currentEffectivePolicyRefs`, `currentWorkerRouteDecisions`, `currentKnowledgeEvidenceRefs`) found real, already-durable supporting infrastructure for exactly one of them: `effective-configuration-policy.ts`'s `resolveEffectiveConfigurationPolicy` already has a durable decision/history layer (`durable-configuration-policy-decision-store.ts` + `configuration-policy-decision-projection.ts` + `resolve-and-project-configuration-policy-decision.ts`, OS-V0-11 Phase A). `currentWorkerRouteDecisions` (needs a durable "admitted worker candidates per route" registry to re-invoke `resolveWorkerRoute` against) and `currentKnowledgeEvidenceRefs` (needs a durable `EvidenceReference` store) still have no genuine durable source anywhere in `src/` — posted as a finding on PR #164 (comment `6237784269`) rather than fabricated, per Brain's own `6223155547` framing ("leave truthful and unresolved until each has a genuine source").

## Reuse surface (read before designing)

- `src/domain/organization-resource-binding.ts` — `resolveOrganizationResourceBindingStatus`'s own doc comment (lines 279-308) names the exact contract: "`resolveEffectiveConfigurationPolicy`'s own output shape ... a caller freshly resolves the current effective controls and passes the resulting refs" for the config/policy gate; its `CONFIG_NOT_CURRENT`/`POLICY_NOT_CURRENT` gates (lines 431-453) are reused unmodified.
- `src/domain/durable-configuration-policy-decision-store.ts` (`FileDurableConfigurationPolicyDecisionStore`, OS-V0-11 Phase A) — `getActiveDecisionProjection(tenantId, decisionKey)` ("latest wins over the full append log") reused unmodified as the genuine "current decision" source.
- `src/domain/configuration-policy-decision-projection.ts` — `encodeConfigurationPolicyDecisionKey` reused unmodified to derive this binding's own project-scope decision key.
- `src/web/organization-resource-binding-durable-source.ts` (`ORG-MEMBERSHIP-DURABLE-001`/`ORG-SERVICE-PRINCIPAL-DURABLE-001`) — extended with a sixth constructor parameter, mirroring every prior store's own wiring exactly.

## Scope (this checkpoint)

- `createDurableOrganizationResourceBindingSource` gains a sixth positional parameter `configurationPolicyDecisionStore: DurableConfigurationPolicyDecisionStore`.
- `resolveStatus` derives the binding's own project-scope `decisionKey` as `{ tenantId: organization.tenantId, customerId: binding.ownership.customerId, projectId: binding.projectRef }` (the SAME identity `currentProject` is already resolved against — no new scope convention invented) and reads `configurationPolicyDecisionStore.getActiveDecisionProjection(...)`.
- `currentEffectiveConfigRefs`/`currentEffectivePolicyRefs` are the active decision's own `resolution.effectiveConfigRefs`/`effectivePolicyRefs` when a decision exists for that exact scope, else `[]` (an honest "nothing currently effective" answer — not a fabricated claim, and the correct input for a binding that referenced a config/policy ref before any decision was ever recorded for its scope to stay `ACTION_REQUIRED`).
- This adapter does **not** itself call `resolveEffectiveConfigurationPolicy` or `resolveAndProjectConfigurationPolicyDecision` — it has no independent source of raw `controls` to recompute a resolution from, and inventing one would be exactly the kind of second resolution policy `configuration-policy-decision-projection.ts`'s own doc comments explicitly forbid. It only reads whatever decision some other, already-authorized caller has already durably recorded.
- `currentWorkerRouteDecisions`/`currentKnowledgeEvidenceRefs` remain real, honest empty evidence — unchanged, still genuinely unresolved pending their own future task.

## Explicitly deferred (not fabricated)

- No new `resolveAndProjectConfigurationPolicyDecision` call site anywhere in this checkpoint — recording a decision remains whatever other caller's own responsibility it already was.
- No durable "admitted worker candidates per route" registry, no durable `EvidenceReference` store — both remain open, named follow-ups (see PR #164 comment `6237784269`).
- Not wired into any live HTTP route, matching every sibling adapter's own established precedent.

## Hard Non-Scope

No modification to `organization-resource-binding.ts`, `effective-configuration-policy.ts`, `configuration-policy-decision-projection.ts`, `resolve-and-project-configuration-policy-decision.ts`, or `durable-configuration-policy-decision-store.ts`. No new HTTP route. No real billing-provider/IdP/credential anywhere. No production deploy, no DNS, no MAIN mutation, no self-merge.

## Mandatory adversarial witnesses

- `tests/organization-resource-binding-durable-source.test.ts`: existing "never fabricates READY" config test retitled/reconfirmed (ACTION_REQUIRED persists when no decision is ever recorded for the binding's scope); 3 new tests — READY once a matching decision is durably recorded for the binding's own project scope (both config and policy refs); `POLICY_NOT_CURRENT` when the durably-decided policy no longer includes the bound ref; cross-scope isolation (a decision recorded for a *different* customer/project under the same tenant does not satisfy this binding's own bound ref).

## Guard-disable sanity

- The new wiring (`activeConfigPolicyDecision?.resolution.effectiveConfigRefs/effectivePolicyRefs ?? []`) was temporarily reverted to the old hardcoded `[]`, rebuilt, and the suite re-run. Exactly 1 test failed — the new READY test proving the wiring load-bearing. No other test regressed. Restored and verified byte-identical via `diff`.

## Evidence

- Clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`): exit 0.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `node --test dist/tests/*.test.js`: **3030/3030 passing** (3027 pre-existing + 3 new).
- Zero new runtime dependency.

Status: `IMPLEMENTED / SELF-VALIDATED` — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`.
