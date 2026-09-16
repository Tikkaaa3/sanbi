# Development Agent Protocol

Protocol-Version: 1

## Purpose

This repository uses two persistent Pi agents:

- **Lead** — owner-facing reasoning, planning, delegation, verification, and review.
- **Coder** — task-scoped implementation, testing, debugging, and reporting.

Pi conversation sessions are disposable.

Repository files are the durable source of workflow truth.

Herdr messages are used to wake, control, and notify agents. Detailed task state and results must live in repository artifacts rather than only in conversation history.

## Core Rules

1. There may be at most one active implementation task at a time.
2. Every implementation task has a task contract in `.agent/tasks/`.
3. The task contract is authoritative for scope, constraints, expected behavior, and acceptance criteria.
4. The Coder must not silently expand scope or override architecture.
5. The Lead does not write application source code or test source code.
6. The Coder owns implementation and test-writing.
7. The Lead independently reviews the repository state rather than trusting the Coder's report alone.
8. Important decisions made during execution must be persisted in the task contract or project context.
9. Conversation history must never be the only location of information required by a future session.
10. Task readiness and owner authorization are separate: `READY` does not authorize implementation.
11. Only the owner-invoked `/execute` command may perform the initial `READY -> CODING` transition and invoke Coder.
12. A completed task is rotated to fresh Lead and Coder sessions through `/next`.
13. Initiatives are optional multi-task planning artifacts. They do not authorize implementation or replace task contracts.
14. At most one initiative may have status `ACTIVE`; `DRAFT` and `PAUSED` initiatives may coexist.
15. Shared understanding does not authorize artifact creation. Natural-language agreement is not `/to-spec`, `/to-tickets`, `/to-task`, or `/execute`.
16. Lead recommends a planning shape; only an explicit owner-invoked planning command crosses that boundary.
17. `/to-task` is the only normal skill-level path that creates one new implementation task.

## Planning Transitions

Discussion, grilling, domain modeling, architecture discussion, and initiative discussion may clarify decisions but never create a task automatically.

For one coherent implementation outcome:

```text
discussion → optional grilling → owner /to-task → one READY task → owner /execute
```

For multi-task work:

```text
discussion → grill-with-docs → owner /to-spec → initiative → owner /to-tickets → Work Map → owner selects one item through /to-task → one READY task → owner /execute
```

Lead must classify the likely shape and recommend the next command, then stop. Lead does not infer any planning transition from “yes,” “sounds good,” “okay,” answers to questions, or apparent requirement completeness. `/to-spec`, `/to-tickets`, and `/to-task` are user-invoked only and must never invoke one another automatically.

A proposed task is valid only when it has one primary objective and coherent behavioral outcome, fits one fresh Coder context, produces one reviewable delta, and can complete independently with meaningful verification. If it could naturally split into independently useful outcomes that land green separately, it is too broad for one task and should route to `/to-spec` or Work Map revision. Never create a mega-task or silently create several tasks.

## Initiative Planning

An initiative in `.agent/initiatives/I-xxx-<slug>.md` records a durable multi-task outcome and evolving Work Map. Initiative IDs are sequential and independent from task IDs. Allowed initiative statuses are `DRAFT`, `ACTIVE`, `PAUSED`, and `DONE`; status changes to `ACTIVE` or `PAUSED` require explicit owner intent.

Work items use initiative-local IDs `W1`, `W2`, ... and statuses `PLANNED`, `READY`, `DONE`, or `DROPPED`. `PLANNED` includes unblocked frontier candidates. `READY` means `/to-task` has created and linked the item's actual just-in-time task; it is still not executable authorization. The selected slice carries its `Sanbi task: T-xxx` reference until reviewed completion makes it `DONE`. `DROPPED` requires an intentional planning decision. The Work Map may evolve as implementation reveals new facts.

Lead may mark an initiative `DONE` only with owner agreement, after its intended outcome and appropriate verification are complete, required work items are `DONE` or explicitly `DROPPED`, and no material Open Questions remain for its declared scope. An empty frontier alone does not imply completion.

