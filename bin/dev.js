#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { adoptProject, CURRENT_SCAFFOLD_VERSION, upgradeProject } from "../src/scaffold.js";
import { assertRuntimeUpgradeSafe, attachHerdr, ensureProjectRuntime, restartProjectRuntime } from "../src/herdr.js";
import { trustProject } from "../src/trust.js";

function usage() {
  console.log(`Usage: dev [upgrade] [options]\n\nAdopt/open a project, or explicitly upgrade its managed agent infrastructure.\n\nCommands:\n  upgrade            Back up and upgrade managed infrastructure when no task is active\n\nOptions:\n  --project <path>   Project root (default: current directory)\n  --session <name>  Herdr session (default: default; intended for tests)\n  --no-attach       Do not open/attach the Herdr TUI\n  --no-agents       Create/recover panes without starting Pi (test/debug)\n  --init-only       Create missing project files only\n  -h, --help        Show this help`);
}

function parse(argv) {
  const options = { command: "open", project: process.cwd(), session: "default", attach: true, noAgents: false, initOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "upgrade" && index === 0) { options.command = "upgrade"; continue; }
    if (value === "-h" || value === "--help") return { help: true };
    if (value === "--no-attach") options.attach = false;
    else if (value === "--no-agents") options.noAgents = true;
    else if (value === "--init-only") options.initOnly = true;
    else if (value === "--project" || value === "--session") {
      const next = argv[++index];
      if (!next) throw new Error(`${value} requires a value`);
      if (value === "--project") options.project = path.resolve(next);
      else options.session = next;
    } else throw new Error(`unknown option: ${value}`);
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.help) { usage(); process.exit(0); }
  let adopted;
  let runtime;
  if (options.command === "upgrade") {
    if (options.initOnly || options.noAgents) throw new Error("--init-only and --no-agents are not valid with dev upgrade");
    const result = await upgradeProject(options.project, {
      beforeApply: (project) => assertRuntimeUpgradeSafe(project, options),
    });
    adopted = result;
    await trustProject(adopted.root);
    if (result.changed) {
      console.log(`Upgraded agent infrastructure: ${result.installedVersion} -> ${result.currentVersion}`);
      console.log(`Updated ${result.replacements.length} managed file(s).`);
      if (result.backupDirectory) console.log(`Backup: ${result.backupDirectory}`);
      runtime = await restartProjectRuntime(adopted, options);
      console.log("Lead and Coder restarted with fresh role context.");
    } else {
      console.log(`Agent infrastructure is already current (version ${CURRENT_SCAFFOLD_VERSION}).`);
      runtime = await ensureProjectRuntime(adopted, options);
    }
  } else {
    adopted = await adoptProject(options.project);
    console.log(adopted.created.length ? `Created ${adopted.created.length} missing infrastructure file(s).` : "Agent infrastructure preserved; no existing files were overwritten.");
    console.log(`Project: ${adopted.root}\nKey: ${adopted.config.project.key}`);
    if (adopted.updateAvailable) {
      console.log(`Agent infrastructure update available.\nInstalled: ${adopted.installedVersion}\nCurrent: ${CURRENT_SCAFFOLD_VERSION}\n\nRun \`dev upgrade\` from the project root to migrate.`);
    }
    await trustProject(adopted.root);
    if (!options.initOnly) runtime = await ensureProjectRuntime(adopted, options);
  }
  if (runtime) {
    console.log(`Herdr ${runtime.session}: workspace ${runtime.workspaceId}, Lead ${runtime.leadPaneId}, Coder ${runtime.coderPaneId}`);
    const insideHerdr = process.env.HERDR_ENV === "1";
    if (options.attach && !insideHerdr) attachHerdr(options.session);
  }
} catch (error) {
  console.error(`dev: ${error.message}`);
  process.exit(1);
}
