import { cp, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentNames, canonicalProjectRoot, deriveProjectKey } from "./project.js";
import { detectVcs } from "./vcs.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_ROOT = path.join(SOURCE_ROOT, "scaffold");
export const CURRENT_SCAFFOLD_VERSION = 11;
const VERSION_FILE = ".agent/scaffold-version";
const VERSIONED_DIRECTORIES = [
  ".agent/skills/lead",
  ".agent/skills/coder",
  ".agent/skills/shared",
  ".agent/initiatives",
  ".agent/subagents/shared",
  ".agent/subagents/lead",
  ".agent/subagents/coder",
];
const MANAGED_FILES = [
  ".agent/protocol.md",
  ".agent/roles/lead.md",
  ".agent/roles/coder.md",
  ".agent/templates/task.md",
  ".agent/templates/result.md",
  ".agent/templates/review.md",
  ".agent/templates/handoff.md",
  ".agent/templates/initiative.md",
  ".agent/.runtime/.gitignore",
  ".pi/extensions/lifecycle.ts",
  ".pi/extensions/sanbi-subagents.ts",
  ".pi/sanbi/subagent-ui.js",
  ".pi/sanbi/runtime-temp.js",
  ".pi/sanbi/runtime-process.js",
];

async function filesUnder(directory, prefix) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function canonicalManagedFiles() {
  const skills = await filesUnder(path.join(SCAFFOLD_ROOT, ".agent", "skills"), path.join(".agent", "skills"));
  const subagents = await filesUnder(path.join(SCAFFOLD_ROOT, ".agent", "subagents"), path.join(".agent", "subagents"));
  return [...MANAGED_FILES, ...skills, ...subagents];
}