When no implementation task is active, Lead may inspect the active initiative frontier and recommend a next item. Only owner-invoked `/to-task` may select and convert one coherent unblocked work item into a normal task contract just in time. An initiative-linked task adds optional frontmatter:

```yaml
initiative: I-001
work_item: W2
```

After the owner approves `/to-task`'s compact proposal, Lead creates exactly one task directly as `READY`, marks only the selected Work Map item `READY`, and adds the resulting `T-xxx` reference. Never create a second task for an item that already has a Sanbi task reference; reconcile that task first. Standalone tasks omit linkage and remain fully valid. Initiative creation, Work Map approval, and task creation do not authorize execution: only owner-invoked `/execute` performs `READY -> CODING`.

Lead owns initiative files. Coder may read a relevant initiative but does not change its Work Map, decisions, status, future-item state, or progress. Coder reports implementation findings through the normal result artifact for Lead to reconcile.

## Task State

Task state lives in YAML frontmatter inside the task Markdown file.

Supported states:

- `DRAFT`
- `READY`
- `CODING`
- `BLOCKED`
- `REVIEW`
- `DONE`

A task also contains:

`active: true | false`

At most one task may have `active: true`.

A task remains active after reaching `DONE` until `/next` successfully rotates the sessions.

`READY` means the owner approved `/to-task`'s proposed contract shape and Lead wrote the implementation contract. It is a waiting state, not execution authorization. Lead must summarize the ready task and wait for the owner to invoke `/execute`.

## State Ownership

### Lead may perform

- `DRAFT -> READY`
- `BLOCKED -> CODING`
- `REVIEW -> CODING`
- `REVIEW -> DONE`

### Coder may perform

- `CODING -> BLOCKED`
- `CODING -> REVIEW`

The Coder may change only execution-owned metadata such as the `status` field. It must not rewrite the task contract.

### `/execute` performs

- verifies the caller is Lead
- verifies exactly one active task exists in `READY`
- transitions `READY -> CODING`
- invokes Coder with the concise task-start message
- rolls the task back to `READY` if Herdr rejects the invocation

### `/next` performs

- verifies the active task is `DONE`
- verifies its handoff exists
- changes `active: true` to `active: false`
- rotates both Pi sessions

## Communication

Herdr remains the signalling transport, not durable task storage. Routine models use Sanbi semantic actions rather than discovering Herdr agent names or CLI syntax.

`/execute` generates the canonical start signal. Lead uses `sanbi_signal_coder` for BLOCKED continuation or REVIEW rework; that action owns the state transition, peer resolution, canonical message, transport, and guarded rollback. Coder-to-Lead `BLOCKED` and `REVIEW` notifications are sent automatically by the lifecycle extension after Coder settles in the new state, with `sanbi_signal_lead` available only for explicit retry. Models must not use raw Herdr discovery/help commands for these routine paths.

Messages should normally be short and reference authoritative files.

Example Lead to Coder:

`Start T-043. Re-read .agent/project.md and execute .agent/tasks/T-043.md.`

Example Coder to Lead:

`T-043 is ready for review. Read .agent/results/T-043.md.`

Example blocker:

`T-043 is BLOCKED. Read .agent/results/T-043.md.`

Do not place important architectural decisions only inside a Herdr message.

## Implementation Freedom

Every task specifies one of three levels.

### NORMAL

The objective, constraints, scope, and acceptance criteria are binding.

Implementation guidance is advisory.

The Coder may choose a better local implementation if it remains inside the contract and reports meaningful deviations.

### DIRECTED

The implementation direction specified by the Lead is binding.

Local implementation details remain the Coder's responsibility.

Departures require Lead approval.

### EXACT

The implementation specification is binding.

Any meaningful deviation requires the Coder to stop and request Lead approval.

Use this for sensitive migrations, protocols, security-sensitive changes, or other tightly constrained work.

## Engineering Disciplines

Coder may use the `tdd` and `diagnosing-bugs` skills inside an authorized task. Testing or diagnosis that exposes a material architecture, public-interface, behavior, acceptance, or scope decision routes through the existing BLOCKED flow to Lead; Coder does not ask the owner directly. Non-implementing diagnostic subagents are optional evidence-gathering assistants and never implement fixes.

