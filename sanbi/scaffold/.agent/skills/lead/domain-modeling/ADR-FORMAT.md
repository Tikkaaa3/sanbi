# ADR Format

ADRs live in `docs/adr/` and use sequential names such as `0001-event-sourced-orders.md`. Scan existing files and increment the highest number. Create the directory lazily.

## Threshold

Create or offer an ADR only when the decision is all three:

1. **Hard to reverse:** changing it later has meaningful cost.
2. **Surprising without context:** a future reader would reasonably question why it was chosen.
3. **A real trade-off:** genuine alternatives were considered and selected for reasons worth preserving.

Ordinary implementation choices do not qualify.

## Default shape

```markdown
# <Short decision title>

<One to three sentences stating the context, decision, and why.>
```

Use optional status, considered-options, or consequences sections only when they preserve information a future reader genuinely needs. Keep the decision and rationale concise; do not turn an ADR into a plan or implementation history.

Adapted from `mattpocock/skills` `domain-modeling/ADR-FORMAT.md` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
