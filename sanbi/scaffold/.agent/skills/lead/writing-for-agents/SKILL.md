---
name: writing-for-agents
description: Improve documents consumed by coding agents. Use when authoring or revising agent instructions, skills, AGENTS.md, CONTEXT.md, or agent-facing documentation where retrieval, hierarchy, completion criteria, duplication, or context load matters.
---

# Writing for Agents

Treat every agent-facing document as a combination of **context pointers**, ordered **steps**, and on-demand **reference**.

When authoring a skill, also read [`SKILL-MECHANICS.md`](SKILL-MECHANICS.md).

## Discipline

- **Context pointers:** Name the referenced material and the distinct conditions that should trigger reading it. Make trigger descriptions concise and specific.
- **Context load:** Minimize always-loaded text. Every pointer and description must earn its permanent attention cost.
- **Cognitive load:** Let humans remain the index where human judgment is valuable; do not optimize human choice away reflexively.
- **Information hierarchy:** Keep immediate steps prominent. Move branch-specific reference behind explicit pointers through progressive disclosure.
- **Completion criteria:** End steps with checkable, sufficiently demanding definitions of done.
- **Co-location:** Keep a concept's definition, rules, and caveats together.
- **Single source of truth:** Avoid duplicating instructions or caching facts cheaply available from code, configuration, directory structure, or `--help`.
- **Pruning:** Remove stale, irrelevant, and no-op instructions. Prefer a useful leading word when it reliably compresses a repeated behavioral concept.
- **Task compression:** For initiative-linked tasks, point to the canonical initiative/work item rather than repeating initiative-level product prose. Retain enough immediate objective, scope, constraints, behavior, verification, and escalation context for a fresh Coder to execute independently.
- **Positive steering:** State the desired behavior directly; reserve prohibitions for genuine guardrails.

Apply this discipline to `.agent/protocol.md`, `.agent/roles/*.md`, `.agent/templates/**`, `.agent/project.md`, `.agent/skills/**`, `AGENTS.md`, `CONTEXT.md`, and `docs/agents/**` when relevant.

## Sanbi ownership boundary

This skill is advisory. In an adopted project, do not rewrite Sanbi-managed protocol, role, template, skill, or lifecycle files merely because they could improve. Present a concrete proposal to the owner; canonical infrastructure changes belong in deliberate Sanbi development followed by the existing upgrade path.

Project-owned documentation may be edited when the Lead role and owner's request permit it. Preserve `.agent/project.md` as stable operational project knowledge and `CONTEXT.md` as domain glossary only.

## Attribution

Sanbi-adapted from `mattpocock/skills` `writing-for-agents` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
