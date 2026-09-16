---
name: to-task
description: Propose and, only after owner approval, create one right-sized READY Sanbi implementation task from developed standalone discussion or one initiative Work Map item.
disable-model-invocation: true
---

# To Task

This is the only normal skill-level path for creating a new `.agent/tasks/T-xxx.md`. Owner invocation authorizes task preparation, not implementation. Never invoke this skill automatically and never invoke `/execute`.

Use `writing-for-agents` principles. Before doing anything, verify that no task has `active: true`. Never create several tasks in advance.

## Choose exactly one input mode

### Mode A — standalone

Use the developed discussion when there is no relevant initiative and the work is genuinely one coherent implementation unit. Do not require initiative overhead for a small change.

### Mode B — initiative work item

Use one selected unblocked item from the sole relevant `ACTIVE` initiative. The owner may name it as `I-001 / W2` or by canonical path and item ID.

An eligible item must be `PLANNED`, have every blocker `DONE`, and have no existing `Sanbi task` reference. If more than one item is unblocked and the owner did not name one, use `ask_user` to ask which **one** to convert. Show only unblocked candidates, identify one concise recommendation, and explain why it is the best dependency/frontier choice. Never choose silently when multiple candidates exist.

Do not combine Work Map items. If the owner explicitly requests a merge, apply the task-size gate to the merged outcome before proposing it.

## Task-size gate

Before writing any file, test the proposed unit:

- one primary implementation objective
- one coherent behavioral outcome
- feasible within one fresh Coder context
- one reviewable delta
- independently verifiable completion
- no unrelated product outcomes
- no large future-feature bundle

Ask:

> Could this work naturally be split into two or more independently useful, independently verifiable outcomes that could land green separately?

If yes, create nothing. Tell the owner:

```text
This is too broad for one Sanbi task.
Recommended next step:
- use /to-spec if no initiative exists
or
- use /to-tickets / revise the Work Map if an initiative already exists

No task has been created.
```

Do not silently split broad work into multiple task files.

A steering-direction-facing change is a plausible standalone task. A game-feel package containing category cues, event feedback, a new-best celebration, audio, and mute persistence is initiative-shaped and must fail this gate.

## Proposal and approval

Inspect current repository truth and allocate the next sequential unused `T-xxx` by scanning `.agent/tasks/`. Prepare a compact proposal before writing, normally:

```markdown
Proposed task: T-004 — <title>

Objective:
...

Included:
- ...

Excluded:
- ...

Key constraints:
- ...

Verification:
- ...

Initiative:
I-001 / W2
```

Omit Initiative for standalone mode. Ask exactly:

```text
Create this task as READY?
```

Natural-language agreement from earlier discussion is not approval for this write. Only an affirmative response to this proposal permits creation. If the owner rejects or revises it, write nothing and iterate on the compact proposal.

## Create exactly one task

After explicit approval only:

1. Write one `.agent/tasks/T-xxx.md` from `.agent/templates/task.md` with `active: true` and `status: READY`.
2. In initiative mode, add exact frontmatter `initiative: I-xxx` and `work_item: Wn`.
3. Keep the contract independently executable: Objective, immediate Why/Context, Included/Excluded scope, directly binding Architectural Constraints, Expected Behavior, Edge Cases, Acceptance Criteria, Verification Requirements, Implementation Guidance, and Escalation Conditions.
4. For an initiative-linked task, point to the canonical initiative and do not repeat initiative-level prose. Include only enough immediate context for a fresh Coder.
5. In initiative mode, update exactly the selected Work Map item to `READY` and add `Sanbi task: T-xxx`. Do not promote any other frontier item.
6. Re-read both artifacts and verify there is exactly one new active READY task with correct linkage.
7. Summarize the task and STOP. Tell the owner that `/execute` remains the only execution authorization.

If a write is interrupted and task/initiative linkage differs, stop and reconcile the artifacts; never create a second task.

Do not modify application/test source, invoke Coder, create or activate an initiative, decompose a Work Map, or transition the task to `CODING`.
