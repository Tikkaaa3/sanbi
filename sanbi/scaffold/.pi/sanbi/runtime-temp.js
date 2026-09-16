import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OWNER_FILE = ".sanbi-runtime-owned";

function safeProjectId(value) {
  const id = String(value ?? "project").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return id || "project";
}

export function runtimeTempRoot(projectId, options = {}) {
  return path.join(options.tmpdir ?? os.tmpdir(), "sanbi", safeProjectId(projectId));
}

export async function createRuntimeTemp(projectId, purpose = "run", options = {}) {
  const root = runtimeTempRoot(projectId, options);
  const directory = path.join(root, `${safeProjectId(purpose)}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, OWNER_FILE), JSON.stringify({ owner: "sanbi", project: safeProjectId(projectId), purpose: safeProjectId(purpose) }) + "\n", { encoding: "utf8", flag: "wx" });
  return directory;
}

export async function cleanupRuntimeTemp(directory, options = {}) {
  const resolved = path.resolve(directory);
  const base = path.resolve(options.tmpdir ?? os.tmpdir(), "sanbi");
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let marker;
  try { marker = JSON.parse(await readFile(path.join(resolved, OWNER_FILE), "utf8")); }
  catch { return false; }
  if (marker?.owner !== "sanbi") return false;
  await rm(resolved, { recursive: true, force: true });
  return true;
}
