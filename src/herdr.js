import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

function commandPrefix(session) {
  return session && session !== "default" ? ["--session", session] : [];
}

export function runHerdr(session, args, options = {}) {
  const result = spawnSync("herdr", [...commandPrefix(session), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error) throw new Error(`cannot run Herdr: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `Herdr exited ${result.status}`).trim());
  if (options.inherit) return undefined;
  const text = result.stdout.trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { throw new Error(`unexpected Herdr output: ${text}`); }
}

function serverRunning(session) {
  const result = spawnSync("herdr", [...commandPrefix(session), "status", "server"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 && /status:\s*running/i.test(result.stdout);
}

export async function ensureServer(session) {
  if (serverRunning(session)) return;
  const child = spawn("herdr", [...commandPrefix(session), "server"], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (serverRunning(session)) return;
  }
  throw new Error(`Herdr session ${session} did not start within 15 seconds`);
}

function resultOf(response, field) {
  const value = response?.result?.[field];
  if (!value) throw new Error(`Herdr response did not include result.${field}`);
  return value;
}

function roleEnv(config, role) {
  const peer = role === "lead" ? config.herdr.coderAgent : config.herdr.leadAgent;
  return [
    `LAD_AGENT_ROLE=${role}`,
    `LAD_PROJECT_KEY=${config.project.key}`,
    `LAD_AGENT_PEER=${peer}`,
  ];
}

function cwdEqual(a, b) {
  const normalize = (value) => path.resolve(value).replaceAll("/", "\\").replace(/[\\]+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

export async function ensureProjectRuntime(adopted, options = {}) {
  const session = options.session ?? "default";
  await ensureServer(session);
  const workspaces = resultOf(runHerdr(session, ["workspace", "list"]), "workspaces");
  const matches = workspaces.filter((item) => item.label === adopted.config.project.key);
  if (matches.length > 1) throw new Error(`multiple Herdr workspaces use project key ${adopted.config.project.key}`);

  let workspace;
  let leadPane;
  let coderPane;
  if (!matches.length) {
    const args = ["workspace", "create", "--cwd", adopted.root, "--label", adopted.config.project.key, "--no-focus"];
    for (const item of roleEnv(adopted.config, "lead")) args.push("--env", item);
    const created = runHerdr(session, args);
    workspace = resultOf(created, "workspace");
    leadPane = resultOf(created, "root_pane");
    const splitArgs = ["pane", "split", "--pane", leadPane.pane_id, "--direction", "right", "--ratio", "0.5", "--cwd", adopted.root, "--no-focus"];
    for (const item of roleEnv(adopted.config, "coder")) splitArgs.push("--env", item);
    coderPane = resultOf(runHerdr(session, splitArgs), "pane");
    runHerdr(session, ["pane", "rename", leadPane.pane_id, "LEAD"]);
    runHerdr(session, ["pane", "rename", coderPane.pane_id, "CODER"]);
  } else {
    workspace = matches[0];
    const snapshot = resultOf(runHerdr(session, ["api", "snapshot"]), "snapshot");
    const layout = snapshot.layouts.find((item) => item.workspace_id === workspace.workspace_id && item.tab_id === workspace.active_tab_id);
    if (!layout) throw new Error(`workspace ${workspace.workspace_id} has no active-tab layout`);
    const paneObjects = layout.panes.map((item) => snapshot.panes.find((pane) => pane.pane_id === item.pane_id)).filter(Boolean);
    if (paneObjects.length !== 2) throw new Error(`managed workspace ${workspace.workspace_id} must have exactly two panes in its active tab`);
    for (const pane of paneObjects) if (!cwdEqual(pane.cwd, adopted.root)) throw new Error(`pane ${pane.pane_id} cwd does not match adopted project root`);
    const live = snapshot.agents;
    const leadLive = live.find((item) => item.name === adopted.config.herdr.leadAgent);
    const coderLive = live.find((item) => item.name === adopted.config.herdr.coderAgent);
    const sorted = [...layout.panes].sort((a, b) => (a.rect.x - b.rect.x) || (a.rect.y - b.rect.y));
    leadPane = paneObjects.find((pane) => pane.pane_id === leadLive?.pane_id) ?? paneObjects.find((pane) => pane.pane_id !== coderLive?.pane_id && pane.pane_id === sorted[0].pane_id);
    coderPane = paneObjects.find((pane) => pane.pane_id === coderLive?.pane_id) ?? paneObjects.find((pane) => pane.pane_id !== leadLive?.pane_id && pane.pane_id === sorted[1].pane_id);
    if (!leadPane || !coderPane || leadPane.pane_id === coderPane.pane_id) throw new Error("could not identify Lead and Coder panes");
  }

  if (!options.noAgents) {
    const agents = resultOf(runHerdr(session, ["agent", "list"]), "agents");
    await ensureAgent(session, adopted, "lead", leadPane.pane_id, agents);
    await ensureAgent(session, adopted, "coder", coderPane.pane_id, agents);
  }
  runHerdr(session, ["workspace", "focus", workspace.workspace_id]);
  return { session, workspaceId: workspace.workspace_id, leadPaneId: leadPane.pane_id, coderPaneId: coderPane.pane_id };
}

async function ensureAgent(session, adopted, role, paneId, agents) {
  const name = role === "lead" ? adopted.config.herdr.leadAgent : adopted.config.herdr.coderAgent;
  const existing = agents.find((item) => item.name === name);
  if (existing) {
    if (existing.pane_id !== paneId) throw new Error(`agent ${name} is running in unexpected pane ${existing.pane_id}`);
    return;
  }
  if (agents.some((item) => item.pane_id === paneId)) throw new Error(`pane ${paneId} already contains another live agent`);
  const roleConfig = adopted.config.roles[role];
  const native = ["--approve", "--thinking", roleConfig.thinking];
  if (roleConfig.model) native.push("--model", roleConfig.model);
  runHerdr(session, ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", ...native]);
}

export async function assertRuntimeUpgradeSafe(adopted, options = {}) {
  const session = options.session ?? "default";
  await ensureServer(session);
  const agents = resultOf(runHerdr(session, ["agent", "list"]), "agents");
  const names = [adopted.config.herdr.leadAgent, adopted.config.herdr.coderAgent];
  const managed = agents.filter((agent) => names.includes(agent.name));
  const callerPane = process.env.HERDR_PANE_ID;
  if (callerPane && managed.some((agent) => agent.pane_id === callerPane)) {
    throw new Error("run sanbi upgrade outside the managed Lead/Coder Pi panes so they can be restarted safely");
  }
  const unsafe = managed.filter((agent) => !["idle", "done"].includes(agent.agent_status));
  if (unsafe.length) throw new Error(`cannot upgrade while managed Pi runtime is not idle: ${unsafe.map((agent) => `${agent.name}=${agent.agent_status}`).join(", ")}`);
  return managed;
}

export async function restartProjectRuntime(adopted, options = {}) {
  const session = options.session ?? "default";
  const managed = await assertRuntimeUpgradeSafe(adopted, options);
  for (const agent of managed) runHerdr(session, ["agent", "send-keys", agent.name, "ctrl+d"]);
  const deadline = Date.now() + 15_000;
  while (managed.length && Date.now() < deadline) {
    const live = resultOf(runHerdr(session, ["agent", "list"]), "agents");
    if (managed.every((old) => !live.some((agent) => agent.name === old.name))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const remaining = resultOf(runHerdr(session, ["agent", "list"]), "agents").filter((agent) => managed.some((old) => old.name === agent.name));
  if (remaining.length) throw new Error(`managed Pi process did not exit cleanly: ${remaining.map((agent) => agent.name).join(", ")}`);
  return ensureProjectRuntime(adopted, options);
}

export function attachHerdr(session) {
  if (session === "default") runHerdr(session, [], { inherit: true });
  else runHerdr(session, ["session", "attach", session], { inherit: true });
}
