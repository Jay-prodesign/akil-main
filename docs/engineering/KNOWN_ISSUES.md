# KNOWN_ISSUES.md

Tracks known engineering issues, limitations, and technical debt. Update this alongside the relevant execution record when an issue is discovered or resolved.

## Format

```
### <short title>
- Discovered: <date>, task <TASK-ID>
- Severity: <blocker | high | medium | low>
- Description: <what's wrong>
- Impact: <what it affects>
- Status: <open | mitigated | resolved>
- Resolution / next step: <...>
```

## Open issues

### DEL-003 parent task remains stage-gated beyond its two bounded slices
- Discovered: 2026-08-19, task DEL-003 (second bounded slice, round-1 correction)
- Severity: low
- Description: DEL-003's full canonical acceptance criteria includes durable production runtime dispatch and cross-service AKILTA↔AI Commerce request/result flows. These depend on INT-001, CONN-001, and AI-004, all of which remain stage/trigger/dependency-gated per the canonical roadmap.
- Impact: DEL-003 cannot reach parent-level COMPLETED until those dependencies activate; not a defect in the two closed/implemented slices.
- Status: open (by design — explicitly not pulled forward, per the DEC-144 V1 Fast Lane anti-scope-creep filter).
- Resolution / next step: activates only when INT-001/CONN-001/AI-004 are triggered by Brain/Founder; no engineering action needed until then.

### `OutcomeJob.jobId` is derived from `OutcomeJobSpec.specId`, not independently opaque
- Discovered: 2026-08-19, task DEL-003 (second bounded slice)
- Severity: low
- Description: `wireAdmittedOutcomeJobs` sets `jobId = specId` (`${planId}:v${version}:${requirementId}`) rather than generating an independent opaque identifier. This is what makes wiring idempotent by construction, but it means job identity is derived, human-readable, and coupled to plan/requirement identity rather than independently assignable.
- Impact: none currently observed; flagged as a disclosed design decision in the round-1 correction evidence bundle for Brain review, not a defect.
- Status: open / disclosed, not a confirmed defect.
- Resolution / next step: revisit only if a future requirement needs job identity independent of plan/requirement lineage.

### Readiness-gate-before-approval ordering in `admitPlan` is a judgment call, not a sourced rule
- Discovered: 2026-08-19, task DEL-003 (second bounded slice, round-1 correction)
- Severity: low
- Description: `admitPlan` evaluates capability/access/evidence readiness (F1) after structural completeness and before approval validity. The packet does not explicitly specify this ordering.
- Impact: none currently observed; correct behavior under every existing test, but the ordering choice is disclosed rather than canonically sourced.
- Status: open / disclosed, not a confirmed defect.
- Resolution / next step: Brain to confirm or correct the ordering during V1 candidate audit; no engineering action needed unless corrected.
