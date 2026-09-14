import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Identity = { role: "lead" | "coder"; project: string; peer: string };

const TASK_RE = /^T-\d{3,}$/;
const VALID_STATUSES = new Set(["DRAFT", "READY", "CODING", "BLOCKED", "REVIEW", "DONE"]);

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
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
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

  pi.on("session_start", async (_event, ctx) => {
    try {
      const agent = await identity(ctx.cwd);
      const active = await activeTask(ctx.cwd);
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
      const expected = active ? `${agent.project}/${agent.role}/${active.id}` : `${agent.project}/${agent.role}/${agent.role === "lead" ? "inbox" : "idle"}`;
      if (pi.getSessionName() !== expected) pi.setSessionName(expected);
      const role = await readRequired(join(ctx.cwd, ".agent", "roles", `${agent.role}.md`));
      const protocol = await readRequired(join(ctx.cwd, ".agent", "protocol.md"));
      const runtime = `Runtime identity: you are the ${agent.role.toUpperCase()} agent for ${agent.project}. Your Herdr peer target is ${agent.peer}. Use that exact peer name for Herdr signalling.`;
      return { systemPrompt: `${event.systemPrompt}\n\n${role}\n\n${protocol}\n\n${runtime}` };
    } catch (error: any) {
      ctx.ui.notify(`Lifecycle context refresh failed: ${error.message}`, "error");
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

        await writeAtomic(active.path, transition(active, "READY", "CODING"));
        const message = `Start ${active.id}.\nRe-read .agent/project.md.\nRead and execute .agent/tasks/${active.id}.md.`;
        const sent = await pi.exec("herdr", ["agent", "prompt", agent.peer, message], { timeout: 10_000 });
        if (sent.code !== 0) {
          const current = await activeTask(ctx.cwd);
          if (current?.id === active.id && current.status === "CODING") {
            await writeAtomic(current.path, transition(current, "CODING", "READY"));
          }
          throw new Error(`Coder invocation failed; ${active.id} was returned to READY: ${(sent.stderr || sent.stdout).trim()}`);
        }

        pi.setSessionName(`${agent.project}/lead/${active.id}`);
        ctx.ui.notify(`${active.id} authorized and delegated to Coder`, "info");
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

        const sent = await pi.exec("herdr", ["agent", "prompt", agent.peer, `/task-reset ${active.id} ${nonce}`], { timeout: 10_000 });
        if (sent.code !== 0) throw new Error(`Coder reset request failed: ${(sent.stderr || sent.stdout).trim()}`);

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
