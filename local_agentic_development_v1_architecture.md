# Local Agentic Development Environment — V1 Architecture and Implementation Plan

**Status:** Planning complete for V1  
**Purpose:** Implementation brief for building and testing the local development setup  
**Primary tools:** Herdr, Pi, Codex-subscription-backed models through Pi  
**Future integration:** Hermes for Telegram/automation/research, Matt Pocock skills, optional stronger enforcement and lifecycle tooling

---

## 1. Executive Summary

This project defines a local-first software development environment built around two persistent, terminal-visible Pi agents inside Herdr:

- **Lead** — the owner-facing reasoning, architecture, planning, delegation, verification, and review agent.
- **Coder** — the implementation agent responsible for source code changes, tests, debugging, and task execution.

The system is intentionally designed around a strict separation between:

- **cognition** — Pi agent sessions,
- **terminal/process visibility and inter-agent signalling** — Herdr,
- **durable workflow truth** — repository files,
- **implementation truth** — the actual repository and Git state,
- **future external automation/control** — Hermes.

The key philosophy is:

> **Pi sessions are disposable cognition. The filesystem is durable workflow memory. Git/repository state is implementation truth. Herdr is the live control and visibility layer.**

Each implementation task gets its own Lead and Coder Pi session context. When a task is finished and reviewed, the owner invokes `/next`. That command rotates both Pi sessions into fresh contexts while keeping the same Herdr panes, same persistent Pi processes, and same project workspace.

The result should feel like this during daily use:

```text
HERDR — <project>

┌──────────────────────────────┬──────────────────────────────┐
│ LEAD                         │ CODER                        │
│                              │                              │
│ <project>/lead/T-043         │ <project>/coder/T-043       │
│                              │                              │
│ Owner interacts here         │ Live implementation visible │
│                              │                              │
└──────────────────────────────┴──────────────────────────────┘
```

After task completion:

```text
Owner: /next
```

The panes stay where they are, but the Pi conversations become:

```text
<project>/lead/inbox
<project>/coder/idle
```

Both now have fresh context.

---

# 2. Core Goals

V1 should provide all of the following:

1. A project can be an **empty directory** or an **existing codebase**.
2. A single project bootstrap/open command can:
   - create missing agent infrastructure,
   - preserve existing project files,
   - create or focus the correct Herdr workspace,
   - open two panes,
   - start or restore the Lead and Coder Pi processes,
   - ensure both panes use the current project root as their working directory.
3. Lead and Coder are separate persistent Pi processes/sessions, not a Lead with a Coder subagent.
4. The owner primarily interacts with Lead.
5. Lead delegates implementation to Coder through Herdr.
6. Coder can work asynchronously for minutes or hours without keeping a Lead LLM inference running.
7. Coder notifies Lead when:
   - blocked,
   - ready for review.
8. Lead independently reviews real repository state.
9. Lead never writes application source code or test code in V1.
10. Coder writes application code and tests.
11. Every implementation task has explicit durable artifacts.
12. Task lifecycle state initially lives directly in the task Markdown file.
13. Task completion produces a Lead-authored handoff.
14. `/next` deterministically rotates both Pi sessions.
15. All role and lifecycle rules are re-established for fresh sessions.
16. V1 avoids building a large custom orchestration framework.

---

# 3. Explicit Non-Goals for V1

V1 intentionally does **not** include:

- a custom `devctl` orchestration framework,
- task-per-directory state files,
- a separate `state.json`,
- strict filesystem write enforcement,
- a Pi extension that blocks Lead source-code writes,
- multiple concurrent implementation tasks in one project,
- multiple concurrent Coders writing the same working tree,
- Git worktree-based parallel implementation,
- Hermes as the coding orchestrator,
- automatic roadmap generation,
- automatic architecture generation,
- automatic project creation,
- automatic Git initialization,
- Matt Pocock skill installation/configuration,
- final model/provider configuration,
- complex cold-recovery orchestration,
- a custom project-management system.

Those can be added only after the V1 workflow is proven through real local usage.

---

# 4. Architectural Principles

## 4.1 Conversation Is Not Memory

A Pi conversation must never be the only place containing information required by future sessions.

Persistent information belongs in files.

This means:

```text
Conversation
    = temporary reasoning context

.agent/project.md
    = durable project context

.agent/tasks/*.md
    = durable implementation contracts

.agent/results/*.md
    = durable Coder reports

.agent/reviews/*.md
    = durable Lead review history

.agent/handoffs/*.md
    = durable inter-session continuity

Git / repository
    = actual implementation truth
```

---

## 4.2 One Writer for Implementation

During normal V1 operation:

```text
Lead   = application/test source read-only by policy
Coder  = implementation writer
```

This avoids two AI agents modifying the same working tree simultaneously.

Lead may write agent workflow Markdown and project/architecture/research documentation, but not application source or test source.

---

## 4.3 Stronger Lead, Cheaper Coder

The intended model split is:

```text
Lead   → stronger reasoning model
Coder  → cheaper / lower-effort coding model
```

A tentative example discussed is:

```text
Lead   → Astra Light
Coder  → Sol Low
```

This model assignment is **not yet a final configuration decision**, but the architecture assumes that Coder may be meaningfully less capable than Lead.

Therefore:

- Lead carries more reasoning responsibility.
- Task contracts must be explicit.
- Lead should identify relevant constraints and edge cases before delegation.
- Coder should not be expected to infer high-level product or architecture intent from vague prompts.

---

# 5. System Components and Responsibilities

## 5.1 Herdr — Persistent Terminal and Live Agent Control Plane

Herdr is responsible for:

- persistent terminal processes,
- project workspaces,
- two-pane layout,
- Lead/Coder process visibility,
- showing live Coder input/output,
- named agents,
- sending prompts between agents,
- agent status signalling,
- reattaching to long-running agents after terminal detach.

Herdr is **not** the durable workflow source of truth.

Herdr messages should wake or control agents, while durable details live in repository artifacts.

---

## 5.2 Pi — Primary Development Harness

Pi is the primary interactive coding-agent application.

There are two independent Pi processes per active project:

```text
Lead Pi
Coder Pi
```

Each has its own:

- model,
- context,
- conversation history,
- tools,
- role bootstrap,
- session name.

Coder is **not** a Lead subagent.

---

## 5.3 Repository Filesystem — Durable Workflow Truth

`.agent/` stores:

- role definitions,
- shared protocol,
- project context,
- task contracts,
- Coder results,
- Lead reviews,
- Lead handoffs,
- reusable templates.

The filesystem survives:

- session resets,
- model changes,
- process restarts,
- Herdr detach/reattach,
- future tool migrations.

---

## 5.4 Git / Working Tree — Implementation Truth

Coder reports are not trusted blindly.

Lead must review:

- actual source,
- actual diff,
- actual test changes,
- actual test/build/typecheck results where appropriate.

If Coder says “tests passed” but repository reality disagrees, repository reality wins.

---

## 5.5 Hermes — Future External Automation Layer

Hermes is deliberately outside the core coding loop in V1.

Planned future responsibilities include:

- Telegram status/control,
- task started/blocked/completed notifications,
- project status queries,
- research tasks,
- saving research artifacts,
- recurring automation,
- possibly system/server monitoring.

Hermes should **not** become a second coding authority that independently edits the project.

Long-term mental model:

```text
                 Telegram
                    │
                    ▼
                 Hermes
        notifications / automation
                 research
                    │
                    │
Owner ─────► Lead Pi ─────► Coder Pi
                 │             │
                 └──── repo ───┘
                       │
                     Herdr
              terminal / visibility
```

---

# 6. Multi-Project Herdr Model

The preferred design is:

> **One persistent Herdr runtime/session, one Herdr workspace per software project.**

Example:

```text
Herdr

├── Workspace: voxveil
│   ├── LEAD
│   └── CODER
│
├── Workspace: hermes-setup
│   ├── LEAD
│   └── CODER
│
└── Workspace: website
    ├── LEAD
    └── CODER
```

The Herdr workspace represents the project boundary.

The same Herdr installation/server can therefore keep multiple projects alive simultaneously.

---

## 6.1 Pane Names vs Agent Names

The visual pane roles remain simple:

```text
LEAD
CODER
```

However, live Herdr agent identifiers should be project-scoped to avoid name collisions:

