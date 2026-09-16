# Design It Twice

Use this only when materially different interface designs are worth comparing. The first idea is rarely the only viable one.

1. Frame the constraints, dependencies, seam, and required behavior. A small illustrative sketch may ground constraints without becoming a proposal.
2. Produce several genuinely different interfaces, sequentially or with existing application-non-writing subagents when useful. Do not introduce a new subagent system or make parallelism mandatory.
3. For each design, show the interface, a caller example, hidden implementation, dependency/adapters strategy, and trade-offs.
4. Compare designs by depth, leverage, locality, test surface, and seam placement. Recommend one design or a justified hybrid.

Use established `CONTEXT.md` vocabulary when available. Lead may delegate factual/codebase exploration to existing application-non-writing subagents. Coder uses this exploration only when the approved task grants enough design freedom; otherwise surface the architectural mismatch through the existing protocol.

Adapted from `mattpocock/skills` `codebase-design/DESIGN-IT-TWICE.md` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
