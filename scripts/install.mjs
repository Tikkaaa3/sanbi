#!/usr/bin/env node

import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const packageRoot = path.join(repositoryRoot, "sanbi");
const dryRun = process.argv.includes("--dry-run");
const skipLink = process.argv.includes("--skip-link");
const skipConfig = process.argv.includes("--skip-config");
const skipHermes = process.argv.includes("--skip-hermes");

const piRoot = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const herdrRoot = process.env.HERDR_CONFIG_DIR || (process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "herdr")
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr"));
const hermesRoot = process.env.HERMES_HOME || (process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes")
  : path.join(os.homedir(), ".hermes"));
const hermesPluginSource = path.join(repositoryRoot, "hermes", "plugins", "sanbi-readonly");
const hermesPluginDestination = path.join(hermesRoot, "plugins", "sanbi-readonly");
const hermesManagedConfig = path.join(repositoryRoot, "hermes", "managed-config.json");
const hermesCommandPrefix = process.env.HERMES_COMMAND_PREFIX ? [process.env.HERMES_COMMAND_PREFIX] : [];

const managed = [
  ["pi_config/settings.json", piRoot, "settings.json"],
  ["pi_config/keybindings.json", piRoot, "keybindings.json"],
  ["pi_config/web-search.json", piRoot, "web-search.json", "merge-json"],
  ["pi_config/extensions/codex-usage.ts", piRoot, "extensions/codex-usage.ts"],
  ["pi_config/extensions/subagent-toggle.ts", piRoot, "extensions/subagent-toggle.ts"],
  ["pi_config/extensions/pi-footer.json", piRoot, "extensions/pi-footer.json"],
  ["pi_config/agents/diagnostic-scout.md", piRoot, "agents/diagnostic-scout.md"],
  ["pi_config/agents/researcher.md", piRoot, "agents/researcher.md"],
  ["pi_config/agents/reviewer.md", piRoot, "agents/reviewer.md"],
  ["pi_config/agents/scout.md", piRoot, "agents/scout.md"],
  ["pi_config/tests/codex-usage.test.ts", piRoot, "tests/codex-usage.test.ts"],
  ["herdr_config/config.toml", herdrRoot, "config.toml"],
];

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
let changed = 0;
let planned = 0;
let backupRoot = null;

async function exists(target) {
  try { await access(target, constants.F_OK); return true; } catch { return false; }
}

function deepMerge(existing, managed) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing) || !managed || typeof managed !== "object" || Array.isArray(managed)) return managed;
  const merged = { ...existing };
  for (const [key, value] of Object.entries(managed)) merged[key] = deepMerge(existing[key], value);
  return merged;
}

async function installManagedFile(sourceRelative, destinationRoot, destinationRelative, mode = "replace") {
  const source = path.join(repositoryRoot, sourceRelative);
  const destination = path.join(destinationRoot, destinationRelative);
  if (!await exists(source)) throw new Error(`missing repository configuration: ${sourceRelative}`);
  let desired = await readFile(source);
  if (mode === "merge-json" && await exists(destination)) {
    const existing = JSON.parse(await readFile(destination, "utf8"));
    const managedValue = JSON.parse(desired.toString("utf8"));
    desired = Buffer.from(`${JSON.stringify(deepMerge(existing, managedValue), null, 2)}\n`);
  }
  if (await exists(destination) && createHash("sha256").update(desired).digest("hex") === createHash("sha256").update(await readFile(destination)).digest("hex")) {
    console.log(`unchanged  ${destination}`);
    return;
  }

  console.log(`${dryRun ? "would set" : "install"}  ${destination}`);
  planned += 1;
  if (dryRun) return;

  if (await exists(destination)) {
    const kind = destinationRoot === piRoot ? "pi" : "herdr";
    backupRoot ||= path.join(piRoot, ".sanbi-backups", timestamp);
    const backup = path.join(backupRoot, kind, destinationRelative);
    await mkdir(path.dirname(backup), { recursive: true });
    await copyFile(destination, backup);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.sanbi-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, desired);
  await rename(temporary, destination);
  changed += 1;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe", windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function tryRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe", windowsHide: true });
  return result.error ? null : result;
}

