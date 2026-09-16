---
name: to-tickets
description: Decompose one Sanbi initiative into an owner-approved tracer-bullet Work Map without creating implementation tasks.
disable-model-invocation: true
---

# To Tickets

This is the only skill responsible for detailed initiative decomposition. Convert the sole `ACTIVE` initiative, a named initiative path, or an initiative just created with `/to-spec` into an evolving Work Map.

## Process

1. Read the complete required initiative. Quietly check optional `CONTEXT.md` and `docs/adr/` once; read relevant content only when present, skip normal absence without an error or repeated probe, and inspect only codebase areas needed to ground decomposition.
2. Draft `W1`, `W2`, ... slices. IDs are initiative-local planning IDs, never `T-xxx` task IDs.
3. Present the proposed Work Map before writing. Ask whether granularity and blockers are right and whether slices should be split, merged, reordered, or dropped. Existing `ask_user` tooling may help.
4. Iterate until the owner explicitly approves the map.
5. Update only the initiative's `## Work Map` plus directly related Decisions or Open Questions that changed during decomposition.
6. Recompute and report the unblocked `PLANNED` frontier. Do not select or promote an item.
7. State that no task was created. If the initiative is `ACTIVE`, say the owner can select one item with `/to-task`. If it is `DRAFT`, say it requires explicit owner activation intent before `/to-task`. Then STOP.

Use this completion shape:

```text
Work Map approved.

Current unblocked frontier:
- W1 — ...
- W2 — ...

No task has been created.
When you are ready, select one item and use /to-task.
```

For a `DRAFT` initiative, replace the final line with:

```text
No task has been created.
This initiative must be explicitly activated before an item can use /to-task.
```

## Slice discipline

Optimize for coherent fresh-context implementation slices, not few tickets. Every ordinary work item should be a plausible future `/to-task` input:

- one primary implementation objective and coherent behavioral outcome
- independently useful and verifiable
- able to land green separately where practical
- feasible in one fresh Coder context
- one reviewable delta
- no unrelated product outcomes

Ask whether the item itself can naturally split into multiple independently useful, independently verifiable outcomes. If yes, split it in the proposed Work Map. Prefer vertical tracer bullets over horizontal “all backend,” “all frontend,” or “all tests” phases, while avoiding implementation-file microtasks.

Declare real blocking edges. Only unblocked `PLANNED` slices form the selectable frontier. `READY` means an actual just-in-time Sanbi task has been created and linked for that item; it is not execution authorization. Do not mark an item `READY` merely because it is unblocked or approved. A slice may remain `PLANNED` indefinitely, and the map may evolve as implementation reveals new facts.

For a broad mechanical refactor that cannot stay green as ordinary vertical slices, use:

1. **Expand:** introduce the new form beside the old.
2. **Migrate:** move callers in coherent blast-radius batches, each blocked by Expand.
3. **Contract:** remove the old form after all migration batches are `DONE`.

Do not fake tracer bullets when repository integrity requires this shape.

## Sanbi boundary

A Work Map item is planning, not an executable contract. Never create or bulk-create `.agent/tasks/**`, invoke `/to-task`, invoke Coder, transition task state, mark a work item `READY`, or publish external tracker issues. Natural-language approval of the map is not task creation. The owner must later select exactly one unblocked item through `/to-task`, and that task must still stop at `READY` until `/execute`.

## Attribution

Sanbi-adapted from `mattpocock/skills` `to-tickets` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; tracker tickets and publication were replaced by an initiative-local Work Map. See `.agent/skills/LICENSE.mattpocock`.
