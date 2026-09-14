import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

export async function canonicalProjectRoot(input) {
  const resolved = await realpath(path.resolve(input));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function deriveProjectKey(root) {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  let base = path.basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!base || !/^[a-z]/.test(base)) base = `p-${base}`;
  base = base.slice(0, 17).replace(/-+$/g, "") || "project";
  return `${base}-${hash}`;
}

export function agentNames(projectKey) {
  const lead = `${projectKey}-lead`;
  const coder = `${projectKey}-coder`;
  if (lead.length > 32 || coder.length > 32) throw new Error("derived Herdr agent name exceeds 32 characters");
  return { lead, coder };
}
