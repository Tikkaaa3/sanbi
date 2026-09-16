import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { cleanupRuntimeTemp, createRuntimeTemp } from "../sanbi/runtime-temp.js";
import { startRuntimeProcess } from "../sanbi/runtime-process.js";

type Identity = { role: "lead" | "coder"; project: string; peer: string };

const TASK_RE = /^T-\d{3,}$/;
const VALID_STATUSES = new Set(["DRAFT", "READY", "CODING", "BLOCKED", "REVIEW", "DONE"]);
const MAX_TRANSPORT_ERROR = 800;

function conciseError(value: unknown): string {
  const lines = String(value ?? "transport failed").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => !/^(usage:|options:|commands:|\s*-\w)/i.test(line)) ?? lines[0] ?? "transport failed";
  return useful.length <= MAX_TRANSPORT_ERROR ? useful : `${useful.slice(0, MAX_TRANSPORT_ERROR)}…`;
}

function signalMessage(kind: "start" | "continue" | "rework" | "blocked" | "review", task: string): string {
  if (kind === "start") return `Start ${task}.\nRe-read .agent/project.md.\nRead and execute .agent/tasks/${task}.md.`;
  if (kind === "continue") return `${task} may continue.\nRead .agent/results/${task}.md and continue the same task.`;
  if (kind === "rework") return `${task} requires changes.\nRead .agent/reviews/${task}.md and continue the same task.`;
  if (kind === "blocked") return `${task} is BLOCKED. Read .agent/results/${task}.md.`;
  return `${task} is ready for review. Read .agent/results/${task}.md.`;
}

async function signalPeer(pi: ExtensionAPI, agent: Identity, message: string): Promise<void> {
  const sent = await pi.exec("herdr", ["agent", "prompt", agent.peer, message], { timeout: 10_000 });
  if (sent.code !== 0) throw new Error(conciseError(sent.stderr || sent.stdout));
}

type Task = { id: string; status: string; active: boolean; path: string; text: string };

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("task has no YAML frontmatter");
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/);
    if (item) result[item[1]] = item[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return result;
}

async function tasks(cwd: string): Promise<Task[]> {
  const dir = join(cwd, ".agent", "tasks");
  let names: string[] = [];
  try { names = await readdir(dir); } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const output: Task[] = [];
  for (const name of names.filter((x) => /^T-\d+\.md$/i.test(x)).sort()) {
    const path = join(dir, name);
    const text = await readFile(path, "utf8");
    const data = frontmatter(text);
    if (!TASK_RE.test(data.id ?? "")) throw new Error(`${name}: invalid or missing id`);
    if (!VALID_STATUSES.has(data.status)) throw new Error(`${name}: invalid status ${data.status ?? "(missing)"}`);
    if (data.active !== "true" && data.active !== "false") throw new Error(`${name}: active must be true or false`);
    output.push({ id: data.id, status: data.status, active: data.active === "true", path, text });
  }
  return output;
}

async function activeTask(cwd: string): Promise<Task | undefined> {
  const active = (await tasks(cwd)).filter((task) => task.active);
  if (active.length > 1) throw new Error("multiple active tasks detected");
  return active[0];
}

