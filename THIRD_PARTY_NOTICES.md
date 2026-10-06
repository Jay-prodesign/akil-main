# Third-Party Notices

This file records the current repository-level third-party dependency posture for
AKILTA Core. It is an engineering rights record, not a substitute for the full
license text of any third-party component.

## Current runtime dependency posture

The current root `package.json` declares **no runtime dependencies**.

The root lockfile currently resolves only development/tooling packages:

| Component | Resolved version | Role | License |
| --- | ---: | --- | --- |
| `typescript` | 5.9.3 | Development compiler/tooling | Apache-2.0 |
| `@types/node` | 22.20.1 | Development type definitions | MIT |
| `undici-types` | 6.21.0 | Transitive development type dependency | MIT |

These packages remain governed by their upstream license terms. They are not
relicensed under AKILTA's proprietary LICENSE.

## Distribution rule

The table above describes the current repository root dependency graph; it is not
a permanent shipping inventory.

Before a materially public or commercial release, installer, container, SDK,
binary bundle, or other distributed artifact:

1. regenerate the dependency inventory from the exact release lockfiles/build;
2. distinguish development-only dependencies from material actually distributed;
3. preserve every required copyright, license, NOTICE, source-offer, attribution,
   or redistribution obligation;
4. review any vendored code, copied source, models, assets, fonts, datasets, or
   other non-package material separately;
5. retain the release's dependency/SBOM evidence with the release IP evidence
   pack.

## Donor / copied material

No third-party material becomes AKILTA-owned merely because it is present in the
repository, modified by an AKILTA contributor, or processed by an AI system.

Any future material donor incorporation must retain its source, version/commit,
license, copyright attribution, modification/use record, and any required
notices in an appropriate repository-local provenance record.

This file should be updated when the actual dependency or distribution model
changes.
