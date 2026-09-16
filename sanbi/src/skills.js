import { stat } from "node:fs/promises";
import path from "node:path";

async function existingDirectory(directory) {
  try { return (await stat(directory)).isDirectory(); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function roleSkillRoots(projectRoot, role) {
  if (role !== "lead" && role !== "coder") throw new Error(`invalid Sanbi skill role: ${role}`);
  const base = path.join(projectRoot, ".agent", "skills");
  const candidates = [path.join(base, role), path.join(base, "shared")];
  const roots = [];
  for (const candidate of candidates) if (await existingDirectory(candidate)) roots.push(candidate);
  return roots;
}

export async function buildPiLaunchArgs(adopted, role) {
  const roleConfig = adopted.config.roles[role];
  if (!roleConfig) throw new Error(`missing Pi role configuration: ${role}`);
  const args = ["--approve", "--thinking", roleConfig.thinking];
  if (roleConfig.model) args.push("--model", roleConfig.model);
  for (const root of await roleSkillRoots(adopted.root, role)) args.push("--skill", root);
  return args;
}
