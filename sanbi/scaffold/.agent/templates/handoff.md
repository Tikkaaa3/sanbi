---
task: T-000
---

# Handoff — T-000

## Completed

Concise description of the final reviewed outcome.

## Active Initiative

Omit this section for standalone tasks. For initiative-linked work, include only:

```markdown
I-001 — <title>

Canonical artifact:
`.agent/initiatives/I-001-<slug>.md`

Completed work item:
W2 — <title>

Initiative delta:
- <only meaningful new decision, progress, or newly unblocked work>

Likely next frontier:
- W3 — <title>
```

Point to the canonical initiative; do not copy its specification or full Work Map into this handoff.

## Stable Decisions Made

Record decisions future Lead sessions may need to know.

Do not repeat ordinary implementation detail unless it affects future reasoning.

## Architectural / Project Context Changes

Describe stable project facts changed by this task.

State whether `.agent/project.md` was updated accordingly.

## Verification

Summarize the final verification performed by Lead.

## Repository State

Record anything important about the repository state at completion.

Examples:

- relevant migrations added
- compatibility preserved
- intentionally deferred cleanup
- unusual generated files

Do not include routine information with no future value.

## Known Limitations / Open Issues

None.

Include only unresolved items that genuinely matter after task completion.

## Follow-ups

Optional possible future work.

These are suggestions, not automatically authorized tasks.

## Context for Next Lead Session

Include only information that the next fresh Lead would otherwise reasonably miss after reading:

- its role
- `.agent/protocol.md`
- `.agent/project.md`
- the current repository

Keep this section short.
