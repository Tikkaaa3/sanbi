import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function updateProjectTrust(projectRoot, decision, options = {}) {
  const agentDirectory = options.agentDirectory ?? path.join(os.homedir(), ".pi", "agent");
  const trustPath = path.join(agentDirectory, "trust.json");
  const lockPath = `${trustPath}.lad.lock`;
  await mkdir(agentDirectory, { recursive: true });
  let lock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lock = await open(lockPath, "wx"); break; } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await delay(20);
    }
  }
  if (!lock) throw new Error(`could not lock Pi trust store: ${trustPath}`);
  try {
    let data = {};
    try { data = JSON.parse(await readFile(trustPath, "utf8")); } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`cannot read Pi trust store: ${error.message}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Pi trust store must contain a JSON object");
    if (decision === null) delete data[projectRoot];
    else data[projectRoot] = decision;
    const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
    const temporary = `${trustPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    await rename(temporary, trustPath);
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export function trustProject(projectRoot, options) {
  return updateProjectTrust(projectRoot, true, options);
}

export function removeProjectTrust(projectRoot, options) {
  return updateProjectTrust(projectRoot, null, options);
}
