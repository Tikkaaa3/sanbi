import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateLegacySanbiSubagentToggle } from "../src/global-subagents.js";
import { adoptProject } from "../src/scaffold.js";
import { CHILD_FORBIDDEN_TOOLS, loadSubagentRegistry, parseSubagentDefinition, ROLE_SUBAGENTS, SUBAGENT_PROFILES } from "../src/subagents.js";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
async function project() { const root = await mkdtemp(path.join(os.tmpdir(), "sanbi-subagents-")); roots.push(root); await adoptProject(root); return root; }

test("Subagent V2 registry is hard-filtered by parent role", async () => {
  const root = await project();
  const lead = await loadSubagentRegistry(root, "lead");
  const coder = await loadSubagentRegistry(root, "coder");
  assert.deepEqual([...lead.keys()].sort(), ["researcher", "reviewer", "scout"]);
  assert.deepEqual([...coder.keys()].sort(), ["diagnostic-scout", "researcher", "scout"]);
  assert.equal(lead.has("diagnostic-scout"), false);
  assert.equal(coder.has("reviewer"), false);
  for (const shared of ["scout", "researcher"]) { assert.equal(lead.has(shared), true); assert.equal(coder.has(shared), true); }
  assert.deepEqual(ROLE_SUBAGENTS.lead, ["scout", "researcher", "reviewer"]);
  assert.deepEqual(ROLE_SUBAGENTS.coder, ["scout", "researcher", "diagnostic-scout"]);
});

test("Subagent V2 profiles use exact models, thinking, and leaf tool sets", async () => {
  const root = await project();
  const lead = await loadSubagentRegistry(root, "lead", { resolveModel: async (id) => id.startsWith("openai-codex/gpt-5.6-") });
  const coder = await loadSubagentRegistry(root, "coder");
  assert.deepEqual(SUBAGENT_PROFILES.scout, { model: "openai-codex/gpt-5.6-luna", thinking: "medium", tools: ["read", "grep", "find", "ls"] });
  assert.deepEqual(SUBAGENT_PROFILES.researcher, { model: "openai-codex/gpt-5.6-terra", thinking: "medium", tools: ["read", "grep", "find", "ls", "web_search", "fetch_content", "source_check", "get_search_content"] });
  assert.deepEqual(SUBAGENT_PROFILES.reviewer, { model: "openai-codex/gpt-5.6-sol", thinking: "high", tools: ["read", "grep", "find", "ls", "bash"] });
  assert.deepEqual(SUBAGENT_PROFILES["diagnostic-scout"], { model: "openai-codex/gpt-5.6-sol", thinking: "medium", tools: ["read", "grep", "find", "ls", "bash"] });
  for (const definition of [...lead.values(), ...coder.values()]) {
    for (const forbidden of CHILD_FORBIDDEN_TOOLS) assert.equal(definition.tools.includes(forbidden), false, `${definition.name} received ${forbidden}`);
  }
  await assert.rejects(() => loadSubagentRegistry(root, "lead", { resolveModel: async (id) => id !== "openai-codex/gpt-5.6-luna" }), /unavailable model openai-codex\/gpt-5\.6-luna/);
});

test("invalid canonical definitions fail clearly", async () => {
  assert.throws(() => parseSubagentDefinition("no frontmatter", "bad.md"), /bad\.md: missing frontmatter/);
  const root = await project();
  const scout = path.join(root, ".agent/subagents/shared/scout.md");
  const text = await readFile(scout, "utf8");
  await writeFile(scout, text.replace("tools: read,grep,find,ls", "tools: read,write"));
  await assert.rejects(() => loadSubagentRegistry(root, "lead"), /(?:unknown|forbidden child) tool write/);
});

