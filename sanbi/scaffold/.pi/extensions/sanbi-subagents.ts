import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext, ThinkingLevel } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mkdirSync, readFileSync, readdirSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { activityCounts, activityRows, createInspectReadModel, currentActivity, latestVisibleText, observeInspectEvent } from "../sanbi/subagent-ui.js";

// Disable the legacy process-spawning package before later global packages load.
// In-process children also inherit this guard, while explicit child resources
// exclude every delegation extension and tool independently.
process.env.PI_SUBAGENT_MAX_DEPTH = "0";

const MAX_RUNNING = 3;
const MAX_RESULT_CHARS = 16_000;
const MAX_TRANSCRIPT_CHARS = 120_000;
const UI_STREAM_THROTTLE_MS = 75;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const TOOL_NAMES = ["subagent_spawn", "subagent_wait", "subagent_check", "subagent_cancel"];
const LEGACY_TOOL = "subagent";
const TOGGLE_FILE = join(getAgentDir(), "subagents-toggle.json");
const ROLES = {
  lead: ["scout", "researcher", "reviewer"],
  coder: ["scout", "researcher", "diagnostic-scout"],
} as const;
const PROFILES: Record<string, { model: string; thinking: ThinkingLevel; tools: string[] }> = {
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium", tools: ["read", "grep", "find", "ls"] },
  researcher: { model: "openai-codex/gpt-5.6-luna", thinking: "high", tools: ["read", "grep", "find", "ls", "web_search", "fetch_content", "source_check", "get_search_content"] },
  reviewer: { model: "openai-codex/gpt-5.6-sol", thinking: "high", tools: ["read", "grep", "find", "ls", "bash"] },
  "diagnostic-scout": { model: "openai-codex/gpt-5.6-sol", thinking: "medium", tools: ["read", "grep", "find", "ls", "bash"] },
};
const KNOWN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "web_search", "fetch_content", "source_check", "get_search_content"]);
const FORBIDDEN_CHILD_TOOLS = new Set([LEGACY_TOOL, ...TOOL_NAMES, "write", "edit", "ask_user", "workflow"]);

type Role = "lead" | "coder";
type Definition = { name: string; description: string; model: string; thinking: ThinkingLevel; tools: string[]; instructions: string; source: string };
type Status = "starting" | "running" | "done" | "error" | "cancelled";
type Child = {
  id: string; title: string; definition: Definition; status: Status; startedAt: number; endedAt?: number;
  session?: AgentSession; unsubscribe?: () => void; transcript: string[]; liveText: string; prompt: string; inspect: any; error?: string;
  final?: string; resultDelivered: boolean; resultDelivery?: "wait" | "async"; cancelRequested: boolean;
};

function roleFromEnvironment(): Role {
  const value = process.env.SANBI_ROLE ?? process.env.LAD_AGENT_ROLE;
  if (value !== "lead" && value !== "coder") throw new Error("Sanbi Subagent V2 requires SANBI_ROLE=lead|coder (or LAD_AGENT_ROLE)");
  return value;
}

function parseDefinition(text: string, source: string): Definition {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`${source}: missing frontmatter`);
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^([a-z_][a-z0-9_]*):\s*(.*?)\s*$/i);
    if (!item) throw new Error(`${source}: malformed frontmatter: ${line}`);
    if (Object.hasOwn(data, item[1])) throw new Error(`${source}: duplicate ${item[1]}`);
    data[item[1]] = item[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  for (const key of ["name", "description", "model", "thinking", "tools"]) if (!data[key]) throw new Error(`${source}: missing ${key}`);
  const tools = data.tools.split(",").map((x) => x.trim()).filter(Boolean);
  const instructions = match[2].trim();
  if (!/^[a-z][a-z0-9-]*$/.test(data.name) || !instructions) throw new Error(`${source}: invalid name or empty instructions`);
  if (!new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(data.thinking)) throw new Error(`${source}: unsupported thinking ${data.thinking}`);
  if (!tools.length || tools.length !== new Set(tools).size) throw new Error(`${source}: tools must be a unique comma-separated list`);
  for (const tool of tools) {
    if (!KNOWN_TOOLS.has(tool)) throw new Error(`${source}: unknown tool ${tool}`);
    if (FORBIDDEN_CHILD_TOOLS.has(tool)) throw new Error(`${source}: forbidden tool ${tool}`);
  }
  return { name: data.name, description: data.description, model: data.model, thinking: data.thinking as ThinkingLevel, tools, instructions, source };
}

