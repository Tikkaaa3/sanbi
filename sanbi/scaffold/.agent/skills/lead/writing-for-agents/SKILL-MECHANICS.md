# Pi Skill Mechanics

A Sanbi skill uses the Agent Skills directory layout with `SKILL.md` and valid YAML frontmatter.

## Invocation

- **Model-invoked:** Provide a conservative `description` that names distinct trigger branches. Omit `disable-model-invocation`. The description is always-loaded context, so it must earn that cost.
- **User-invoked only:** Set `disable-model-invocation: true`. Keep the human-facing description short. The owner chooses when to invoke it.

Choose model invocation only when the agent genuinely needs to reach the discipline autonomously or another skill composes it.

## Composition

For a tiny wrapper, point to the authoritative sibling `SKILL.md` using a relative Markdown link and instruct the agent to read and apply it. Do not duplicate the complete discipline. Keep supporting references inside the owning skill directory so Pi treats them as skill resources rather than independent skills.

## Sanbi placement

Place canonical skills according to role:

- `.agent/skills/lead/` — Lead only
- `.agent/skills/coder/` — Coder only
- `.agent/skills/shared/` — both roles

Sanbi, not project agents, owns these canonical resources. Changes require deliberate Sanbi scaffold/upgrade work.

Adapted from `mattpocock/skills` `writing-for-agents/SKILL-MECHANICS.md` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
