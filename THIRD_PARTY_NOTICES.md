# Third-Party Notices

This repository has **zero runtime dependencies** (`package.json` declares
no `dependencies` key). The following are development-time-only
dependencies, verified directly against `package.json` and
`package-lock.json` as of this document's date. Each entry below is
recorded exactly as declared/installed — no license fact in this
document is inferred or assumed.

| Component | Declared range | Installed version | License | Source |
|---|---|---|---|---|
| `@types/node` | `^22.15.0` | `22.20.1` | MIT | https://www.npmjs.com/package/@types/node |
| `typescript` | `^5.6.0` | `5.9.3` | Apache-2.0 | https://www.npmjs.com/package/typescript |

## Transitive dependencies

| Component | Installed version | License | Pulled in by |
|---|---|---|---|
| `undici-types` | `6.21.0` | MIT | `@types/node` |

## Scope of this document

- This inventory reflects `devDependencies` used to build and type-check
  this repository. None of these components are bundled into, shipped
  with, or become part of any runtime artifact produced by this
  repository.
- No vendored third-party source files or assets were found in this
  repository as of this document's date.
- This document does not itself grant any rights to the listed
  components; each remains governed by its own upstream license. 7T does
  not claim ownership of any third-party component listed here.
- This inventory must be kept current: whenever `package.json` or
  `package-lock.json` changes, this document should be updated to match
  before merge.
