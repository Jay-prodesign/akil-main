# AKILTA Main — Release Legal / Privacy Readiness

Status: **CURRENT REPOSITORY BASELINE — NON-BLOCKING UNTIL A MATERIAL RELEASE OR RIGHTS/DATA EVENT**

## Purpose

This record translates AKILTA's central IP/licensing/privacy governance into
the release checks that are relevant to this repository.

It is not a substitute for jurisdiction-specific legal advice and it is not a
generic user-facing Privacy Policy, Terms of Service, or EULA.

## Current truthful state

At the LEGAL-IP-001 review point:

- the authoritative source repository is private;
- AKILTA-owned repository material is proprietary;
- the root package declares no runtime dependencies;
- the lockfile currently records only development/build dependencies;
- the repository README states that the current surface is an internal
  engineering-checkpoint shell, not a deployed customer-facing service;
- no distributed desktop/mobile binary from this repository currently requires
  a product EULA;
- no live public SaaS/customer service represented by this repository currently
  requires final Terms of Service;
- a final public Privacy Policy must not be published until the actual shipping
  data flows, operators/controllers, processors, retention, deletion/export,
  telemetry, cookies, analytics, authentication, payment, communications, and
  provider behavior are known and implemented.

Therefore this repository intentionally does **not** fabricate a final EULA,
Terms, or Privacy Policy at this stage.

## Triggered review before material beta/public/commercial release

The product/release owner and authorized agents must establish the actual
release truth and produce only the documents that apply.

### Distribution and IP

- confirm source remains private unless a deliberate exception was approved;
- confirm the outbound license for AKILTA-owned release material;
- regenerate SBOM/dependency and third-party notice evidence;
- review bundled/vendor code, assets, fonts, models, datasets, prompts,
  templates, SDKs, and service/API terms;
- preserve donor/clean-implementation provenance where material;
- confirm contributor/contractor ownership or license basis for material
  shipping work;
- classify confidential know-how that must remain a trade secret;
- consider trademark/design/copyright/patent protection only where commercially
  valuable and separately authorized.

### Product legal surfaces

Create/update, as actually applicable:

- EULA for distributed desktop/mobile/binary software;
- Terms of Service / Terms & Conditions for a live SaaS/web service;
- Privacy Policy and platform/store privacy disclosures where personal data is
  processed;
- cookie/analytics/consent disclosures where the shipping implementation uses
  those technologies;
- SECURITY/contact/vulnerability-disclosure information;
- required source offers, attributions, or third-party notices.

### Architecture-to-policy truth check

A legal/privacy statement must be backed by implemented behavior. Review at
least:

- authentication/session/account flows;
- tenant/customer/project data boundaries;
- personal and customer data collected or generated;
- telemetry, analytics, cookies, diagnostics, logs, and crash reporting;
- AI/model/provider inputs and outputs;
- operational/customer data use and any training prohibition/permission;
- payment/billing data flows;
- email/messaging/notification providers;
- subprocessors and hosted services;
- retention periods and deletion/account-closure behavior;
- user access/export/correction controls where promised or required;
- encryption/security claims;
- local-only/no-sale/no-sharing/opt-out claims;
- jurisdiction, age, store, and platform requirements where applicable.

If the implementation cannot support a planned statement, correct the
implementation or the statement before release.

## Evidence pack

For a materially important release, preserve a bounded snapshot sufficient to
show:

- exact release tag/hash/date;
- why AKILTA had the right to ship each material component;
- what AKILTA can truthfully claim as its own;
- relevant contributor/ownership evidence;
- dependency/SBOM and notice evidence;
- material donor/AI/asset provenance;
- current privacy/legal documents tied to that release;
- trade-secret/public-source classification;
- protection/registration status where relevant.

## Engineering velocity rule

This is not a standing pre-coding gate. Normal implementation, testing,
benchmarking, and authorized donor research continue.

Re-run this review when a material release, distribution/license change,
substantial donor incorporation, or material new personal-data, telemetry,
payment, authentication, or other rights/privacy event makes it relevant.
