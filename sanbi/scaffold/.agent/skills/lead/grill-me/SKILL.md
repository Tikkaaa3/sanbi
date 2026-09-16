---
name: grill-me
description: Rigorously question a non-project idea, plan, design, or decision without creating project documentation.
disable-model-invocation: true
---

# Grill Me

Read and apply `.agent/skills/lead/grilling/SKILL.md` for this stateless discussion, including independent frontier-question batching and completion classification.

Never create or modify tasks, initiatives, `CONTEXT.md`, ADRs, `.agent/project.md`, or other project documentation. Do not invoke another planning command. At completion you may say that the idea would likely be a standalone task or initiative if applied to a project, then STOP.

Sanbi-adapted from `mattpocock/skills` `grill-me` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