async function filesBelow(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function installHermesPlugin() {
  if (!await exists(hermesPluginSource)) throw new Error("missing repository Hermes plugin");
  console.log(`${dryRun ? "would install" : "install"} Hermes plugin ${hermesPluginDestination}`);
  if (dryRun) return;
  for (const relative of await filesBelow(hermesPluginSource)) {
    const source = path.join(hermesPluginSource, relative);
    const destination = path.join(hermesPluginDestination, relative);
    const desired = await readFile(source);
    if (await exists(destination) && createHash("sha256").update(desired).digest("hex") === createHash("sha256").update(await readFile(destination)).digest("hex")) continue;
    if (await exists(destination)) {
      backupRoot ||= path.join(piRoot, ".sanbi-backups", timestamp);
      const backup = path.join(backupRoot, "hermes", "plugins", "sanbi-readonly", relative);
      await mkdir(path.dirname(backup), { recursive: true });
      await copyFile(destination, backup);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    changed += 1;
  }
}

async function configureRegistry(command) {
  const registry = path.join(hermesRoot, "sanbi", "projects.json");
  let value = { workspace_roots: [], projects: {} };
  if (await exists(registry)) value = JSON.parse(await readFile(registry, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hermes Sanbi registry must be an object");
  if (value.workspace_roots === undefined) value.workspace_roots = [];
  if (!Array.isArray(value.workspace_roots) || !value.workspace_roots.every((entry) => typeof entry === "string" && path.isAbsolute(entry))) {
    throw new Error("Hermes Sanbi registry workspace_roots must be a list of absolute paths");
  }
  if (!value.projects || typeof value.projects !== "object" || Array.isArray(value.projects)) {
    throw new Error("Hermes Sanbi registry projects must be an object");
  }

  const rawRoots = process.env.HERMES_SANBI_WORKSPACE_ROOTS;
  let requestedRoots = [path.dirname(repositoryRoot)];
  if (rawRoots !== undefined) {
    try { requestedRoots = JSON.parse(rawRoots); } catch { throw new Error("HERMES_SANBI_WORKSPACE_ROOTS must be a JSON array of absolute paths"); }
    if (!Array.isArray(requestedRoots)) throw new Error("HERMES_SANBI_WORKSPACE_ROOTS must be a JSON array of absolute paths");
  }
  if (!requestedRoots.every((entry) => typeof entry === "string" && entry.trim() && path.isAbsolute(entry))) {
    throw new Error("HERMES_SANBI_WORKSPACE_ROOTS entries must be absolute paths");
  }
  const roots = [];
  const seenRoots = new Set();
  for (const entry of [...value.workspace_roots, ...requestedRoots]) {
    const resolved = path.resolve(entry);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!seenRoots.has(key)) { seenRoots.add(key); roots.push(resolved); }
  }
  value.workspace_roots = roots;

  const alias = (process.env.HERMES_SANBI_PROJECT_ALIAS || "").trim();
  const projectPath = (process.env.HERMES_SANBI_PROJECT_PATH || "").trim();
  if (Boolean(alias) !== Boolean(projectPath)) throw new Error("HERMES_SANBI_PROJECT_ALIAS and HERMES_SANBI_PROJECT_PATH must be set together");
  if (alias) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) throw new Error("HERMES_SANBI_PROJECT_ALIAS is invalid");
    const resolved = path.resolve(projectPath);
    if (!await exists(path.join(resolved, ".agent"))) throw new Error("HERMES_SANBI_PROJECT_PATH must contain a .agent directory");
    value.projects[alias] = { path: resolved };
  }
  const desired = `${JSON.stringify(value, null, 2)}\n`;
  if (await exists(registry) && desired === await readFile(registry, "utf8")) return;
  if (!dryRun && command && process.env.HERMES_GATEWAY_MANAGE !== "1") {
    const status = tryRun(command, [...hermesCommandPrefix, "gateway", "status"]);
    const output = `${status?.stdout || ""}\n${status?.stderr || ""}`;
    if (status?.status === 0 && /gateway process running/i.test(output)) {
      throw new Error("Hermes gateway is running and the Sanbi registry schema must be reloaded. Re-run with HERMES_GATEWAY_MANAGE=1 and configured Telegram credentials so installation can restart and verify the gateway safely.");
    }
  }
  console.log(`${dryRun ? "would set" : "install"}  ${registry}`);
  if (dryRun) return;
  if (await exists(registry)) {
    backupRoot ||= path.join(piRoot, ".sanbi-backups", timestamp);
    const backup = path.join(backupRoot, "hermes", "sanbi", "projects.json");
    await mkdir(path.dirname(backup), { recursive: true });
    await copyFile(registry, backup);
  }
  await mkdir(path.dirname(registry), { recursive: true });
  await writeFile(registry, desired, "utf8");
  changed += 1;
}

async function configureTelegramEnv() {
  const token = process.env.HERMES_TELEGRAM_BOT_TOKEN;
  const users = process.env.HERMES_TELEGRAM_ALLOWED_USERS;
  if (!token && !users) return false;
  if (!token || !users) throw new Error("HERMES_TELEGRAM_BOT_TOKEN and HERMES_TELEGRAM_ALLOWED_USERS must be set together");
  const envPath = path.join(hermesRoot, ".env");
  const content = await exists(envPath) ? await readFile(envPath, "utf8") : "";
  if (/^TELEGRAM_BOT_TOKEN=/m.test(content) || /^TELEGRAM_ALLOWED_USERS=/m.test(content)) {
    console.log("preserve existing Telegram credentials in Hermes .env");
    return /^TELEGRAM_BOT_TOKEN=.+/m.test(content) && /^TELEGRAM_ALLOWED_USERS=.+/m.test(content);
  }
  console.log(`${dryRun ? "would configure" : "configure"} Telegram credentials (values hidden)`);
  if (dryRun) return true;
  await mkdir(hermesRoot, { recursive: true });
  const separator = content && !content.endsWith("\n") ? "\n" : "";
  await writeFile(envPath, `${content}${separator}TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_ALLOWED_USERS=${users}\n`, { encoding: "utf8", mode: 0o600 });
  changed += 1;
  return true;
}

function resolveHermesCommand() {
  if (process.env.HERMES_COMMAND) return process.env.HERMES_COMMAND;
  if (tryRun("hermes", ["--version"])?.status === 0) return "hermes";
  const installed = path.join(hermesRoot, "bin", process.platform === "win32" ? "hermes.exe" : "hermes");
  return tryRun(installed, ["--version"])?.status === 0 ? installed : null;
}

function ensureHermes() {
  let command = resolveHermesCommand();
  if (command || dryRun) {
    if (dryRun && !command) console.log("would install Hermes using the official Nous Research installer");
    return command;
  }
  if (process.platform !== "win32") throw new Error("Hermes is missing; install it with https://hermes-agent.nousresearch.com/install.sh");
  console.log("install  Hermes using the official Nous Research Windows installer");
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    "& ([scriptblock]::Create((Invoke-RestMethod 'https://hermes-agent.nousresearch.com/install.ps1'))) -SkipSetup"]);
  command = resolveHermesCommand();
  if (!command) throw new Error("official Hermes installer completed but hermes is unavailable");
  return command;
}