Lead may use `code-review` during `REVIEW`, optionally with fresh application-non-writing `reviewer` subagents for separate Contract and Standards passes. The active task contract remains the binding specification. Lead writes the existing review artifact and remains prohibited from modifying source or tests.

Subagent V2 specialists are isolated, application-non-writing evidence gatherers inside the parent Pi process. Lead has `scout`, `researcher`, and `reviewer`; Coder has `scout`, `researcher`, and `diagnostic-scout`. They receive filesystem context pointers, not automatic parent transcript clones, and cannot delegate recursively or exercise lifecycle authority. Reviewer and Diagnostic Scout retain `bash` for verification and reproduction, so their non-writing boundary is instruction-enforced rather than an operating-system sandbox.

Task-local ephemeral verification servers use `sanbi_runtime_process`, not model-authored background shell/PID cleanup. Start with an explicit deterministic port and framework strict-port equivalent when available, wait for returned HTTP/output readiness, verify through the exact returned URL, and explicitly stop the opaque handle afterward. Sanbi owns the process tree and OS-temp logs; session shutdown is fallback cleanup. Never use this helper for Pi, Herdr, owner processes, or long-lived infrastructure.

## Blocking

The Coder must stop rather than guess when:

- requirements are materially ambiguous
- repository reality conflicts with the task contract
- scope needs to expand
- a stated architectural constraint must be broken
- a product or architecture decision is required
- a required dependency or environment condition prevents meaningful progress

The Coder writes the blocker into its result artifact, marks the task `BLOCKED`, and notifies the Lead.

## Review and Rework

The Coder moves the task to `REVIEW` only after completing its own verification and updating the result artifact.

The Lead then:

- reads the task contract
- reads the result
- inspects the actual diff and repository state
- runs appropriate tests/build/typecheck/lint or other verification
- checks acceptance criteria

If changes are required:

- Lead appends a review round
- Lead invokes the Sanbi-native rework signal, which atomically returns the task to `CODING` and notifies Coder
- the same Coder session continues

There is no separate `REWORK` state.

If approved, before the final task status transition:

- for an initiative-linked task, Lead marks the referenced work item `DONE`, retains its Sanbi task reference, records only meaningful initiative-level progress, and identifies—but does not automatically promote—the newly unblocked frontier
- Lead updates stable project context if necessary
- Lead writes the handoff
- Lead marks the task `DONE` last, so an active `DONE` task always has its required durable handoff and initiative reconciliation

Completion does not automatically create the next task. Future slice selection normally remains for the fresh Lead after `/next`.

## Artifact Ownership

### Lead owns

- `.agent/project.md`
- `.agent/tasks/*.md`
- `.agent/reviews/*.md`
- `.agent/handoffs/*.md`
- `.agent/initiatives/*.md`

Except that the Coder may update the execution `status` field in the active task.

### Coder owns

- application implementation
- application tests
- `.agent/results/*.md`

### Sanbi manages

- `.agent/protocol.md`
- `.agent/roles/**`
- `.agent/templates/**`
- `.agent/skills/**`
- `.agent/subagents/{shared,lead,coder}/**`
- `.agent/.runtime/.gitignore`
- `.pi/extensions/lifecycle.ts`
- `.pi/extensions/sanbi-subagents.ts`
- `.pi/sanbi/subagent-ui.js`
- `.pi/sanbi/runtime-temp.js`
- `.pi/sanbi/runtime-process.js`

Project agents may propose improvements to these resources but do not rewrite them during normal project work. Lead may maintain project-owned documentation such as `CONTEXT.md` and qualifying ADRs under `docs/adr/`; Lead still does not write application or test source.

## Session Lifecycle

After a task reaches `DONE`, both task sessions remain available until the owner invokes `/next`.

This allows final discussion about the completed task.

`/next` then archives the previous task sessions and creates:

- fresh Lead session: `<project>/lead/inbox`
- fresh Coder session: `<project>/coder/idle`

The fresh Lead receives its role, shared protocol, current project context, and previous handoff.

The fresh Coder receives its role and shared protocol and remains idle.

When a new task starts, the Coder must re-read current `.agent/project.md` before execution because project context may have changed while it was idle.