function loadRegistry(cwd: string, role: Role): Map<string, Definition> {
  const definitions: Definition[] = [];
  for (const scope of ["shared", role]) {
    const directory = join(cwd, ".agent", "subagents", scope);
    let names: string[];
    try { names = readdirSync(directory).filter((x) => x.endsWith(".md")).sort(); }
    catch (error: any) { throw new Error(`${directory}: ${error.message}`); }
    for (const filename of names) {
      const source = join(directory, filename);
      const definition = parseDefinition(readFileSync(source, "utf8"), source);
      if (`${definition.name}.md` !== filename) throw new Error(`${source}: filename must match name`);
      definitions.push(definition);
    }
  }
  const names = definitions.map((x) => x.name);
  const expected = [...ROLES[role]];
  if (new Set(names).size !== names.length || names.slice().sort().join() !== expected.slice().sort().join()) {
    throw new Error(`${role} registry must contain exactly ${expected.join(", ")}`);
  }
  for (const definition of definitions) {
    const profile = PROFILES[definition.name];
    if (!profile || profile.model !== definition.model || profile.thinking !== definition.thinking || profile.tools.join() !== definition.tools.join()) {
      throw new Error(`${definition.source}: profile differs from canonical Sanbi configuration`);
    }
  }
  return new Map(definitions.map((x) => [x.name, x]));
}

