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

`READY` means the Lead considers the contract complete enough to implement. It is a waiting state, not owner authorization. Lead must summarize the ready task and wait for the owner to invoke `/execute`.

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

Use **Herdr for signalling**, not as durable task storage.

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
- task returns to `CODING`
- Lead notifies Coder
- the same Coder session continues

If approved:

- Lead marks the task `DONE`
- Lead updates stable project context if necessary
- Lead writes the handoff

## Artifact Ownership

### Lead owns

- `.agent/project.md`
- `.agent/tasks/*.md`
- `.agent/reviews/*.md`
- `.agent/handoffs/*.md`

Except that the Coder may update the execution `status` field in the active task.

### Coder owns

- application implementation
- application tests
- `.agent/results/*.md`

## Session Lifecycle

After a task reaches `DONE`, both task sessions remain available until the owner invokes `/next`.

This allows final discussion about the completed task.

`/next` then archives the previous task sessions and creates:

- fresh Lead session: `<project>/lead/inbox`
- fresh Coder session: `<project>/coder/idle`

The fresh Lead receives its role, shared protocol, current project context, and previous handoff.

The fresh Coder receives its role and shared protocol and remains idle.

When a new task starts, the Coder must re-read current `.agent/project.md` before execution because project context may have changed while it was idle.