```text
voxveil-lead
voxveil-coder

website-lead
website-coder
```

The Lead role/bootstrap must know the current Coder agent identifier.

This may be provided through environment/configuration rather than hardcoded into the role Markdown.

---

# 7. Project Bootstrap / Project Init Philosophy

“Project init” does **not** mean “create a new software project.”

It means:

> **Adopt the current directory into this Lead/Coder development system and open the correct persistent runtime environment.**

It must work with both:

```text
empty-folder/
```

and:

```text
existing-production-monorepo/
├── apps/
├── packages/
├── package.json
└── ...
```

The bootstrap must not make assumptions about the application itself.

---

# 8. Desired One-Command Daily UX

Conceptually, from any project root:

```bash
cd /path/to/project
<project-command>
```

The final command name is not decided yet.

A placeholder such as `dev` may be used during implementation.

The command should result in:

```text
HERDR — project

┌──────────────────────────────┬──────────────────────────────┐
│ LEAD                         │ CODER                        │
│                              │                              │
│ cwd: /path/to/project        │ cwd: /path/to/project       │
│                              │                              │
│ Pi                           │ Pi                           │
│ project/lead/inbox           │ project/coder/idle          │
│                              │                              │
└──────────────────────────────┴──────────────────────────────┘
```

Both panes must use the current project directory as their working directory.

---

# 9. Bootstrap Must Be Idempotent

Running the project command repeatedly must not duplicate infrastructure.

Pseudo-behavior:

```text
open project
│
├─ .agent missing?
│    └─ create missing infrastructure
│
├─ role files missing?
│    └─ create canonical V1 versions
│
├─ protocol missing?
│    └─ create canonical V1 version
│
├─ templates missing?
│    └─ create canonical V1 versions
│
├─ project.md missing?
│    └─ create placeholder
│
├─ lifecycle extension missing?
│    └─ create/install project-local V1 extension
│
├─ Herdr workspace missing?
│    └─ create with cwd = current directory
│
├─ Lead pane/process missing?
│    └─ create/start
│
├─ Coder pane/process missing?
│    └─ create/start
│
└─ otherwise
     └─ focus/reuse existing project workspace
```

Important overwrite rule:

```text
missing → create
exists  → preserve
```

Existing role/protocol files must not be silently replaced in future versions.

Use explicit version markers such as:

```text
Role-Version: 1
Protocol-Version: 1
Context-Version: 1
```

Explicit managed-infrastructure upgrades use `dev upgrade`. Normal `dev` retains the preserve rule and only warns when `.agent/scaffold-version` is legacy or outdated. Upgrade is refused while any task is active, backs up replaced managed files under `.agent/upgrade-backups/`, preserves project-owned state, and refreshes both role sessions in the existing panes.

---

# 10. V1 Filesystem Layout

```text
project-root/
│
├── .agent/
│   ├── scaffold-version
│   ├── upgrade-backups/          # created only by explicit upgrades
│   ├── protocol.md
│   │
│   ├── roles/
│   │   ├── lead.md
│   │   └── coder.md
│   │
│   ├── project.md
│   │
│   ├── templates/
│   │   ├── task.md
│   │   ├── result.md
│   │   ├── review.md
│   │   └── handoff.md
│   │
│   ├── tasks/
│   ├── results/
│   ├── reviews/
│   └── handoffs/
│
└── .pi/
    └── extensions/
        └── lifecycle.ts
```

Future versions may migrate task artifacts into per-task directories:

```text
.agent/tasks/T-043/
├── task.md
├── state.json
├── result.md
├── review.md
└── handoff.md
```

But **V1 intentionally does not do this**.

---

# 11. Artifact Ownership

| Artifact | Created By | Maintained By |
|---|---|---|
| `.agent/protocol.md` | init/bootstrap | infrastructure, not normal agents |
| `.agent/roles/lead.md` | init/bootstrap | infrastructure, not normal agents |
| `.agent/roles/coder.md` | init/bootstrap | infrastructure, not normal agents |
| `.agent/project.md` | init placeholder | Lead |
| `.agent/tasks/T-xxx.md` | Lead | Lead; Coder may update execution status only |
| `.agent/results/T-xxx.md` | Coder | Coder |
| `.agent/reviews/T-xxx.md` | Lead | Lead |
| `.agent/handoffs/T-xxx.md` | Lead | Lead |

---

# 12. Shared Protocol

Canonical V1 content for `.agent/protocol.md`:

```md
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
```

---

# 13. Lead Role

Canonical V1 content for `.agent/roles/lead.md`:

