---
name: to-spec
description: Synthesize the current developed multi-task discussion into one owner-approved Sanbi initiative document.
disable-model-invocation: true
---

# To Spec

This is an explicit owner-controlled planning transition, normally after `grill-with-docs` classifies work as multi-task. Turn the already-developed discussion into one initiative specification without restarting a full requirements interview.

## Premature-task conflict gate

Before drafting, inspect active task artifacts. If a `DRAFT` or `READY` task already represents the same discussion and the work now appears initiative-sized, do not treat that task as authoritative planning input and do not continue silently. Report:

```text
A READY task already exists, but this work now appears initiative-sized.

Planning cannot proceed cleanly until that task is reconciled.
```

Use `ask_user` for one explicit choice:

- cancel/remove the premature never-started task and continue planning
- keep the task and do not create an initiative
- stop and inspect manually

Recommend cancellation only when the task has never entered `CODING` and clearly bundles the same work. Never delete or deactivate a task without that explicit choice. Never reconcile a task that entered execution through this skill. If ownership or history is unclear, stop for manual inspection. Sanbi adds no `CANCELLED` state.

## Process

1. Synthesize existing conversation and decisions.
2. Inspect only relevant repository context not already understood.
3. Quietly check optional root `CONTEXT.md` and `docs/adr/` once. Read relevant content only when present; absence is normal, produces no tool error, and is not probed again in this flow.
4. Determine important verification seams and overall testing strategy. Ask only focused confirmation needed to avoid synthesizing the wrong shape.
5. Allocate the next sequential project-local initiative ID by scanning `.agent/initiatives/I-*.md` independently of task IDs.
6. Draft from `.agent/templates/initiative.md` and present the complete proposed initiative shape, including proposed `DRAFT` or `ACTIVE` status, before writing.
7. Ask the owner to approve that exact proposal and status. If proposing `ACTIVE`, state explicitly that approval creates and activates the initiative.
8. Write one `.agent/initiatives/I-xxx-<slug>.md` only after approval, then STOP.

Use `DRAFT` while preparing. For the normal current-work flow, propose `ACTIVE` after confirming no other initiative is `ACTIVE`; exact owner approval then supplies the required activation intent. Otherwise create it as `DRAFT`. A `DRAFT` initiative may be decomposed with `/to-tickets` but must later receive explicit owner activation intent before any item can pass through `/to-task`. General agreement during earlier discussion is not initiative approval or activation.

Capture the problem, desired outcome, numbered user/system stories, durable decisions, testing strategy, out-of-scope boundaries, and material open questions. Leave `Work Map` empty; `/to-tickets` is the only skill responsible for detailed decomposition.

An initiative is durable multi-task context, not a Sanbi task. Never write `.agent/tasks/**`, invoke `/to-tickets`, invoke `/to-task`, invoke Coder, publish to an issue tracker, use `.scratch`, or perform implementation. Initiative creation or activation never bypasses the owner-controlled `/to-tickets → /to-task → /execute` transitions.

## Attribution

Sanbi-adapted from `mattpocock/skills` `to-spec` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; external publication and tracker assumptions were replaced by project-owned Sanbi initiatives. See `.agent/skills/LICENSE.mattpocock`.
