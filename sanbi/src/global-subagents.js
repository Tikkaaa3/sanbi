import { constants } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LEGACY_SIGNATURES = [
  'const TOOL_NAME = "subagent";',
  "Sanbi uses subagents only as leaf specialists.",
  'pi.registerCommand("subagents"',
];
const FUNCTION_START = "export default function subagentToggle(pi: ExtensionAPI) {";
const GUARD = '  if (process.env.SANBI_SUBAGENT_V2 === "1" || existsSync(join(process.cwd(), ".pi", "extensions", "sanbi-subagents.ts"))) return;';

/**
 * Disable only the positively identified legacy Sanbi toggle inside V2 projects.
 * The generic package and unrelated user extensions/configuration remain untouched.
 */
export async function migrateLegacySanbiSubagentToggle(options = {}) {
  const agentDir = options.agentDir ?? path.join(os.homedir(), ".pi", "agent");
  const file = path.join(agentDir, "extensions", "subagent-toggle.ts");
  let text;
  try { text = await readFile(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", file };
    throw error;
  }
  if (text.includes(GUARD)) return { status: "already-migrated", file };
  if (!LEGACY_SIGNATURES.every((signature) => text.includes(signature)) || !text.includes(FUNCTION_START)) {
    return { status: "unowned", file };
  }
  const replacement = `${FUNCTION_START}\n  // Sanbi Subagent V2 owns delegation and /subagents in upgraded projects.\n${GUARD}`;
  const next = text.replace(FUNCTION_START, replacement);
  const backup = `${file}.sanbi-v1.bak`;
  try { await copyFile(file, backup, constants.COPYFILE_EXCL); } catch (error) { if (error?.code !== "EEXIST") throw error; }
  await writeFile(file, next, "utf8");
  return { status: "migrated", file, backup };
}
