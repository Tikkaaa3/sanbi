import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const SUBAGENT_PROFILES = Object.freeze({
  scout: Object.freeze({ model: "openai-codex/gpt-5.6-luna", thinking: "medium", tools: Object.freeze(["read", "grep", "find", "ls"]) }),
  researcher: Object.freeze({ model: "openai-codex/gpt-5.6-terra", thinking: "medium", tools: Object.freeze(["read", "grep", "find", "ls", "web_search", "fetch_content", "source_check", "get_search_content"]) }),
  reviewer: Object.freeze({ model: "openai-codex/gpt-5.6-sol", thinking: "high", tools: Object.freeze(["read", "grep", "find", "ls", "bash"]) }),
  "diagnostic-scout": Object.freeze({ model: "openai-codex/gpt-5.6-sol", thinking: "medium", tools: Object.freeze(["read", "grep", "find", "ls", "bash"]) }),
});

export const ROLE_SUBAGENTS = Object.freeze({
  lead: Object.freeze(["scout", "researcher", "reviewer"]),
  coder: Object.freeze(["scout", "researcher", "diagnostic-scout"]),
});

export const CHILD_FORBIDDEN_TOOLS = Object.freeze([
  "write", "edit", "ask_user", "subagent", "subagent_spawn", "subagent_wait", "subagent_check", "subagent_cancel",
]);

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const KNOWN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "web_search", "fetch_content", "source_check", "get_search_content"]);

export function parseSubagentDefinition(text, source = "subagent definition") {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`${source}: missing frontmatter`);
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^([a-z_][a-z0-9_]*):\s*(.*?)\s*$/i);
    if (!item) throw new Error(`${source}: malformed frontmatter line: ${line}`);
    if (Object.hasOwn(data, item[1])) throw new Error(`${source}: duplicate ${item[1]}`);
    data[item[1]] = item[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  const required = ["name", "description", "model", "thinking", "tools"];
  for (const field of required) if (!data[field]) throw new Error(`${source}: missing ${field}`);
  if (!/^[a-z][a-z0-9-]*$/.test(data.name)) throw new Error(`${source}: invalid name ${data.name}`);
  if (!data.model.includes("/")) throw new Error(`${source}: model must be provider/model-id`);
  if (!THINKING.has(data.thinking)) throw new Error(`${source}: unsupported thinking level ${data.thinking}`);
  const tools = data.tools.split(",").map((item) => item.trim()).filter(Boolean);
  if (!tools.length || new Set(tools).size !== tools.length) throw new Error(`${source}: tools must be a unique comma-separated list`);
  for (const tool of tools) if (!KNOWN_TOOLS.has(tool)) throw new Error(`${source}: unknown tool ${tool}`);
  for (const tool of CHILD_FORBIDDEN_TOOLS) if (tools.includes(tool)) throw new Error(`${source}: forbidden child tool ${tool}`);
  const instructions = match[2].trim();
  if (!instructions) throw new Error(`${source}: instructions are empty`);
  return { ...data, tools, instructions, source };
}

async function markdownFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`missing managed subagent directory: ${directory}`);
    throw error;
  }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
}

export async function loadSubagentRegistry(projectRoot, role, options = {}) {
  const expected = ROLE_SUBAGENTS[role];
  if (!expected) throw new Error(`invalid Sanbi subagent role: ${role}`);
  const base = path.join(projectRoot, ".agent", "subagents");
  const definitions = [];
  for (const scope of ["shared", role]) {
    const directory = path.join(base, scope);
    for (const name of await markdownFiles(directory)) {
      const source = path.join(directory, name);
      const definition = parseSubagentDefinition(await readFile(source, "utf8"), source);
      if (`${definition.name}.md` !== name) throw new Error(`${source}: filename must match name ${definition.name}`);
      definitions.push(definition);
    }
  }
  const names = definitions.map((item) => item.name);
  if (new Set(names).size !== names.length) throw new Error(`duplicate Sanbi subagent name for ${role}`);
  if (names.slice().sort().join(",") !== expected.slice().sort().join(",")) {
    throw new Error(`${role} subagent registry must contain exactly: ${expected.join(", ")}`);
  }
  for (const definition of definitions) {
    const profile = SUBAGENT_PROFILES[definition.name];
    if (!profile || definition.model !== profile.model || definition.thinking !== profile.thinking || definition.tools.join(",") !== profile.tools.join(",")) {
      throw new Error(`${definition.source}: profile differs from canonical Sanbi configuration`);
    }
    if (options.resolveModel && !await options.resolveModel(definition.model)) throw new Error(`${definition.source}: unavailable model ${definition.model}`);
  }
  return new Map(definitions.map((item) => [item.name, item]));
}
