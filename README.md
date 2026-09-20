# Sanbi

Sanbi is a local, owner-controlled agentic development environment for **Pi** and **Herdr**. It gives each project two persistent agents—a **Lead** and a **Coder**—and keeps durable truth in repository files instead of relying on chat history.

The repository includes everything needed to reproduce the intended workstation setup:

```text
sanbi/
├── sanbi/         # CLI package, project scaffold, runtime extensions, and tests
├── pi_config/     # Portable global Pi configuration
├── herdr_config/  # Portable global Herdr configuration
├── scripts/       # Safe installer implementation
├── install.sh     # Direct Git Bash installer
└── Makefile       # install, update, test, and check shortcuts
```

Sanbi is designed around a simple boundary: **the owner authorizes planning and execution; agents perform the work inside those explicit boundaries.**

## What Sanbi provides

- One persistent Lead Pi process and one persistent Coder Pi process per project.
- A deterministic task lifecycle stored under `.agent/`.
- Explicit owner gates for specifications, tickets, tasks, and execution.
- Optional durable multi-task initiatives.
- Role-specific planning, TDD, diagnosis, design, and review skills.
- Isolated, application-non-writing specialist subagents with bounded results.
- Safe Lead↔Coder signaling through Herdr.
- Git-aware review with a quiet non-Git fallback.
- Owned OS-temp resources and process-tree cleanup for dev servers and browser tooling.
- Reproducible global Pi and Herdr configuration without copying credentials or runtime history.

## Requirements

The supported environment is:

- Windows with Git Bash
- Node.js 20 or newer
- npm
- Pi 0.85.1
- Herdr 0.9.x with Pi integration installed
- `make` for the Makefile shortcuts, or use `./install.sh` directly

Confirm Herdr's Pi integration before installing:

```bash
herdr integration status
```

Authentication is intentionally not stored in this repository. Configure Pi/provider authentication and any web-provider credentials through their normal mechanisms.

## Install

Clone the repository, then run from its root:

```bash
make install
```

If `make` is unavailable:

```bash
./install.sh
```

The installer:

1. Links `sanbi/` globally with `npm link`.
2. Makes the `sanbi` command available from npm's global executable directory.
3. Adds that directory to the Windows user `PATH` when it is missing.
4. Installs the managed files from `pi_config/` into `~/.pi/agent/`.
5. Installs `herdr_config/config.toml` into `%APPDATA%/herdr/config.toml`.
6. Backs up every changed destination before replacing it.
7. Leaves unrelated global files untouched.

If PATH changes, open a new terminal. Restart Pi and apply the Herdr configuration with:

```bash
herdr server reload-config
```

Verify installation:

```bash
sanbi --help
```

### Preview installation

To show what would change without writing files or linking the package:

```bash
make dry-run
# or
./install.sh --dry-run
```

### Update an existing installation

Pull the latest repository changes and rerun:

```bash
make update
```

`make update` is intentionally the same safe, idempotent operation as installation. Unchanged configuration files are skipped. Replaced files are backed up under:

```text
~/.pi/agent/.sanbi-backups/<timestamp>/
```

The installer manages only the explicitly vendored files. It does **not** delete unrelated extensions, agents, skills, credentials, sessions, trust decisions, logs, sockets, caches, or Herdr workspaces. Managed web-search routing is deep-merged so existing local provider keys and other non-vendored fields survive updates.

## Global configuration included

### Pi

`pi_config/` contains the portable portion of the workstation's Pi configuration:

```text
pi_config/
├── settings.json
├── keybindings.json
├── web-search.json
├── agents/
│   ├── diagnostic-scout.md
│   ├── researcher.md
│   ├── reviewer.md
│   └── scout.md
├── extensions/
│   ├── codex-usage.ts
│   ├── subagent-toggle.ts
│   └── pi-footer.json
└── tests/
    └── codex-usage.test.ts
```

This config supplies:

- Catppuccin Mocha styling.
- Fullscreen Pi behavior and compact startup.
- Enter-to-submit and Shift+Enter/Ctrl+J newline bindings.
- `pi-ask-user`, `pi-web-access`, `pi-footer`, Catppuccin, and optional global subagent packages.
- OpenAI/Exa web-search routing and fallback behavior.
- A two-line footer with model, thinking, context, path, Git, and token information.
- Codex usage reporting.
- The persistent global subagent toggle.
- The Scout, Researcher, Reviewer, and Diagnostic Scout specialist definitions.

