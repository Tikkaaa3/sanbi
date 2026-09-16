import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { cleanupRuntimeTemp, createRuntimeTemp } from "./runtime-temp.js";

const LOG_TAIL_CHARS = 4_000;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;

function bounded(value, max = LOG_TAIL_CHARS) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `…${text.slice(-max)}`;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safePurpose(value) { return String(value || "process").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40) || "process"; }
async function portAvailable(url) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid readiness port in ${url}`);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error("runtime HTTP readiness must use a loopback host");
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => reject(new Error(error?.code === "EADDRINUSE" ? `requested port ${port} is already in use` : error.message)));
    server.listen({ host: host === "localhost" ? "127.0.0.1" : host.replace(/^\[|\]$/g, ""), port, exclusive: true }, () => server.close(resolve));
  });
  return { url, host, port };
}
function childAlive(child) { return child && child.exitCode === null && child.signalCode === null; }
async function stopTree(child, platform, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  if (!child?.pid) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true, timeout: timeoutMs, stdio: "pipe" });
  } else {
    // Kill the owned process group even if its leader already exited; descendants may remain.
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    const grace = Date.now() + Math.min(2_000, timeoutMs);
    while (childAlive(child) && Date.now() < grace) await delay(50);
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  const deadline = Date.now() + timeoutMs;
  while (childAlive(child) && Date.now() < deadline) await delay(50);
}

export async function startRuntimeProcess(options, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const spawnProcess = dependencies.spawn ?? spawn;
  const directory = await createRuntimeTemp(options.projectId, `process-${safePurpose(options.purpose)}`, dependencies.tempOptions);
  const logPath = path.join(directory, "process.log");
  const metadataPath = path.join(directory, ".sanbi-process.json");
  const handle = `rp-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  let output = "";
  let child;
  let log;
  let stopped = false;
  let readyUrl;
  try {
    if (!options.command || !Array.isArray(options.args ?? [])) throw new Error("runtime process requires command and args array");
    if (options.waitForHttp) { await portAvailable(options.waitForHttp); readyUrl = options.waitForHttp; }
    const requestedArgs = options.args ?? [];
    const windowsExecutable = platform === "win32" && /(?:^|[\\/]).+\.exe$/i.test(options.command);
    if (platform === "win32" && !windowsExecutable) {
      const unsafe = [options.command, ...requestedArgs].find((value) => /[\r\n%\^&|<>()!]/.test(String(value)));
      if (unsafe !== undefined) throw new Error("Windows command-wrapper arguments may not contain shell metacharacters; use a direct executable or safe argument form");
    }
    const command = platform === "win32" && !windowsExecutable ? (process.env.ComSpec || "cmd.exe") : options.command;
    const args = platform === "win32" && !windowsExecutable ? ["/d", "/s", "/c", options.command, ...requestedArgs] : requestedArgs;
    log = createWriteStream(logPath, { flags: "a" });
    child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const capture = (chunk) => { const text = String(chunk); output = bounded(output + text); log.write(text); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const spawnError = new Promise((_, reject) => child.once("error", reject));
    await Promise.race([new Promise((resolve) => child.once("spawn", resolve)), spawnError]);
    await writeFile(metadataPath, JSON.stringify({ owner: "sanbi", handle, project: options.projectId, role: options.role, session: options.session, purpose: safePurpose(options.purpose), pid: child.pid, startedAt }) + "\n", { encoding: "utf8", flag: "wx" });

    const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 120_000));
    const deadline = Date.now() + timeoutMs;
    if (options.waitForHttp || options.waitForOutput) {
      let ready = false;
      while (Date.now() < deadline) {
        if (!childAlive(child)) throw new Error(`process exited before readiness (${child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`})`);
        if (options.waitForOutput && output.includes(options.waitForOutput)) { ready = true; break; }
        if (options.waitForHttp) {
          try { const response = await fetch(options.waitForHttp, { signal: AbortSignal.timeout(1_000) }); if (response.ok) { ready = true; break; } } catch {}
        }
        if (options.signal?.aborted) throw new Error("runtime process start cancelled");
        await delay(100);
      }
      if (!ready) throw new Error(`readiness timed out after ${timeoutMs}ms`);
    }

    const owned = {
      handle, pid: child.pid, purpose: safePurpose(options.purpose), logPath, directory, startedAt, url: readyUrl,
      status: () => childAlive(child) && !stopped ? "running" : "stopped",
      async logs() { try { return bounded(await readFile(logPath, "utf8")); } catch { return ""; } },
      async stop({ cleanup = true } = {}) {
        if (!stopped) { stopped = true; await stopTree(child, platform); }
        if (log && !log.closed) await new Promise((resolve) => log.end(resolve));
        if (cleanup) await cleanupRuntimeTemp(directory, dependencies.tempOptions);
        return true;
      },
    };
    return owned;
  } catch (error) {
    if (child) await stopTree(child, platform).catch(() => undefined);
    if (log && !log.closed) await new Promise((resolve) => log.end(resolve));
    const reason = bounded(error?.message ?? error, 800);
    const diagnostic = output ? `${reason}\nlog tail:\n${bounded(output, 3_000)}` : reason;
    await cleanupRuntimeTemp(directory, dependencies.tempOptions).catch(() => undefined);
    throw new Error(diagnostic);
  }
}
