# WHOLE-PRODUCT-GAP-SCAN-2026-10-23 — Researcher gap scan (read-only, implements nothing)

Status: RESEARCH / NON_SELECTOR. This document only proposes candidates. It changes no source, selects no task on its own, and authorizes no protected action.

## Scope and exclusions

Excluded on purpose, because they are already known and exhausted: `CUS-OFFBOARD-002` (decision packet D1-D6), `currentWorkerRouteDecisions` / worker-admission authority (another agent has this), and `LOCAL-EXEC-007` safe-switch preflight.

## Canonical sources read (Drive `modifiedTime` checked first)

| Source | Drive ID | modifiedTime | How it was read |
|---|---|---|---|
| 02 — Current Project State (AA-002) | `1mXuoY0p…pu0` | 2026-10-12 | Read the full newest-first section (Rev183→Rev205, Founder directives, product registry), then targeted greps across all 16.4k lines (V5-LAB/EVAL, company graph, conversational, CONNECTED_DARK, site integration, Drive-ID index). |
| Current Engineering Handoff (AA-005) | `1yaomlst…dGd` | 2026-10-20 | Read REV202→REV218 in full (the controlling tail, lines 8100-8477), plus the CONNECTED_DARK / INTERNAL_CONNECTED preflight (lines 1755-1870). Targeted greps elsewhere. |
| V2→V5 Corridor packet | `113M8-J5…rVA` | 2026-08-27 | Read in full. |
| V2→V5 Master Program Blueprint R22 | `1OjPfxJa…rps` | 2026-08-28 | Read in full. |
| V3 / V4 blueprints | `1joeMcCR…p50` / `1M5vANxd…DNs` | 2026-08-28 / 08-29 | Read in full. |
| V5 blueprint R22 | `1HfQ8Mzb…el8` | 2026-09-29 | Read the overlay, the workstreams A-J and the headings. |
| AKILTA OS Core Definition & V0/V1/V2 Blueprint R1 | `1SsxLDjA…XgWg` | 2026-09-26 | Read §1-§30 and §33 in full (V0 MUST, Lift Matrix A-Z, V1/V2 boundary, owner-gate map). |
| OS V0/V1 Execution Program R1 | `1CG53xxe…cJc` | 2026-10-05 | Read §6-§20 in full (the V1 package contracts OS-V1-00..14+RC). |
| 04 — Master Roadmap (sheet) | `1VRDtcYN…P4` | 2026-09-28 | The connector returns only sample rows. Treated as NON_SELECTOR; not relied on. |

The controlling authority for selecting work is AA-005 REV216 (continuous software finish mode) together with REV218 (auto-merge after independent review). REV216 explicitly authorizes "bounded durable stores, existing-port persistence implementations, lookup/enumeration adapters, read/write application boundaries, **route/UI wiring, integration composition**, recovery/data-lifecycle plumbing". REV215 adds: "derive a bounded V2 engineering contract from existing canonical OS blueprint".

## Headline finding

The 2026-10-22 entry in `CURRENT_STATE.md` says there are "zero remaining C-class units". That scan only looked for missing **domain primitives** and unfilled currentness dimensions. It did not look at **composition and route wiring**, which REV216 names as authorized work. Almost every durable adapter built since PR #158 says in its own exec-plan "Not wired into any live HTTP route / `node-server-entrypoint.ts` / `internal-os-dev-main.ts`". I checked this directly: none of `createDurableClientProjectSnapshotSource`, `createDurableWorkProjectSource`, `createDurableWorkJobSource`, `createDurableOperationalObservabilitySource`, `createDurableCustomerOffboardingAdminSource` or `createDurableOrganizationResourceBindingSource` has a single call site in `src/` outside its own file. None of the `*AsAuthenticatedStaff/Admin` mutation boundaries has a call site either. The deployable runtime still serves fixtures.

## C-class candidates (ranked by how foundational they are)

