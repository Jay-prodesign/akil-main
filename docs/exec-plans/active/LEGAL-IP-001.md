# LEGAL-IP-001 — AKILTA Main Repository Legal / IP Readiness

Status: **IMPLEMENTED / SELF-VALIDATED — PENDING BRAIN EXACT-HEAD VERIFICATION**

## Authority

Founder instruction on 2026-10-06: complete AKILTA Main's applicable license,
IP, privacy/legal, and related repository protections now.

Controlling company posture:

- private source by default;
- proprietary AKILTA-owned source by default;
- public product availability does not imply public source availability;
- third-party rights remain under their own licenses;
- legal/privacy documents must match actual product architecture and data flows;
- do not fabricate release documents before the relevant product surface exists.

## Base and scope

Base: `main@3226c76fa338e425e553638e5f5f48924182a1c0`

This task is documentation/legal-governance only.

In scope:

- root proprietary `LICENSE`;
- current third-party dependency notice;
- repository security reporting policy;
- repository-local legal/IP readiness index;
- release-time legal/privacy truth checklist;
- README navigation;
- this execution record.

Out of scope:

- `src/` changes;
- package/dependency changes;
- OS-V0 selector or source-task changes;
- deployment, DNS, credentials, provider activation, spend, or customer effects;
- fabricated final EULA/Terms/Privacy text for a product surface that does not
  yet exist;
- changes to first-party product repositories.

## Validation

Required before completion:

1. exact branch diff contains only the files above;
2. `package.json` still has no runtime dependencies;
3. listed npm licenses/versions match the current lockfile;
4. no source or dependency file changed;
5. final legal/privacy claims match the repository's current engineering-only
   state;
6. exact-head Brain review passes before merge.

## Merge authority

This task has explicit Founder authorization to complete AKILTA Main's
repository-level legal/IP posture. Merge is limited to this reviewed docs-only
packet and must not be treated as authorization for any product release,
publication, filing, counsel/spend, or other repository.
