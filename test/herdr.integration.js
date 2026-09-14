import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeProjectTrust } from "../src/trust.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const session = `lad-test-${Date.now().toString(36)}`;
const temporary = await mkdtemp(path.join(os.tmpdir(), "lad-herdr-"));
const projectOne = path.join(temporary, "empty");
const projectTwo = path.join(temporary, "existing");
await mkdir(projectOne);
await mkdir(projectTwo);
await writeFile(path.join(projectTwo, "existing.txt"), "preserve me\n");

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function herdr(args) { return execute("herdr", ["--session", session, ...args]); }
function snapshot() { return JSON.parse(herdr(["api", "snapshot"])).result.snapshot; }
async function findSessionFile(id, directory = path.join(os.homedir(), ".pi", "agent", "sessions")) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findSessionFile(id, target);
      if (found) return found;
    } else if (entry.name.endsWith(`_${id}.jsonl`)) return target;
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const launch = (project, extra = []) => execute(process.execPath, ["bin/dev.js", "--project", project, "--session", session, "--no-attach", ...extra]);
  const upgrade = (project) => execute(process.execPath, ["bin/dev.js", "upgrade", "--project", project, "--session", session, "--no-attach"]);
  launch(projectOne);
  const configOne = JSON.parse(await readFile(path.join(projectOne, ".agent/config.json"), "utf8"));
  let state = snapshot();
  assert.equal(state.workspaces.length, 1);
  assert.equal(state.panes.length, 2);
  assert.deepEqual(state.panes.map((pane) => pane.label).sort(), ["CODER", "LEAD"]);
  assert.equal(state.agents.length, 2);

  const initialWorkspaceId = state.workspaces[0].workspace_id;
  const initialIds = Object.fromEntries(state.agents.map((agent) => [agent.name, agent.agent_session.value]));

  await writeFile(path.join(projectOne, ".agent/scaffold-version"), "1\n");
  await writeFile(path.join(projectOne, ".agent/protocol.md"), "legacy protocol\n");
  await writeFile(path.join(projectOne, ".agent/roles/lead.md"), "legacy lead role\n");
  await writeFile(path.join(projectOne, ".pi/extensions/lifecycle.ts"), "export default function legacy() {}\n");
  await writeFile(path.join(projectOne, ".agent/project.md"), "preserved project context\n");
  await writeFile(path.join(projectOne, "application.txt"), "preserved application\n");
  for (const directory of ["results", "reviews", "handoffs"]) await writeFile(path.join(projectOne, ".agent", directory, "preserve.md"), `${directory}\n`);
  const activeUpgradeTask = path.join(projectOne, ".agent/tasks/T-099.md");
  await writeFile(activeUpgradeTask, "---\nid: T-099\nstatus: READY\nactive: true\n---\n# Active upgrade guard\n");

  const warning = launch(projectOne);
  assert.match(warning, /Agent infrastructure update available/);
  assert.equal(await readFile(path.join(projectOne, ".agent/protocol.md"), "utf8"), "legacy protocol\n", "normal dev must not overwrite outdated infrastructure");

  const refused = spawnSync(process.execPath, ["bin/dev.js", "upgrade", "--project", projectOne, "--session", session, "--no-attach"], { cwd: sourceRoot, encoding: "utf8", windowsHide: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /cannot upgrade while an active task exists/);
  assert.equal(await readFile(path.join(projectOne, ".agent/protocol.md"), "utf8"), "legacy protocol\n");
  await writeFile(activeUpgradeTask, "---\nid: T-099\nstatus: DONE\nactive: false\n---\n# Inactive upgrade guard\n");

  const upgradedOutput = upgrade(projectOne);
  assert.match(upgradedOutput, /Upgraded agent infrastructure: 1 -> 2/);
  assert.match(await readFile(path.join(projectOne, ".pi/extensions/lifecycle.ts"), "utf8"), /registerCommand\("execute"/);
  assert.match(await readFile(path.join(projectOne, ".agent/roles/lead.md"), "utf8"), /READY` means you believe/);
  assert.equal(await readFile(path.join(projectOne, ".agent/project.md"), "utf8"), "preserved project context\n");
  assert.equal(await readFile(path.join(projectOne, "application.txt"), "utf8"), "preserved application\n");
  for (const directory of ["results", "reviews", "handoffs"]) assert.equal(await readFile(path.join(projectOne, ".agent", directory, "preserve.md"), "utf8"), `${directory}\n`);

  state = snapshot();
  assert.equal(state.workspaces.length, 1);
  assert.equal(state.workspaces[0].workspace_id, initialWorkspaceId, "upgrade must reuse the existing workspace");
  let firstIds = Object.fromEntries(state.agents.map((agent) => [agent.name, agent.agent_session.value]));
  assert.notDeepEqual(firstIds, initialIds, "upgrade must restart both roles with fresh sessions");
  herdr(["agent", "prompt", configOne.herdr.leadAgent, "Without tools, answer in one sentence: does READY authorize implementation, and what exact mechanism authorizes it?", "--wait", "--timeout", "120000"]);
  await sleep(100);
  const freshLeadSession = await findSessionFile(firstIds[configOne.herdr.leadAgent]);
  assert.ok(freshLeadSession, "fresh Lead session file must exist after upgrade");
  const freshLeadEntries = (await readFile(freshLeadSession, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const freshLeadAnswer = freshLeadEntries
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
    .flatMap((entry) => entry.message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.match(freshLeadAnswer, /No; READY|READY.*not.*authoriz|does not.*authoriz/i, "fresh Lead must distinguish readiness from authorization");
  assert.match(freshLeadAnswer, /\/execute/, "fresh Lead must identify /execute as the authorization mechanism");

  const currentOutput = upgrade(projectOne);
  assert.match(currentOutput, /already current/);
  state = snapshot();
  assert.deepEqual(Object.fromEntries(state.agents.map((agent) => [agent.name, agent.agent_session.value])), firstIds, "idempotent upgrade must not restart current sessions");

  launch(projectOne);
  state = snapshot();
  assert.equal(state.workspaces.length, 1, "warm reopen must reuse workspace");
  assert.deepEqual(Object.fromEntries(state.agents.map((agent) => [agent.name, agent.agent_session.value])), firstIds, "warm reopen must preserve sessions");

  launch(projectTwo);
  state = snapshot();
  assert.equal(state.workspaces.length, 2, "two projects must coexist");
  assert.equal(await readFile(path.join(projectTwo, "existing.txt"), "utf8"), "preserve me\n");

  const taskPath = path.join(projectOne, ".agent/tasks/T-001.md");
  const secondTaskPath = path.join(projectOne, ".agent/tasks/T-002.md");
  const taskWith = (id, status, active = true) => `---\nid: ${id}\ntitle: Execute gate integration\nstatus: ${status}\nactive: ${active}\nimplementation_freedom: EXACT\n---\n# ${id} — Execute gate integration\n\n## Objective\nDo not change application files. Record a result and move to REVIEW.\n\n## Acceptance Criteria\n- [ ] No application files changed.\n`;
  const invokeExecute = () => herdr(["agent", "prompt", configOne.herdr.leadAgent, "/execute"]);

  invokeExecute();
  await sleep(300);
  assert.equal(state.agents.find((agent) => agent.name === configOne.herdr.coderAgent).agent_session.value, firstIds[configOne.herdr.coderAgent], "/execute with no task must not rotate Coder");

  for (const status of ["DRAFT", "CODING", "BLOCKED", "REVIEW", "DONE"]) {
    await writeFile(taskPath, taskWith("T-001", status));
    invokeExecute();
    await sleep(300);
    assert.match(await readFile(taskPath, "utf8"), new RegExp(`status: ${status}`), `/execute must reject ${status}`);
  }

  const unavailableCoderName = `${configOne.project.key}-codex`;
  herdr(["agent", "rename", configOne.herdr.coderAgent, unavailableCoderName]);
  await writeFile(taskPath, taskWith("T-001", "READY"));
  invokeExecute();
  await sleep(500);
  assert.match(await readFile(taskPath, "utf8"), /status: READY/, "failed Coder invocation must roll back to READY");
  herdr(["agent", "rename", unavailableCoderName, configOne.herdr.coderAgent]);

  await writeFile(taskPath, taskWith("T-001", "READY"));
  await writeFile(secondTaskPath, taskWith("T-002", "READY"));
  invokeExecute();
  await sleep(300);
  assert.match(await readFile(taskPath, "utf8"), /status: READY/);
  assert.match(await readFile(secondTaskPath, "utf8"), /status: READY/, "/execute must reject multiple active tasks");
  await writeFile(secondTaskPath, taskWith("T-002", "READY", false));

  const coderBeforeReadyWait = snapshot().agents.find((agent) => agent.name === configOne.herdr.coderAgent);
  await sleep(500);
  const coderAfterReadyWait = snapshot().agents.find((agent) => agent.name === configOne.herdr.coderAgent);
  assert.equal(coderAfterReadyWait.state_change_seq, coderBeforeReadyWait.state_change_seq, "READY alone must not invoke Coder");

  invokeExecute();
  const codingDeadline = Date.now() + 10_000;
  while (Date.now() < codingDeadline && (await readFile(taskPath, "utf8")).includes("status: READY")) await sleep(50);
  assert.doesNotMatch(await readFile(taskPath, "utf8"), /status: READY/, "/execute must transition READY before Coder runs");
  invokeExecute();
  await sleep(300);
  assert.doesNotMatch(await readFile(taskPath, "utf8"), /status: READY/, "a second /execute must not invoke the already-started task");

  const settleDeadline = Date.now() + 120_000;
  while (Date.now() < settleDeadline) {
    const agents = snapshot().agents;
    const lead = agents.find((agent) => agent.name === configOne.herdr.leadAgent);
    const coder = agents.find((agent) => agent.name === configOne.herdr.coderAgent);
    if (lead?.agent_status !== "working" && coder?.agent_status !== "working") break;
    await sleep(200);
  }

  const doneTask = taskWith("T-001", "DONE");
  const handoff = `---\ntask: T-001\n---\n# Handoff — T-001\n\n## Completed\nIntegration fixture.\n`;
  await writeFile(taskPath, doneTask);
  herdr(["agent", "prompt", configOne.herdr.leadAgent, "/next"]);
  await sleep(500);
  assert.match(await readFile(taskPath, "utf8"), /active: true/, "/next must refuse a missing handoff");
  await writeFile(path.join(projectOne, ".agent/handoffs/T-001.md"), handoff);
  herdr(["agent", "prompt", configOne.herdr.leadAgent, "/next"]);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await readFile(taskPath, "utf8")).includes("active: false")) break;
    await sleep(100);
  }
  assert.match(await readFile(taskPath, "utf8"), /active: false/);
  const sessionDeadline = Date.now() + 10_000;
  let lead;
  let coder;
  while (Date.now() < sessionDeadline) {
    state = snapshot();
    lead = state.agents.find((agent) => agent.name === configOne.herdr.leadAgent);
    coder = state.agents.find((agent) => agent.name === configOne.herdr.coderAgent);
    if (lead && coder && lead.agent_session.value !== firstIds[lead.name] && coder.agent_session.value !== firstIds[coder.name]) break;
    await sleep(100);
  }
  assert.notEqual(lead.agent_session.value, firstIds[lead.name]);
  assert.notEqual(coder.agent_session.value, firstIds[coder.name]);
  assert.match(lead.terminal_title, /lead\/inbox/);
  assert.match(coder.terminal_title, /coder\/idle/);

  console.log(`PASS: Herdr integration in isolated session ${session}`);
} finally {
  spawnSync("herdr", ["session", "stop", session], { encoding: "utf8", windowsHide: true });
  spawnSync("herdr", ["session", "delete", session], { encoding: "utf8", windowsHide: true });
  await removeProjectTrust(projectOne).catch(() => undefined);
  await removeProjectTrust(projectTwo).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
