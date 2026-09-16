import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIMEOUT_MS = 8_000;
const BAR_WIDTH = 20;
const MAX_STDERR = 4_096;
const MAX_STDOUT_BUFFER = 1_048_576;

type WindowName = "5-hour" | "Weekly";
type RateLimitWindow = {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};
type RateLimitSnapshot = {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
};
type ChatGptAccount = { type: "chatgpt"; planType?: unknown };
export type UsageData = {
  account: ChatGptAccount;
  snapshot: RateLimitSnapshot | null;
};
type RpcResponse = { id?: unknown; result?: unknown; error?: { message?: unknown } };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type ErrorKind = "missing" | "auth" | "timeout" | "protocol";
type SpawnCodex = () => ChildProcessWithoutNullStreams;

export function isRpcResponse(value: unknown): value is RpcResponse {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class UsageError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind) {
    super(kind);
    this.kind = kind;
  }
}

export function remainingPercent(usedPercent: unknown): number | null {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)));
}

export function classifyWindow(durationMins: unknown): WindowName | undefined {
  if (typeof durationMins !== "number" || !Number.isFinite(durationMins)) return undefined;
  if (Math.abs(durationMins - 300) <= 15) return "5-hour";
  if (Math.abs(durationMins - 10_080) <= 180) return "Weekly";
  return undefined;
}

export function formatBar(remaining: number): string {
  const safe = Math.min(100, Math.max(0, remaining));
  const filled = Math.round((safe / 100) * BAR_WIDTH);
  return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

export function formatReset(resetsAt: unknown, now = new Date()): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  const reset = new Date(resetsAt * 1_000);
  if (!Number.isFinite(reset.getTime())) return null;

  const deltaMs = reset.getTime() - now.getTime();
  if (deltaMs <= 0) return "Reset due now";
  if (deltaMs < 24 * 60 * 60 * 1_000) {
    const totalMinutes = Math.max(1, Math.ceil(deltaMs / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `Resets in ${minutes}m`;
    return `Resets in ${hours}h ${String(minutes).padStart(2, "0")}m`;
  }

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = `${months[reset.getMonth()]} ${reset.getDate()}`;
  const time = `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`;
  return `Resets ${date}, ${time}`;
}

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_prolite: "Self Serve Business ProLite",
  self_serve_business_usage_based: "Self Serve Business Usage Based",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  enterprise_cbp_usage_based: "Enterprise CBP Usage Based",
  enterprise: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

export function formatPlan(planType: unknown): string {
  const plan = typeof planType === "string" ? PLAN_NAMES[planType] : undefined;
  return plan ? `OpenAI Codex — ${plan}` : "OpenAI Codex";
}

function renderWindow(name: WindowName, window: RateLimitWindow | undefined, now: Date): string {
  if (!window) return `${name}\nUnavailable`;
  const remaining = remainingPercent(window.usedPercent);
  if (remaining === null) return `${name}\nUnavailable`;
  const lines = [`${name}`, `${formatBar(remaining)} ${remaining}% remaining`];
  const reset = formatReset(window.resetsAt, now);
  if (reset) lines.push(reset);
  return lines.join("\n");
}

export function formatUsage(data: UsageData, now = new Date()): string {
  const header = formatPlan(data.account.planType);
  const windows = new Map<WindowName, RateLimitWindow>();
  for (const window of [data.snapshot?.primary, data.snapshot?.secondary]) {
    if (!window) continue;
    const name = classifyWindow(window.windowDurationMins);
    if (name && !windows.has(name)) windows.set(name, window);
  }

  if (windows.size === 0) {
    return `${header}\n\nUsage limits are currently unavailable from Codex.`;
  }

  return [
    header,
    renderWindow("5-hour", windows.get("5-hour"), now),
    renderWindow("Weekly", windows.get("Weekly"), now),
    "Updated just now",
  ].join("\n\n");
}

class RpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private exited = false;
  private failure: Error | undefined;

  constructor(spawnCodex: SpawnCodex) {
    try {
      this.child = spawnCodex();
    } catch {
      throw new UsageError("missing");
    }

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", this.onStdout);
    this.child.stderr.on("data", this.onStderr);
    this.child.stdin.on("error", this.onStdinError);
    this.child.once("error", this.onProcessError);
    this.child.once("exit", this.onExit);
  }

  private onStdout = (chunk: string): void => {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER) {
      this.fail(new UsageError("protocol"));
      return;
    }

    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trimEnd();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        this.fail(new UsageError("protocol"));
        return;
      }
      if (!isRpcResponse(decoded)) {
        this.fail(new UsageError("protocol"));
        return;
      }
      const message = decoded;

      // Notifications have no id; unrelated notifications are intentionally ignored.
      if (!Object.prototype.hasOwnProperty.call(message, "id")) continue;
      if (typeof message.id !== "number") {
        this.fail(new UsageError("protocol"));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new UsageError("protocol"));
      else if (Object.prototype.hasOwnProperty.call(message, "result")) pending.resolve(message.result);
      else pending.reject(new UsageError("protocol"));
    }
  };

  private onStderr = (chunk: string): void => {
    this.stderrBuffer = (this.stderrBuffer + chunk).slice(-MAX_STDERR);
  };

  private onStdinError = (): void => {
    this.fail(new UsageError("protocol"));
  };

  private onProcessError = (error: NodeJS.ErrnoException): void => {
    this.fail(new UsageError(error.code === "ENOENT" ? "missing" : "protocol"));
  };

  private onExit = (): void => {
    this.exited = true;
    if (this.pending.size > 0) this.fail(this.failure ?? new UsageError("protocol"));
  };

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(params === undefined ? { method, id } : { method, id, params }, id);
    });
  }

  private write(message: unknown, id?: number): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (!error) return;
      const failure = new UsageError("protocol");
      if (id !== undefined) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(failure);
      }
      this.fail(failure);
    });
  }

  abort(error: Error): void {
    this.fail(error);
    if (!this.exited) this.child.kill();
  }

  async close(): Promise<void> {
    this.child.stdout.off("data", this.onStdout);
    this.child.stderr.off("data", this.onStderr);
    this.child.stdin.end();
    if (this.exited) {
      this.child.stdin.off("error", this.onStdinError);
      return;
    }

    this.child.kill();
    if (!(await this.waitForExit(500))) {
      this.child.kill("SIGKILL");
      await this.waitForExit(500);
    }
    if (this.exited) this.child.stdin.off("error", this.onStdinError);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.child.off("exit", onExit);
        resolve(this.exited);
      }, timeoutMs);
      this.child.once("exit", onExit);
    });
  }
}