async function readRequired(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function bootstrapText(cwd: string, role: string, handoff?: string, active?: Task): Promise<string> {
  const roleText = await readRequired(join(cwd, ".agent", "roles", `${role}.md`));
  const protocol = await readRequired(join(cwd, ".agent", "protocol.md"));
  let text = `Fresh ${role === "lead" ? "Lead" : "Coder"} session bootstrap. These instructions are authoritative.\n\n${roleText}\n\n${protocol}`;
  if (role === "lead") {
    text += `\n\n${await readRequired(join(cwd, ".agent", "project.md"))}`;
    if (handoff) text += `\n\nPrevious reviewed-task handoff:\n\n${handoff}`;
  } else if (active) {
    text += `\n\nCold-recovery state: ${active.id} is the active durable task with status ${active.status}. Read .agent/project.md, .agent/tasks/${active.id}.md, and any existing result/review artifacts. Recover according to the protocol; do not assume old conversation history is available.`;
  } else {
    text += "\n\nYou currently have no assigned task. Remain idle and do not modify application code until Lead delegates an active task. Re-read .agent/project.md when a task is assigned.";
  }
  return text;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function transition(task: Task, from: string, to: string): string {
  const header = task.text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!header) throw new Error(`${task.id}: missing frontmatter`);
  const occurrences = header[1].match(new RegExp(`^status:\\s*${from}\\s*$`, "gm")) ?? [];
  if (task.status !== from || occurrences.length !== 1) throw new Error(`${task.id}: expected one status: ${from} field`);
  return task.text.replace(new RegExp(`^status:\\s*${from}\\s*$`, "m"), `status: ${to}`);
}

function deactivate(task: Task): string {
  const header = task.text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!header) throw new Error(`${task.id}: missing frontmatter`);
  const occurrences = header[1].match(/^active:\s*true\s*$/gm) ?? [];
  if (occurrences.length !== 1) throw new Error(`${task.id}: expected one active: true field`);
  return task.text.replace(/^active:\s*true\s*$/m, "active: false");
}

function fail(ctx: any, message: string): void {
  ctx.ui.notify(`ERROR: ${message}`, "error");
}

