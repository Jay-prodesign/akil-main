---
name: akilta-provider-safe-write
description: AKILTA-only safe write workflow for Shopify/provider/theme, repository, GitHub, Google Drive canonical, and other mutable surfaces. Use before any AKILTA mutation requiring fresh target resolution, pre-read, revision/head/checksum fencing, post-read/readback, invariant verification, and bounded evidence writeback.
---

# AKILTA Provider Safe Write

Use after `akilta-context-compiler` and before any meaningful AKILTA mutation. Do not use for other projects.

## Pattern

1. Fresh-read current authority and writable scope.
2. Resolve the writable target dynamically from current authority/live provider truth.
3. Pre-read the exact target and record revision/head/checksum when the provider supports it.
4. Check MAIN/live/read-only boundaries, project isolation, single-writer/lease state, and protected-action gates.
5. Mutate the smallest authorized scope.
6. Capture provider/repository response.
7. Post-read/readback the exact target.
8. Verify expected invariants and unchanged compatible concurrent provider changes.
9. Write back only bounded evidence through the current authorized state-writeback path.

## Fail-Closed Conditions

Reject or pause the mutation when:

- The target is MAIN/live/read-only under current authority.
- A target ID, branch, SHA, checksum, provider revision, or lease is stale.
- The request mutates another project.
- The mutation crosses a protected boundary without the current authority.
- Readback or invariant verification cannot be obtained for a claim that depends on it.

Never replay an old patch only because an old checksum differs. A changed checksum means fresh semantic reconciliation is required.

Do not hard-code current mutable IDs into this skill.