test("legacy global toggle migration changes only positively identified Sanbi glue", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "sanbi-global-")); roots.push(agentDir);
  const extensions = path.join(agentDir, "extensions"); await mkdir(extensions);
  const file = path.join(extensions, "subagent-toggle.ts");
  const legacy = 'const TOOL_NAME = "subagent";\n// Sanbi uses subagents only as leaf specialists.\nexport default function subagentToggle(pi: ExtensionAPI) {\n  pi.registerCommand("subagents", {});\n}\n';
  await writeFile(file, legacy);
  const migrated = await migrateLegacySanbiSubagentToggle({ agentDir });
  assert.equal(migrated.status, "migrated");
  assert.match(await readFile(file, "utf8"), /SANBI_SUBAGENT_V2/);
  assert.equal(await readFile(`${file}.sanbi-v1.bak`, "utf8"), legacy);
  const foreignDir = await mkdtemp(path.join(os.tmpdir(), "sanbi-global-")); roots.push(foreignDir); await mkdir(path.join(foreignDir, "extensions"));
  const foreign = path.join(foreignDir, "extensions/subagent-toggle.ts"); await writeFile(foreign, "export default function custom() {}\n");
  assert.equal((await migrateLegacySanbiSubagentToggle({ agentDir: foreignDir })).status, "unowned");
  assert.equal(await readFile(foreign, "utf8"), "export default function custom() {}\n");
});

test("specialist result contracts are compressed and role-focused", async () => {
  const root = await project();
  const scout = await readFile(path.join(root, ".agent/subagents/shared/scout.md"), "utf8");
  const researcher = await readFile(path.join(root, ".agent/subagents/shared/researcher.md"), "utf8");
  const reviewer = await readFile(path.join(root, ".agent/subagents/lead/reviewer.md"), "utf8");
  const diagnostic = await readFile(path.join(root, ".agent/subagents/coder/diagnostic-scout.md"), "utf8");
  assert.match(scout, /at most about 8 meaningful findings/);
  assert.match(scout, /500 words or fewer/);
  assert.match(researcher, /Direct conclusion first/);
  assert.match(researcher, /Three to seven key findings/);
  assert.match(researcher, /800 words or fewer/);
  assert.match(reviewer, /only the review axis delegated/);
  assert.match(reviewer, /Do not broadly restate the task contract/);
  assert.match(reviewer, /With `VCS: none`, do not probe again or run Git status\/diff\/log/);
  assert.match(reviewer, /If no material issue exists, keep the result short/);
  assert.match(diagnostic, /Supported root cause or ranked falsifiable hypotheses/);
  assert.match(diagnostic, /Avoid narrating every investigative command/);
});

test("managed extension uses in-process isolated persistent sessions and Pi-native UI", async () => {
  const source = await readFile(new URL("../scaffold/.pi/extensions/sanbi-subagents.ts", import.meta.url), "utf8");
  assert.match(source, /createAgentSession/);
  assert.match(source, /SessionManager\.create\(cwd/);
  assert.match(source, /parentSession/);
  assert.match(source, /DefaultResourceLoader/);
  assert.match(source, /SettingsManager\.create/);
  assert.match(source, /getActiveToolNames/);
  assert.match(source, /FORBIDDEN_CHILD_TOOLS/);
  assert.match(source, /process\.env\.PI_SUBAGENT_MAX_DEPTH = "0"/);
  assert.match(source, /expandPromptTemplates: false/);
  assert.match(source, /ctx\.ui\.custom/);
  assert.match(source, /createInspectReadModel/);
  assert.match(source, /activityRows/);
  assert.match(source, /RAW TRANSCRIPT/);
  assert.match(source, /setWidget\("sanbi-subagents-running"/);
  assert.match(source, /UI_STREAM_THROTTLE_MS = 75/);
  assert.match(source, /resultDelivered/);
  assert.match(source, /deliverPendingIfIdle/);
  assert.match(source, /deliverAs: "followUp"/);
  assert.match(source, /StringEnum\(ROLES\[role\]\)/);
  assert.doesNotMatch(source, /Type\.Union\(\[\.\.\.ROLES/);
  assert.match(source, /session_shutdown/);
  assert.match(source, /terminal\?\.stopReason === "error"/);
  assert.match(source, /terminal\.errorMessage/);
  assert.match(source, /private closed = false/);
  assert.match(source, /private validationError/);
  assert.match(source, /Subagent V2 is disabled/);
  assert.match(source, /this\.runs/);
  assert.doesNotMatch(source, /child_process|spawnSync|execFile/);
});
