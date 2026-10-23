# CUS-OFFBOARD-002 — Decision Packet: customer-scoped resource dispositions on offboarding

**Status:** DECISION PACKET, non-destructive. It implements nothing, deletes nothing and sets no retention policy.
**Prepared:** 2026-10-23 by an architecture/research Claude agent (separate context), on owner instruction in PR #170 comment `6354570236`. It answers: "produce a non-destructive decision packet... preserve that real owner gate."
**Base examined:** local `main` at `f4493e4`, plus AA-005 (Drive `1yaomlst_...`, modified 2026-10-20, top revisions REV216–REV218) and AA-002 (Drive `1mXuoY0p...`, modified 2026-10-12).
**Not legal advice.** The regulatory notes below are general reasoning. Counsel must confirm which regimes apply and what periods they require.

---

## 1. What the Founder is being asked

`CUS-OFFBOARD-002` (`src/domain/customer-offboarding-execution.ts`) records exactly one disposition for each customer-scoped resource kind, and that disposition is always `BLOCKED_UNSUPPORTED`. That is truthful today. The canonical V2 blueprint names "backup/restore, export/delete/offboarding **and retention** verified" (quoted in `customer-lifecycle-backup.ts`). AA-005 lists "OS-V1-10 Data Lifecycle / Export / Delete / Offboarding" as NEW-MINIMUM. AA-002 says retention duration and final legal/privacy wording "remain evidence/policy-gated", and that release legal/privacy readiness is "explicitly triggered by the actual future ... retention/deletion/export" surfaces.

Engineering cannot replace `BLOCKED_UNSUPPORTED` with a real deletion behavior until the Founder answers decisions D1–D6 in §5. REV216 hard stops 2 (irreversible/destructive action) and 7 (legal/commercial terms) apply directly. Everything in §4 can proceed without any of these answers.

---

## 2. Ground truth on current `main` (verified, with corrections to the existing record)

| Fact | Evidence |
|---|---|
| **Correction 1: the inventory of "exactly three" customer-scoped kinds is materially incomplete.** About 30 domain types carry `customerId`. Examples: `OutcomeJob`, `EvidenceReference` (`evidence.ts`), `AuditEvent`, `BillingReferenceRecord`, `Subscription`/entitlement records, `ProjectPlan`, `ApprovalReference`, `SoldScope`, `VerificationResult`, `OutcomeJobExecutionRunState`/events, `PlanAdmission*`, `ExecutionEconomicsAttribution`, quota reservations, protected-decision waits. | `grep -rn "readonly customerId" src/domain` |
| **Correction 2: customer-scoped data is already durably at rest in more places than the three kinds.** Durable stores whose records carry `customerId`: project, outcome-job (File and Postgres), outcome-job-execution (File and Postgres), plan-admission, evidence-reference, customer-offboarding-request, external-sale-bootstrap, protected-decision-wait, quota-reservation (Postgres), connector-connection, controlled-org-provisioning, resource-binding. Also `src/application/durable-audit-log.ts`. | `grep -l customerId src/domain/durable-*.ts src/domain/postgres-*.ts` |
| `PROJECT` **has** a durable store with a customer enumeration primitive: `DurableProjectStore.listByCustomer(tenantId, customerId)`. It has `create`/`update` and **no delete**. The record holds `tenantId, customerId, projectId, ownerRef, state`. | `src/domain/durable-project-store.ts` L126–145, `src/domain/project.ts` |
| `CUSTOMER_EVIDENCE` (`CustomerEvidenceItem`) has **no durable store** in this repository. It is a value object with `subject` and `sourceLocator` (a locator, not payload), and is consumed by plan compilation and fixtures. | `src/domain/customer-evidence.ts`. No `*Store` references it. |
| `COMMERCIAL_ORDER` (`CommercialOrder`) has **no durable store**, and **no price/payment field** (`tenantId, customerId, orderId, serviceRef, placedAt`). The real financial records are `BillingReferenceRecord` (`externalInvoiceRef`, terminal `PAID`/`FAILED`) and subscriptions, and neither is in the CUS-OFFBOARD-002 inventory. | `src/domain/commercial-order.ts` L15–35, `src/domain/billing-reference.ts` L83–100 |
| **A customer export primitive already exists**, though only for the `Customer`'s own fields: `exportCustomerLifecycleSnapshot` (CUS-BACKUP-001). `restoreCustomerLifecycleFromSnapshot` refuses restore when a supplied `COMPLETED` offboarding request is present. That parameter is **optional and caller-supplied**. | `src/domain/customer-lifecycle-backup.ts` |
| **Precedent for "retain + restrict":** Organization offboarding is a state transition (`OFFBOARDED`), not data deletion. The resource binding "never changes once bootstrapped (historical evidence is never deleted)", and an OFFBOARDED org can never become READY again. | `organization.ts` L31, `organization-resource-binding.ts` L283–287, L346–347 |
| `AuditEvent` is "immutable/append-only at domain-contract level". | `src/domain/audit-event.ts` L14 |
| `Customer.learningEligibility` exists. Customer data may feed learning/knowledge, so offboarding has a derived-data dimension. | `src/domain/customer.ts` |
| The offboarding decision gate already requires a GRANTED protected-action principal distinct from the requester (CUS-OFFBOARD-001), with durable request truth (CUS-OFFBOARD-DURABLE-001). REV217 adds WRITE authority for denial. | `customer-offboarding.ts`, `durable-customer-offboarding-request-store.ts`, AA-005 REV217 |

