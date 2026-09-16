#!/usr/bin/env node

import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

const piRoot = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const herdrRoot = process.env.HERDR_CONFIG_DIR || (process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "herdr")
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr"));

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

console.log("");
if (dryRun) {
  console.log(`Sanbi dry run complete (${planned} configuration file${planned === 1 ? "" : "s"} would change). No files, links, or PATH entries were modified.`);
} else {
  console.log(`Sanbi installation complete (${changed} configuration file${changed === 1 ? "" : "s"} changed).`);
  if (backupRoot) console.log(`Backups: ${backupRoot}`);
  console.log("Open a new terminal if PATH changed. Restart Pi; reload Herdr with: herdr server reload-config");
}
