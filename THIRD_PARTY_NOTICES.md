# Third-Party Notices

This file records the third-party npm dependencies currently declared by the
AKILTA main engineering repository at the LEGAL-IP-001 review point.

The repository's own AKILTA-authored material is proprietary under
[LICENSE](./LICENSE). Third-party components remain governed by their own
licenses.

## Current npm dependency inventory

The root `package.json` currently declares no runtime dependencies. The
current `package-lock.json` records these development/build dependencies:

| Component | Resolved version | Role | License |
| --- | ---: | --- | --- |
| `@types/node` | 22.20.1 | Development type definitions | MIT |
| `typescript` | 5.9.3 | TypeScript compiler/build tooling | Apache-2.0 |
| `undici-types` | 6.21.0 | Transitive development type dependency of `@types/node` | MIT |

The applicable upstream license terms and copyright notices remain in force.
This file does not relicense those components under the AKILTA proprietary
license.

## Distribution rule

This inventory is intentionally scoped to the repository state reviewed for
LEGAL-IP-001. It is not a permanent claim that AKILTA has no other third-party
rights surfaces.

Before a material public/commercial release or a material dependency change:

1. regenerate the dependency/SBOM inventory from the actual release lockfiles
   and build artifacts;
2. identify runtime, bundled, vendored, model, dataset, font, asset, SDK,
   service, and other third-party rights surfaces;
3. preserve all required copyright, attribution, license, source-offer, or
   redistribution notices; and
4. resolve any `REVIEW_REQUIRED` dependency before shipping if its
   obligations may conflict with the intended release posture.

Generated inventories support evidence collection; they do not replace a
rights/compatibility decision where terms are ambiguous.