**What this means for the decision:** "delete PROJECT / CUSTOMER_EVIDENCE / COMMERCIAL_ORDER" is the wrong unit to decide on. Two of the three kinds have nothing durably stored in AKILTA to delete. The customer data that actually sits at rest is mostly elsewhere: OutcomeJob, execution and evidence-reference stores, and the audit log. A real policy has to be set per *data class*, not per the three literals.

---

## 3. Options per data class

Legend: **Rev** = reversible. **New infra** = needs something that does not exist on `main`.

### Option catalogue (applies to every class)

| ID | Option | What it means |
|---|---|---|
| A | Hard delete | Physically remove records from the durable stores (and backups). |
| B | Anonymize/pseudonymize in place | Keep the record shape and replace or strip the customer linkage and any PII. Records stay usable for aggregate, audit and accounting purposes. |
| C | Export, then A or B | Produce a scope-limited export for the customer or staff first, then delete or anonymize. |
| D | Retain + access-restrict | Data is kept, and every read path refuses access once offboarding is COMPLETED. This mirrors Organization `OFFBOARDED`. |
| E | Retain for a period T, then A or B | D first, then a scheduled purge. **Requires a retention period**, which is a policy value. |

### 3.1 PROJECT (durable: `FileDurableProjectStore`)

| Opt | Implementation on this codebase | Rev | New infra | Considerations |
|---|---|---|---|---|
| A | Add `delete`/`purge` to `DurableProjectStore` with lock and replay revalidation. Cascade to dependents keyed on `(tenant, customer, project)`: outcome-job, execution, plan-admission, evidence-reference, resource-binding `projectRef` (the binding is designed never to change). | No | Cascade + backup purge | Breaks the binding's "historical evidence never deleted" invariant and the append-only audit lineage (`AuditEvent.projectId`). Highest blast radius. |
| B | `anonymizeProject` via the existing `update(expectedVersion)` path. Overwrite `ownerRef` with a tombstone and keep `projectId`. | Partly | No (uses existing `update`) | `customerId` is part of the storage key, so changing it is an identity reassignment, which `update` forbids by design. True pseudonymization of the key needs a re-key migration. |
| C | Export: `listByCustomer` → scope-limited snapshot, following the `exportCustomerLifecycleSnapshot` pattern. | **Yes** (export alone) | **No** | Export is non-destructive and buildable now (see §4). |
| D | Add an offboarded-customer read gate where project reads compose (client snapshot source, resource-binding source). The disposition becomes something like `RETAINED_ACCESS_RESTRICTED`. | Yes | No | Same pattern as the Organization OFFBOARDED gate. Changes customer/staff-visible behavior, so see D1. |
| E | D, plus a durable purge schedule and a runner. | No (at purge) | Scheduler/runner | Needs T (D2). |

### 3.2 CUSTOMER_EVIDENCE (no durable store in AKILTA)

| Opt | Implementation | Rev | New infra | Considerations |
|---|---|---|---|---|
| A/B/C/E | Nothing to act on inside AKILTA persistence today. The actual customer material is behind `sourceLocator`, which points at an external location. Real deletion there would be an **external effect** through a connector (REV216 stop 5 or 8) or a manual step. | — | Connector effect | The derived, durable thing is `EvidenceReference` (`durable-evidence-reference-store.ts`, carries `customerId`). That store is the real target, and it was not in the inventory. |
| Truthful interim | Replace `BLOCKED_UNSUPPORTED` with a more precise status for this kind, e.g. `NO_AKILTA_DURABLE_RECORD`, and add `EVIDENCE_REFERENCE` as a separate kind. | Yes | No | This is a truth-surface refinement, not policy. It must not read as "deleted". |

### 3.3 COMMERCIAL_ORDER (no durable store; no price field)

