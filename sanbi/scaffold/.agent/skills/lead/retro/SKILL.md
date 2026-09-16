---
name: retro
description: Review a Sanbi development cycle and recommend evidence-based workflow or environment improvements.
disable-model-invocation: true
---

# Retro

Conduct a retrospective only because the owner explicitly invoked this skill. Never auto-run after a task or session.

## Process

1. **Observe:** Read the relevant primary sources that exist. Depending on the requested cycle, these may include task, result, review, handoff, `.agent/project.md`, `CONTEXT.md`, ADRs, Git diff/history, and available session evidence. Do not require every source.
2. **Analyze:** Look for evidenced friction in navigation, automated checks, verification, task-contract clarity, instruction quality, context pointers, repeated expensive exploration, information access, subagent usage, context load, durable knowledge, and Lead/Coder boundaries.
3. **Recommend:** Present the smallest useful improvements in severity or impact order. Do not invent findings to fill categories.

For each recommendation include:

- observed evidence
- why it matters
- smallest proposed improvement
- where it would live
- whether it is project-specific or Sanbi/global

Prefer:

```markdown
## Retro

### High impact
1. <category>: <finding>
   Evidence: ...
   Recommendation: ...

### Medium impact
...

### No action needed
...
```

## Mutation boundary

Retro is `OBSERVE → ANALYZE → RECOMMEND`. It does not automatically mutate Sanbi-managed protocol, roles, templates, skills, lifecycle extension, Sanbi source, or global Pi/Herdr configuration. Applying such a recommendation is separate deliberate work.

Edit project-owned low-risk documentation only when the owner explicitly asks. Otherwise produce the report in conversation.

When evaluating agent-facing instructions, apply the advisory discipline in [`../writing-for-agents/SKILL.md`](../writing-for-agents/SKILL.md).

## Attribution

Sanbi-adapted from the in-progress `mattpocock/skills` `retro` design at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
