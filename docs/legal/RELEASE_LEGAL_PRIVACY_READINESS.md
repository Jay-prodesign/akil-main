# AKILTA Core — Release Legal / Privacy / Rights Readiness

Status: INTERNAL ENGINEERING RECORD  
Applies to: `Jay-prodesign/akil-main`  
Current distribution posture: PRIVATE SOURCE / PROPRIETARY / NOT A PUBLIC PRODUCT RELEASE

This document records what must be true before AKILTA Core is represented as a
public/commercial product or used to make public legal/privacy claims. It is not
itself a public Privacy Policy, Terms of Service, EULA, or legal opinion.

## 1. Current repository reality

At the time this record was created:

- the repository is private;
- the root package is marked `"private": true`;
- the repository declares no runtime npm dependencies;
- the repository is an active engineering source surface, not a declared
  production/customer-facing service;
- root proprietary licensing, third-party notices, security guidance, and
  contribution/provenance rules are maintained in repository files;
- public/commercial Privacy Policy, Terms of Service, or EULA text is not
  asserted because the final deployed product/data/distribution model is not yet
  established by this repository.

Do not convert planned behavior, domain types, tests, or internal architecture
into public legal claims without deployed evidence.

## 2. Source and IP posture

Default source posture is PRIVATE + PROPRIETARY.

Before any source publication, public SDK/sample release, source-available
distribution, or open-source transition, confirm:

- the intended public scope is explicit;
- AKILTA has the right to license every included first-party contribution;
- third-party material is correctly classified and separated;
- prior license grants and donor obligations are preserved;
- confidential/trade-secret material and repository history do not leak;
- trademarks/branding are not accidentally licensed with code;
- the release has a bounded IP evidence snapshot.

A public product, website, API, SaaS service, installer, or binary does not
require the authoritative source repository to become public.

## 3. Privacy / data-flow gate

Before publishing a Privacy Policy or store/platform privacy disclosure, map the
actual shipping implementation and operations, including as applicable:

- account/identity/session data;
- tenant/customer/project data;
- prompts, model inputs/outputs, attachments, files, and generated artifacts;
- connection/provider credentials and secret handling;
- telemetry, analytics, diagnostics, crash reporting, and cookies;
- billing/payment metadata;
- support/contact records;
- audit/security logs;
- retention periods and deletion behavior;
- export/access/correction/closure mechanisms;
- subprocessors/providers and cross-border transfers;
- AI/model/data-training behavior;
- backups and recovery copies;
- child/minor or other special-category data if the product ever enters those
  domains.

Every published privacy claim must match code, configuration, providers, and
operations. If a promised deletion, export, opt-out, retention, local-only
processing, no-training, no-sale/no-sharing, encryption, or account-closure
control does not exist in reality, correct the implementation or the statement
before release.

## 4. Terms / EULA selection gate

Do not create every legal artifact by default. Select the artifact that matches
the actual product:

- SaaS/web account/service: Terms of Service / Terms & Conditions;
- downloadable desktop/mobile/binary application: EULA where appropriate;
- public SDK/source package: applicable outbound software license;
- API/developer platform: developer/API terms where actually needed;
- enterprise/customer delivery: contract/order terms remain separate from
  generic public terms.

The final terms must reflect actual pricing, subscriptions, refunds, acceptable
use, account rules, service availability, user content, AI features, third-party
services, warranty/liability posture, termination, governing law/jurisdiction,
and dispute process. Unknown commercial/legal facts must remain unresolved rather
than being invented in repository boilerplate.

## 5. Third-party / donor release gate

For the exact release candidate:

1. regenerate the dependency graph and SBOM/equivalent evidence;
2. inventory vendored/copied source, assets, fonts, models, datasets, templates,
   SDKs, and generated-content sources;
3. preserve required licenses, attribution, NOTICE files, source offers, and
   redistribution obligations;
4. distinguish OBSERVE_BENCHMARK / INSPIRED_CLEAN_IMPLEMENTATION from actual
   INCORPORATE material;
5. resolve any materially incompatible or unknown rights basis before release.

`THIRD_PARTY_NOTICES.md` is a living repository record and must be refreshed
when the shipping graph changes.

## 6. Security / operational claims gate

Before public/commercial release, validate the actual deployment and operating
model for:

- authentication and session controls;
- tenant/customer/project isolation;
- authorization and protected effects;
- credential/secret storage;
- audit/logging and sensitive-log redaction;
- rate/quota/cost abuse boundaries where activated;
- dependency/supply-chain integrity;
- backups, recovery, incident handling, and supported-version policy;
- vulnerability reporting/contact path;
- data retention/deletion/export consistency.

A README, test, type, ADR, or policy statement is not sufficient evidence of a
production control.

## 7. Release IP evidence snapshot

For a materially important public/commercial release, retain at least:

- exact release tag/commit/hash/date;
- material contributor/ownership basis;
- first-party vs third-party inventory;
- dependency/SBOM and required notices;
- material donor/clean-implementation provenance;
- original design/art/content provenance where relevant;
- material AI-assisted provenance where relevant;
- source visibility and trade-secret classification;
- then-current trademark/design/patent/copyright protection status;
- the exact public legal/privacy documents shipped with the release.

This is release-level evidence, not per-commit paperwork.

## 8. Founder / legal gates

Routine engineering does not wait on legal review.

Separate Founder/legal approval is required where the action creates a material
commitment, including:

- changing AKILTA Core from proprietary/private source to a public/open-source or
  other materially different distribution posture;
- accepting material external legal terms on behalf of the company;
- hiring external counsel or paying filing/registration fees;
- making formal trademark, design, patent, or comparable filings;
- settlement, waiver, indemnity, or other material legal commitments;
- selecting final governing-law/dispute language for a public/commercial legal
  agreement when not already established by company legal authority.

## 9. Completion rule

The repository is legally/privacy-ready for a specific release only when the
release's actual product architecture, data flows, distribution, dependencies,
commercial model, and public claims have been checked against the applicable
items above.

Until then, the truthful posture is:

**PRIVATE SOURCE BY DEFAULT — PUBLIC PRODUCT BY INTENT — LEGAL/PRIVACY PAGES
GENERATED FROM ACTUAL PRODUCT REALITY.**