| Opt | Implementation | Rev | New infra | Considerations |
|---|---|---|---|---|
| A | N/A in-repo (nothing persisted). | — | — | — |
| D/E | Applies to the **financial records that actually exist**: `BillingReferenceRecord`, subscriptions/entitlements, `ExecutionEconomicsAttribution`. | — | — | Commercial and financial records are commonly subject to bookkeeping/tax retention obligations that can outweigh an erasure request. Many privacy regimes (e.g. GDPR Art. 17's right to erasure) carve out data needed to meet a legal obligation. **Counsel must name the applicable obligation and period. Engineering will not guess one.** The usual pattern is B (strip the PII link and keep the transaction facts) or E. |

### 3.4 Data classes not in the current inventory (they must be covered by the same decision)

- **Audit log** (`AuditEvent`, `durable-audit-log.ts`): append-only by contract. The realistic choices are D, or B (pseudonymize `customerId`/`actorRef`). A breaks the integrity guarantee.
- **OutcomeJob, execution, plan-admission, verification and approval records:** operational lineage. Usually B or E.
- **Backups/snapshots:** the restore gate already refuses an offboarded customer, but only when the caller supplies the offboarding request. Deletion that does not propagate to backups can be undone by a restore.
- **Learning/knowledge derivatives** (`learningEligibility`): whether erasure must reach derived knowledge is a policy question on its own.

---

## 4. Work engineering can do now, without any Founder decision (non-destructive, reversible, delegated under REV216)

Each item is a bounded C-class candidate. None deletes data or sets a retention value.

1. **E1 — Inventory truth correction.** Fix the false "exactly three domain types carry `customerId`" claim in the `customer-offboarding-execution.ts` doc comment and in `CUS-OFFBOARD-002.md`. Widen `CustomerScopedResourceKind` to the durable data classes in §2 (at minimum `OUTCOME_JOB`, `OUTCOME_JOB_EXECUTION`, `PLAN_ADMISSION`, `EVIDENCE_REFERENCE`, `AUDIT_EVENT`, `BILLING_REFERENCE`), each still `BLOCKED_UNSUPPORTED`. The cost is a test update (E4 currently asserts exactly 3 dispositions).
2. **E2 — Non-destructive PROJECT export.** Add `exportCustomerProjectsSnapshot` over the existing `DurableProjectStore.listByCustomer`, gated like `exportCustomerLifecycleSnapshot`. Widen the disposition union with `EXPORTED` **for PROJECT only**. This is precedent-backed (CUS-BACKUP-001 and the OS-V1-04 org archive) and needs no new store.
3. **E3 — Precise status for non-persisted kinds** (§3.2 truthful interim). Optional, and only alongside E1.
4. **E4 (optional) — Make the restore gate authoritative.** Have the restore path read `DurableCustomerOffboardingRequestStore` instead of relying on the optional caller-supplied `relatedOffboardingRequest`. This closes "deleted customer reappears via restore" before any deletion exists.

Not delegated (needs §5): any `delete`/`purge`/`anonymize` write path, any retention timer, any read-gate change that alters customer-visible behavior (unless D1 approves it), and any external connector deletion effect.

---

## 5. Decisions for the Founder (approve / reject / amend each)

Recommendations are shaped to keep every irreversible step behind an explicit later approval. They are recommendations, not policy.

| # | Decision | Recommended answer | Approve / Reject / Amend |
|---|---|---|---|
| D1 | Interim default once offboarding is COMPLETED: **retain + access-restrict (Option D)** for every customer-scoped class, mirroring Organization OFFBOARDED. | **Approve.** Non-destructive and reversible, closes customer-visible access, and buys time for D2–D4. | ☐ / ☐ / ☐ |
| D2 | Retention period(s) after offboarding, per data class (operational, financial, audit, evidence). | **Founder + counsel supply the values.** Engineering builds the mechanism only after values exist. Until then E-options stay `BLOCKED_UNSUPPORTED`. | ☐ / ☐ / ☐ |
| D3 | Erasure model at end of retention: hard delete (A) or anonymize (B), per class. | **B for financial, audit and operational lineage. A only for content-bearing records with no legal hold.** Subject to counsel. | ☐ / ☐ / ☐ |
| D4 | Treatment of financial/commercial records (`BillingReference`, subscriptions, `CommercialOrder`) against an erasure request. | **Retain the transaction facts under the legal-obligation exception, strip the PII link** (B/E). Counsel to confirm. | ☐ / ☐ / ☐ |
| D5 | Must erasure propagate to backups/snapshots and learning/knowledge derivatives? | **Yes for backups**, through the restore-refusal gate (E4) plus expiry of backups, rather than rewriting them. **Founder call on learning derivatives**, which depends on `learningEligibility` consent semantics. | ☐ / ☐ / ☐ |
| D6 | Authority for an irreversible purge, if/when built. | **Protected action plus a distinct second principal** (reusing the CUS-OFFBOARD-001 pattern), with dry-run evidence before execution and production execution kept a Founder-gated effect. | ☐ / ☐ / ☐ |

**Smallest useful answer:** approving D1 alone unblocks a reversible "retain + restrict" disposition, alongside the E1/E2 work that needs no approval. D2–D6 can follow when counsel is available.

---

## 6. Explicit non-claims

- This packet does not assert that any regulation applies to AKILTA or name any retention period.
- It changes no code, no store and no git state.
- `BLOCKED_UNSUPPORTED` stays the only reachable disposition until §4 work is reviewed or §5 decisions are recorded in canonical authority (AA-005).
