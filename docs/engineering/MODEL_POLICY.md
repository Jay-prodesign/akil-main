# MODEL_POLICY.md — Cost / Model Efficiency

Use the lowest-capability model/mode that can reliably complete a bounded task. Think in capability tiers, not permanent model names — specific model names change over time, tiers don't.

- **Tier A — cheap/mechanical work.** Formatting, boilerplate, mechanical file edits, simple lookups, straightforward doc updates.
- **Tier B — normal engineering work.** Most implementation, debugging, and refactoring tasks. This should normally be sufficient for material engineering work.
- **Tier C — deep reasoning / difficult or high-risk problems.** Genuinely hard architectural tradeoffs, high-risk security-sensitive changes, ambiguous multi-system debugging.

Do not use Tier C merely because it is available. Escalate to Tier C only when task difficulty or risk genuinely justifies it, and note the justification in the execution record's Implementation Notes.

This applies to model/effort selection by any engineering agent (Claude, Codex) operating under this contract, and to sub-agent delegation within a single engineer's session.