export default function lifecycle(pi: ExtensionAPI) {
  let identityPromise: Promise<Identity> | undefined;
  let vcsPromise: Promise<"git" | "none"> | undefined;
  let observedCoderState: string | undefined;
  const taskMutations = new Set<string>();
  const allocatedRuntimeTemps = new Set<string>();
  const runtimeProcesses = new Map<string, any>();
  const mutateTask = async <T>(taskId: string, operation: () => Promise<T>): Promise<T> => {
    if (taskMutations.has(taskId)) throw new Error(`${taskId} already has a lifecycle action in progress`);
    taskMutations.add(taskId);
    try { return await operation(); } finally { taskMutations.delete(taskId); }
  };
  const vcsCapability = (cwd: string): Promise<"git" | "none"> => vcsPromise ??= (async () => {
    const probe = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 5_000 });
    return probe.code === 0 && probe.stdout.trim() === "true" ? "git" : "none";
  })().catch(() => "none");
  const identity = (cwd: string): Promise<Identity> => identityPromise ??= (async () => {
    const config = JSON.parse(await readRequired(join(cwd, ".agent", "config.json")));
    let role = process.env.LAD_AGENT_ROLE === "lead" || process.env.LAD_AGENT_ROLE === "coder"
      ? process.env.LAD_AGENT_ROLE : undefined;
    if (process.env.HERDR_ENV === "1") {
      const current = await pi.exec("herdr", ["pane", "current", "--current"], { timeout: 5_000 });
      if (current.code === 0) {
        const pane = JSON.parse(current.stdout)?.result?.pane;
        if (pane?.label === "LEAD") role = "lead";
        if (pane?.label === "CODER") role = "coder";
      }
    }
    if (role !== "lead" && role !== "coder") throw new Error("cannot determine role from pane label or LAD_AGENT_ROLE");
    const peer = role === "lead" ? config?.herdr?.coderAgent : config?.herdr?.leadAgent;
    if (!config?.project?.key || !peer) throw new Error("invalid .agent/config.json lifecycle identity");
    return { role, project: config.project.key, peer };
  })();

  const runtimeRole = process.env.SANBI_ROLE ?? process.env.LAD_AGENT_ROLE;
  if (runtimeRole === "lead") {
    pi.registerTool({
      name: "sanbi_signal_coder",
      label: "Continue Sanbi task",
      description: "Atomically continue one BLOCKED task or return one REVIEW task for rework, then signal the known Coder peer. Do not edit task status separately.",
      parameters: Type.Object({ kind: StringEnum(["continue", "rework"]), task: Type.String({ pattern: "^T-[0-9]{3,}$" }) }),
      execute: async (_call, params: any, _signal, _updates, ctx: any) => {
        const agent = await identity(ctx.cwd);
        if (agent.role !== "lead") throw new Error("sanbi_signal_coder is Lead-only");
        return mutateTask(params.task, async () => {
          const task = await activeTask(ctx.cwd);
          const expected = params.kind === "continue" ? "BLOCKED" : "REVIEW";
          if (!task || task.id !== params.task || task.status !== expected) throw new Error(`${params.task} must be the active ${expected} task`);
          if (params.kind === "rework") await readRequired(join(ctx.cwd, ".agent", "reviews", `${task.id}.md`));
          await writeAtomic(task.path, transition(task, expected, "CODING"));
          try {
            await signalPeer(pi, agent, signalMessage(params.kind, task.id));
          } catch (error: any) {
            const current = await activeTask(ctx.cwd);
            if (current?.id === task.id && current.status === "CODING") await writeAtomic(current.path, transition(current, "CODING", expected));
            throw new Error(`Coder signal failed; ${task.id} was returned to ${expected}: ${conciseError(error.message)}`);
          }
          return { content: [{ type: "text", text: `${task.id} moved ${expected} -> CODING and Coder was signaled for ${params.kind}.` }], details: { task: task.id, from: expected, to: "CODING", kind: params.kind } };
        });
      },
    });
  } else if (runtimeRole === "coder") {
    pi.registerTool({
      name: "sanbi_signal_lead",
      label: "Retry Lead notification",
      description: "Retry the canonical Lead notification for the active BLOCKED or REVIEW task. Normal notification is automatic after Coder settles.",
      parameters: Type.Object({ kind: StringEnum(["blocked", "review"]), task: Type.String({ pattern: "^T-[0-9]{3,}$" }) }),
      execute: async (_call, params: any, _signal, _updates, ctx: any) => {
        const agent = await identity(ctx.cwd);
        if (agent.role !== "coder") throw new Error("sanbi_signal_lead is Coder-only");
        const task = await activeTask(ctx.cwd);
        const expected = params.kind === "blocked" ? "BLOCKED" : "REVIEW";
        if (!task || task.id !== params.task || task.status !== expected) throw new Error(`${params.task} must be the active ${expected} task`);
        await signalPeer(pi, agent, signalMessage(params.kind, task.id));
        return { content: [{ type: "text", text: `${task.id} ${expected} notification sent to Lead.` }], details: { task: task.id, status: expected, kind: params.kind } };
      },
    });
  }

  pi.registerTool({
    name: "sanbi_runtime_temp",
    label: "Sanbi runtime temp",
    description: "Allocate or clean a positively-owned disposable OS-temp directory for browser profiles, traces, logs, screenshots, or smoke artifacts.",
    parameters: Type.Object({ action: StringEnum(["allocate", "cleanup"]), purpose: Type.Optional(Type.String({ maxLength: 40 })), path: Type.Optional(Type.String()) }),
    execute: async (_call, params: any, _signal, _updates, ctx: any) => {
      const agent = await identity(ctx.cwd);
      if (params.action === "allocate") {
        const directory = await createRuntimeTemp(agent.project, params.purpose || "run");
        allocatedRuntimeTemps.add(directory);
        return { content: [{ type: "text", text: directory }], details: { action: "allocate", path: directory } };
      }
      if (!params.path) throw new Error("cleanup requires path");
      const cleaned = await cleanupRuntimeTemp(params.path);
      if (!cleaned) throw new Error("cleanup refused: path is outside Sanbi OS temp or lacks Sanbi ownership marker");
      allocatedRuntimeTemps.delete(params.path);
      return { content: [{ type: "text", text: `Cleaned ${params.path}` }], details: { action: "cleanup", path: params.path } };
    },
  });

  pi.registerTool({
    name: "sanbi_runtime_process",
    label: "Sanbi runtime process",
    description: "Start, inspect, or stop a Sanbi-owned task-local verification process tree. Stop accepts only an opaque handle returned by start, never a PID.",
    parameters: Type.Object({
      action: StringEnum(["start", "status", "logs", "stop"]),
      purpose: Type.Optional(Type.String({ maxLength: 40 })),
      command: Type.Optional(Type.String({ minLength: 1, maxLength: 260 })),
      args: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 64 })),
      wait_for_http: Type.Optional(Type.String({ maxLength: 1_000 })),
      wait_for_output: Type.Optional(Type.String({ maxLength: 300 })),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000 })),
      handle: Type.Optional(Type.String({ pattern: "^rp-[a-f0-9-]+$" })),
    }),
    execute: async (_call, params: any, signal: AbortSignal | undefined, _updates, ctx: any) => {
      const agent = await identity(ctx.cwd);
      if (params.action === "start") {
        if (!params.command) throw new Error("start requires command");
        const owned = await startRuntimeProcess({
          projectId: agent.project, role: agent.role, session: ctx.sessionManager.getSessionFile(), purpose: params.purpose || "verification",
          command: params.command, args: params.args || [], cwd: ctx.cwd, waitForHttp: params.wait_for_http,
          waitForOutput: params.wait_for_output, timeoutMs: params.timeout_ms, signal,
        });
        runtimeProcesses.set(owned.handle, owned);
        const summary = [`handle: ${owned.handle}`, `pid: ${owned.pid}`, `purpose: ${owned.purpose}`, `log: ${owned.logPath}`, `started-at: ${owned.startedAt}`];
        if (owned.url) summary.push(`url: ${owned.url}`);
        return { content: [{ type: "text", text: summary.join("\n") }], details: { handle: owned.handle, pid: owned.pid, purpose: owned.purpose, logPath: owned.logPath, startedAt: owned.startedAt, url: owned.url } };
      }
      if (!params.handle) throw new Error(`${params.action} requires a Sanbi runtime process handle`);
      const owned = runtimeProcesses.get(params.handle);
      if (!owned) throw new Error(`unknown or unowned Sanbi runtime process handle: ${params.handle}`);
      if (params.action === "status") return { content: [{ type: "text", text: `${owned.handle}: ${owned.status()}` }], details: { handle: owned.handle, status: owned.status() } };
      if (params.action === "logs") return { content: [{ type: "text", text: await owned.logs() || "(no output)" }], details: { handle: owned.handle, logPath: owned.logPath } };
      await owned.stop({ cleanup: true });
      runtimeProcesses.delete(params.handle);
      return { content: [{ type: "text", text: `Stopped and cleaned ${params.handle}` }], details: { handle: params.handle, stopped: true } };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const agent = await identity(ctx.cwd);
      const active = await activeTask(ctx.cwd);
      if (agent.role === "coder") observedCoderState = active ? `${active.id}:${active.status}` : undefined;
      if (!pi.getSessionName()) {
        pi.setSessionName(active ? `${agent.project}/${agent.role}/${active.id}` : `${agent.project}/${agent.role}/${agent.role === "lead" ? "inbox" : "idle"}`);
      }
      if (ctx.sessionManager.getEntries().length === 0) {
        let handoff: string | undefined;
        if (agent.role === "lead" && active?.status === "DONE") {
          handoff = await readRequired(join(ctx.cwd, ".agent", "handoffs", `${active.id}.md`));
        }
        pi.sendMessage({ customType: "lad-bootstrap", content: await bootstrapText(ctx.cwd, agent.role, handoff, active), display: true });
      }
    } catch (error: any) {
      ctx.ui.notify(`Lifecycle bootstrap failed: ${error.message}`, "error");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const agent = await identity(ctx.cwd);
      const active = await activeTask(ctx.cwd);
      if (agent.role === "coder") observedCoderState = active ? `${active.id}:${active.status}` : undefined;
      const expected = active ? `${agent.project}/${agent.role}/${active.id}` : `${agent.project}/${agent.role}/${agent.role === "lead" ? "inbox" : "idle"}`;
      if (pi.getSessionName() !== expected) pi.setSessionName(expected);
      const role = await readRequired(join(ctx.cwd, ".agent", "roles", `${agent.role}.md`));
      const protocol = await readRequired(join(ctx.cwd, ".agent", "protocol.md"));
      const vcs = await vcsCapability(ctx.cwd);
      const runtime = `Runtime identity: you are the ${agent.role.toUpperCase()} agent for ${agent.project}. Repository capability: VCS: ${vcs}. Routine peer signaling is Sanbi lifecycle infrastructure; use the Sanbi-native action exposed for your role and do not discover or operate the Herdr CLI for it.`;
      return { systemPrompt: `${event.systemPrompt}\n\n${role}\n\n${protocol}\n\n${runtime}` };
    } catch (error: any) {
      ctx.ui.notify(`Lifecycle context refresh failed: ${error.message}`, "error");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const agent = await identity(ctx.cwd);
      if (agent.role !== "coder") return;
      const active = await activeTask(ctx.cwd);
      const current = active ? `${active.id}:${active.status}` : undefined;
      const changed = current !== observedCoderState;
      observedCoderState = current;
      if (!active || !changed || (active.status !== "BLOCKED" && active.status !== "REVIEW")) return;

      await signalPeer(pi, agent, signalMessage(active.status === "BLOCKED" ? "blocked" : "review", active.id));
      ctx.ui.notify(`${active.id} ${active.status} notification sent to Lead`, "info");
    } catch (error: any) {
      ctx.ui.notify(`Automatic Lead notification failed: ${error.message}`, "error");
    }
  });

  pi.registerCommand("execute", {
    description: "Owner authorization gate: start the one active READY task",
    handler: async (_args, ctx) => {
      const agent = await identity(ctx.cwd).catch((error) => { fail(ctx, error.message); return undefined; });
      if (!agent || agent.role !== "lead") return fail(ctx, "/execute may only run in the Lead process");
      let active: Task | undefined;
      try {
        active = await activeTask(ctx.cwd);
        if (!active) throw new Error("no active task exists; prepare a task and move it to READY first");
        if (active.status !== "READY") {
          const suffix = active.status === "DONE" ? "; use /next after completing final discussion" : "";
          throw new Error(`active task ${active.id} has status ${active.status}, not READY${suffix}`);
        }

        await mutateTask(active.id, async () => {
          const authorized = await activeTask(ctx.cwd);
          if (!authorized || authorized.id !== active!.id || authorized.status !== "READY") throw new Error(`${active!.id} is no longer the active READY task`);
          await writeAtomic(authorized.path, transition(authorized, "READY", "CODING"));
          try {
            await signalPeer(pi, agent, signalMessage("start", authorized.id));
          } catch (signalError: any) {
            const current = await activeTask(ctx.cwd);
            if (current?.id === authorized.id && current.status === "CODING") {
              await writeAtomic(current.path, transition(current, "CODING", "READY"));
            }
            throw new Error(`Coder invocation failed; ${authorized.id} was returned to READY: ${conciseError(signalError.message)}`);
          }
          pi.setSessionName(`${agent.project}/lead/${authorized.id}`);
          ctx.ui.notify(`${authorized.id} authorized and delegated to Coder`, "info");
        });
      } catch (error: any) {
        fail(ctx, error.message);
      }
    },
  });

  pi.registerCommand("task-reset", {
    description: "Internal: rotate Coder into a fresh idle session",
    handler: async (args, ctx) => {
      const agent = await identity(ctx.cwd).catch((error) => { fail(ctx, error.message); return undefined; });
      if (!agent || agent.role !== "coder") return fail(ctx, "/task-reset may only run in the Coder process");
      const [taskId, nonce, ...extra] = args.trim().split(/\s+/);
      if (!TASK_RE.test(taskId ?? "") || !/^[a-f0-9-]{16,}$/i.test(nonce ?? "") || extra.length) {
        return fail(ctx, "usage: /task-reset <T-nnn> <nonce>");
      }
      try {
        const active = await activeTask(ctx.cwd);
        if (!active || active.id !== taskId || active.status !== "DONE") throw new Error(`${taskId} is not the active DONE task`);
        const content = await bootstrapText(ctx.cwd, "coder");
        const ackDir = join(ctx.cwd, ".agent", ".runtime");
        const ack = join(ackDir, `reset-${nonce}.json`);
        await ctx.newSession({
          parentSession: ctx.sessionManager.getSessionFile(),
          setup: async (sm) => {
            sm.appendSessionInfo(`${agent.project}/coder/idle`);
            sm.appendCustomMessageEntry("lad-bootstrap", content, true);
          },
          withSession: async (fresh) => {
            await mkdir(ackDir, { recursive: true });
            await writeAtomic(ack, JSON.stringify({ task: taskId, role: "coder", project: agent.project, at: new Date().toISOString() }) + "\n");
            fresh.ui.notify(`Coder rotated after ${taskId}; now idle`, "info");
          },
        });
      } catch (error: any) {
        fail(ctx, error.message);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...runtimeProcesses.values()].map((owned) => owned.stop({ cleanup: true }).catch(() => false)));
    runtimeProcesses.clear();
    await Promise.all([...allocatedRuntimeTemps].map((directory) => cleanupRuntimeTemp(directory).catch(() => false)));
    allocatedRuntimeTemps.clear();
  });

  pi.registerCommand("next", {
    description: "Rotate a reviewed DONE task into fresh Lead and Coder sessions",
    handler: async (_args, ctx) => {
      const agent = await identity(ctx.cwd).catch((error) => { fail(ctx, error.message); return undefined; });
      if (!agent || agent.role !== "lead") return fail(ctx, "/next may only run in the Lead process");
      try {
        const active = await activeTask(ctx.cwd);
        if (!active) throw new Error("no completed active task exists");
        if (active.status !== "DONE") throw new Error(`active task ${active.id} has status ${active.status}, not DONE`);
        const handoffPath = join(ctx.cwd, ".agent", "handoffs", `${active.id}.md`);
        const handoff = await readRequired(handoffPath);
        const nonce = randomUUID();
        const ack = join(ctx.cwd, ".agent", ".runtime", `reset-${nonce}.json`);

        try { await signalPeer(pi, agent, `/task-reset ${active.id} ${nonce}`); }
        catch (error: any) { throw new Error(`Coder reset request failed: ${conciseError(error.message)}`); }

        const deadline = Date.now() + 30_000;
        let acknowledged = false;
        while (Date.now() < deadline) {
          try { await readFile(ack, "utf8"); acknowledged = true; break; } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!acknowledged) throw new Error("Coder did not acknowledge reset within 30 seconds; task remains active");
        await unlink(ack).catch(() => undefined);

        await writeAtomic(active.path, deactivate(active));
        const content = await bootstrapText(ctx.cwd, "lead", handoff);
        const result = await ctx.newSession({
          parentSession: ctx.sessionManager.getSessionFile(),
          setup: async (sm) => {
            sm.appendSessionInfo(`${agent.project}/lead/inbox`);
            sm.appendCustomMessageEntry("lad-bootstrap", content, true);
          },
          withSession: async (fresh) => fresh.ui.notify(`${active.id} archived; fresh Lead inbox ready`, "info"),
        });
        if (result.cancelled) throw new Error("Lead session rotation was cancelled after task deactivation");
      } catch (error: any) {
        fail(ctx, error.message);
      }
    },
  });
}
