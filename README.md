# Local Agentic Development V1

Reusable Windows + Git Bash bootstrap application for the two-agent Pi/Herdr workflow described in [`local_agentic_development_v1_architecture.md`](local_agentic_development_v1_architecture.md).

## Requirements

- Windows with Git Bash
- Node.js 20+
- Pi
- Herdr 0.9.x with its Pi integration installed

Verify the integration with:

```bash
herdr integration status
```

## Install the command

From this source repository:

```bash
npm link
```

Then open or adopt any project from its root:

```bash
sanbi
```

Upgrade an already-adopted project explicitly with:

```bash
sanbi upgrade
```

For development without linking globally:

```bash
npm run sanbi -- --project C:/path/to/project
```

The command creates missing infrastructure, saves Pi trust for the adopted project, creates or recovers its workspace in the default Herdr session, starts its Lead and Coder Pi processes, focuses the workspace, and attaches Herdr when called outside Herdr. It does not overwrite existing infrastructure files. New projects receive `.agent/scaffold-version`; legacy projects are opened unchanged with an upgrade warning.

Useful development options:

```text
--project <path>   Adopt this path instead of the current directory
--no-attach       Prepare/focus Herdr without attaching its TUI
--init-only       Create files and Pi trust without creating runtime state
--session <name>  Use an isolated Herdr session (testing only)
--no-agents       Prepare panes without starting Pi (testing/debugging)
```

## Explicit infrastructure upgrades

Normal `sanbi` startup never replaces existing infrastructure. To explicitly migrate an adopted project when no task is active:

```bash
sanbi upgrade
```

`sanbi upgrade` compares the installed scaffold with the current canonical managed files, backs up changed existing files under `.agent/upgrade-backups/`, installs the canonical files, updates `.agent/scaffold-version`, and restarts both Pi roles with fresh `lead/inbox` and `coder/idle` sessions in the existing panes. Run it from a normal terminal outside those managed Pi panes so they can exit safely. It refuses while any task has `active: true` and has no force option.

Managed files are the protocol, Lead/Coder roles, templates, and lifecycle extension. Project context, task/result/review/handoff artifacts, and application files are never overwritten. Running the command when already current is a no-op and does not restart sessions.

## Role models

Each adopted project gets `.agent/config.json`. Lead and Coder settings are independent:

```json
{
  "roles": {
    "lead": { "model": "openai-codex/gpt-5.6-sol", "thinking": "high" },
    "coder": { "model": "openai-codex/gpt-5.6-sol", "thinking": "low" }
  }
}
```

The V1 defaults are GPT-5.6 Sol with high thinking for Lead and low thinking for Coder. Replace either value with another exact Pi model ID when needed. Setting `model` to `null` uses Pi's configured default. The thinking values accepted by Pi are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Configuration changes apply when that role's Pi process is next started; warm reopen deliberately preserves the running process.

## Lifecycle

The generated `.pi/extensions/lifecycle.ts` provides:

- `/execute` — owner authorization gate that transitions the one active `READY` task to `CODING` and signals Coder exactly once.
- `/next` — Lead-only validation and rotation of a `DONE`, active task with a handoff.
- `/task-reset <task-id> <nonce>` — internal Coder reset used by `/next`.

A Lead must stop after preparing and summarizing a `READY` task. Only the owner invoking `/execute` starts initial implementation. `/execute` writes `CODING` before signalling so Coder always reads an authorized state, and rolls back to `READY` if Herdr rejects the invocation. It does not wait for implementation.

When Coder settles after transitioning the active task to `BLOCKED` or `REVIEW`, the lifecycle extension automatically sends the canonical Herdr notification to Lead. This does not depend on Coder discovering a model-callable Herdr tool.

`/next` resets Coder first, waits for an acknowledgement, atomically changes the task to `active: false`, and finally creates a fresh Lead session. Panes and Pi processes remain in place.

Herdr agent names use a sanitized, truncated folder name plus an eight-character path hash. They remain within Herdr's 32-character limit while avoiding collisions between same-named directories.

## Tests

Fast filesystem/unit tests:

```bash
npm test
```

Isolated real Herdr/Pi integration test:

```bash
npm run test:integration
```

The integration test creates temporary projects and a unique named Herdr session, then removes both. It exercises empty and existing projects, upgrade warnings and preservation, active-task refusal, backup migration, fresh-session restart in reused panes, upgrade idempotence, multiple workspaces, `/execute` validation and delegation, Lead-to-Coder lifecycle signalling, and `/next` session rotation. It does not touch the default Herdr session.