function readEnabled(): boolean {
  try { return JSON.parse(readFileSync(TOGGLE_FILE, "utf8")).enabled !== false; } catch { return true; }
}
function writeEnabled(enabled: boolean) {
  mkdirSync(dirname(TOGGLE_FILE), { recursive: true });
  writeFileSync(TOGGLE_FILE, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}
function bounded(value: unknown, max = MAX_RESULT_CHARS): string {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated]`;
}
function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
}
function elapsed(child: Child): string {
  const seconds = Math.max(0, Math.floor(((child.endedAt ?? Date.now()) - child.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
function modelLabel(model: string): string {
  const id = model.split("/").at(-1) ?? model;
  return id.replace(/^gpt-[\d.]+-/, "").replace(/^./, (x) => x.toUpperCase());
}
function lastAssistantMessage(session: AgentSession): any | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message: any = session.messages[i];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}
function finalAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message: any = session.messages[i];
    if (message?.role !== "assistant") continue;
    const text = (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").trim();
    if (text) return text;
  }
  return "";
}
function childResult(child: Child): string {
  const response = child.status === "error" ? child.error : (child.final || child.error);
  return bounded(`agent: ${child.definition.name}\ntitle: ${child.title}\nstatus: ${child.status}\nfinal response:\n${response || "(no response)"}`);
}
function contextPercent(child: Child): string {
  const usage = child.session?.getContextUsage();
  const tokens = usage?.tokens;
  const window = child.session?.model?.contextWindow ?? usage?.contextWindow;
  if (typeof tokens !== "number" || typeof window !== "number" || window <= 0) return "?%";
  return `${Math.max(0, Math.min(100, Math.round(tokens / window * 100)))}%`;
}
function waitBounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise.catch(() => undefined), new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);
}

class Manager {
  readonly children: Child[] = [];
  private listeners = new Set<() => void>();
  private nextId = 1;
  private modelRuntime?: ModelRuntime;
  private activeContext?: ExtensionContext;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private deliveryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private validationError?: string;
  private runs = new Set<Promise<void>>();
  constructor(readonly pi: ExtensionAPI, readonly role: Role, readonly registry: Map<string, Definition>) {}
  async validateModels() {
    this.modelRuntime ??= await ModelRuntime.create();
    for (const definition of this.registry.values()) {
      const [provider, ...id] = definition.model.split("/");
      if (!this.modelRuntime.getModel(provider, id.join("/"))) throw new Error(`Sanbi subagent model is unavailable: ${definition.model}`);
    }
    const researcher = this.registry.get("researcher");
    if (researcher) {
      const available = new Set(this.pi.getAllTools().map((tool) => tool.name));
      const missing = researcher.tools.filter((tool) => !["read", "grep", "find", "ls"].includes(tool) && !available.has(tool));
      if (missing.length) throw new Error(`Sanbi researcher requires pi-web-access tools: ${missing.join(", ")}`);
    }
  }
  setContext(ctx: ExtensionContext) { this.activeContext = ctx; this.refreshTools(); this.notify(); }
  failValidation(ctx: ExtensionContext, error: unknown) {
    this.activeContext = ctx;
    this.validationError = bounded(error instanceof Error ? error.message : error, 4_096);
    this.refreshTools();
    ctx.ui.notify(`Subagent V2 disabled: ${this.validationError}`, "error");
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify() {
    if (this.closed || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      for (const listener of this.listeners) listener();
      const running = this.children.filter((x) => x.status === "starting" || x.status === "running").length;
      this.activeContext?.ui.setWidget("sanbi-subagents-running", running ? [`■ ${running} subagent${running === 1 ? "" : "s"} running · /subagents`] : undefined, { placement: "belowEditor" });
    }, UI_STREAM_THROTTLE_MS);
  }
  refreshTools() {
    const enabled = readEnabled() && !this.validationError;
    const active = this.pi.getActiveTools().filter((name) => name !== LEGACY_TOOL && !TOOL_NAMES.includes(name));
    if (enabled) active.push(...TOOL_NAMES);
    this.pi.setActiveTools([...new Set(active)]);
  }
  private append(child: Child, line: string) {
    child.transcript.push(line);
    let size = child.transcript.reduce((sum, item) => sum + item.length + 1, child.liveText.length);
    while (size > MAX_TRANSCRIPT_CHARS && child.transcript.length > 1) size -= child.transcript.shift()!.length + 1;
    this.notify();
  }
  async spawn(agent: string, prompt: string, title?: string): Promise<Child> {
    if (this.validationError) throw new Error(`Subagent V2 is disabled: ${this.validationError}`);
    if (this.closed) throw new Error("subagent manager is shutting down");
    const definition = this.registry.get(agent);
    if (!definition) throw new Error(`${agent} is not available to ${this.role}; allowed: ${[...this.registry.keys()].join(", ")}`);
    if (this.children.filter((x) => x.status === "starting" || x.status === "running").length >= MAX_RUNNING) throw new Error(`maximum ${MAX_RUNNING} concurrently running subagents reached`);
    const child: Child = { id: `sa-${this.nextId++}`, title: bounded(title || prompt.split(/\r?\n/)[0] || agent, 100), definition, status: "starting", startedAt: Date.now(), transcript: [`USER: ${bounded(prompt, 8_000)}`], liveText: "", prompt: bounded(prompt, 8_000), inspect: createInspectReadModel(prompt), resultDelivered: false, cancelRequested: false };
    this.children.push(child); this.notify();
    const run = this.run(child, prompt);
    this.runs.add(run);
    void run.finally(() => this.runs.delete(run));
    return child;
  }
  private async run(child: Child, prompt: string) {
    try {
      this.modelRuntime ??= await ModelRuntime.create();
      if (this.closed || child.cancelRequested) throw new Error("subagent cancelled before session creation");
      const [provider, ...idParts] = child.definition.model.split("/");
      const model = this.modelRuntime.getModel(provider, idParts.join("/"));
      if (!model) throw new Error(`Sanbi subagent model is unavailable: ${child.definition.model}`);
      const cwd = this.activeContext?.cwd;
      if (!cwd || !this.activeContext?.isProjectTrusted()) throw new Error("trusted parent project context is required for subagents");
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
      const webAgent = child.definition.name === "researcher";
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        appendSystemPrompt: [child.definition.instructions, "You are a leaf Sanbi specialist. Never delegate, run parent lifecycle commands, or open owner-interactive UI. Return the concise result to your parent."],
        extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((extension: any) => webAgent && /pi-web-access/i.test(`${extension.path} ${extension.resolvedPath}`)), errors: [] }),
      });
      await loader.reload();
      const parentSession = this.activeContext.sessionManager.getSessionFile();
      const sessionManager = SessionManager.create(cwd, undefined, parentSession ? { parentSession } : undefined);
      sessionManager.appendCustomEntry("sanbi-subagent", { parentRole: this.role, agent: child.definition.name, title: child.title, version: 2 });
      sessionManager.appendSessionInfo(`sanbi/${this.role}/${child.definition.name}: ${child.title}`);
      const created = await createAgentSession({ cwd, agentDir, modelRuntime: this.modelRuntime, model, thinkingLevel: child.definition.thinking, tools: child.definition.tools, excludeTools: [...FORBIDDEN_CHILD_TOOLS], sessionManager, settingsManager, resourceLoader: loader });
      child.session = created.session;
      if (this.closed || child.cancelRequested) { await child.session.abort(); child.session.dispose(); child.session = undefined; throw new Error("subagent cancelled before prompt"); }
      await child.session.bindExtensions({ mode: "print" });
      const actualTools = child.session.getActiveToolNames().slice().sort();
      const expectedTools = child.definition.tools.slice().sort();
      if (actualTools.join() !== expectedTools.join()) throw new Error(`child tool policy mismatch: expected ${expectedTools.join(", ")}; got ${actualTools.join(", ")}`);
      child.unsubscribe = child.session.subscribe((event: any) => {
        if (event.type === "agent_start") { child.status = "running"; this.notify(); }
        else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          child.liveText += event.assistantMessageEvent.delta;
          observeInspectEvent(child.inspect, { type: "assistant_text_delta", delta: event.assistantMessageEvent.delta });
          this.notify();
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
          if (child.liveText.trim()) {
            this.append(child, `ASSISTANT: ${child.liveText.trim()}`);
            observeInspectEvent(child.inspect, { type: "assistant_text", text: child.liveText.trim() });
          }
          child.liveText = "";
        } else if (event.type === "tool_execution_start") {
          observeInspectEvent(child.inspect, event);
          this.append(child, `TOOL ${event.toolName}: ${bounded(safeJson(event.args), 2_000)}`);
        } else if (event.type === "tool_execution_end") {
          observeInspectEvent(child.inspect, event);
          const detail = event.result === undefined ? "" : ` ${bounded(safeJson(event.result), 2_000)}`;
          this.append(child, `TOOL ${event.toolName}: ${event.isError ? "ERROR" : "done"}${detail}`);
        }
      });
      child.status = "running"; this.notify();
      await child.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
      await child.session.waitForIdle();
      const terminal = lastAssistantMessage(child.session);
      child.final = bounded(finalAssistantText(child.session));
      if (terminal?.stopReason === "error") throw new Error(terminal.errorMessage || "subagent model request failed");
      if (terminal?.stopReason === "aborted") child.cancelRequested = true;
      child.status = child.cancelRequested ? "cancelled" : "done";
    } catch (error: any) {
      child.error = bounded(error?.message ?? error, 4_096);
      child.status = child.cancelRequested ? "cancelled" : "error";
      observeInspectEvent(child.inspect, { type: "error", error: child.error });
      this.append(child, `ERROR: ${child.error}`);
    } finally {
      child.endedAt = Date.now();
      if (!this.closed) { this.notify(); this.scheduleAsyncDelivery(child); }
    }
  }
  private scheduleAsyncDelivery(child: Child) {
    if (this.closed || child.resultDelivered || this.deliveryTimer) return;
    this.deliveryTimer = setTimeout(() => { this.deliveryTimer = undefined; this.deliverPendingIfIdle(); }, 50);
  }
  deliverPendingIfIdle() {
    if (this.closed || !this.activeContext?.isIdle()) return;
    for (const child of this.children) {
      if (!child.endedAt || child.resultDelivered) continue;
      child.resultDelivered = true; child.resultDelivery = "async";
      this.pi.sendMessage({ customType: "sanbi-subagent-result", content: childResult(child), display: true, details: { id: child.id, agent: child.definition.name, title: child.title, status: child.status } }, { triggerTurn: true, deliverAs: "followUp" });
    }
  }
  get(id: string) { return this.children.find((x) => x.id === id); }
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const child = this.get(id); if (!child) throw new Error(`unknown subagent ${id}`);
    if (child.resultDelivered) return `${id} result was already delivered via ${child.resultDelivery}`;
    const deadline = Date.now() + timeoutMs;
    while (!child.endedAt && Date.now() < deadline) {
      if (signal?.aborted) throw new Error(`wait for ${id} cancelled`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!child.endedAt) return `${id} is still ${child.status}`;
    child.resultDelivered = true; child.resultDelivery = "wait";
    return childResult(child);
  }
  async cancel(id: string) {
    const child = this.get(id); if (!child) throw new Error(`unknown subagent ${id}`);
    if (child.endedAt) return false;
    child.cancelRequested = true;
    await child.session?.abort().catch(() => undefined);
    if (!child.session) { child.status = "cancelled"; child.endedAt = Date.now(); }
    this.notify(); return true;
  }
  async shutdown() {
    this.closed = true;
    for (const child of this.children) child.cancelRequested = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    this.activeContext?.ui.setWidget("sanbi-subagents-running", undefined);
    await Promise.all(this.children.map(async (child) => {
      child.unsubscribe?.();
      if (!child.session) return;
      await waitBounded(child.session.abort(), SHUTDOWN_TIMEOUT_MS);
      try {
        if (child.session.extensionRunner.hasHandlers("session_shutdown")) await waitBounded(child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" } as any), SHUTDOWN_TIMEOUT_MS);
      } catch {}
      child.session.dispose();
    }));
    await Promise.all([...this.runs].map((run) => waitBounded(run, SHUTDOWN_TIMEOUT_MS)));
  }
}

function dashboardLine(child: Child): string {
  const symbol = child.status === "running" || child.status === "starting" ? "■" : child.status === "done" ? "✓" : child.status === "error" ? "!" : "×";
  const active = child.status === "running" ? ` · ${currentActivity(child.inspect)}` : "";
  return `${symbol} ${child.title}  ${child.definition.name} · ${modelLabel(child.definition.model)} · ${child.definition.thinking} · ctx ${contextPercent(child)} · ${elapsed(child)} · ${child.status}${active}`;
}

async function inspectChild(ctx: ExtensionContext, manager: Manager, child: Child) {
  if (ctx.mode !== "tui") return;
  await ctx.ui.custom<null>((tui, theme, _keys, done) => {
    let offset = 0; let cached: string[] = []; let dirty = true; let lastRender = 0; let lastWidth = 0; let details = false; let showPrompt = false;
    const unsubscribe = manager.subscribe(() => { dirty = true; const now = Date.now(); if (now - lastRender >= UI_STREAM_THROTTLE_MS) tui.requestRender(); });
    const clock = setInterval(() => { dirty = true; tui.requestRender(); }, 1_000);
    const component = {
      render(width: number) {
        lastRender = Date.now();
        if (width !== lastWidth) { dirty = true; lastWidth = width; }
        if (dirty) {
          const header = [
            theme.fg("accent", theme.bold("Sanbi Subagent — Inspect")),
            truncateToWidth(`${child.title}  ${child.definition.name} · ${modelLabel(child.definition.model)} · ${child.definition.thinking} · ctx ${contextPercent(child)} · ${elapsed(child)} · ${child.status}`, width),
            theme.fg("dim", `↑/↓ scroll · d ${details ? "summary" : "details"} · p ${showPrompt ? "hide prompt" : "prompt"} · x cancel · Esc back`),
            "",
          ];
          let logical: string[];
          if (details) {
            logical = [theme.fg("accent", "RAW TRANSCRIPT"), ...child.transcript, ...(child.liveText ? [`ASSISTANT (live): ${child.liveText}`] : [])];
          } else {
            const rows = activityRows(child.inspect);
            logical = [
              theme.fg("accent", "CURRENT"),
              `  ${currentActivity(child.inspect)}`,
              "",
              theme.fg("accent", "ACTIVITY"),
              ...(rows.length ? rows.map((row: any) => `  ${row.symbol} ${row.text}`) : ["  No tool activity yet."]),
              `  ${activityCounts(child.inspect)}`,
              "",
              theme.fg("accent", "LATEST"),
              `  ${latestVisibleText(child.inspect, child.final || child.error || "") || "Waiting for visible output…"}`,
            ];
          }
          if (showPrompt) logical = [theme.fg("accent", "DELEGATED PROMPT"), `  ${child.prompt}`, "", ...logical];
          const body = logical.flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width - 2)));
          const height = Math.max(8, (process.stdout.rows || 24) - header.length - 2);
          offset = Math.max(0, Math.min(offset, Math.max(0, body.length - height)));
          cached = [...header.map((line) => truncateToWidth(line, width)), ...body.slice(offset, offset + height).map((line) => truncateToWidth(` ${line}`, width))]; dirty = false;
        }
        return cached;
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) done(null);
        else if (data === "x") { void manager.cancel(child.id); }
        else if (data === "d") { details = !details; offset = 0; }
        else if (data === "p") { showPrompt = !showPrompt; offset = 0; }
        else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
        else if (matchesKey(data, Key.down)) offset += 1;
        else if (matchesKey(data, "pageup")) offset = Math.max(0, offset - 10);
        else if (matchesKey(data, "pagedown")) offset += 10;
        dirty = true; tui.requestRender();
      },
      invalidate() { dirty = true; },
      dispose() { unsubscribe(); clearInterval(clock); },
    };
    return component;
  });
}

async function openDashboard(ctx: ExtensionContext, manager: Manager) {
  if (ctx.mode !== "tui") { ctx.ui.notify("/subagents dashboard requires Pi TUI mode", "warning"); return; }
  let selection = 0;
  while (true) {
    const action = await ctx.ui.custom<{ type: "inspect" | "cancel"; id: string } | null>((tui, theme, _keys, done) => {
      let dirty = true; let cached: string[] = []; let lastWidth = 0;
      const unsubscribe = manager.subscribe(() => { dirty = true; tui.requestRender(); });
      const clock = setInterval(() => { dirty = true; tui.requestRender(); }, 1_000);
      return {
        render(width: number) {
          if (width !== lastWidth) { dirty = true; lastWidth = width; }
          const children = manager.children;
          selection = Math.max(0, Math.min(selection, Math.max(0, children.length - 1)));
          if (dirty) {
            cached = [theme.fg("accent", theme.bold("Sanbi Subagent V2")), theme.fg("dim", "↑/↓ select · Enter inspect · x cancel · Esc close"), ""];
            if (!children.length) cached.push(theme.fg("muted", "No subagents created in this parent session."));
            else {
              const capacity = Math.max(3, (process.stdout.rows || 24) - cached.length - 2);
              const start = Math.max(0, Math.min(selection - Math.floor(capacity / 2), Math.max(0, children.length - capacity)));
              children.slice(start, start + capacity).forEach((child, offset) => {
                const index = start + offset;
                cached.push(truncateToWidth(`${index === selection ? ">" : " "} ${dashboardLine(child)}`, width));
              });
              if (children.length > capacity) cached.push(theme.fg("dim", `${start + 1}-${Math.min(children.length, start + capacity)} of ${children.length}`));
            }
            cached = cached.map((line) => truncateToWidth(line, width));
            dirty = false;
          }
          return cached;
        },
        handleInput(data: string) {
          const children = manager.children;
          if (matchesKey(data, Key.escape)) done(null);
          else if (matchesKey(data, Key.up)) selection = Math.max(0, selection - 1);
          else if (matchesKey(data, Key.down)) selection = Math.min(Math.max(0, children.length - 1), selection + 1);
          else if (matchesKey(data, Key.enter) && children[selection]) done({ type: "inspect", id: children[selection].id });
          else if (data === "x" && children[selection]) done({ type: "cancel", id: children[selection].id });
          dirty = true; tui.requestRender();
        },
        invalidate() { dirty = true; },
        dispose() { unsubscribe(); clearInterval(clock); },
      };
    });
    if (!action) return;
    const child = manager.get(action.id); if (!child) continue;
    if (action.type === "cancel") await manager.cancel(child.id);
    else await inspectChild(ctx, manager, child);
  }
}

export default function sanbiSubagents(pi: ExtensionAPI) {
  const role = roleFromEnvironment();
  let registry: Map<string, Definition>;
  let manager: Manager;
  try { registry = loadRegistry(process.cwd(), role); manager = new Manager(pi, role, registry); }
  catch (error: any) { throw new Error(`Sanbi Subagent V2 registry failed: ${error.message}`); }

  const AgentSchema = StringEnum(ROLES[role]);
  pi.registerTool({
    name: "subagent_spawn", label: "Spawn Sanbi specialist",
    description: `Spawn one fresh in-process specialist. Allowed for ${role}: ${ROLES[role].join(", ")}. Returns immediately with an ID.`,
    parameters: Type.Object({ agent: AgentSchema, prompt: Type.String({ minLength: 1 }), title: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }),
    execute: async (_id, params: any) => {
      try { const child = await manager.spawn(params.agent, params.prompt, params.title); return { content: [{ type: "text", text: `Spawned ${child.id}: ${child.title} (${child.definition.name})` }], details: { id: child.id, status: child.status } }; }
      catch (error: any) { throw new Error(error.message); }
    },
  });
  pi.registerTool({
    name: "subagent_wait", label: "Wait for Sanbi specialist", description: "Wait for one specialist result. A final result is delivered at most once.",
    parameters: Type.Object({ id: Type.String(), timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 300_000 })) }),
    execute: async (_call, params: any, signal: AbortSignal | undefined) => { try { return { content: [{ type: "text", text: await manager.wait(params.id, params.timeout_ms ?? 120_000, signal) }], details: { id: params.id } }; } catch (error: any) { throw new Error(error.message); } },
  });
  pi.registerTool({
    name: "subagent_check", label: "Check Sanbi specialists", description: "Check compact specialist status without injecting transcripts or final responses.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    execute: async (_call, params: any) => { const children = params.id ? manager.children.filter((x) => x.id === params.id) : manager.children; return { content: [{ type: "text", text: children.length ? children.map((x) => `${x.id}: ${dashboardLine(x)}`).join("\n") : "No matching subagents." }], details: { count: children.length } }; },
  });
  pi.registerTool({
    name: "subagent_cancel", label: "Cancel Sanbi specialist", description: "Cancel one running specialist.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_call, params: any) => { try { const cancelled = await manager.cancel(params.id); return { content: [{ type: "text", text: cancelled ? `Cancellation requested for ${params.id}` : `${params.id} already settled` }], details: { id: params.id, cancelled } }; } catch (error: any) { throw new Error(error.message); } },
  });

  let watching = false;
  pi.registerCommand("subagents", {
    description: "Dashboard or global toggle: /subagents [on|off|toggle|status]",
    handler: async (args, ctx) => {
      manager.setContext(ctx);
      const arg = args.trim().toLowerCase();
      if (!arg) return openDashboard(ctx, manager);
      if (arg === "status") { ctx.ui.notify(`Subagents: ${readEnabled() ? "ON" : "OFF"}`, "info"); return; }
      let enabled: boolean;
      if (["on", "enable", "enabled"].includes(arg)) enabled = true;
      else if (["off", "disable", "disabled"].includes(arg)) enabled = false;
      else if (arg === "toggle") enabled = !readEnabled();
      else { ctx.ui.notify("Usage: /subagents [on|off|toggle|status]", "warning"); return; }
      writeEnabled(enabled); manager.refreshTools(); ctx.ui.notify(`Subagents: ${enabled ? "ON" : "OFF"}`, "info");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    try { await manager.validateModels(); }
    catch (error) {
      manager.failValidation(ctx, error);
      throw error;
    }
    manager.setContext(ctx);
    if (!watching) { watchFile(TOGGLE_FILE, { interval: 500 }, () => manager.refreshTools()); watching = true; }
  });
  pi.on("before_agent_start", async () => { manager.refreshTools(); });
  pi.on("agent_settled", async () => { manager.deliverPendingIfIdle(); });
  pi.on("session_shutdown", async () => { if (watching) unwatchFile(TOGGLE_FILE); watching = false; await manager.shutdown(); });
}