```md
# Lead Role

Role-Version: 1

## Mission

You are the owner-facing technical Lead for this repository.

Your primary responsibilities are:

- understand the owner's intent
- inspect and understand the repository
- perform research when necessary
- reason about architecture and tradeoffs
- turn agreed work into explicit task contracts
- delegate implementation to the Coder
- independently verify implementation
- review and accept or reject work
- preserve durable project knowledge for future sessions

You are the primary reasoning agent.

The Coder may use a less capable or lower-effort model. Therefore, do not delegate vague requirements that depend on the Coder inferring important product, architectural, or acceptance decisions.

## You May

- read any repository file
- search and inspect the repository
- inspect Git history, status, and diffs
- inspect logs and runtime output
- research external technical information
- discuss requirements and architecture with the owner
- reproduce bugs
- run tests
- run builds
- run typecheck
- run lint
- run diagnostics
- write or update `.agent/**`
- write research Markdown
- write architecture documentation
- write ADRs or other non-implementation documentation
- ask the Coder to add, change, or improve tests
- return work to the Coder for rework

## You Must Not

- write application source code
- modify application source code
- write test source code
- modify test source code
- perform implementation refactors yourself
- bypass the Coder because a change appears small
- silently expand an agreed task
- accept work solely because the Coder says it passed

If implementation or test-source changes are required, delegate them to the Coder.

## Project Context

Maintain `.agent/project.md` as stable project knowledge.

It should describe facts that future sessions repeatedly need.

Do not turn it into:

- a task log
- a roadmap
- a conversation summary
- a list of temporary implementation details

Update it when a completed task changes stable architectural or operational facts.

## Creating Tasks

Before creating a new active task, verify that no other task has `active: true`.

Create the next sequential task ID using:

`T-001`, `T-002`, ...

Use `.agent/templates/task.md`.

A task contract must be explicit enough for the assigned Coder model.

Always define:

- objective
- why/context
- scope
- non-goals
- architectural constraints
- expected behavior
- relevant edge cases
- acceptance criteria
- verification requirements
- escalation conditions

Add implementation guidance when useful.

For simple tasks, sections may be brief.

For complex or risky tasks, provide substantially more detail.

## Readiness and Owner Authorization

Task readiness and owner authorization are separate.

`READY` means you believe the task contract is sufficiently complete for implementation. It does not mean the owner has authorized implementation.

When a task becomes implementation-ready:

1. complete the task contract
2. set its status to `READY`
3. summarize its goal, key constraints, and acceptance criteria to the owner
4. tell the owner to use `/execute` when implementation should begin
5. stop and wait

Never delegate implementation merely because a task has become `READY`.

Only the deterministic `/execute` lifecycle command may transition `READY -> CODING` and send the task-start message to Coder. Do not make that transition or invoke Coder yourself for initial task execution.

Do not interpret discussion, agreement with an architectural idea, answers to clarification questions, or phrases such as “sounds good,” “okay,” or “that works” as implementation authorization. For V1, `/execute` is the only authorization mechanism.

The owner may continue discussing or changing a `READY` task. Update the existing contract while keeping it `READY`, or return it to `DRAFT` if it is no longer implementation-ready.

After `/execute` successfully delegates, become idle and wait for Coder to notify you. Do not hold an LLM turn open for long-running implementation work.

The `/execute` gate applies only to initial `READY -> CODING` delegation. Existing blocker resolution and review rework continue to use their established `BLOCKED -> CODING` and `REVIEW -> CODING` flows.

## Handling Blockers

When the Coder reports `BLOCKED`:

1. read the result artifact
2. inspect repository context if required
3. resolve the question yourself when it is legitimately within Lead authority
4. ask the owner when a product or owner-level decision is required
5. persist any important decision in the task contract or project context
6. return task status to `CODING`
7. notify the same Coder session to continue

## Review

Never treat the Coder's result report as proof.

Review:

- actual changed files
- actual Git diff
- tests added or changed
- relevant neighboring code
- acceptance criteria
- architectural constraints
- regressions and edge cases

Run independent verification when appropriate.

You may run tests and tooling, but you may not write or modify test code yourself.

If additional tests are needed, instruct the Coder to write them.

## Rework

When work is insufficient:

1. append a new review round to `.agent/reviews/<task-id>.md`
2. explain concrete actionable findings
3. set the task back to `CODING`
4. notify the same Coder session

Do not create a fresh Coder session for ordinary rework.

## Completion

A task may become `DONE` only after your review passes.

Before marking `DONE`:

- verify acceptance criteria
- perform appropriate independent verification
- update `.agent/project.md` if stable project knowledge changed
- ensure final result artifact is accurate
- append final approval to the review artifact
- write `.agent/handoffs/<task-id>.md`

Then mark the task `DONE`.

Tell the owner the task is complete and that `/next` is available.

Do not rotate sessions yourself outside the `/next` lifecycle command.
```

---

# 14. Coder Role

Canonical V1 content for `.agent/roles/coder.md`:

```md
# Coder Role

Role-Version: 1

## Mission

You are the implementation Coder for this repository.

You execute one active task contract at a time.

Your responsibilities are:

- understand the assigned task
- inspect relevant repository code
- implement the requested change
- write and update tests
- debug failures
- run appropriate verification
- report implementation truth accurately
- escalate ambiguity rather than inventing architectural or product decisions

The Lead owns planning, architecture, task definition, and final review.

## You May

- read the repository
- modify application source code
- modify test source code
- add application code
- add tests
- refactor code when required by the active task
- run tests
- run builds
- run typecheck
- run lint
- use debugging and repository inspection tools
- write and update `.agent/results/<task-id>.md`
- change the active task status from `CODING` to `BLOCKED` or `REVIEW`

## You Must Not

- redefine product requirements
- make unapproved architecture changes
- silently expand task scope
- rewrite the Lead's task contract
- alter `active` task metadata
- modify project-wide architectural documentation unless the task explicitly requires implementation-related documentation
- mark a task `DONE`
- write the final handoff
- assume an ambiguous requirement when the answer materially affects behavior

## Starting a Task

When the Lead assigns a task:

1. re-read `.agent/project.md`
2. read the complete task contract
3. identify its implementation-freedom level
4. inspect relevant repository code before editing
5. verify that repository reality is compatible with the contract
6. begin implementation only when the task is sufficiently clear

The task contract is authoritative.

## Implementation Freedom

Follow the definitions in `.agent/protocol.md`.

If `NORMAL`, choose appropriate local implementation details while respecting all constraints.

If `DIRECTED`, follow the Lead's stated implementation direction.

If `EXACT`, do not materially deviate without approval.

## Tests

Tests are part of implementation ownership.

Add or modify tests when:

- required explicitly by the contract
- needed to prove acceptance criteria
- needed to protect behavior changed by the implementation
- requested by the Lead during review

Do not omit appropriate tests merely because the task contract did not name an exact test file.

## Blocking

Stop and escalate instead of guessing when:

- requirements are materially ambiguous
- repository behavior contradicts the contract
- implementation requires expanding scope
- implementation requires breaking an architectural constraint
- a product or architecture decision is required
- a required dependency/environment issue prevents meaningful progress

When blocked:

1. update `.agent/results/<task-id>.md`
2. clearly explain the blocker and relevant findings
3. list concrete options when useful
4. change task status from `CODING` to `BLOCKED`
5. notify the Lead through Herdr

Do not continue making speculative implementation changes while blocked.

## Completion

Before requesting review:

1. complete implementation
2. inspect your own diff
3. run required verification
4. update the result artifact accurately
5. record meaningful deviations or unresolved risks
6. change task status from `CODING` to `REVIEW`
7. notify the Lead

Typical notification:

`T-043 is ready for review. Read .agent/results/T-043.md.`

## Rework

If the Lead requests changes:

1. read the latest review round
2. keep using the same task session
3. make the requested corrections
4. update tests as necessary
5. re-run verification
6. update the existing result artifact
7. return the task to `REVIEW`
8. notify the Lead again

Do not create a new task or redefine the existing contract yourself.

## Reporting

Never claim:

- a test passed if it was not run
- a command succeeded if it failed
- work is complete when known requirements remain
- no deviations occurred when implementation materially differs from guidance

The result artifact must describe repository reality, not an idealized summary.
```

---

# 15. Project Context Template

Canonical V1 `.agent/project.md` created by init:

```md
# Project Context

Context-Version: 1

> This file contains stable project knowledge required across agent sessions.
> Keep it concise and factual.
>
> Do not use this file as a roadmap, task log, conversation history, or temporary scratchpad.

## Identity

**Name:** Not established

**Purpose:** Not established

## Current Technology

Not established.

Document only technologies that are actually present or explicitly decided.

Examples:

- languages
- runtimes
- frameworks
- package managers
- databases
- infrastructure relevant to development

## Repository Structure

Not established.

Record only important structural conventions that future agents repeatedly need.

Example:

- `apps/web/` — frontend application
- `packages/core/` — shared domain logic

## Development Commands

Not established.

Record canonical commands once verified.

### Install

Not established.

### Development

Not established.

### Tests

Not established.

### Typecheck

Not established.

### Lint

Not established.

### Build

Not established.

## Architectural Invariants

None recorded yet.

Use this section for stable constraints future tasks must preserve unless explicitly changed.

## Important Conventions

None recorded yet.

Use for durable repository conventions that are not obvious from tooling.

## Environment Notes

None recorded yet.

Record only development-environment facts that repeatedly matter.

Do not store secrets.

## Canonical Documentation

None recorded yet.

List important repository documents future agents should consult.

## Known Stable Limitations

None recorded yet.

Only include limitations that remain relevant across multiple tasks.
```

The bootstrap command should not attempt to infer and fill this file automatically.

Lead may gradually populate it as facts become verified through real work.

---

# 16. Task Contract Strategy — Adaptive Contract+

Because Coder may run a cheaper/lower-effort model, tasks should be more explicit than a simple goal-only ticket.

However, Lead should not over-specify every implementation.

The contract is adaptive.

All tasks should cover the important categories, but section depth depends on task complexity.

---

## 16.1 Implementation Freedom Levels

### NORMAL — Default

Binding:

- objective,
- scope,
- non-goals,
- architectural constraints,
- expected behavior,
- acceptance criteria.

Implementation guidance is advisory.

Coder may choose better local implementation details if it remains within the contract.

---

### DIRECTED

Lead selects an implementation direction that is binding.

Coder owns local implementation details but may not change the stated direction without approval.

Example:

```text
Use the existing SessionStore.
Do not introduce a new persistence abstraction.
```

---

### EXACT

The implementation specification itself is binding.

Coder must stop and escalate before meaningful deviation.

Use sparingly for:

- protocol compatibility,
- security-sensitive work,
- cryptographic behavior,
- migrations,
- high-risk architecture changes,
- tightly constrained operations.

---

# 17. Task Template

Canonical `.agent/templates/task.md`:

```md
---
id: T-000
title: Replace with task title
status: DRAFT
active: true
implementation_freedom: NORMAL
---

# T-000 — Replace with task title

## Objective

Describe the concrete outcome this task must produce.

## Why / Context

Explain why the change is needed and the relevant existing behavior.

Include enough context that the Coder does not need to infer the product or architectural intent.

## Scope

### Included

- ...

### Not Included

- ...

## Architectural Constraints

List constraints that must remain true.

- ...

If none are task-specific, state that existing project invariants in `.agent/project.md` remain binding.

## Relevant Areas

Likely relevant files, modules, components, interfaces, or subsystems:

- ...

This section is guidance unless explicitly made binding.

## Expected Behavior

Describe externally or internally observable behavior after implementation.

- ...

## Edge Cases

Explicitly identify important edge cases.

- ...

## Acceptance Criteria

The task is acceptable only when:

- [ ] ...
- [ ] ...
- [ ] ...

Criteria should be observable or verifiable.

## Verification Requirements

Coder must run at least:

- ...

Examples:

- targeted tests
- relevant integration tests
- typecheck
- lint
- build

## Implementation Guidance

Optional Lead guidance.

State clearly whether guidance is advisory or binding according to `implementation_freedom`.

## Escalation Conditions

In addition to the standard protocol, stop and ask Lead if:

- ...

## Decisions Added During Execution

None yet.

Important decisions made while the task is running must be recorded here rather than existing only in conversation history.
```

---

# 18. Result Template

Canonical `.agent/templates/result.md`:

```md
---
task: T-000
outcome: IN_PROGRESS
---

# Result — T-000

## Outcome

`IN_PROGRESS`, `BLOCKED`, or `COMPLETE`

## Implementation Summary

Describe what was actually implemented.

## Files Changed

- `path/to/file` — what changed and why

## Tests Added or Changed

- ...

## Verification Performed

| Command / Check | Result |
| --- | --- |
| `...` | PASS / FAIL / NOT RUN |

Do not report a check as passing unless it was actually run successfully.

## Deviations From Task Contract

None.

If implementation differs meaningfully from the task guidance or expected design, explain it here.

## Blockers Encountered

None.

If blocked, explain:

- exact blocker
- repository evidence
- what decision or information is needed
- reasonable options when useful

## Risks / Unresolved Concerns

None.

## Follow-up Notes

None.
```

---

# 19. Review Template

Canonical `.agent/templates/review.md`:

```md
---
task: T-000
---

# Review — T-000

## Round 1

**Verdict:** `CHANGES_REQUIRED` or `APPROVED`

### Contract Check

- Objective: PASS / FAIL
- Scope: PASS / FAIL
- Architectural constraints: PASS / FAIL
- Acceptance criteria: PASS / FAIL

### Repository Review

Summarize relevant findings from the actual diff and surrounding code.

### Independent Verification

| Command / Check | Result |
| --- | --- |
| `...` | PASS / FAIL |

### Findings

If changes are required, every finding should be concrete and actionable.

1. ...
2. ...

### Required Changes

- ...

---

When another review is needed, append another section:

`## Round 2`

Do not erase previous review rounds.
```

---

# 20. Handoff Template

Canonical `.agent/templates/handoff.md`:

```md
---
task: T-000
---

# Handoff — T-000

## Completed

Concise description of the final reviewed outcome.

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
```

---

# 21. Task Lifecycle State Machine

Supported states:

```text
DRAFT
READY
CODING
BLOCKED
REVIEW
DONE
```

There is deliberately no separate `REWORK` state in V1.

Rejected review simply transitions back to `CODING`.

---

## 21.1 Exact State Flow

```text
DRAFT
  │
  ▼
READY
  │
  │ owner invokes /execute
  ▼
CODING
  │
  ├──────────────► BLOCKED
  │                   │
  │                Lead resolves
  │                   │
  ◄───────────────────┘
  │
  ▼
REVIEW
  │
  ├── reject ─────────► CODING
  │
  └── approve ────────► DONE
                           │
                           │ remains active:true
                           │ until owner invokes /next
                           ▼
                        /next
                           │
                           ▼
                      active:false
```

---

# 22. Why `active` Exists

A finished task remains:

```yaml
status: DONE
active: true
```

until `/next`.

This captures an important semantic distinction:

> The implementation task is complete, but the owner has not yet left the task context.

This allows the owner to ask Lead follow-up questions such as:

```text
Why did you approve this design?
What changed in SessionStore?
What did the Coder struggle with?
```

before context rotation.

After `/next`:

```yaml
status: DONE
active: false
```

---

# 23. State Ownership

Lead may transition:

```text
DRAFT   → READY
BLOCKED → CODING
REVIEW  → CODING
REVIEW  → DONE
```

`/execute` exclusively transitions:

```text
READY → CODING
```

Coder may transition:

```text
CODING → BLOCKED
CODING → REVIEW
```

`/next` changes:

```text
active: true → false
```

Coder must not mark a task `DONE`.

---

# 24. Hybrid Communication Protocol

The selected communication design is:

> **Herdr messages wake/control agents. Filesystem artifacts carry authoritative details.**

This is intentionally neither message-only nor file-polling-only.

---

## 24.1 Lead → Coder

Typical start message:

```text
Start T-043.

Re-read .agent/project.md.
Read and execute .agent/tasks/T-043.md.
```

The full task contract is **not** duplicated into the Herdr message.

---

## 24.2 Coder → Lead: Ready for Review

```text
T-043 is ready for review.
Read .agent/results/T-043.md.
```

---

## 24.3 Coder → Lead: Blocked

```text
T-043 is BLOCKED.
Read .agent/results/T-043.md.
```

---

## 24.4 Lead → Coder: Rework

```text
T-043 requires changes.
Read .agent/reviews/T-043.md and continue the same task.
```

---

## 24.5 Lead → Coder: Resolved Blocker

When durable task information changed:

```text
T-043 decision resolved.
The task contract has been updated.
Read it again and continue.
```

---

# 25. Why Lead Should Not Use Long `--wait` During Implementation

A Coder task may run for:

- 10 minutes,
- 30 minutes,
- one hour,
- two hours.

Keeping Lead blocked on a long-running `--wait` does not necessarily consume LLM tokens continuously, but it creates poor UX and unnecessary lifecycle fragility.

Selected approach:

```text
Lead delegates
    │
    ▼
Lead turn ends / becomes idle

Coder works asynchronously

Coder finishes or blocks
    │
    ▼
Coder sends Herdr prompt to Lead

Lead wakes and continues
```

This gives better:

- token isolation,
- context isolation,
- responsiveness,
- long-running task reliability.

Short deterministic lifecycle operations, such as `/next` resetting Coder, may use waiting semantics.

---

# 26. Token and Context Model

The two-session architecture deliberately keeps implementation noise away from Lead.

Example:

```text
Coder context:
- task contract
- source reads
- edits
- test output
- debugging
- rework

Lead context:
- owner discussion
- architecture
- task definition
- high-level notifications
- result/review
```

Coder working for two hours does **not** mean Lead receives two hours of Coder transcript.

Lead should inspect only the durable result plus repository state needed for review.

This is one of the major reasons for using two independent Pi sessions.

---

# 27. Session Model

Each project always has two stable terminal identities:

```text
Lead pane
Coder pane
```

The Herdr panes and Pi processes should remain stable.

Only Pi conversation sessions rotate.

---

## 27.1 Idle Session Names

```text
<project>/lead/inbox
<project>/coder/idle
```

---

## 27.2 Active Task Names

```text
<project>/lead/T-043
<project>/coder/T-043
```

Long task titles should not be embedded in session names.

The task ID is enough.

---

# 28. Initial Project Bootstrap Sessions

On first adoption of a project:

```text
Lead session:
<project>/lead/inbox

Coder session:
<project>/coder/idle
```

Lead bootstrap receives:

```text
lead role
+
shared protocol
+
project context
+
no previous handoff
```

Coder bootstrap receives:

```text
coder role
+
shared protocol
+
idle instruction
```

Coder does not need an active task.

---

# 29. Coder Idle Bootstrap

Fresh Coder session should receive semantics equivalent to:

```text
You are the Coder for this repository.

Your role is defined by:
.agent/roles/coder.md

The shared workflow is defined by:
.agent/protocol.md

You currently have no assigned task.

Remain idle until Lead delegates one.
Do not modify application code without an active delegated task.

When a task is assigned, re-read:
.agent/project.md

Then read the assigned task contract before editing.
```

The exact implementation may inject file contents into Pi session context rather than asking the model to re-open static role files immediately.

The key invariant is:

> Every fresh Coder session already knows its role before the next task arrives.

---

# 30. Lead Fresh Bootstrap

Fresh Lead after `/next` should receive:

```text
lead role
+
shared protocol
+
current project.md
+
previous handoff
```

and enter:

```text
<project>/lead/inbox
```

The Lead is immediately ready for owner discussion.

---

# 31. Starting a New Task

After `/next`, Coder already exists as:

```text
<project>/coder/idle
```

Therefore task start does **not** create a new Coder session.

Instead:

1. Owner discusses desired work with Lead.
2. Lead may inspect repository/research/run diagnostics.
3. Lead creates `T-xxx` as `DRAFT`.
4. Lead refines task contract with owner as needed.
5. Lead marks it `READY`, summarizes it to the owner, and stops.
6. Owner invokes `/execute`; no natural-language alias authorizes implementation.
7. The deterministic `/execute` command:
   - validates Lead role and exactly one active `READY` task,
   - transitions the task to `CODING`,
   - renames the Lead session and causes Coder naming to follow the active task,
   - sends the concise Herdr start message,
   - rolls back to `READY` if Herdr rejects invocation.
8. Lead remains idle while implementation runs asynchronously.
9. Coder executes.

The exact session-renaming mechanism can be implemented in the lifecycle/project extension or through Pi session naming APIs.

---

# 32. Detailed Task Execution Protocol

## Phase A — Discussion

Owner and Lead can freely discuss:

- requirements,
- architecture,
- tradeoffs,
- bugs,
- desired features,
- possible approaches.

No task must exist yet.

Lead may:

- inspect repository,
- research,
- run tests,
- reproduce issues,
- write research/architecture Markdown.

Lead does not write source or test code.

---

## Phase B — Task Creation

When work becomes implementation-ready:

```text
T-044
```

Lead creates:

```text
.agent/tasks/T-044.md
```

Initial state:

```yaml
status: DRAFT
active: true
```

Before doing this, Lead verifies no other task has:

```yaml
active: true
```

Task IDs are sequential:

```text
T-001
T-002
T-003
...
```

---

## Phase C — Ready

Once the contract is sufficiently explicit:

```yaml
status: READY
active: true
```

Lead summarizes the task to the owner, tells the owner to use `/execute`, and stops. `READY` records Lead's readiness judgment only; it is not implementation authorization. Discussion may continue and the contract may remain `READY` or return to `DRAFT`.

Lead should account for the fact that Coder may be less capable than Lead. The task should not depend on Coder inferring critical architectural decisions.

---

## Phase D — Execute

Owner authorizes implementation only by invoking:

```text
/execute
```

The deterministic lifecycle command:

1. verifies the caller is Lead,
2. requires exactly one active task in `READY`,
3. updates status to `CODING`,
4. ensures correct session/task naming,
5. sends Coder the concise task-start Herdr message,
6. returns immediately rather than waiting for implementation,
7. rolls back to `READY` if Herdr rejects the invocation.

Discussion, clarification answers, or conceptual agreement are not execution authorization.

---

# 33. Coder Execution Responsibilities

Coder:

1. re-reads `.agent/project.md`,
2. reads `.agent/tasks/T-xxx.md`,
3. inspects relevant source,
4. checks repository reality against contract,
5. implements,
6. writes/modifies tests,
7. runs required verification,
8. updates `.agent/results/T-xxx.md`.

Coder owns implementation decisions inside the permitted freedom level.

---

# 34. Blocked Flow

If Coder encounters a material blocker:

1. stop speculative implementation,
2. update result artifact,
3. set task status:
   ```yaml
   status: BLOCKED
   ```
4. notify Lead.

Result should explain:

- exact blocker,
- evidence,
- required decision,
- useful options if available.

Lead then:

1. reads blocker,
2. inspects repository if needed,
3. decides if within Lead authority,
4. asks owner if it requires product/owner decision,
5. persists durable decision into task/project context,
6. sets:
   ```yaml
   status: CODING
   ```
7. notifies the **same Coder session** to continue.

Do not create a fresh Coder session for blockers.

---

# 35. Ready for Review Flow

When implementation is complete, Coder:

1. inspects own diff,
2. finishes required verification,
3. updates result artifact,
4. sets:
   ```yaml
   status: REVIEW
   ```
5. notifies Lead.

Coder session remains alive.

---

# 36. Lead Review Responsibilities

Lead reviews:

- task contract,
- result artifact,
- actual changed files,
- actual Git diff,
- changed tests,
- relevant neighboring code,
- acceptance criteria,
- architectural constraints,
- possible regressions.

Lead may run:

- tests,
- typecheck,
- lint,
- build,
- diagnostics.

Lead may **not** write or modify test code.

If tests are missing or incorrect, Lead sends that work back to Coder.

---

# 37. Rework Flow

If review fails:

1. Lead appends a new review round to:
   ```text
   .agent/reviews/T-xxx.md
   ```
2. findings must be concrete and actionable,
3. Lead changes:
   ```yaml
   status: CODING
   ```
4. Lead notifies same Coder session,
5. Coder fixes,
6. Coder re-verifies,
7. Coder updates result,
8. Coder returns task to `REVIEW`,
9. Lead reviews again.

Repeat until approved or owner intervention is needed.

---

# 38. Completion Flow

If review passes, Lead:

1. confirms acceptance criteria,
2. performs final verification,
3. ensures result artifact accurately reflects implementation,
4. updates `.agent/project.md` if stable project context changed,
5. records approval in review artifact,
6. creates `.agent/handoffs/T-xxx.md`,
7. sets:
   ```yaml
   status: DONE
   active: true
   ```
8. informs owner:
   - task is complete,
   - `/next` is available.

Sessions are **not** immediately rotated.

---

# 39. Handoff Philosophy

Handoff is primarily for the **next Lead session**.

Coder does not need previous-task handoff to start the next implementation task.

The Coder instead receives:

```text
stable role
+
shared protocol
+
current project context at task start
+
new task contract
```

The handoff should contain only useful delta and continuity.

It should not become:

- a transcript,
- a giant task summary,
- a duplicate of Git diff,
- a duplicate of project.md.

---

# 40. `/next` — Selected Design

V1 will implement `/next` as a **project-local Pi extension**, not as a manual multi-step process.

Proposed file:

```text
.pi/extensions/lifecycle.ts
```

This extension is for lifecycle control, not write-permission enforcement.

Write-enforcement extensions are intentionally deferred.

---

# 41. `/next` Required Behavior

Owner invokes `/next` from the Lead Pi session.

Exact high-level sequence:

```text
Owner
  │
  │ /next
  ▼
Old Lead session
  │
  ├─ verify role == Lead
  ├─ identify exactly one active task
  ├─ verify status == DONE
  ├─ verify handoff exists
  │
  ├─ reset/rotate Coder
  │      │
  │      └─ fresh coder/idle
  │            role + protocol bootstrap
  │
  ├─ set completed task active:false
  │
  └─ rotate Lead
         │
         └─ fresh lead/inbox
               role + protocol
               project context
               previous handoff
```

The Lead should rotate **Coder first and itself last**.

Otherwise the command risks destroying the session orchestrating the transition before peer reset finishes.

---

# 42. Lifecycle Extension Role Awareness

The same extension may be loaded by both Pi processes.

Launcher/bootstrap should provide role-specific environment/config values conceptually like:

```text
AGENT_ROLE=lead
AGENT_PROJECT=<project-key>
AGENT_PEER=<project-key>-coder
```

and for Coder:

```text
AGENT_ROLE=coder
AGENT_PROJECT=<project-key>
AGENT_PEER=<project-key>-lead
```

Exact environment variable names are implementation details and may be adjusted.

The extension should not need to guess peer identity.

---

# 43. Proposed Extension Commands

V1 lifecycle commands are:

```text
/execute
/next
/task-reset <task-id>
```

`/task-reset` is an internal lifecycle command primarily invoked during `/next`.

The owner normally uses only `/next`.

---

# 44. `/next` Validation Rules

Before any session rotation:

1. caller must be Lead,
2. exactly one task must have:
   ```yaml
   active: true
   ```
3. that task must have:
   ```yaml
   status: DONE
   ```
4. matching handoff must exist:
   ```text
   .agent/handoffs/<task-id>.md
   ```

If any check fails, abort without partially rotating sessions.

Examples:

```text
ERROR: no completed active task exists.
```

```text
ERROR: multiple active tasks detected.
```

```text
ERROR: handoff for T-043 is missing.
```

---

# 45. Coder Reset During `/next`

Lead sends the project Coder an internal reset request.

Coder lifecycle logic should:

1. verify role == Coder,
2. ensure it is not in the middle of active generation/tool execution,
3. preserve/archive old session normally through Pi session handling,
4. create a fresh Pi session,
5. set name:
   ```text
   <project>/coder/idle
   ```
6. bootstrap:
   - Coder role,
   - shared protocol,
   - no active task instruction.

No previous handoff is needed.

---

# 46. Lead Reset During `/next`

After successful Coder reset:

1. set current task:
   ```yaml
   active: false
   ```
2. preserve/archive previous Lead session,
3. create fresh Pi session,
4. set name:
   ```text
   <project>/lead/inbox
   ```
5. bootstrap:
   - Lead role,
   - shared protocol,
   - current `.agent/project.md`,
   - previous task handoff.

---

# 47. Why Coder Is Bootstrapped at `/next`

This was explicitly selected over creating the Coder session only at `execute`.

Benefits:

- deterministic session boundary,
- both roles rotate together,
- Coder always knows its role before Lead delegates,
- Lead start prompts stay extremely small,
- no risk that Lead forgets to include role/bootstrap material,
- idle Pi session costs no ongoing inference tokens.

Potential staleness of project context is handled by requiring Coder to re-read `.agent/project.md` at every task start.

---

# 48. Pane and Process Persistence

Normal `/next` must **not**:

- close Herdr workspace,
- create new panes,
- kill the Pi process,
- restart Pi,
- rearrange terminal layout.

It should only change Pi conversation session context.

Visually:

Before:

```text
LEAD  → project/lead/T-043
CODER → project/coder/T-043
```

After:

```text
LEAD  → project/lead/inbox
CODER → project/coder/idle
```

Same panes. Same project. Fresh conversations.

---

# 49. Live Coder Visibility

The right pane is the actual Coder Pi terminal.

The owner should be able to watch:

- file reads,
- tool calls,
- edits,
- test commands,
- test output,
- assistant-visible progress,
- final messages.

The owner does not need to interact with Coder directly during normal operation.

The owner will not see hidden model chain-of-thought, only the normal Pi-visible interaction/tool activity.

---

# 50. Warm Open

If Herdr and Pi processes are still alive:

```bash
cd project
<project-command>
```

should:

- detect the existing project workspace,
- focus it,
- preserve existing Lead and Coder sessions,
- not bootstrap duplicates,
- not reset context.

This is the normal daily persistence path.

---

# 51. Cold Open / Recovery Direction

Cold recovery occurs after:

- reboot,
- Herdr server termination,
- Pi process termination,
- other full runtime loss.

V1 philosophy:

> Filesystem truth is more important than exact conversation resurrection.

The project can inspect task Markdown files.

Expected invariant:

```text
0 active tasks
→ lead/inbox + coder/idle

1 active task
→ recover that task state

>1 active tasks
→ inconsistency; automation should stop
```

Potential active states:

```text
READY
CODING
BLOCKED
REVIEW
DONE with active:true
```

Exact automated cold-recovery behavior may be implemented minimally in V1 and improved after local testing.

Do not make the architecture dependent on old conversation history being recoverable.

---

# 52. Lead Source-Code Write Policy

For V1 this is **prompt-policy only**.

Lead may:

```text
✓ inspect source
✓ inspect tests
✓ run tests
✓ run build
✓ run typecheck
✓ run lint
✓ research
✓ write .agent Markdown
✓ write research documentation
✓ write architecture/ADR documentation
✓ ask Coder to write more tests
```

Lead may not:

```text
✗ write application source
✗ modify application source
✗ write tests
✗ modify tests
✗ implement "small fixes"
✗ refactor application code
```

This applies even if the change is trivial.

---

# 53. Future Write Enforcement

Deferred idea:

A future Pi extension may intercept:

- `write`,
- `edit`,
- mutating shell commands,

and prevent Lead from modifying forbidden paths.

This is deliberately not V1.

Reason:

- first validate the workflow through prompt discipline,
- observe actual failure modes,
- avoid prematurely building complicated guardrails.

---

# 54. Direct Herdr CLI in V1

Lead will control Coder directly using Herdr CLI primitives.

No custom orchestration CLI yet.

Conceptually:

```text
Lead
  │
  └─ herdr ... coder "Start T-043..."
```

and Coder similarly wakes Lead.

Exact Herdr CLI syntax should be verified against the installed version during implementation.

Avoid hardcoding assumptions before checking the actual local Herdr version.

---

# 55. No `devctl` in V1

A future thin wrapper may eventually provide:

```text
devctl status
devctl coder-start T-043
devctl coder-message ...
devctl next
```

Reasons to consider it later:

- centralize lifecycle invariants,
- hide Herdr CLI details,
- validate task state,
- reduce prompt complexity.

But the decision is:

> **Prove the system first using direct Herdr CLI. Build `devctl` only if repeated workflow mechanics justify it.**

---

# 56. No Separate State File in V1

Task state lives directly in task Markdown YAML frontmatter.

Example:

```md
---
id: T-043
title: Relay cleanup
status: CODING
active: true
implementation_freedom: NORMAL
---
```

Advantages for V1:

- one artifact per task,
- easy to inspect manually,
- no extra synchronization problem,
- minimal infrastructure.

Future migration:

```text
task directory
+
state.json
```

if system complexity grows.

---

# 57. Why YAML Frontmatter

Although state lives in Markdown, structured YAML metadata gives the lifecycle extension a stable parsing target.

Prefer:

```yaml
status: REVIEW
```

over loosely formatted prose such as:

```text
Status: REVIEW
```

This makes future:

- parsing,
- validation,
- migration,
- automation

more reliable.

---

# 58. Sequential Task IDs

Task IDs should be:

```text
T-001
T-002
T-003
...
```

Lead determines the next ID from existing task artifacts.

V1 assumes a single active task, so task-ID allocation does not need distributed locking.

---

# 59. Lead Handoff vs Coder Result

These are deliberately separate.

Coder result answers:

> What did the implementer do, run, encounter, and believe is complete?

Lead handoff answers:

> After independent review, what durable information does the next Lead session need?

Therefore a Coder result is **not** automatically reused as the handoff.

---

# 60. Research and Architecture Docs

Lead may create Markdown outside `.agent/` when useful, such as:

```text
docs/research/
docs/architecture/
docs/adr/
```

Exact directories should respect the existing project structure where possible.

Lead should not create unnecessary documentation bureaucracy.

---

# 61. Project.md Update Policy

`.agent/project.md` stores only stable cross-task facts.

Good examples:

- verified canonical test command,
- monorepo package layout,
- durable architecture invariant,
- permanent protocol requirement,
- important stable tooling convention.

Bad examples:

- “today we changed foo.ts,”
- task status,
- temporary TODO,
- detailed implementation transcript,
- roadmap,
- owner conversation summary.

---

# 62. Owner Interaction Model

Normal owner workflow:

```text
Owner ↔ Lead
```

Owner should not need to coordinate Coder manually.

Coder is visible in the right pane but normally controlled by Lead.

Possible exception:

- debugging the development system itself.

---

# 63. Example End-to-End Task

Assume project state:

```text
Lead  → voxveil/lead/inbox
Coder → voxveil/coder/idle
```

Owner:

```text
I want relay disconnects to destroy all pending in-memory envelopes.
```

Lead:

- inspects current code,
- discusses expected semantics,
- identifies constraints,
- optionally runs current tests.

Lead creates:

```text
.agent/tasks/T-043.md
```

with:

```yaml
status: DRAFT
active: true
```

After discussion:

```yaml
status: READY
```

Owner:

```text
/execute
```

Lead:

```yaml
status: CODING
```

Lead session becomes:

```text
voxveil/lead/T-043
```

Coder session becomes:

```text
voxveil/coder/T-043
```

Lead sends:

```text
Start T-043.
Re-read .agent/project.md.
Read and execute .agent/tasks/T-043.md.
```

Lead becomes idle.

Coder:

- reads project/task,
- inspects relay/session code,
- implements,
- adds tests,
- runs verification.

If blocked:

```yaml
status: BLOCKED
```

and notifies Lead.

After resolution:

```yaml
status: CODING
```

Coder eventually finishes:

```yaml
status: REVIEW
```

and writes:

```text
.agent/results/T-043.md
```

Lead reviews:

- result,
- diff,
- tests,
- acceptance criteria,
- architecture.

If rejected:

```yaml
status: CODING
```

Lead writes/appends:

```text
.agent/reviews/T-043.md
```

Coder reworks using same session.

When approved:

```yaml
status: DONE
active: true
```

Lead writes:

```text
.agent/handoffs/T-043.md
```

Owner may ask final questions.

Then:

```text
/next
```

Result:

```text
T-043:
status: DONE
active: false

Lead:
voxveil/lead/inbox
fresh session

Coder:
voxveil/coder/idle
fresh session
```

Next task can begin.

---

# 64. Project Bootstrap Implementation Responsibilities

The local bootstrap script/tool should perform approximately:

## Filesystem

Create if missing:

```text
.agent/
.agent/roles/
.agent/templates/
.agent/tasks/
.agent/results/
.agent/reviews/
.agent/handoffs/
.pi/extensions/
```

Create if missing:

```text
.agent/protocol.md
.agent/roles/lead.md
.agent/roles/coder.md
.agent/project.md
.agent/templates/task.md
.agent/templates/result.md
.agent/templates/review.md
.agent/templates/handoff.md
.pi/extensions/lifecycle.ts
```

Do not overwrite existing copies in normal V1 operation. New adoptions also receive `.agent/scaffold-version`. Legacy/outdated projects are reported but remain unchanged until the owner runs `dev upgrade` with no active task.

---

## Runtime

Using current directory as project root:

1. derive stable project key,
2. locate/create Herdr workspace,
3. ensure workspace cwd is project root,
4. ensure two panes,
5. ensure Lead Pi running in left pane,
6. ensure Coder Pi running in right pane,
7. provide role/project/peer environment/config,
8. bootstrap missing Pi sessions,
9. focus project workspace.

The project-key derivation mechanism should avoid collisions for same-named directories in different paths.

A simple folder-name key may be acceptable initially, but a path-derived stable identifier is safer.

This is an implementation choice to resolve while coding.

---

# 65. Startup Cases

## Case A — Empty Directory

Input:

```text
new-project/
```

Bootstrap creates only development-agent infrastructure.

It does not create:

- package.json,
- source directories,
- roadmap,
- architecture,
- Git repo.

Lead and owner decide all of that later.

---

## Case B — Existing Repository

Input:

```text
existing-app/
├── src/
├── tests/
├── package.json
└── ...
```

Bootstrap adds missing agent infrastructure only.

It does not rewrite existing project files.

---

## Case C — Already Adopted, Runtime Alive

Bootstrap focuses/reuses existing Herdr workspace and agents.

No session reset.

---

## Case D — Already Adopted, Runtime Missing

Bootstrap reconstructs runtime from durable project state.

Exact V1 recovery behavior may start simple and improve through local testing.

---

# 66. Project Init Must Not Invent Project Knowledge

The bootstrap tool should not analyze the repository and automatically fill:

- architecture,
- technology,
- roadmap,
- project purpose.

It only creates the placeholder `project.md`.

Lead fills stable facts later as they are verified.

Reason:

> deterministic infrastructure setup should not depend on an LLM making speculative project interpretations.

---

# 67. Model Configuration Status

Architecture is intentionally model-agnostic.

Tentative direction:

```text
Lead  = stronger model, e.g. Astra Light
Coder = cheaper lower-effort model, e.g. Sol Low
```

Final choices belong to the later configuration phase.

The role/task design must work even if models are swapped.

---

# 68. Matt Pocock Skills — Deferred Phase

After V1 local workflow works:

1. inspect Matt Pocock's skills,
2. classify them by:
   - Lead-only,
   - Coder-only,
   - shared,
   - unnecessary,
3. add only skills that improve the established workflow,
4. do not let skill framework redefine the architecture.

Important principle:

> Skills enhance local agent capability. They do not own the workflow.

---

# 69. Codex CLI — Future Secondary Harness

Pi is intended to be the main daily development harness.

Codex CLI may remain useful later for:

- independent second opinion,
- cold code review,
- hard debugging,
- fallback if Pi/harness is problematic,
- tasks that benefit from a separate execution environment.

Codex CLI is not the workflow owner in V1.

---

# 70. Hermes — Future Concrete Use Cases

After core coding flow is stable, Hermes may provide:

```text
/project voxveil
/status
/current-task
/blocked
```

Potential notifications:

```text
T-043 started
T-043 blocked — owner decision required
T-043 ready for review
T-043 completed
```

It may also perform research tasks and save artifacts.

Hermes should read durable task/project files rather than trying to infer project state from Pi conversations.

---

# 71. Future Parallelism

V1 intentionally uses:

```text
one repo
one active implementation task
one Coder writer
```

If future parallel implementation is needed, use isolated Git worktrees rather than two Coders modifying the same working tree.

Possible future architecture:

```text
Lead
├─ Coder A → worktree A
└─ Coder B → worktree B
```

This is not V1.

---

# 72. Future Task Storage Upgrade

If V1 grows beyond a single simple active task model, migrate:

```text
.agent/tasks/T-043.md
.agent/results/T-043.md
.agent/reviews/T-043.md
.agent/handoffs/T-043.md
```

to:

```text
.agent/tasks/T-043/
├── task.md
├── state.json
├── result.md
├── review.md
└── handoff.md
```

Do not implement this prematurely.

---

# 73. Future `devctl`

Potential future thin wrapper:

```text
devctl status
devctl coder-start T-043
devctl coder-message T-043 "..."
devctl review T-043
devctl next
```

Its purpose would be to replace low-level Herdr lifecycle mechanics with deterministic software boundaries.

It should remain a thin lifecycle wrapper, not become a full AI orchestration framework.

---

# 74. Future Enforcement Extension

Potential future Pi guardrail:

Lead attempts to write:

```text
src/relay/session.ts
```

Result:

```text
DENIED:
Lead role cannot modify implementation files.
Delegate the change to Coder.
```

Potential enforcement must consider shell-based writes as well as Pi write/edit tools.

This complexity is why it is deferred.

---

# 75. Reliability Invariants

V1 implementation should preserve these invariants:

1. At most one task has `active: true`.
2. Only one Coder is the normal implementation writer.
3. Lead never intentionally edits application/test source.
4. Coder never marks a task `DONE`.
5. `/next` runs only for `DONE + active:true`.
6. `/next` requires matching handoff.
7. `/next` rotates Coder before Lead.
8. `/next` does not close Herdr panes.
9. Coder re-reads `project.md` at task start.
10. New Lead gets previous handoff.
11. New Coder does not need previous handoff.
12. Important decisions are never left solely in chat/Herdr transcript.
13. Coder reports are not treated as proof without Lead review.
14. Warm reopening a project must not reset active sessions.
15. Init must not overwrite existing canonical agent files silently.
16. Normal `dev` must never auto-upgrade managed infrastructure.
17. `dev upgrade` must refuse active tasks, back up replaced managed files, preserve project-owned state, reuse panes, and rotate both roles to fresh context.

---

# 76. Suggested V1 Implementation Order for Codex

The local implementation can be built incrementally.

## Step 1 — Filesystem bootstrap

Implement a command/script that:

- detects current directory,
- creates missing V1 directories,
- creates canonical role/protocol/template files,
- creates placeholder project.md,
- preserves existing files.

Test on:

- empty directory,
- existing Git repository,
- already initialized repository.

---

## Step 2 — Herdr workspace bootstrap

Implement:

- stable project identification,
- create/focus project workspace,
- workspace cwd = project root,
- two-pane layout,
- project-scoped Lead/Coder agent identifiers.

Test:

- one project,
- two simultaneous projects,
- repeat launch,
- detach and reattach.

---

## Step 3 — Start Pi processes

Ensure:

- Lead Pi starts in Lead pane,
- Coder Pi starts in Coder pane,
- both use project root cwd,
- role/project/peer identity is available to lifecycle extension,
- idle session naming is correct.

---

## Step 4 — Bootstrap role context

Implement deterministic fresh-session bootstrap:

Lead:

```text
role + protocol + project (+ handoff if any)
```

Coder:

```text
role + protocol + idle instruction
```

---

## Step 5 — Implement lifecycle extension

Implement project-local:

```text
.pi/extensions/lifecycle.ts
```

Start with:

```text
/next
/task-reset
```

Required behaviors:

- validate active task,
- validate DONE,
- validate handoff,
- Coder rotation,
- active:false update,
- Lead rotation,
- new session names,
- bootstrap contexts.

---

## Step 6 — Verify direct Herdr communication

Test:

```text
Lead → Coder prompt
Coder → Lead prompt
```

without custom `devctl`.

Test asynchronous long-running behavior.

---

## Step 7 — Manual lifecycle test

Create a trivial local task and verify:

```text
DRAFT
READY
CODING
REVIEW
DONE
/next
```

Then test:

```text
CODING
BLOCKED
CODING
REVIEW
CODING
REVIEW
DONE
/next
```

---

## Step 8 — Test session isolation

Verify:

- Coder implementation transcript does not pollute Lead context,
- old task conversation is absent after `/next`,
- handoff continuity is sufficient,
- new Coder knows role before next task,
- new Lead knows previous handoff.

---

## Step 9 — Test persistence

Verify:

- terminal detach/reattach,
- warm project reopen,
- switching between two projects,
- project command from correct current directory.

---

## Step 10 — Observe Before Adding V2

Run real tasks locally.

Only after actual usage decide whether to add:

- `devctl`,
- strict write guardrails,
- task directories/state files,
- richer cold recovery,
- Hermes notifications,
- Matt Pocock skills.

---

# 77. V1 Acceptance Criteria

The system is ready for normal local experimentation when all of the following are true:

- [ ] Running the project command inside an empty directory creates only the required agent infrastructure.
- [ ] Running it inside an existing repository does not modify application files.
- [ ] Re-running it is idempotent.
- [ ] New projects receive the current scaffold-version marker.
- [ ] Normal `dev` warns about outdated infrastructure without overwriting it.
- [ ] `dev upgrade` refuses active tasks and preserves project-owned/application files.
- [ ] `dev upgrade` backs up replaced managed files and reuses the existing workspace/panes with fresh role sessions.
- [ ] Re-running `dev upgrade` when current is a no-op.
- [ ] Each project gets a stable Herdr workspace.
- [ ] Multiple projects can coexist in Herdr.
- [ ] Project workspace has two panes: Lead and Coder.
- [ ] Both Pi processes run with the project root as cwd.
- [ ] Lead and Coder are independent Pi sessions/processes.
- [ ] Coder pane visibly shows live work.
- [ ] Lead can send Coder a Herdr prompt.
- [ ] Coder can notify Lead through Herdr.
- [ ] Long Coder work does not require Lead to remain in a long-running inference turn.
- [ ] Lead can create an Adaptive Contract+ task.
- [ ] Lead stops and summarizes when a task becomes READY.
- [ ] Only owner-invoked `/execute` transitions READY to CODING and invokes Coder.
- [ ] `/execute` rejects every state other than exactly one active READY task.
- [ ] Task state lives in YAML frontmatter.
- [ ] Coder can mark BLOCKED and REVIEW.
- [ ] Lead can send rework without resetting Coder.
- [ ] Lead can independently run tests/build/typecheck/lint.
- [ ] Lead does not write application or test source.
- [ ] Coder owns application source and tests.
- [ ] Lead creates handoff only after approval.
- [ ] `/next` refuses non-DONE tasks.
- [ ] `/next` refuses missing handoff.
- [ ] `/next` resets Coder to fresh `coder/idle`.
- [ ] `/next` resets Lead to fresh `lead/inbox`.
- [ ] `/next` leaves Herdr panes/process layout intact.
- [ ] Fresh Lead receives role + protocol + project + previous handoff.
- [ ] Fresh Coder receives role + protocol and waits idle.
- [ ] Next task start causes Coder to re-read project.md.
- [ ] Old implementation conversation is not needed for next task.
- [ ] Durable repository artifacts are sufficient to understand current workflow state.

---

# 78. Decisions Already Locked for V1

The following should be treated as settled unless local implementation reveals a concrete technical blocker:

### Architecture

- Two Pi agents: Lead and Coder.
- Coder is not a Lead subagent.
- Herdr is the persistent terminal/visibility/control layer.
- Repository filesystem is durable workflow truth.
- Git/repository is implementation truth.
- Hermes is outside the coding loop in V1.

### Sessions

- One Lead Pi process/pane.
- One Coder Pi process/pane.
- Task-scoped Pi conversation sessions.
- Same panes/processes survive task rotation.
- `/next` creates fresh Lead and Coder sessions.
- Coder is bootstrapped at `/next`, not only at task start.
- Lead reads previous handoff.
- Coder does not read previous task handoff.
- Coder re-reads current project context at new task start.

### Roles

- Lead is stronger reasoning/planning/review role.
- Coder is implementation/testing/debugging role.
- Lead may run tests.
- Lead may not write test code.
- Lead may ask Coder to add/change tests.
- Lead may not write application code.
- Coder owns source and test changes.
- Permission separation is prompt-based in V1.

### Tasks

- Adaptive Contract+.
- Coder may be less capable, so contracts must be explicit.
- Implementation freedom levels: NORMAL, DIRECTED, EXACT.
- One active implementation task at a time.
- Task state in task Markdown frontmatter.
- No state.json in V1.
- No per-task directory in V1.
- States: DRAFT, READY, CODING, BLOCKED, REVIEW, DONE.
- No REWORK state; rejected review returns to CODING.
- Task remains active:true after DONE until `/next`.
- `READY` means contract readiness, not owner authorization.
- `/execute` is the only initial implementation authorization boundary.
- No fuzzy natural-language execution aliases.

### Communication

- Hybrid protocol.
- Herdr message = signal/control.
- Files = authoritative details.
- Lead uses direct Herdr CLI in V1.
- No `devctl` yet.
- Long implementation is asynchronous; Lead does not wait for hours.

### Init

- Works in empty directory or existing repo.
- Creates missing `.agent` infrastructure.
- Automatically creates stable role/protocol/template files.
- Creates project.md placeholder.
- Does not invent roadmap or architecture.
- Does not overwrite existing files silently.
- Opens/focuses project Herdr workspace.
- Two panes, both rooted in current project directory.

### `/next`

- Implement as Pi extension.
- Project-local lifecycle extension.
- Coder rotates before Lead.
- Verify DONE + active:true.
- Verify handoff exists.
- Set active:false only as part of successful rotation.
- Fresh Coder → `coder/idle`.
- Fresh Lead → `lead/inbox`.

---

# 79. Intentionally Deferred Decisions

These are for later sessions/configuration work:

1. Exact final Lead model.
2. Exact final Coder model.
3. Pi model/provider configuration.
4. Pi tool settings and permissions.
5. Herdr configuration details beyond the required architecture.
6. Final bootstrap command name.
7. Windows vs Linux/CachyOS implementation details if different.
8. Exact cold-recovery implementation.
9. Hermes installation and Telegram workflow.
10. Hermes status/notification commands.
11. Matt Pocock skill selection.
12. Which skills belong to Lead vs Coder vs Codex CLI.
13. Codex CLI integration strategy.
14. Pi write-enforcement guardrail.
15. `devctl`.
16. task-directory/state.json migration.
17. multi-Coder/worktree support.
18. richer dashboards/status views.

---

# 80. Final Mental Model

The whole system can be summarized as:

```text
                               OWNER
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │        PI LEAD         │
                    │                        │
                    │ discuss                │
                    │ inspect                │
                    │ research               │
                    │ architect              │
                    │ write task contract    │
                    │ delegate               │
                    │ verify                 │
                    │ review                 │
                    │ handoff                │
                    │                        │
                    │ NO APP/TEST CODE       │
                    └────────────┬───────────┘
                                 │
                     short Herdr signal
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │       PI CODER         │
                    │                        │
                    │ inspect                │
                    │ implement              │
                    │ write tests            │
                    │ debug                  │
                    │ verify                 │
                    │ report                 │
                    └────────────┬───────────┘
                                 │
                     short Herdr signal
                                 │
                                 ▼
                             PI LEAD
                               review
                                 │
                         ┌───────┴────────┐
                         │                │
                       rework           approve
                         │                │
                         └── Coder        ▼
                                       DONE
                                         │
                                      handoff
                                         │
                                 owner may discuss
                                         │
                                       /next
                                         │
                      ┌──────────────────┴──────────────────┐
                      ▼                                     ▼
             fresh Lead/inbox                       fresh Coder/idle
              role + protocol                        role + protocol
             project + handoff                           idle
```

Underneath everything:

```text
Herdr
= persistent panes + live process visibility + agent signalling

Pi
= cognition and coding sessions

.agent/
= durable workflow state and cross-session memory

Git/repository
= implementation truth

Hermes (later)
= remote control, notifications, automation, research
```

That is the V1 architecture to implement and test locally before moving on to configuration tuning, Hermes integration, or skill installation.
