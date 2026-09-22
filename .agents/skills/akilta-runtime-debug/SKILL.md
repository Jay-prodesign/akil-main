---
name: akilta-runtime-debug
description: AKILTA-only Three.js/WebGL/runtime diagnostics. Use for AKILTA renderer initialization, shader/runtime errors, WebGL availability versus transport/runtime failure, context lost/restored, DPR, resize/orientation, RAF lifecycle, cleanup, duplicate loops, scroll/morph choreography, fallbacks, provider/runtime transport, GPU/load budgets, frame performance, console errors, and integration with rendered visual QA.
---

# AKILTA Runtime Debug

Use after `akilta-context-compiler`. Pair with `akilta-visual-qa` whenever a visual/runtime claim depends on actual browser behavior.

## Diagnostic Checklist

Inspect only the relevant runtime surface, covering:

- renderer initialization and teardown
- shader compile/runtime errors
- WebGL support versus transport/runtime failure
- context lost/restored behavior
- DPR and adaptive quality
- viewport resize/orientation
- requestAnimationFrame lifecycle and suspension/resume
- geometry/material/texture/buffer lifecycle and cleanup
- duplicate render loops
- event-listener lifecycle
- scroll/morph choreography and state transitions
- fallback classification
- provider/runtime transport and asset loading
- responsive GPU/load budgets and frame problems
- console errors and unhandled rejections

## Output Discipline

Classify findings as source, provider, render, visual, or Founder-acceptance evidence. Do not convert a source/runtime audit into `VISUAL_PASS`; use `akilta-visual-qa` for rendered proof.
