---
name: grill-with-docs
description: Rigorously clarify a repository change or design while capturing durable domain vocabulary and qualifying architectural decisions.
disable-model-invocation: true
---

# Grill With Docs

This is a Sanbi-native wrapper for `grilling` plus `domain-modeling`. Before asking the first question, read and apply both canonical files directly:

- `.agent/skills/lead/grilling/SKILL.md`
- `.agent/skills/lead/domain-modeling/SKILL.md`

Use grilling's dependency-ordered frontier throughout the project-aware discussion, including its installed Ask UI capability rule and sequential fallback. As decisions crystallize, use domain-modeling to update only its permitted durable documentation surfaces: root `CONTEXT.md` for genuine domain vocabulary and `docs/adr/**` when the ADR threshold is met. Treat `.agent/project.md` separately and change it only when normal Lead protocol establishes a stable operational fact.

Never create or modify `.agent/tasks/**` or `.agent/initiatives/**`. Do not invoke `/to-task`, `/to-spec`, `/to-tickets`, `/execute`, or Coder automatically.

At completion:

1. summarize shared understanding and remaining uncertainty
2. summarize durable domain decisions and the exact documentation changed, or state none
3. classify the work as likely standalone task or likely initiative using grilling's task-size test
4. recommend `/to-task` or `/to-spec`
5. explicitly state that no task or initiative was created
6. STOP

Sanbi-adapted from `mattpocock/skills` `grill-with-docs` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