async function applyHermesConfig(command) {
  const manifest = JSON.parse(await readFile(hermesManagedConfig, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.settings)) throw new Error("invalid Hermes managed config manifest");
  for (const setting of manifest.settings) {
    if (!setting || typeof setting.key !== "string" || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(setting.key)) {
      throw new Error("invalid key in Hermes managed config manifest");
    }
    if (!["string", "number", "boolean"].includes(typeof setting.value)) throw new Error(`invalid value for Hermes managed config key ${setting.key}`);
    const value = String(setting.value);
    if (dryRun) console.log(`would run hermes config set ${setting.key} ${value}`);
    else run(command, [...hermesCommandPrefix, "config", "set", setting.key, value]);
  }
}

function finishHermes(command, telegramReady) {
  if (dryRun || !command) return;
  const hermes = (args) => run(command, [...hermesCommandPrefix, ...args]);
  hermes(["plugins", "doctor", "--ci", hermesPluginDestination]);
  hermes(["plugins", "enable", "--no-allow-tool-override", "sanbi-readonly"]);
  if (process.env.HERMES_GATEWAY_MANAGE !== "1") return;
  if (!telegramReady) throw new Error("HERMES_GATEWAY_MANAGE=1 requires configured Telegram credentials");
  const status = hermes(["gateway", "status"]);
  if (/No gateway service installed/i.test(status)) hermes(["gateway", "install", "--start-now"]);
  else hermes(["gateway", "restart"]);
  hermes(["gateway", "status", "--deep"]);
}

function pathContains(entries, candidate) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  return entries.some((entry) => entry && normalize(entry) === normalize(candidate));
}

