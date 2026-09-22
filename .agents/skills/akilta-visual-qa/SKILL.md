---
name: akilta-visual-qa
description: AKILTA-only rendered visual QA workflow. Use for AKILTA visual acceptance, browser/device inspection, responsive QA, Shopify preview/live rendered checks, SOURCE_PASS versus VISUAL_PASS separation, screenshots, console/runtime errors, WebGL/context-loss checks, menu/header/footer, CP431/Living, packages, Work/Proof, Contact, Company, and visual Founder gates.
---

# AKILTA Visual QA

Use after `akilta-context-compiler`. This skill executes the current AKILTA visual authority; it does not create a second visual authority.

## Evidence Ladder

Hard invariant:

`SOURCE_PASS != PROVIDER_PASS != RENDER_PASS != VISUAL_PASS != FOUNDER_VISUAL_ACCEPTANCE`

Never issue `VISUAL_PASS` without rendered evidence.

If browser/computer-use is unavailable, preserve any `SOURCE_PASS` or `PROVIDER_PASS`, mark `VISUAL_PASS` as `OPEN` or `BLOCKED`, and do not manufacture screenshots or device observations.

## Minimum Matrix

Derive the exact matrix from current authority. Support at least:

- desktop
- laptop
- tablet
- mobile portrait
- mobile landscape / shallow landscape
- current Founder reference device(s) when specified

## Surface Coverage

Select only surfaces relevant to the current task, but know the current AKILTA set includes:

- Homepage
- capability pages
- Web & Commerce
- menu/header/footer
- Company
- Contact
- Work/Proof
- package/product routes
- CP431/Living/WebGL
- motion and scroll transitions
- fallback/reduced-motion paths
- orientation/resize
- console/runtime errors
- WebGL/context loss when testable
- obvious overflow/crop/layout failure

Use browser/computer-use/playwright-style rendered evidence where available. Keep evidence separate by type: source, provider, render, visual, Founder acceptance.
