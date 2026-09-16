import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startRuntimeProcess } from "../src/runtime-process.js";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
async function temporary(prefix) { const root = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(root); return root; }
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}
async function waitForFile(file, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { return await readFile(file, "utf8"); } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`timed out waiting for ${file}`);
}
async function requestFails(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(750) }); return false; } catch { return true; }
}

test("owned runtime process starts ready, logs, stops its descendant tree, then permits npm ci", { timeout: 60_000 }, async () => {
  const root = await temporary("sanbi-process-");
  const tempBase = await temporary("sanbi-process-temp-");
  const port = await freePort();
  const pidFile = path.join(root, "child.pid");
  const childScript = path.join(root, "child.mjs");
  const parentScript = path.join(root, "parent.mjs");
  await writeFile(childScript, `import http from 'node:http'; import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); http.createServer((_q,r)=>{r.end('ready')}).listen(${port}, '127.0.0.1', ()=>console.log('child ready')); setInterval(()=>{},1000);\n`);
  await writeFile(parentScript, `import { spawn } from 'node:child_process'; const child=spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'inherit'}); child.on('exit',()=>process.exit()); setInterval(()=>{},1000);\n`);
  await writeFile(path.join(root, "package.json"), '{"name":"runtime-smoke","version":"1.0.0"}\n');
  await writeFile(path.join(root, "package-lock.json"), '{"name":"runtime-smoke","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"runtime-smoke","version":"1.0.0"}}}\n');

  const owned = await startRuntimeProcess({ projectId: "runtime-smoke", role: "coder", session: "test", purpose: "dev-server", command: process.execPath, args: [parentScript], cwd: root, waitForHttp: `http://127.0.0.1:${port}/`, timeoutMs: 15_000 }, { tempOptions: { tmpdir: tempBase } });
  assert.match(owned.handle, /^rp-[a-f0-9-]+$/);
  assert.equal(owned.status(), "running");
  assert.equal(owned.url, `http://127.0.0.1:${port}/`);
  assert.equal(owned.logPath.startsWith(path.join(tempBase, "sanbi")), true);
  assert.match(await owned.logs(), /child ready/);
  const descendantPid = Number(await waitForFile(pidFile));
  assert.ok(descendantPid > 0 && descendantPid !== owned.pid);

  await owned.stop({ cleanup: true });
  assert.equal(await requestFails(`http://127.0.0.1:${port}/`), true, "owned descendant server must be gone");
  await assert.rejects(() => stat(owned.directory), /ENOENT/);
  if (process.platform === "win32") assert.throws(() => process.kill(descendantPid, 0), /ESRCH|EINVAL/);
  const ciCommand = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
  const ciArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"] : ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  const ci = spawnSync(ciCommand, ciArgs, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(ci.status, 0, ci.stderr || ci.stdout);
});

test("runtime process readiness failures are bounded and deterministic ports fail clearly", { timeout: 20_000 }, async () => {
  const root = await temporary("sanbi-process-fail-");
  const tempBase = await temporary("sanbi-process-fail-temp-");
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  await assert.rejects(() => startRuntimeProcess({ projectId: "fail", purpose: "server", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, waitForHttp: `http://127.0.0.1:${port}/`, timeoutMs: 500 }, { tempOptions: { tmpdir: tempBase } }), /requested port .* already in use/);
  await new Promise((resolve) => blocker.close(resolve));

  if (process.platform === "win32") {
    await assert.rejects(() => startRuntimeProcess({ projectId: "fail", purpose: "unsafe", command: "node", args: ["-e", "console.log(a=>a)"], cwd: root }, { tempOptions: { tmpdir: tempBase } }), /may not contain shell metacharacters/);
  }

  const noisyScript = path.join(root, "noisy.mjs");
  await writeFile(noisyScript, `console.error('x'.repeat(10000)); setInterval(()=>{},1000);\n`);
  await assert.rejects(async () => {
    try { await startRuntimeProcess({ projectId: "fail", purpose: "server", command: process.execPath, args: [noisyScript], cwd: root, waitForOutput: "never-ready", timeoutMs: 300 }, { tempOptions: { tmpdir: tempBase } }); }
    catch (error) { assert.ok(error.message.length <= 4_100); throw error; }
  }, /readiness timed out/);
});

test("runtime process semantic API is handle-owned and shutdown stops before temp cleanup", async () => {
  const source = await readFile(new URL("../scaffold/.pi/extensions/lifecycle.ts", import.meta.url), "utf8");
  assert.match(source, /name: "sanbi_runtime_process"/);
  assert.match(source, /unknown or unowned Sanbi runtime process handle/);
  assert.doesNotMatch(source, /params\.pid/);
  assert.match(source, /session_shutdown[\s\S]*runtimeProcesses\.values\(\)[\s\S]*owned\.stop[\s\S]*allocatedRuntimeTemps/);
  const helper = await readFile(new URL("../scaffold/.pi/sanbi/runtime-process.js", import.meta.url), "utf8");
  assert.match(helper, /taskkill", \["\/PID", String\(child\.pid\), "\/T", "\/F"\]/);
  assert.match(helper, /process\.kill\(-child\.pid, "SIGTERM"\)/);
  assert.match(helper, /\.sanbi-process\.json/);
});
