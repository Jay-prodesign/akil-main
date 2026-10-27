# Worker ADMITTED/ELEVATED Admission: Policy-Authority Analysis (AA-002 / AA-003 / AA-005 / Rev106)

**Date:** 2026-10-27 · **Repo state read:** `main` @ `6b190a2` · **Role:** independent fresh-context architecture/policy reviewer, analysis only. No code or files were modified. No worker trust or authority was granted, proposed as granted, or activated.

> **Provenance note:** this is a redo of a Founder-delegated Brain-role task originally commissioned on 2026-10-23 (PR #145 comments `6354980451`/`6355014544`). The original run's deliverable was never persisted anywhere — no PR comment, no committed doc — and was discovered missing during the 2026-10-27 fresh gap scan despite having been marked `completed` in task tracking. This document and the accompanying PR #145 comment are the correction: the result is committed to the repository and posted to the standing comms thread so it cannot silently vanish again.

## Verdict

**D-class (needs a genuine Founder/Brain policy decision). No reversible C-class path exists for the privileged part.**

Existing canonical authority already answers how a worker is *born*: always `UNTRUSTED`/`STANDARD`. It says nothing about who may move a worker to `ADMITTED` or `ELEVATED`, on what evidence, or how that is revoked. One canonical rule also forbids the most obvious design, which is to let organization-admin authority admit a worker. Building a durable registry that writes `ADMITTED`/`ELEVATED` would create a new authority-granting root of trust. Under the corridor's own rules that is HIGH/PROTECTED and must not be invented by engineering.

---

## 1. What `ADMITTED` + `ELEVATED` actually unlocks (blast radius)

### `src/domain/worker-routing-policy.ts`
- **L162-164:** a worker that is not `ADMITTED` is never eligible. Admission is the master switch.
- **L177-179:** `HIGH_RISK` work also needs `maxRiskLevel: "HIGH_RISK"`. This is a separate field, and today it is also supplied by the caller.
- **L186-191** (with `AUTHORITY_RANK` at L51-54): `ELEVATED` satisfies routes that require `requiredAuthorityLevel: "ELEVATED"`, described as "protected/high-trust scope" in the L39-48 doc comment.
- **L285-292 and L313-321:** the same filter makes an `ADMITTED` worker eligible as an executor **and** as the independent reviewer.
- **L205:** reviewer independence is enforced only by comparing `workerId`. Two worker ids owned by the same principal or provider would count as "independent". Whoever controls admission therefore also controls what independence means in practice.

### Outside the router: `ADMITTED`+`ELEVATED` is the repo's trust root for commercial facts
1. **Service catalog.** `service-catalog-admission.ts` L107-150 (`admitServiceCatalogEntry`) requires `trustStatus === "ADMITTED"` (L127) and `authorityLevel === "ELEVATED"` (L132), and records `admittedByAuthorityId = authorizingWorker.workerId` (L147). That admission then feeds two things:
   - `TrustedServiceResolution`, which sold-scope intake now requires (`commercial-order-intake.ts` L5, L30-61; C8, PR #189);
   - `admitManualExecutionAllowedFromServiceCatalogAdmission` (`outcome-job-routing-execution.ts` L521, L571-591). A catalog entry an `ELEVATED` worker admitted as `MANUAL_EXECUTION_ALLOWED` lets jobs execute **without routed assignment**.
2. **Subscription-plan mappings.** `subscription-entitlement.ts` L246 and L264-274: the same `ADMITTED`+`ELEVATED` gate admits external-platform-product → `SubscriptionPlan` mappings (entitlement/billing semantics).
3. **Local adapter results.** `local-execution-adapter-certification.ts` L79-84: a local adapter's result is accepted as the task outcome only if the worker is currently `ADMITTED`.
4. **Local failover.** `local-execution-collaboration.ts` L609-635 picks the incoming worker from the `ADMITTED` eligible set.
5. **Resource binding.** `organization-resource-binding.ts` L455-465: a binding that names worker routes reaches `READY` only through a current `ROUTED` decision.

### What it does *not* unlock
- **Organization permissions.** `organization-service-principal.ts` L34-44 never imports the routing module, by design.
- **Reviewing its own work.** L205 / L320 exclude the executor from reviewer selection.
- **`HIGH_RISK` work without `maxRiskLevel: "HIGH_RISK"`** (L177).

### Where `ADMITTED`/`ELEVATED` values exist today
- **Live code:** none. The only non-test `ADMITTED`+`ELEVATED` value is the fixture `elevatedCatalogAuthorityWorker()` in `src/fixtures/website-build-v1-commercial-order.ts` L41-53 (used at L74-80). The runtime composition root imports only `fixtures/web-shell.js` (`src/runtime/node-server-entrypoint.ts` L6).
- **Staff wrapper:** `createLocalWorkerRegistrationForAuthenticatedStaff` hard-codes `UNTRUSTED`/`STANDARD` (`src/web/local-execution-staff-binding.ts` L119-128, rationale at L41-62).
- **Domain constructor:** the underlying `createLocalWorkerRegistration` still accepts any enum value (`local-execution.ts` L382-393).
- **`currentWorkerRouteDecisions`:**
  - hard-coded to `[]` at `organization-resource-binding-durable-source.ts` L154 (honest-empty rationale at L77-91);
  - hard-coded to `[]` at `controlled-organization-provisioning.ts` L677.
- **`/os` view:** AI & Capabilities stays `NOT_ACTIVE` (`internal-os-view-state.ts` L354-366), and "Workers" is listed among the not-active admin concepts at L1477-1478.

**Conclusion of §1:** a durable admission registry would not be a read-model convenience. It would supply the root identity that today authorizes trusted service-catalog entries, manual (non-routed) execution policy, subscription-plan mappings, and routable executor/reviewer status.

---

## 2. Canonical sources read

| Source | Drive ID | modifiedTime | Coverage |
|---|---|---|---|
| AA-002 "02 — AKILTA Current Project State" | `1mXuoY0pcdfOMpS7j8CRxws_qYe8jPfOIwmQhgIxjpu0` | 2026-10-12T09:29:22Z | **Not read in full** (~1.2M chars). Targeted greps (Rev106, 106, trustStatus, AdmittedWorker, ELEVATED, worker admission, admitted worker, explicit grant, elevat*, execution-surface), then full reads of every matching section. |
| AA-003 | `10D5cnRRHPZlwbITKEka1hKPq3SfDNur4gzyDHcVC94s` | 2026-09-16T22:03:07Z | **Read in full.** |
| AA-005 "AKILTA — Current Engineering Handoff" | `1yaomlst_hKvKk_DTJI8Tctn-Yc_hXoa-dFoIb3fdgNc` | 2026-10-20T00:17:31Z | **Not read in full** (~878k chars). Same grep set, plus full reads of Rev136 (OS-V0-02), REV216 and REV218. |
| Engineering Handoff Cold History, snapshot 2026-09-16 | `17BcSqs1z6Shk1YOfvKT1lgdPLK3rXkRQ37p7M8nGrxg` | 2026-09-16T11:39:04Z | Rev106 and Rev107 read in full; the Rev99 Local Execution block read. |
| Local Execution Bridge packet R1 | `1vhHCHZYu15IugytGb2O2epe7jgRFQF6vRoZsozjASDU` | not checked | **Read in full.** |
| V5 blueprint R22 | `1HfQ8Mzbos63LZPE_vZryd4TiLyfa8GFP_AdtmLR-el8` | 2026-09-29T10:34:02Z | §6, §16, Workstream B hot buffer and line 13 read. |

**How AA-003 was identified:** AA-005 itself names it: "AA-003 Drive engineering governance/delegation contract: `10D5cnRR…`" (AA-005 text-export line ~3004). Its Drive title is "AKILTA — AI Engineering Operating System — v1.0"; the body heading is "AKILTA — COMPACT ENGINEERING EXECUTION CONTRACT", epoch E17. A candidate from the same Drive folder ("03 — AJANS Decision Log & Governance Register") was considered and rejected, because AA-005 points to `10D5…` explicitly.

**Two different "Rev106" documents exist:**
- **The one this delegation means:** "BRAIN PERIODIC HIGH-RISK SWEEP — Rev106 — 2026-09-12 — AUTHENTICATION ≠ AUTHORIZATION". It lives in the Cold History snapshot, not in AA-002 or AA-005, and it is the Rev106 the repo cites (`LOCAL-EXEC-004.md` §"Rev106 correction"; `V2_TO_V5.md` L470-476).
- **An unrelated one:** AA-005's "BRAIN REV106 — ADM-PROJ-001 EXECUTION ENVELOPE / SINGLE-HANDOFF CONTRACT — 2026-09-23", about the project activation profile, not workers.
- AA-002 contains no Rev106 text at all.

Line numbers above refer to plain-text exports and are not stable anchors inside the Google Docs.

---

## 3. Existing authority vs. the true policy gap

### What canonical authority already settles
- **E1 — Rev106 (2026-09-12), PR #54 F1:** "authentication/membership may establish ownership identity only; worker trust/admission/authority must come from an existing semantically compatible admission/authority grant or remain fail-closed/non-privileged until such a grant is supplied. Do not map OrganizationRole directly to protected authority unless canonical policy explicitly authorizes that mapping."
  - Rev107 accepted "always creates UNTRUSTED/STANDARD workers" as the resolution.
  - The repo recorded at the time: "A real admission/elevation step remains a separate, later, explicitly-authorized grant mechanism; none is fabricated here" (`LOCAL-EXEC-004.md` L47).
- **E2 — AA-005 Brain Rev136 (OS-V0-02 semantic contract):** "Worker trust/admission/routing status cannot manufacture Organization authority; **Organization authority cannot manufacture worker admission.**" Also: "do not create a second worker registry"; and "Identity ≠ membership ≠ worker admission/routing ≠ permission."
- **E3 — AA-003 §1:** Founder-protected decisions include "credential/access widening" and "fundamental architecture".
- **E4 — AA-003 §9:** "auth/IAM/authority boundary … credential/access widening … financial/payment/customer-binding behavior" are HIGH/PROTECTED and NOT SAFE_MERGE. "If classification is uncertain between MEDIUM and HIGH, classify HIGH."
- **E5 — AA-002 "Founder-Approved Execution-Surface Reconciliation" (2026-09-27):**
  - Local Execution is "optional and default OFF until admitted".
  - "Before source admission Brain must fresh-read … then admit only the smallest dependency-safe vertical slice".
  - Eligibility requires "worker/device admission/currentness"; account mode or subscription capacity "never create authority".
  - "CURRENT SOURCE EFFECT: NONE."
  - It supersedes the 2026-09-11 Local Execution packet, which now carries "HISTORICAL / NON-SELECTOR … no section below may create a … task". That packet's suggested grants (`local_device.register_self`, `local_worker.join_org_pool`, `project.worker.assign`, …) include no admit or elevate grant in any case.
- **E6 — AA-002 "Founder-Approved Core Intelligence / Worker / … / Eval Direction":**
  - Activation sequence step 3: "After the core V0 execution chain is genuinely working/dogfoodable, **admit one bounded real AI-worker vertical slice** against one real use case".
  - Step 4: "promote only with evaluation evidence".
  - Eval tooling rule: "`evaluationEvidenceRef` must ultimately point to versioned, reproducible evidence rather than a decorative string".
  - "SOURCE EFFECT NOW: NONE … do not treat this planning approval as evidence that any real AI provider, local worker … is already implemented or active."
- **E7 — V5 §6 and line 13:** routing happens "among **admitted** … workers"; "provider availability ≠ admission ≠ authority"; "local/cheap/available never means admitted or authorized". §6 assumes admission. It never defines who performs it.
- **E8 — AA-005 REV216:**
  - It authorizes "bounded durable stores … that directly complete already-defined behavior", subject to "consumer-driven and reuse-first … preserve truthful NOT_ACTIVE … rather than fabricating capability".
  - Stop condition (1): "material architecture decision".
  - Stop condition (5): "live credentials/secrets/provider activation".
  - REV218 keeps every non-merge protected ceiling.

### Exec-plan check (where is an admitted worker supposed to come from?)
- `V5-WRK-001.md` L13 and L38 describe "a caller-declared registry of admitted workers" with "no worker admission/registry mutation".
- `SVC-ADM-001.md` L35 (Rev102 F2) and `APP-SUB-001.md` L35 reuse `AdmittedWorker` as the authority primitive and take the admitted worker as a caller-supplied given.
- `WHOLE-PRODUCT-GAP-SCAN-2026-10-23.md` explicitly excluded "worker-admission authority", leaving AI & Capabilities `NOT_ACTIVE`.
- **No accepted exec-plan says who admits a worker, on what evidence, or how revocation works.**

### The true gap
No canonical text authorizes any actor or mechanism to move a worker to `ADMITTED` or `ELEVATED`:
- Rev106 permits only an *existing* compatible grant. None exists, which the repo already verified once at Rev106 and this analysis re-verified today.
- E2 rules out the natural design: a tenant `AuthorityContext` or organization-admin admission.
- Reusing an `ADMITTED`+`ELEVATED` worker to admit other workers just moves the problem: something still has to admit the first one.
- E5 and E6 reserve real-worker admission to an explicit Brain admission, after V0 dogfooding, with evaluation evidence.
- Because `ELEVATED` gates catalog/order-intake and subscription-mapping truth (§1), the decision also touches financial/customer-binding semantics (E3/E4).

### A non-privileged registry is not C-class either
A registry that only stores `UNTRUSTED`/`STANDARD` registrations was considered. Its shape would be Rev106-compliant. But such workers can never route (L162), so `currentWorkerRouteDecisions` would stay empty and AI & Capabilities would have nothing truthful to activate. It has no consumer under REV216 (E8), and Local Execution source still awaits Brain admission (E5). **Not recommended as a C-class item.**

### Parallels with existing D-entries
- **D12** ("no canonical source in this repository currently specifies" a multi-org registry or durable grant store): same shape. The missing thing is architecture plus authority, not plumbing.
- **D4** ("inventing one would itself be fabricating a policy"): same shape for role→permission.
- **D7** (entitlement/delegated authority × capability routing; "no canonical source … specifies how they compose"): adjacent, and should be decided together with this.
- **Break-glass analog:** the 2026-10-27 C7 entry in `CURRENT_STATE.md` notes "nothing currently mints or revokes a `BreakGlassAccessGrant` at runtime … its own separately-scoped follow-on" — now recorded as **D13** in the gap-scan doc. This is the same minting-authority gap, one layer over.

---

## 4. Proposed D-entry (recorded as **D15** in `WHOLE-PRODUCT-GAP-SCAN-2026-10-23.md`)

**Item:** a durable worker-admission/elevation registry, which is what would back `currentWorkerRouteDecisions` and `/os` AI & Capabilities.

**Why no C path:** it requires a new authority-granting root of trust that no canonical source specifies. Evidence: E1 + E2 + E3/E4 + E5/E6, and §1's blast radius.

**Decisions the Founder/Brain must make:**
1. **Root of trust.** Who may set `ADMITTED`? Who may set `ELEVATED`? Options: Founder only; a Brain-recorded canonical decision; a human protected-action authority. The last option requires an explicit carve-out from E2 ("Organization authority cannot manufacture worker admission") and from Rev106's OrganizationRole clause. How is the first admitter bootstrapped?
2. **Scope.** Is admission global and non-tenant (as `AdmittedWorker` is today; `service-catalog-admission.ts` doc comment L89-106), per Organization/tenant, or per project? Is `org_akilta` treated the same as customer organizations?
3. **Per-dimension authority.** Are `trustStatus`, `authorityLevel`, `maxRiskLevel` and the declared capability/tool/policy refs set by separate decisions? Can any of them be self-declared by the worker or its owner? Today all of them are caller-supplied.
4. **Evidence bar.** What must `evaluationEvidenceRef` resolve to before `ADMITTED`, `ELEVATED`, or `HIGH_RISK` is granted (E6: versioned, reproducible; Golden Worker Evaluation)? Does it differ for local and cloud/API workers?
5. **Revocation and currentness.**
   - Who can revoke, and is `REVOKED` terminal?
   - Must every consumer re-resolve currentness before use, as `admitLocalWorkerAdapterResult` already does?
   - Do `ServiceCatalogAdmission`s and subscription mappings authorized by a later-revoked worker cascade, or stay valid?
6. **Reviewer independence.** Is a distinct `workerId` enough (L205), or must executor and reviewer differ by owner principal, provider or account?
7. **Classification of `ELEVATED`.** Should "admit a trusted service-catalog entry or subscription mapping" stay a worker-authority attribute at all (a Rev102 / Rev60 reuse expedient)? Or, given its financial/customer-binding reach, should it be a Founder/human-protected decision instead?
8. **Sequencing.** Is this registry admitted now, or only together with E6's "first bounded real AI-worker vertical slice" after V0 dogfooding? Which first worker? Any cloud/API worker also hits D3 (credentials) and REV216 stop #5.
9. **Audit.** What durable provenance must each admission or revocation record (actor, evidence, scope, time), consistent with AA-002's provenance rule?

**Smallest reversible shape, once decided (for reference only, not authorized):**
- A durable append-only worker-admission ledger, using the existing `linkSync` atomic-claim / full-revalidation store pattern.
- Each record carries the authorizer provenance from Q1, the evidence ref from Q4, and the revocation semantics from Q5.
- A read adapter projects current `AdmittedWorker` candidates. For each binding's `workerRouteRefs`, a fresh `resolveWorkerRoute` computes `currentWorkerRouteDecisions`.
- A read-only `/os/ai-capabilities` view sits on top.
- No seeded admitted worker. Everything is still born `UNTRUSTED`/`STANDARD`.
- Classification HIGH/PROTECTED, NOT SAFE_MERGE (AA-003 §9).

---

## 5. Disposition and next action

- **STOP_CLASS:** A/B (AA-003 §3) for this edge only.
- **BLOCKED_EDGE:** worker `ADMITTED`/`ELEVATED` admission authority. Downstream of it: `currentWorkerRouteDecisions` and `/os` AI & Capabilities.
- **What is not blocked:** all other REV216 work. Nothing else depends on this edge. The existing fail-closed behavior (born `UNTRUSTED`/`STANDARD`, honest-empty route decisions, `NOT_ACTIVE` page) is correct and should be kept unchanged.
- **NEXT_WAKE_TRIGGER:** a canonical Founder/Brain decision answering Q1-Q9, at minimum Q1, Q2, Q4 and Q5.
- **Required of engineering until then:** do not add any code path that writes `ADMITTED`/`ELEVATED` outside tests or fixtures.

### Most load-bearing repo files
- `src/domain/worker-routing-policy.ts`
- `src/domain/service-catalog-admission.ts`
- `src/domain/subscription-entitlement.ts`
- `src/domain/outcome-job-routing-execution.ts`
- `src/domain/local-execution.ts`
- `src/web/local-execution-staff-binding.ts`
- `src/domain/local-execution-adapter-certification.ts`
- `src/domain/organization-resource-binding.ts`
- `src/web/organization-resource-binding-durable-source.ts`
- `src/fixtures/website-build-v1-commercial-order.ts`
- `docs/exec-plans/active/LOCAL-EXEC-004.md`
- `docs/exec-plans/active/WHOLE-PRODUCT-GAP-SCAN-2026-10-23.md`