export async function queryCodexUsage(
  timeoutMs = TIMEOUT_MS,
  spawnCodex: SpawnCodex = () => spawn("codex", ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }),
): Promise<UsageData> {
  const client = new RpcClient(spawnCodex);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    client.abort(new UsageError("timeout"));
  }, timeoutMs);

  try {
    await client.request("initialize", {
      clientInfo: { name: "pi_codex_usage", title: "Pi Codex Usage", version: "1.0.0" },
      capabilities: null,
    });
    client.notify("initialized", {});

    // account/read reports the account authenticated in the local Codex installation.
    // refreshToken:false avoids asking Codex for a proactive token refresh.
    const accountResult = await client.request("account/read", { refreshToken: false }) as {
      account?: unknown;
      requiresOpenaiAuth?: unknown;
    };
    const account = accountResult?.account as Partial<ChatGptAccount> | null | undefined;
    if (!account || account.type !== "chatgpt") throw new UsageError("auth");

    const limitsResult = await client.request("account/rateLimits/read") as {
      rateLimits?: unknown;
    };
    const snapshot = limitsResult?.rateLimits;
    return {
      account: account as ChatGptAccount,
      snapshot: snapshot && typeof snapshot === "object" ? snapshot as RateLimitSnapshot : null,
    };
  } catch (error) {
    if (timedOut) throw new UsageError("timeout");
    if (error instanceof UsageError) throw error;
    throw new UsageError("protocol");
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}

function formatError(error: unknown): string {
  const kind = error instanceof UsageError ? error.kind : "protocol";
  if (kind === "missing") {
    return "Codex usage unavailable\n\nCould not find `codex` on PATH.\nInstall Codex CLI and sign in first.";
  }
  if (kind === "auth") {
    return "Codex usage unavailable\n\nCodex is not signed in to a ChatGPT account.\nRun `codex login`.";
  }
  if (kind === "timeout") {
    return "Codex usage unavailable\n\nTimed out while reading account limits.";
  }
  return "Codex usage unavailable\n\nCould not read account limits from the local Codex app-server.";
}

export default function codexUsage(pi: ExtensionAPI): void {
  let registered = false;

  // Pi exposes command discovery only after extension loading is complete, so
  // defer conflict detection and registration until the runtime is active.
  pi.on("session_start", async (_event, ctx) => {
    if (registered) return;
    if (pi.getCommands().some((command) => command.name === "usage")) {
      if (ctx.hasUI) {
        ctx.ui.notify("Codex usage extension disabled: /usage already exists.", "warning");
      }
      return;
    }

    pi.registerCommand("usage", {
      description: "Show current OpenAI Codex subscription usage limits",
      handler: async (_args, commandContext) => {
        try {
          const usage = await queryCodexUsage();
          commandContext.ui.notify(formatUsage(usage), "info");
        } catch (error) {
          commandContext.ui.notify(formatError(error), "error");
        }
      },
    });
    registered = true;
  });
}