The repository deliberately excludes `auth.json`, sessions, trust data, package caches, generated model stores, downloaded binaries, and Herdr's generated Pi integration extension.

### Herdr

`herdr_config/config.toml` supplies the Sanbi-oriented Herdr experience:

- Catppuccin theme.
- A compact two-pane presentation.
- Priority-sorted agent status in the sidebar.
- Persistent Pi-session resume after Herdr restart.
- Windows system notifications and Pi completion sounds.
- `Ctrl+B` prefix bindings and direct `Ctrl+Alt+H/J/K/L` pane navigation.
- Hidden single-tab bar and useful workspace/pane titles.
- No forced shell override.
- No persisted terminal screen-history replay.

Runtime state, sockets, logs, session history, lock files, and backup files are not vendored.

## Start Sanbi in a project

From any project directory:

```bash
sanbi
```

Or name a project explicitly:

```bash
sanbi --project C:/path/to/project
```

On first adoption Sanbi:

- Creates missing `.agent/` project infrastructure.
- Saves Pi trust for the project.
- Creates or recovers a Herdr workspace.
- Starts the persistent Lead and Coder Pi processes.
- Focuses the workspace and attaches Herdr when appropriate.

Normal startup is non-destructive. It never replaces existing managed infrastructure merely because a newer scaffold exists.

Current changed model defaults:

- Coder: `openai-codex/gpt-5.6-luna` with `xhigh` thinking.
- Researcher: `openai-codex/gpt-5.6-luna` with `high` thinking.

Useful CLI options:

| Option | Purpose |
| --- | --- |
| `--project <path>` | Adopt a path instead of the current directory. |
| `--no-attach` | Prepare/focus Herdr without attaching its TUI. |
| `--init-only` | Create project files and trust without runtime state. |
| `--session <name>` | Use an isolated Herdr session, primarily for testing. |
| `--no-agents` | Prepare panes without starting Pi. |

For local CLI development without a global link:

```bash
npm --prefix sanbi run sanbi -- --project C:/path/to/project
```

## How the workflow works

```text
                     task contract
Owner ⇄ Lead ─────────────────────────→ Coder
          ↑                              │
          └──── result / review / block ─┘
```

### Lead

Lead owns planning, clarification, task contracts, initiative state, review, rework decisions, handoffs, and final completion. Lead cannot write application or test source.

### Coder

Coder owns implementation, tests, verification, and task result reports after explicit execution authorization. Coder cannot create planning decisions or mark work `DONE`.

### Durable state

Each adopted project contains:

```text
.agent/
├── project.md
├── protocol.md
├── config.json
├── initiatives/       # optional I-xxx plans and Work Maps
├── tasks/             # executable T-xxx contracts
├── results/           # Coder evidence
├── reviews/           # Lead review rounds
├── handoffs/          # final continuation context
├── roles/
├── skills/
└── subagents/
```

Filesystem artifacts—not a model's memory—are authoritative.

## Lifecycle and owner gates

The implementation lifecycle is:

```text
DRAFT → READY → CODING → BLOCKED / REVIEW → DONE
```

Only one implementation task may be active at a time.

| Command | Authority and effect |
| --- | --- |
| `/to-spec` | Owner-approved creation of one initiative specification. |
| `/to-tickets` | Owner-approved Work Map decomposition; does not create tasks. |
| `/to-task` | Creates exactly one approved, right-sized `READY` task. |
| `/execute` | The only initial `READY → CODING` authorization gate. |
| `/next` | Archives/rotates a completed active task and starts fresh role sessions. |

Discussion, grilling, or ordinary agreement never substitutes for one of these commands.

### Small change

```text
discussion
→ optional grilling
→ /to-task
→ approve one compact task
→ READY
→ /execute
→ CODING
→ REVIEW
→ DONE
→ /next
```

### Multi-task initiative

```text
discussion
→ /grill-with-docs
→ /to-spec
→ approve initiative
→ /to-tickets
→ approve Work Map
→ select one unblocked PLANNED item
→ /to-task
→ approve one linked task
→ /execute
→ implementation and review
→ repeat one item at a time
```