### C1 — Runtime composition root: wire the real durable sources into the deployable runtime (FILE driver)
- **Gap (verified):** `src/runtime/node-server-entrypoint.ts` still injects `createWebShellFixtureSnapshotSource`/`TeamAttentionSource`. Its own doc comment says "no such source exists yet", which is now stale because `client-project-snapshot-durable-source.ts` exists. The deployable runtime does not serve `/os` at all; `createInternalOsHttpServer` is only used by `internal-os-dev-main.ts`. `http-server.ts` never passes `commercialStatusSource`/`billingReferenceStatusSource`/`lifecycleReadinessSource` to `createRequestHandler`, so the V2-CUST-SURFACE-001 sections cannot be reached from any real server.
- **Canonical source:** AA-005 "MINIMUM INTERNAL_CONNECTED GATE — STAFF/FOUNDER SURFACE" items (1) "production runtime actually exposes the `/os` surface … by one composed Node router", (4) "Organization Zero project/job sources read real durable/current state", (5) and (6). AA-005 "MINIMUM PRE-LIVE CONNECTED_DARK GAPS" (3) "wire production/internal read projections to real persistence" and (5) "add DB/critical dependency health/readback". OS Blueprint §30 V0 MUST #18. Deferrals in RUNTIME-001, CLIENT-SNAPSHOT-DURABLE-001, OBS-ADMIN-SOURCE-001, PROJ-DURABLE-001 and WORK-JOB-SOURCE-001.
- **Why it is dependency-safe:** the production `SessionProvider`/`StaffSessionProvider` remain unconditionally fail-closed, so no real data can be served to anyone in production. Dev fixtures are already rejected in production. There is no deploy (DEPLOY-002's app spec has never been applied). It is reversible through git.
- **First slice:** add an `AppConfig` data-directory field for the FILE driver. Add one composed Node router (`/health` + `/portal/*` + `/os/*`), keeping both handlers transport-agnostic. Construct the existing `FileDurable*` stores and adapters once. Add a store-readability health probe. Update the stale doc comments. Roughly 300-500 lines of code plus tests.
- **Disclosed limit:** FILE persistence on an App Platform container is ephemeral. Real production durability requires Postgres (see D2). C1 makes that later swap a port-binding change rather than a rewrite.

### C1a (quick win) — `internal-os-http-server.ts` missed PROTO-HEADER-HARDENING
- **Gap (verified):** line ~45 builds `const headers: Record<…> = {}` as a plain object. `http-server.ts` and the Cloudflare adapter both use `Object.create(null)`.
- **Canonical source:** PROTO-HEADER-HARDENING.md claims the fix covers "both Node and Cloudflare Worker transports". The internal-OS Node transport was missed.
- **Size:** about 5 lines plus one test. Can be folded into C1.

### C2 — Durable staff access-grant source (replace static `grants` arrays)
- **Gap (verified):** `InternalOsRequestHandlerDeps.grants` is a caller-supplied static array. The `AuthorityContext` and `assignments` inside each `StaffAccessGrant` have no durable source. The membership store (`FileDurableOrganizationMembershipStore.listByTenant`) already exists.
- **Canonical source:** AA-005 INTERNAL_CONNECTED gate (3) "staff membership/effective-access grants are resolved current/fail-closed, not static fixture arrays". AA-005 STAFF AUTHORITY FACT. OS Blueprint §25.B "explicit grants/denies". Golden Path B (§30/§33.5).
- **Why it is dependency-safe:** explicit per-membership grant records (READ/WRITE/EXECUTE plus project assignments) mean there is no need to invent a role→permission mapping, which FAMILY-2 and organization-access-role.ts both say is a policy decision. The source fails closed when no grant has been recorded.
- **Size:** a medium store plus adapter, about 400 lines, following the `durable-organization-service-principal-store.ts` pattern.
- **Caveat:** if Brain wants role-derived permission bundles instead of explicit grants, this becomes D4.

### C3 — Activate the four `NOT_ACTIVE` `/os` destinations and the People directory over existing durable data
- **Gap (verified):** `internal-os-request-handler.ts` renders `notActiveDestinationPageContent` for attention, ai-capabilities, connections and knowledge. `resolvePeopleView` shows only the viewer's own membership.
- **Canonical source:** OS-V0-08.md NOT_ACTIVE lane ("no backing data source in this repository yet (OS-V0-06/07/13 territory)"). That precondition no longer holds. Also OS Blueprint §7, §8 and §25.I, V0 MUST #7/#8/#12, and V5 Workstream J.
- **Backing data that now exists:**
  - Connections: `FileDurableConnectorConnectionStore.list(tenantId)`, plus `integration-admin-view.ts` (a secret-masked read model) and the connector catalog.
  - Knowledge/Evidence: `FileDurableEvidenceReferenceStore.listByTenant`.
  - People: `FileDurableOrganizationMembershipStore.listByTenant`.
  - Attention/Approvals: needs one bounded enumeration method on `DurableProtectedDecisionWaitStore`. OS-V0-12's non-scope explicitly says "a future task can add one if a real consumer needs it", and this page is that consumer. It can be combined with the V4-OPS-001 deferred attention families that now have real sources (connection DEGRADED/REVOKED → credential/access problem; WAIT → customer approval required; retry containment → recovery required).
- **Size:** one slice per destination, each small to medium. Recommended order: Connections, People, Knowledge, Attention. AI & Capabilities comes last because its backing data is thinnest.
- **Resolution (2026-10-23):** Connections (#175), People (#176), Knowledge (#177) and Attention (#178, two of its three deferred families — retry containment stays separate, see C6) are activated and merged. AI & Capabilities was investigated and deliberately left `NOT_ACTIVE`: no durable store in this repository persists workers, declared capabilities, trust/authority, or evaluation evidence (`AdmittedWorker`/`resolveWorkerRoute` and `CapabilityAdmission` are domain types with no store; `organization-resource-binding.ts`'s `admittedCapabilityRefs` is explicitly bootstrap-time-only provenance, not a current registry; `FileDurableOrganizationServicePrincipalStore` is explicitly "NOT an alias for `AdmittedWorker`" and keeps "no worker registry" of its own). Activating this page today would require inventing data. A future, narrower, separately-scoped slice could show service principals read-only (under Admin "Workers" or People, not this label, since the records carry no AI/capability/model information) — that needs its own task contract, not assumed here. C3 is complete with this as its honest final state.

### C4 — `/os` admin mutation HTTP surface over the existing authenticated boundaries
- **Gap (verified):** the `/os` handler rejects every non-GET request. These functions all have zero route call sites: `mutateConnectorConnectionStateAsAuthenticatedAdmin`, `complete/denyCustomerOffboardingAsAuthenticatedStaff`, `create/reviseProtectedDecisionRecordAsAuthenticatedStaff`, `resolveControlledOrganizationSwitchAsAuthenticatedStaff`, `resolveEffectiveDelegatedAccessAsAuthenticatedStaff`.
- **Canonical source:** OS Blueprint Golden Path B (§30, §33.5) and §25.J "Thin Admin … revoke". Deferrals in CUSTOMER-REPO-DURABLE-001, CONN-001 ("Admin UI — genuinely the next elaboration step") and V2-ADMIN-SURFACE-001.
- **Why it is dependency-safe:** the domain authority checks already exist and are fail-closed. There is no external effect. Within the envelope it needs a design for request-body parsing, a CSRF/same-origin posture and a POST→redirect pattern.
- **First slice:** one mutation, for example offboarding deny/complete.

### C5 — Forward-port V5-LAB-001 and V5-EVAL-001 (never reached `main`)
- **Gap (verified):** `origin/claude/v5-lab-001-reusable-capability-learning` (`reusable-capability-learning.ts`) and `origin/claude/v5-eval-001-governed-evaluation-loop` (`governed-evaluation-loop.ts`) are not ancestors of `origin/main`. Neither has an exec-plan on main. Neither was in the 2026-10-21 BACKLOG RESCUE list.
- **Canonical source:** V5 blueprint Workstream G (Product Lab / Reusable Capability Learning) and Workstream I (Governed Evaluation). Master Program §8. The AA-002 Core-Intelligence direction and the V5 overlay ("GOVERNED EVALUATION").
- **Why it is dependency-safe:** both are pure additive domain modules (about 300 lines plus tests each), and both carry Rev90 bounded corrections.
- **Action:** re-derive them against current main (do not cherry-pick stale commits), confirm the post-Rev90 Brain disposition, and get an independent review.

### C6 — Wire retry containment into the live execution path
- **Gap (verified):** `resolveRetryContainmentDisposition` has no caller outside `outcome-job-retry-containment.ts`.
- **Canonical source:** OS-V1-07.md non-scope, which names this as "a separate, explicitly-named follow-on". REV209 OS-V1-07 "bound retries … crash-loop containment".
- **Size:** small to medium.
- **Resolution (2026-10-26):** `resolveRetryContainmentDisposition` is now wired into `retryOutcomeJobExecutionAttempt` (#PR_NUMBER) through a new optional, backward-compatible `retryContainmentPolicy` input. When the policy is omitted, behavior is exactly unchanged. When it is supplied, the gate runs on the freshly re-read run state after the activation/quota-currentness/lineage checks and before `admitQuotaForAttempt`. A `BLOCKED` disposition returns `{ state, invoked: false, containment }` (a new optional `containment` field on `DispatchOutcomeJobExecutionResult`): no quota is reserved, no `ATTEMPT_STARTED` is appended, and the worker is never invoked. `dispatchOutcomeJobExecutionRun` is deliberately not touched, because it only ever starts attempt 1 of a run with `currentAttempt === 0`, which the gate's own rule always admits. `src/domain/outcome-job-retry-containment.ts` is unchanged. Still open, and out of this item's scope: there is no live caller of `retryOutcomeJobExecutionAttempt` in `src/runtime` or `src/web` yet, so no production path supplies a real policy. That wiring, and the canonical policy values, need their own task contract.

### C7 — Break-glass route wiring plus a durable grant/audit store
- **Gap:** OS-V1-09.md non-scope lists both the route wiring and "a durable break-glass grant/audit STORE" as follow-ons.
- **Canonical source:** REV209 OS-V1-09 and OS Blueprint §25.T.
- **Note:** this is security-sensitive, so it should come after C2/C4.

### C8 — Require `TrustedServiceResolution` in sold-scope intake
- **Gap:** SVC-ADM-001 names this as a follow-up composition. `intakeSoldScopeFromResolution` still accepts a raw `DeclaredServiceLookupResult`.
- **Canonical source:** AUD-V5-GAP-02 ("trusted service-resolution provenance … explicitly OPEN").
- **Size:** small.

### C9 — Production-shaped portal commercial sources
- **Gap:** V2-CUST-SURFACE-001 defers a production-shaped implementation of its 3 ports. APP-BILL-001 and APP-SUB-001 say "a durable store is a separate, later integration step".
- **Work:** durable `Subscription`/`BillingReference` stores plus source adapters, threaded through C1.
- **Constraint:** no billing provider, no amounts.

### C10 — Minimal company context / Organization profile with proposed-vs-confirmed provenance
- **Gap:** there is no profile or company-graph primitive anywhere in `src/`.
- **Canonical source:** OS Blueprint §25.D, V0 MUST #11 and §30 Correction 4. Program OS-V0-13 (original label) and OS-V1-09 "Company Graph / Discovery / Knowledge Freshness". Rev202 classified V1-09 as "CERTIFY/EXTEND context freshness".
- **Caveat:** REV209 renumbered V1 and dropped this package, and REV214 certified V1 without it. Confirm with Brain that it is still in the product definition before building.

### C11 (low) — Smaller canonical items
- **DEC175-CONV-001 end-to-end witness:** Brain Rev116 PASS on an unmerged branch. CXP-ACT-001 calls it "a real, separately-scoped follow-up".
- **Config/capability cohort rollout:** Program OS-V1-05 and Rev202. No cohort concept exists in `src/`. It may have been superseded by REV209's V1-07.
- **Deterministic typed command surface (no model):** OS Blueprint §7 and §25.H, V0 MUST "conversational command surface". Nothing in `src/` implements it. A model-backed natural-language version is provider activation (D3).

## D-class (needs a genuine decision; no C-class path)

| ID | Item | Decision needed | Why no C path |
|---|---|---|---|
| D1 | Production IdP (staff + customer) | Choose an identity provider and activate credentials | `production-*-session-provider.ts` are fail-closed by design (FAMILY-2, OS-V0-08, SITE-INTEGRATION Slice A). REV216 stop #5. |
| D2 | Postgres activation | (a) the sync-vs-async store threading architecture (RUNTIME-001 "explicit, disclosed, later architectural decision"); (b) a concrete SQL driver dependency; (c) Managed PG plus a migration runner (AA-005 MIGRATION GAP) | Architecture choice plus a new dependency plus spend/credentials. It is also the only route to real durability for a container deployment. |
| D3 | Secret manager/KMS and the first concrete `ConnectorTransport`/provider adapter | Which provider/account, and its credentials | Golden C stays BLOCKED/NOT_ACTIVATED (OS-V0-13/14). REV216 stop #5. |
| D4 | Role→permission bundles; role-filtered commercial data | Which role sees or does what | FAMILY-2 and V3-COM-001: "inventing one would itself be fabricating a policy". |
| D5 | Commission %, discount limits, reseller/wholesale, binding SLA | Finance/legal/Founder | V3 Workstream E deferred activation fields; DEC-146. |
| D6 | OutcomeJob exception-state exit/recovery graph | Product semantics for leaving BLOCKED/RECOVERING/ESCALATED/STOPPED | SALE-TO-CLOSE: "matching the canonical source's own silence". |
| D7 | How entitlement and delegated authority compose with capability routing | Policy | V4-SVC-001: "no canonical source in this repository specifies how they compose". |
| D8 | TR/EN portal localization | Is portal i18n still in scope? Should the `app-i18n-001` branch be resurrected? | SITE-INTEGRATION Slice A V2 Hard Non-Scope explicitly asks for Founder/Brain direction. |
| D9 | Partner/agency user identity for V3 Workstream F multi-client surfaces | Partner session/ingress model (reuse the staff principal family, or a separate partner session) | V3 forbids a new auth framework. V3-PTR-001 and V3-F-001 defer the UI. Partners are not staff. |
| D10 | Activation packets | Web Presence/Publishing capability; External Capability Distribution Surfaces (ChatGPT App); OS-V1-13 AI Commerce federation; CONNECTED_DARK deploy; OS V2 billing/signup/trial | Each canonically requires its own activation packet or a protected gate (OS Blueprint addenda; §33.15; REV216 stops #3-#8). |
| D11 | `AUD-V5-AUTHORITY-INGRESS` merge decision | Explicit Founder/owner-gate approval to merge `claude/aud-v5-authority-ingress-binding` (tip `edbbe87`, never merged, discovered 2026-10-26 during a branch-triage sweep alongside V5-LAB-001/V5-EVAL-001) | This branch binds `admitPartnerCapabilityClaim`/`revokePartnerCapabilityClaim` to a real caller `AuthorityContext` (closing a genuine fail-open gap — any caller with no permission could currently admit/revoke a partner capability claim), and already carries a Brain Rev77 PASS for its bounded "PARTIAL HARDENING" claim. Its own exec-plan doc's `MERGE_DISPOSITION: HOLD_MERGE` is explicit and deliberately stronger than the generic hold language on other stale branches: "a separate, explicitly granted protected owner-gate is still required, never inferred from this review or from any other PR's grant." That sentence exists specifically to block the standing self-merge-after-independent-review practice this corridor otherwise uses (as applied to C5/V5-LAB-001/V5-EVAL-001) from being read as covering this case too. Treated here as a genuine D-class item rather than re-derived and merged unilaterally. `partner-capability-admission.ts` is confirmed byte-identical between the branch's fork point and current `main`, so re-deriving it is mechanically trivial once a Founder grants the gate - the blocker is the decision, not the engineering. |
