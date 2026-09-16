---
name: domain-modeling
description: Sharpen project-specific domain terminology and record durable trade-off decisions. Use when terminology is fuzzy or conflicting, domain semantics need scenario testing, or a CONTEXT.md or ADR genuinely needs creation or revision.
---

# Domain Modeling

Build a precise ubiquitous language while discussing the domain.

1. Quietly check for root `CONTEXT.md` once. Read it when present; if absent, skip without a tool error or repeated probe.
2. Challenge fuzzy, overloaded, or conflicting terms. Propose one canonical term and identify words to avoid.
3. Stress-test concepts with concrete scenarios, especially boundary and edge cases.
4. When stated semantics concern existing behavior, inspect the relevant code and surface contradictions rather than treating either prose or code as automatically correct.
5. Capture a resolved project-specific domain term promptly using [`CONTEXT-FORMAT.md`](CONTEXT-FORMAT.md). Create root `CONTEXT.md` lazily, only when real vocabulary exists.
6. Offer or write an ADR using [`ADR-FORMAT.md`](ADR-FORMAT.md) only when all three threshold conditions hold.

## Documentation boundaries

`CONTEXT.md` is a domain glossary only. Keep it free of task history, plans, commands, repository navigation, roadmaps, transient state, task contracts, and implementation detail.

`.agent/project.md` remains the source for stable operational and project facts: repository structure, architectural invariants, commands, environment notes, and development conventions. Do not repurpose it as a glossary.

ADRs live under `docs/adr/` and record only qualifying hard-to-reverse decisions. Create the directory lazily.

This skill grants no implementation permission. Lead may write `CONTEXT.md`, `docs/adr/**/*.md`, and other documentation surfaces allowed by the Lead role, but may not modify application or test source.

## Attribution

Sanbi-adapted from `mattpocock/skills` `domain-modeling` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