Work Map items remain `PLANNED` until `/to-task` creates and links a real task. Sanbi never bulk-creates future tasks.

### Blocked work and rework

Coder may transition `CODING → BLOCKED` when owner or Lead input is genuinely required. Once resolved, Lead signals continuation without creating a new task.

Coder transitions successful work to `REVIEW`. Material findings return the same task to `CODING`; there is intentionally no separate `REWORK` state. Only Lead may approve `REVIEW → DONE`.

## Skills

Sanbi installs role-scoped Agent Skills into each adopted project. Pi receives them additively, so normal global Pi skills remain available.

### Lead skills

| Skill | Purpose | Invocation |
| --- | --- | --- |
| `grilling` | Clarifies dependency-ready decisions and classifies work as standalone or initiative-sized. | Automatic when useful |
| `grill-with-docs` | Performs project-aware grilling and captures durable domain/ADR context. | Owner-only |
| `grill-me` | Runs a stateless interview without writing project artifacts. | Owner-only |
| `wait-what` | Re-explains the previous answer without silently changing the decision. | Owner-only |
| `to-questionnaire` | Builds a stakeholder questionnaire for an unresolved knowledge gap. | Owner-only |
| `domain-modeling` | Establishes domain vocabulary in `CONTEXT.md` and qualifying decisions in ADRs. | Automatic when useful |
| `writing-for-agents` | Improves agent-facing instructions, context structure, and operational clarity. | Automatic when useful |
| `to-spec` | Proposes and creates one explicitly approved initiative. | Owner-only |
| `to-tickets` | Proposes and creates an approved initiative Work Map without creating tasks. | Owner-only |
| `to-task` | Proposes and creates exactly one approved `READY` task. | Owner-only |
| `code-review` | Reviews Contract and Standards axes, using independent reviewers before targeted Lead inspection. | Automatic in review |
| `retro` | Produces an evidence-based workflow retrospective and recommendations. | Owner-only |

The installed Ask UI accepts one question per call, so grilling asks one focused frontier question at a time. If a future verified Ask schema supports native multi-question input, only independent questions from the current dependency frontier may be batched.

### Coder skills

| Skill | Purpose |
| --- | --- |
| `tdd` | Enforces focused expected RED → minimal GREEN slices for behavioral work, followed by final verification. |
| `diagnosing-bugs` | Uses reproduction, falsifiable hypotheses, evidence, minimal repair, and regression proof. |

TDD is required only where a meaningful behavioral test seam exists. Configuration, generated scaffolding, mechanical moves, environment repair, and similar non-behavioral work require an explicit “not applicable” reason instead of meaningless tests.

### Shared skill

| Skill | Purpose |
| --- | --- |
| `codebase-design` | Encourages deep modules, narrow interfaces, good seams, adapters, and testable boundaries. |

Supporting references for domain formats, writing mechanics, design deepening, test design, and mocking live beside their owning skills.

## Acknowledgements

