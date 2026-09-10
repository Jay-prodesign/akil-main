# IP Provenance Register

This document is a maintainable, evidence-based register of the origin
and ownership status of material in this repository. It is intended to
be updated incrementally as new asset/component families are added or
their provenance is clarified. Where a fact is not currently known or
verified, this document says so explicitly (`TBD` / `UNKNOWN`) rather
than guessing.

This register is engineer-maintained and does not constitute legal
advice or a legal opinion. See
`docs/legal/AI_ASSISTED_DEVELOPMENT.md` for the policy governing how
AI-assisted engineering work is attributed and reviewed.

## Register

| Asset / component family | Creator / source | Date (if known) | Ownership / license status | Evidence location | Commit / revision | Restrictions |
|---|---|---|---|---|---|---|
| TypeScript domain/application source (`src/`) | Written for this project during AKILTA engineering (AKI-BE-001 onward) | Ongoing since project inception | Proprietary — first-party AKILTA Material, owned by 7T Tekstil Sanayi ve Ticaret Limited Şirketi | `src/` directory, this repository's commit history | See `git log` for per-file history | Governed by `LICENSE` |
| Automated tests (`tests/`) | Written for this project alongside the code they verify | Ongoing since project inception | Proprietary — first-party AKILTA Material, owned by 7T | `tests/` directory | See `git log` | Governed by `LICENSE` |
| Engineering/architecture documentation (`docs/`) | Written for this project | Ongoing since project inception | Proprietary — first-party AKILTA Material, owned by 7T | `docs/` directory | See `git log` | Governed by `LICENSE` |
| `@types/node` (devDependency) | Third party (DefinitelyTyped contributors, published via npm) | N/A | Third-party, MIT license — not an AKILTA Material | `package.json`, `package-lock.json` | N/A | Governed by its own MIT license, not `LICENSE` |
| `typescript` (devDependency) | Third party (Microsoft) | N/A | Third-party, Apache-2.0 license — not an AKILTA Material | `package.json`, `package-lock.json` | N/A | Governed by its own Apache-2.0 license, not `LICENSE` |
| `undici-types` (transitive devDependency) | Third party | N/A | Third-party, MIT license — not an AKILTA Material | `package-lock.json` | N/A | Governed by its own MIT license, not `LICENSE` |
| UI/UX/design assets, graphics, audiovisual material | UNKNOWN — no such assets identified in this repository as of this document's date | TBD | TBD | TBD | TBD | TBD |
| Trademark registration (AKILTA word/logo mark) | TBD — no registration number, class, territory, or certificate is recorded anywhere in this repository | TBD | Brand/trademark ownership asserted per `TRADEMARKS.md`; formal registration status is TBD | `TRADEMARKS.md` | N/A | See `TRADEMARKS.md` |

## Maintenance

When a new asset or component family is added to this repository (a new
dependency, a new vendored file, a new design asset, etc.), add a row
here recording what is actually known, and mark any unknown field `TBD`
or `UNKNOWN` rather than leaving it blank or inferring a value.