async function isDirectory(directory) {
  try { return (await stat(directory)).isDirectory(); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function exists(file) {
  try { await readFile(file); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function copyMissing(source, destination, created) {
  if (await exists(destination)) return;
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { errorOnExist: true, force: false });
  created.push(path.relative(path.dirname(path.dirname(destination)), destination));
}

export async function adoptProject(projectDirectory) {
  const absoluteRoot = await realpathPreservingCase(projectDirectory);
  const wasAdopted = await exists(path.join(absoluteRoot, ".agent", "config.json"));
  const installedAtOpen = wasAdopted ? await readScaffoldVersion(absoluteRoot) : undefined;
  const currentInfrastructure = !wasAdopted || installedAtOpen === CURRENT_SCAFFOLD_VERSION;
  const canonicalRoot = await canonicalProjectRoot(projectDirectory);
  const directories = [
    ".agent/roles", ".agent/templates", ".agent/tasks", ".agent/results",
    ".agent/reviews", ".agent/handoffs", ".pi/extensions",
  ];
  if (currentInfrastructure) directories.push(...VERSIONED_DIRECTORIES);
  for (const directory of directories) await mkdir(path.join(absoluteRoot, directory), { recursive: true });

  const managedFiles = currentInfrastructure ? await canonicalManagedFiles() : [];
  const files = [...managedFiles, ".agent/project.md"];
  const created = [];
  for (const file of files) await copyMissing(path.join(SCAFFOLD_ROOT, file), path.join(absoluteRoot, file), created);

  const configPath = path.join(absoluteRoot, ".agent", "config.json");
  let config;
  if (await exists(configPath)) {
    config = JSON.parse(await readFile(configPath, "utf8"));
    validateConfig(config);
  } else {
    const projectKey = deriveProjectKey(canonicalRoot);
    config = {
      configVersion: 1,
      project: { key: projectKey, root: absoluteRoot },
      roles: {
        lead: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
        coder: { model: "openai-codex/gpt-5.6-sol", thinking: "low" },
      },
      herdr: { leadAgent: agentNames(projectKey).lead, coderAgent: agentNames(projectKey).coder },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    created.push(".agent/config.json");
  }
  const versionPath = path.join(absoluteRoot, VERSION_FILE);
  if (!(await exists(versionPath)) && !wasAdopted) {
    await writeFile(versionPath, `${CURRENT_SCAFFOLD_VERSION}\n`, { encoding: "utf8", flag: "wx" });
    created.push(VERSION_FILE);
  }
  const installedVersion = await readScaffoldVersion(absoluteRoot);
  return {
    root: absoluteRoot,
    canonicalRoot,
    config,
    vcs: detectVcs(absoluteRoot),
    created,
    installedVersion,
    updateAvailable: installedVersion === "legacy" || installedVersion < CURRENT_SCAFFOLD_VERSION,
  };
}

export async function readScaffoldVersion(root) {
  const marker = path.join(root, VERSION_FILE);
  if (!(await exists(marker))) return "legacy";
  const value = (await readFile(marker, "utf8")).trim();
  if (!/^\d+$/.test(value)) throw new Error(`${VERSION_FILE}: expected a numeric scaffold version`);
  return Number(value);
}

async function activeTaskFiles(root) {
  const directory = path.join(root, ".agent", "tasks");
  let names = [];
  try { names = await readdir(directory); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const active = [];
  for (const name of names.filter((entry) => /^T-\d+\.md$/i.test(entry))) {
    const content = await readFile(path.join(directory, name), "utf8");
    const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!header) throw new Error(`${name}: task has no YAML frontmatter`);
    if (/^active:\s*(?:true|"true"|'true')\s*$/m.test(header)) active.push(name);
  }
  return active;
}

function backupName(installedVersion) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-v${installedVersion}-to-v${CURRENT_SCAFFOLD_VERSION}`;
}

export async function upgradeProject(projectDirectory, options = {}) {
  const root = await realpathPreservingCase(projectDirectory);
  const configPath = path.join(root, ".agent", "config.json");
  if (!(await exists(configPath))) throw new Error("this directory is not an adopted project: .agent/config.json is missing");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  validateConfig(config);

  const active = await activeTaskFiles(root);
  if (active.length) throw new Error(`cannot upgrade while an active task exists: ${active.join(", ")}`);

  const installedVersion = await readScaffoldVersion(root);
  if (installedVersion !== "legacy" && installedVersion > CURRENT_SCAFFOLD_VERSION) {
    throw new Error(`installed scaffold version ${installedVersion} is newer than this tool (${CURRENT_SCAFFOLD_VERSION})`);
  }

  const missingDirectories = [];
  for (const relative of VERSIONED_DIRECTORIES) {
    if (!(await isDirectory(path.join(root, relative)))) missingDirectories.push(relative);
  }

  const managedFiles = await canonicalManagedFiles();
  const replacements = [];
  for (const relative of managedFiles) {
    const source = path.join(SCAFFOLD_ROOT, relative);
    const destination = path.join(root, relative);
    const canonical = await readFile(source);
    let current;
    try { current = await readFile(destination); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!current || !current.equals(canonical)) replacements.push({ relative, source, destination, exists: Boolean(current) });
  }

  const canonicalSubagents = new Set(managedFiles.filter((relative) => relative.startsWith(path.join(".agent", "subagents"))));
  const retiredFiles = [];
  // Only the three role registry directories are Sanbi-owned namespaces. Preserve
  // arbitrary sibling directories instead of treating every Markdown file below
  // .agent/subagents as managed infrastructure.
  for (const scope of ["shared", "lead", "coder"]) {
    const scopePrefix = path.join(".agent", "subagents", scope);
    const files = await filesUnder(path.join(root, scopePrefix), scopePrefix);
    retiredFiles.push(...files.filter((relative) => relative.toLowerCase().endsWith(".md") && !canonicalSubagents.has(relative)));
  }
  const markerNeedsUpdate = installedVersion !== CURRENT_SCAFFOLD_VERSION;
  if (!replacements.length && !retiredFiles.length && !missingDirectories.length && !markerNeedsUpdate) {
    return { root, config, installedVersion, currentVersion: CURRENT_SCAFFOLD_VERSION, changed: false, replacements: [], retiredFiles: [], createdDirectories: [], backupDirectory: null };
  }

  await options.beforeApply?.({
    root,
    config,
    installedVersion,
    replacements: replacements.map((item) => item.relative),
    retiredFiles,
    createdDirectories: missingDirectories,
  });

  let backupDirectory = null;
  const existing = [
    ...replacements.filter((item) => item.exists),
    ...retiredFiles.map((relative) => ({ relative, destination: path.join(root, relative), exists: true })),
  ];
  if (existing.length) {
    backupDirectory = path.join(root, ".agent", "upgrade-backups", backupName(installedVersion));
    for (const item of existing) {
      const backup = path.join(backupDirectory, item.relative);
      await mkdir(path.dirname(backup), { recursive: true });
      await cp(item.destination, backup, { errorOnExist: true, force: false });
    }
  }

  for (const relative of missingDirectories) await mkdir(path.join(root, relative), { recursive: true });
  for (const item of replacements) {
    await mkdir(path.dirname(item.destination), { recursive: true });
    await cp(item.source, item.destination, { force: true });
  }
  for (const relative of retiredFiles) await unlink(path.join(root, relative));
  await writeFile(path.join(root, VERSION_FILE), `${CURRENT_SCAFFOLD_VERSION}\n`, "utf8");
  return {
    root,
    config,
    installedVersion,
    currentVersion: CURRENT_SCAFFOLD_VERSION,
    changed: true,
    replacements: replacements.map((item) => item.relative),
    retiredFiles,
    createdDirectories: missingDirectories,
    backupDirectory,
  };
}

async function realpathPreservingCase(input) {
  const { realpath } = await import("node:fs/promises");
  return realpath(path.resolve(input));
}

export function validateConfig(config) {
  if (config?.configVersion !== 1) throw new Error(".agent/config.json: unsupported configVersion");
  if (!/^[a-z][a-z0-9_-]{0,25}$/.test(config?.project?.key ?? "")) throw new Error(".agent/config.json: invalid project.key");
  for (const role of ["lead", "coder"]) {
    const value = config?.roles?.[role];
    if (!value || !(value.model === null || typeof value.model === "string")) throw new Error(`.agent/config.json: roles.${role}.model must be null or a Pi model ID`);
    if (!new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(value.thinking)) throw new Error(`.agent/config.json: invalid roles.${role}.thinking`);
  }
  const expected = agentNames(config.project.key);
  if (config?.herdr?.leadAgent !== expected.lead || config?.herdr?.coderAgent !== expected.coder) throw new Error(".agent/config.json: Herdr agent names do not match project.key");
}
