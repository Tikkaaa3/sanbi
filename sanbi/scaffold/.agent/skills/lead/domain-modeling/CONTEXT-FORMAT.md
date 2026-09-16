# `CONTEXT.md` Format

Use a root `CONTEXT.md` only as the project's canonical domain glossary.

```markdown
# <Domain name>

<One or two sentences describing this domain.>

## Language

**Order**

<One or two sentences defining what the term is.>

_Avoid:_ Purchase, transaction

**Customer**

<One or two sentences defining what the term is.>

_Avoid:_ Client, buyer, account
```

## Rules

- Pick one canonical term when synonyms compete; list discouraged synonyms under `_Avoid_`.
- Keep definitions to one or two sentences and define what the concept is.
- Include only vocabulary specific to the project's domain, not general programming terms.
- Group terms under headings only when natural clusters emerge.
- Do not include implementation details, task state, plans, commands, repository navigation, roadmaps, or architectural decision history.

Create this file lazily when the first meaningful term is resolved.

Adapted from `mattpocock/skills` `domain-modeling/CONTEXT-FORMAT.md` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