Sanbi's skill system was strongly inspired by and adapted from [Matt Pocock's `mattpocock/skills` project](https://github.com/mattpocock/skills). In particular, Sanbi adapts `grilling`, `grill-with-docs`, `grill-me`, `wait-what`, `to-questionnaire`, `domain-modeling`, `writing-for-agents`, `to-spec`, `to-tickets`, `code-review`, `retro`, `codebase-design`, `tdd`, and `diagnosing-bugs` from Matt's work.

Those skills were modified to fit Sanbi's persistent Lead/Coder roles, owner-controlled transitions, filesystem-backed task and initiative lifecycle, BLOCKED/REVIEW flow, specialist boundaries, and local Work Maps. For example, `to-tickets` creates an initiative-local Work Map instead of publishing tracker tickets, while TDD and diagnosis route decisions through Sanbi's task and Lead authority. Sanbi's `to-task` transition is project-specific and connects the adapted planning skills to the explicit `READY → /execute` authorization boundary.

The adapted material is based on [`mattpocock/skills` commit `3cca18b`](https://github.com/mattpocock/skills/commit/3cca18b368ae95cdbdebbff572ccafa662551015) and is used under the MIT License. The full copyright notice and license are preserved in [`sanbi/scaffold/.agent/skills/LICENSE.mattpocock`](sanbi/scaffold/.agent/skills/LICENSE.mattpocock). Thank you to Matt Pocock for publishing the original skills and ideas openly.

## Specialist subagents

Herdr owns only the persistent Lead and Coder panes. Each parent Pi may create isolated specialist sessions internally:

| Available to | Specialist | Model | Thinking | Responsibility |
| --- | --- | --- | --- | --- |
| Lead/Coder | `scout` | GPT-5.6 Luna | medium | Fast repository reconnaissance. |
| Lead/Coder | `researcher` | GPT-5.6 Terra | medium | Current external technical research with sources. |
| Lead | `reviewer` | GPT-5.6 Sol | high | Independent Contract or Standards review axis. |
| Coder | `diagnostic-scout` | GPT-5.6 Sol | medium | Failure reproduction and root-cause investigation. |

Specialists:

- Start with fresh context rather than cloned parent transcripts.
- Receive explicit files, symbols, claims, or questions.
- Have separate persisted child sessions.
- Do not receive Pi `write` or `edit`, cannot control lifecycle state, and cannot recursively delegate.
- Reviewer and Diagnostic Scout retain `bash` for verification and reproduction; this is an instruction-enforced non-writing boundary, not an operating-system sandbox.
- Return one bounded final result to the parent.
- Are limited to three concurrent children per parent.

Use:

```text
/subagents
/subagents on
/subagents off
/subagents toggle
/subagents status
```

The dashboard shows semantic activity such as `READ`, `FIND`, `RUN`, `SEARCH`, and `FETCH` without additional model calls. Press `d` for raw details, `p` for the delegated prompt, and `x` to cancel a running specialist.

## Models

Newly adopted projects default to:

```json
{
  "roles": {
    "lead": { "model": "openai-codex/gpt-5.6-sol", "thinking": "high" },
    "coder": { "model": "openai-codex/gpt-5.6-sol", "thinking": "low" }
  }
}
```

These values are project-local in `.agent/config.json`. Setting a model to `null` uses Pi's configured default. Changes apply when that role process next starts; reopening a warm workspace preserves the already-running process.

## Safe runtime behavior

### Lead↔Coder signaling

Lifecycle messages use Sanbi-native semantic tools. Agents do not need to discover or reason about Herdr CLI syntax:

```text
sanbi_signal_coder({ kind: "continue" | "rework", task: "T-xxx" })
sanbi_signal_lead({ kind: "blocked" | "review", task: "T-xxx" })
```

Herdr remains the transport. State changes are serialized and rollback is guarded when signaling fails.

### Git and non-Git projects

Sanbi probes Git capability once per parent process. It never runs `git init`. Non-Git projects receive one concise warning and review falls back to task-relevant current files without repeated Git failures or Git help output.

### Runtime temp

Disposable browser profiles, screenshots, traces, and logs live under the OS temp directory, normally:

```text
%TEMP%/sanbi/<project-key>/
```

They are never created directly under durable `.agent/`. Cleanup requires a positive Sanbi ownership marker.

### Owned runtime processes

Task-local Vite, preview, browser-companion, and similar servers use `sanbi_runtime_process`, which provides:

- Opaque ownership handles instead of arbitrary PID input.
- Explicit port preflight.
- Bounded HTTP/output readiness checks.
- OS-temp logs and diagnostics.
- Windows descendant-tree termination with `taskkill /T`.
- POSIX process-group termination with TERM→KILL fallback.
- Shutdown cleanup before runtime-temp cleanup.

This prevents completed work from leaving task-local Node/Vite process trees behind.

## Upgrade adopted projects

Installing a newer global Sanbi command does not silently mutate existing adopted projects. When no task is active and Lead/Coder are idle, run from a normal terminal:

```bash
cd C:/path/to/project
sanbi upgrade
```

Upgrade:

- Refuses while any task has `active: true`.
- Has no force bypass.
- Backs up replaced managed files under `.agent/upgrade-backups/`.
- Replaces only Sanbi-managed protocol, roles, templates, skills, subagents, and extensions.
- Preserves project context, initiatives, tasks, results, reviews, handoffs, ADRs, source, and tests.
- Restarts both persistent role sessions only when migration actually changes infrastructure.

Running `sanbi upgrade` when already current is a no-op.

## Development

Run the fast test suite from the repository root:

```bash
make test
# or
npm --prefix sanbi test
```

Run the isolated real Pi/Herdr integration suite:

```bash
make test-integration
# or
npm --prefix sanbi run test:integration
```

Run tests plus whitespace validation:

```bash
make check
```

The integration suite creates temporary projects and a unique Herdr session. It does not touch the default Herdr session.

Architecture details are documented in [`sanbi/local_agentic_development_v1_architecture.md`](sanbi/local_agentic_development_v1_architecture.md).

## Security and ownership boundaries

The repository intentionally does not contain:

- Pi authentication or provider tokens.
- Conversation/session history.
- Machine trust decisions.
- Runtime logs, caches, sockets, or current Herdr session state.
- Generated Herdr Pi integration code.

The installer backs up and replaces only declared managed files. Sanbi cleanup deletes only positively identified Sanbi-owned paths and processes. Application code, tests, project artifacts, and unrelated global configuration remain outside installer ownership.

## Portable Hermes, Telegram, and Sanbi integration

The `hermes/` directory vendors the complete `sanbi-readonly` plugin and its tests, plus credential-free setup examples:

```text
hermes/
├── .env.example
├── sanbi/projects.example.json
└── plugins/sanbi-readonly/
    ├── plugin.yaml
    ├── __init__.py
    ├── core.py
    ├── bridge.py
    ├── plugin.py
    └── tests/
```

A normal `make install` or `./install.sh` now provisions Pi, Herdr, Sanbi, and Hermes. If Hermes is absent on native Windows, the installer uses Nous Research's official PowerShell installer with `-SkipSetup`. It copies only the vendored plugin, runs Plugin Doctor, and enables `sanbi-readonly` without tool-override permission. Existing Hermes configuration, provider credentials, auth, sessions, memories, logs, caches, plugins, and unrelated files are not replaced.

The installer creates an empty `%LOCALAPPDATA%/hermes/sanbi/projects.json` only when no registry exists. Registering a project is explicit; set both variables before installation:

```bash
export HERMES_SANBI_PROJECT_ALIAS='my-project'
export HERMES_SANBI_PROJECT_PATH='C:/absolute/path/to/project'
./install.sh
```

No workstation-specific project path is included in this repository. Existing registry entries are preserved and the explicit alias is merged.

### Telegram credentials

Create a bot with Telegram's `@BotFather`, determine the permitted Telegram user ID, and provide both values through the process environment. Do not place real values in this repository:

```bash
export HERMES_TELEGRAM_BOT_TOKEN='set-at-install-time'
export HERMES_TELEGRAM_ALLOWED_USERS='123456789'
./install.sh
```

The values are written to Hermes' local `.env` without being printed. If either Telegram key already exists there, the installer preserves the existing local values rather than overwriting credentials. You can instead configure Telegram after installation with the Hermes dashboard or `hermes gateway setup`.

Gateway lifecycle changes are opt-in. The installer does not start, restart, or install a gateway unless Telegram is configured and `HERMES_GATEWAY_MANAGE=1` is set. With that explicit opt-in it installs/starts an absent gateway or restarts an existing one, then runs `hermes gateway status --deep`:

```bash
export HERMES_GATEWAY_MANAGE=1
./install.sh
```

Preview all managed changes safely with `make dry-run`. The dry run never installs Hermes, invokes Hermes, writes credentials, changes plugin state, or touches the gateway.

Hermes plugin tests are included in the default `make test` target. Run them separately with `make test-hermes`. Real secrets, auth files, project registries, sessions, runtime history, logs, caches, backups, and `__pycache__` are intentionally excluded.

### Managed Hermes settings

`hermes/managed-config.json` is the credential-free, portable manifest for the Hermes settings this repository owns. The installer applies each dotted key with the official `hermes config set KEY VALUE` command after Hermes is available and before plugin validation, enablement, or gateway management. This updates only the declared keys; unrelated `config.yaml` fields, `.env`, `auth.json`, OAuth credentials, and other local state remain outside repository ownership.

The managed settings select the existing `gpt-5.6-luna` model on the `openai-codex` provider, low reasoning effort, a 500-turn limit, the local terminal backend, trusted gateway environment loading, and the standard gateway loop/startup watchdog values. Plugin state remains explicit: the installer enables `sanbi-readonly` with tool override disabled and does not disable or replace other plugins such as `herdr-agent-state`.

Provider authentication is never copied or automated by this repository. Complete the normal OpenAI Codex OAuth flow manually after installation when needed:

```bash
hermes auth add openai-codex
```

`--dry-run` reads the manifest and prints every intended `hermes config set` operation, but it does not invoke Hermes or write any Hermes files.

## Hermes dynamic workspace discovery

The vendored `sanbi-readonly` plugin is version 4.0.0 and includes the complete Hermes integration used by this workstation: deterministic Sanbi status, sentinel-bound Lead conversation, lazy runtime activation, `/execute`, `/next`, `/to-task`, `/to-task-approve`, Telegram routing, and dynamic project discovery from trusted workspace roots.

A normal `make install`, `make update`, or `./install.sh` installs this plugin, applies the credential-free settings in `hermes/managed-config.json`, enables the plugin without tool-override permission, and merges the trusted workspace configuration into Hermes' existing `sanbi/projects.json`. Existing explicit aliases and unrelated Hermes state are preserved.

By default, the parent directory containing this setup repository becomes a trusted workspace root. With the common layout:

```text
Workspace/
├── setup/
├── 2dweb/
├── voxveil/
└── newgame/
```

Hermes discovers `setup`, `2dweb`, `voxveil`, and `newgame` automatically as project aliases. Discovery is fresh and read-only on every relevant request, examines direct child directories only, and does not use a cache, watcher, cron job, or background scanner. A directory does not need `.agent`, `.pi`, Git, or a package manifest to be listed. Sanbi initialization occurs only when the owner explicitly performs an operation such as `/lead`; listing and status commands never initialize or activate a project.

Override or extend the trusted roots at installation time with a JSON array of absolute paths:

```bash
export HERMES_SANBI_WORKSPACE_ROOTS='["C:/Users/me/Workspace","D:/Projects"]'
./install.sh
```

Existing roots are preserved and duplicates are removed using Windows-compatible case-insensitive path normalization. Explicit aliases remain optional and take precedence over dynamically discovered basenames:

```bash
export HERMES_SANBI_PROJECT_ALIAS='special-game'
export HERMES_SANBI_PROJECT_PATH='D:/Repos/actual-game'
./install.sh
```

Dynamic aliases are directory basenames and resolve case-insensitively on Windows while preserving filesystem casing for display. Multiple roots exposing the same basename fail closed as ambiguous. Raw paths, traversal components, absolute paths, UNC paths, and aliases containing path separators are rejected. Resolved dynamic project and `.agent` paths must remain contained within the trusted workspace root; escaping symlinks or junctions are not exposed.

Directories with spaces are addressable with quotes:

```text
/projects
/project "My Project"
/lead "My Project" inspect this directory
```

The concise project list reports only initialization classification, based on `.agent/config.json`; it does not perform an expensive runtime join for every directory. An uninitialized status is deterministic:

```text
Project: newgame
Path: C:\Users\me\Workspace\newgame
Sanbi: not initialized
Runtime: offline
```

Use these Hermes-only shortcuts when Pi, Herdr, and the global `sanbi` executable are already installed:

```bash
make dry-run-hermes
make install-hermes
```

Telegram credentials remain install-time secrets and are never stored in the repository. Gateway lifecycle management also remains explicit:

```bash
export HERMES_TELEGRAM_BOT_TOKEN='set-at-install-time'
export HERMES_TELEGRAM_ALLOWED_USERS='123456789'
export HERMES_GATEWAY_MANAGE=1
make install
```

The installer hides credential values, preserves existing credentials, validates the plugin with Plugin Doctor, and starts or restarts the gateway only when `HERMES_GATEWAY_MANAGE=1` is supplied. If a registry schema update is required while a gateway is already running, installation fails before changing the registry unless gateway management is explicitly enabled; this prevents an older in-memory plugin from being broken by the new schema. Provider OAuth remains a separate manual step.
