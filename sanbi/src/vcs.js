import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cache = new Map();

function concise(value, max = 240) {
  const lines = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => !/^(usage:|options:|commands:|\s*-\w)/i.test(line)) ?? lines[0] ?? "Git repository not detected";
  return useful.length <= max ? useful : `${useful.slice(0, max)}…`;
}

export function detectVcs(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  if (!options.noCache && cache.has(root)) return cache.get(root);
  const run = options.spawnSync ?? spawnSync;
  const result = run("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    stdio: "pipe",
  });
  const vcs = !result.error && result.status === 0 && String(result.stdout).trim() === "true" ? "git" : "none";
  const detected = { vcs, reason: vcs === "git" ? undefined : concise(result.error?.message ?? result.stderr ?? result.stdout) };
  if (!options.noCache) cache.set(root, detected);
  return detected;
}

export function clearVcsCache() { cache.clear(); }

export async function claimNoGitWarning(projectRoot, options = {}) {
  const key = createHash("sha256").update(path.resolve(projectRoot).toLowerCase()).digest("hex").slice(0, 20);
  const marker = path.join(options.tmpdir ?? os.tmpdir(), "sanbi", "warnings", `${key}-no-git-v1`);
  try { await readFile(marker, "utf8"); return false; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  await mkdir(path.dirname(marker), { recursive: true });
  try {
    await writeFile(marker, "Sanbi no-Git warning shown. This is runtime UI state, not project knowledge.\n", { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}