function ensureWindowsUserPath(binDirectory) {
  const escaped = binDirectory.replace(/'/g, "''");
  const script = [
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$parts = @($current -split ';' | Where-Object { $_ })",
    `$candidate = '${escaped}'`,
    "if (-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $candidate.TrimEnd('\\') })) {",
    "  $next = (@($parts) + $candidate) -join ';'",
    "  [Environment]::SetEnvironmentVariable('Path', $next, 'User')",
    "  Write-Output 'added'",
    "} else { Write-Output 'present' }",
  ].join("; ");
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

async function ensurePosixPath(binDirectory) {
  const profile = path.join(os.homedir(), ".profile");
  const marker = "# Added by Sanbi installer";
  let content = await exists(profile) ? await readFile(profile, "utf8") : "";
  if (content.includes(marker)) return "present";
  const line = `\n${marker}\nexport PATH="${binDirectory.replace(/"/g, "\\\"")}:$PATH"\n`;
  await writeFile(profile, content + line, "utf8");
  return "added";
}

async function installExecutable() {
  const npmCli = process.platform === "win32"
    ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : null;
  const hasNpmCli = npmCli && await exists(npmCli);
  const npmCommand = hasNpmCli ? process.execPath : (process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm");
  const npmPrefixArgs = hasNpmCli ? [npmCli] : (process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : []);
  const prefix = run(npmCommand, [...npmPrefixArgs, "prefix", "-g"]);
  const binDirectory = process.platform === "win32" ? prefix : path.join(prefix, "bin");

  // v10 and earlier used the package name local-agentic-development while exposing
  // the same sanbi binary. Remove only a positively identified legacy npm shim.
  const shimCandidates = process.platform === "win32"
    ? [path.join(binDirectory, "sanbi"), path.join(binDirectory, "sanbi.cmd"), path.join(binDirectory, "sanbi.ps1")]
    : [path.join(binDirectory, "sanbi")];
  const isLegacyShim = (content) => content.replaceAll("\\", "/").includes("node_modules/local-agentic-development/bin/sanbi.js");
  const existingShims = [];
  for (const candidate of shimCandidates) if (await exists(candidate)) existingShims.push(await readFile(candidate, "utf8"));
  const hasLegacyShim = existingShims.some(isLegacyShim);
  const currentEntries = (process.env.PATH || "").split(path.delimiter);
  if (dryRun) {
    if (hasLegacyShim) console.log("would migrate legacy local-agentic-development npm link");
    console.log(`would run npm link in ${packageRoot}`);
    if (!pathContains(currentEntries, binDirectory)) console.log(`would add ${binDirectory} to the persistent user PATH`);
    return;
  }
  if (hasLegacyShim) {
    console.log("migrate  legacy local-agentic-development npm link");
    run(npmCommand, [...npmPrefixArgs, "unlink", "--global", "local-agentic-development"]);
    // npm can remove the linked package yet leave its generated Windows shims.
    for (const candidate of shimCandidates) {
      if (await exists(candidate)) {
        const content = await readFile(candidate, "utf8");
        if (isLegacyShim(content)) await rm(candidate);
      }
    }
  }

  console.log(`link     ${packageRoot}`);
  run(npmCommand, [...npmPrefixArgs, "link"], { cwd: packageRoot });
  if (pathContains(currentEntries, binDirectory)) {
    console.log(`path     already contains ${binDirectory}`);
  } else if (process.platform === "win32") {
    console.log(`path     ${ensureWindowsUserPath(binDirectory)} ${binDirectory}`);
  } else {
    console.log(`path     ${await ensurePosixPath(binDirectory)} ${binDirectory}`);
  }

  const linkedCommand = process.platform === "win32" ? path.join(binDirectory, "sanbi.cmd") : path.join(binDirectory, "sanbi");
  if (!await exists(linkedCommand)) throw new Error(`npm link completed but ${linkedCommand} was not created`);
  console.log(`command  ${linkedCommand}`);
}

if (!skipConfig) {
  for (const entry of managed) await installManagedFile(...entry);
}
if (!skipLink) await installExecutable();
if (!skipHermes) {
  const hermesCommand = ensureHermes();
  await applyHermesConfig(hermesCommand);
  await installHermesPlugin();
  const telegramReady = await configureTelegramEnv();
  if (process.env.HERMES_GATEWAY_MANAGE === "1") finishHermes(hermesCommand, telegramReady);
  await configureRegistry(hermesCommand);
  if (process.env.HERMES_GATEWAY_MANAGE !== "1") finishHermes(hermesCommand, telegramReady);
}

console.log("");
if (dryRun) {
  console.log(`Sanbi dry run complete (${planned} configuration file${planned === 1 ? "" : "s"} would change). No files, links, or PATH entries were modified.`);
} else {
  console.log(`Sanbi installation complete (${changed} configuration file${changed === 1 ? "" : "s"} changed).`);
  if (backupRoot) console.log(`Backups: ${backupRoot}`);
  console.log("Open a new terminal if PATH changed. Restart Pi; reload Herdr with: herdr server reload-config");
}
