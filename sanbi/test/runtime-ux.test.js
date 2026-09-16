import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activityCounts, activityRows, createInspectReadModel, currentActivity, latestVisibleText, observeInspectEvent, semanticTool } from "../scaffold/.pi/sanbi/subagent-ui.js";
import { cleanupRuntimeTemp, createRuntimeTemp, runtimeTempRoot } from "../src/runtime-temp.js";
import { claimNoGitWarning, clearVcsCache, detectVcs } from "../src/vcs.js";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
async function temporary(prefix) { const root = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(root); return root; }

test("semantic subagent inspect merges tool lifecycle without raw JSON", () => {
  const model = createInspectReadModel("full secret delegated prompt");
  observeInspectEvent(model, { type: "tool_execution_start", toolName: "read", toolCallId: "a", args: { path: "src/game.ts" } });
  assert.equal(currentActivity(model), "READ src/game.ts");
  assert.deepEqual(activityRows(model), [{ symbol: "●", text: "READ    src/game.ts", status: "running" }]);
  observeInspectEvent(model, { type: "tool_execution_end", toolName: "read", toolCallId: "a", isError: false });
  assert.deepEqual(activityRows(model), [{ symbol: "✓", text: "READ    src/game.ts", status: "done" }]);
  assert.equal(activityRows(model).length, 1, "start/success must remain one logical row");
  assert.doesNotMatch(activityRows(model)[0].text, /\{|done/);
  assert.equal(activityCounts(model), "1 file read · 0 searches · 0 errors");
});

test("semantic rendering covers registered tools and compacts errors/output", () => {
  assert.deepEqual(semanticTool("find", { path: "src", pattern: "**/*test*" }), { verb: "FIND", target: "src/**/*test*" });
  assert.deepEqual(semanticTool("bash", { command: "npm test\necho ignored" }), { verb: "RUN", target: "npm test" });
  assert.equal(semanticTool("web_search", { query: "Web Audio policy" }).verb, "SEARCH");
  assert.match(semanticTool("fetch_content", { url: "https://developer.mozilla.org/docs/Web/API" }).target, /^developer\.mozilla\.org/);
  assert.equal(semanticTool("custom_tool", { path: "thing" }).verb, "CUSTOM TOOL");
  const model = createInspectReadModel();
  observeInspectEvent(model, { type: "tool_execution_start", toolName: "read", args: { path: "tsconfig.json" } });
  observeInspectEvent(model, { type: "tool_execution_end", toolName: "read", isError: true, result: "not found\nUsage: read [options]" });
  assert.deepEqual(activityRows(model), [{ symbol: "✗", text: "READ    tsconfig.json — not found", status: "error" }]);
  observeInspectEvent(model, { type: "assistant_text", text: "A meaningful latest observation that remains bounded." });
  assert.match(latestVisibleText(model), /meaningful latest observation/);
});

test("inspect source keeps prompt hidden by default, raw details, metadata, throttle, and cancellation", async () => {
  const source = await readFile(new URL("../scaffold/.pi/extensions/sanbi-subagents.ts", import.meta.url), "utf8");
  assert.match(source, /let details = false; let showPrompt = false/);
  assert.match(source, /data === "d"/);
  assert.match(source, /RAW TRANSCRIPT/);
  assert.match(source, /data === "p"/);
  assert.match(source, /DELEGATED PROMPT/);
  assert.match(source, /currentActivity\(child\.inspect\)/);
  assert.match(source, /modelLabel\(child\.definition\.model\).*child\.definition\.thinking.*contextPercent\(child\).*elapsed\(child\)/s);
  assert.match(source, /UI_STREAM_THROTTLE_MS = 75/);
  assert.match(source, /width !== lastWidth/);
  assert.match(source, /header\.map\(\(line\) => truncateToWidth/);
  assert.match(source, /data === "x".*manager\.cancel\(child\.id\)/s);
  assert.doesNotMatch(await readFile(new URL("../scaffold/.pi/sanbi/subagent-ui.js", import.meta.url), "utf8"), /createAgentSession|sendMessage|prompt\(/);
});

test("VCS detection is cached, non-fatal, concise, and never initializes Git", async () => {
  clearVcsCache();
  const gitRoot = await temporary("sanbi-git-");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: gitRoot }).status, 0);
  assert.equal(detectVcs(gitRoot).vcs, "git");
  const noGit = await temporary("sanbi-nogit-");
  let calls = 0;
  const fake = (_command, args) => { calls += 1; assert.deepEqual(args, ["rev-parse", "--is-inside-work-tree"]); return { status: 128, stdout: "", stderr: "fatal: not a git repository\nusage: giant help" }; };
  assert.deepEqual(detectVcs(noGit, { spawnSync: fake }), { vcs: "none", reason: "fatal: not a git repository" });
  assert.equal(detectVcs(noGit, { spawnSync: fake }).vcs, "none");
  assert.equal(calls, 1);
  await assert.rejects(() => stat(path.join(noGit, ".git")), /ENOENT/);
  assert.equal(await claimNoGitWarning(noGit), true);
  assert.equal(await claimNoGitWarning(noGit), false);
});

test("initial non-Git adoption warns once without initializing Git", async () => {
  const root = await temporary("sanbi-warning-");
  const run = () => spawnSync(process.execPath, [path.resolve("bin/sanbi.js"), "--project", root, "--init-only"], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
  const first = run();
  const second = run();
  assert.equal(first.status, 0);
  assert.match(first.stderr, /No Git repository detected/);
  assert.match(first.stderr, /task delta attribution is degraded/);
  assert.doesNotMatch(second.stderr, /No Git repository detected/);
  await assert.rejects(() => stat(path.join(root, ".git")), /ENOENT/);
  assert.equal(await readFile(path.join(root, ".agent/.runtime/.gitignore"), "utf8"), "*\n!.gitignore\n");
});

test("runtime temp uses OS temp and cleanup requires positive Sanbi ownership", async () => {
  const tempBase = await temporary("sanbi-temp-base-");
  const project = await temporary("sanbi-project-owned-");
  const owned = await createRuntimeTemp("project-key", "browser", { tmpdir: tempBase });
  assert.equal(owned.startsWith(runtimeTempRoot("project-key", { tmpdir: tempBase })), true);
  assert.equal(owned.includes(`${path.sep}.agent${path.sep}`), false);
  await writeFile(path.join(owned, "profile.log"), "temporary");
  const afterCrash = await createRuntimeTemp("project-key", "browser", { tmpdir: tempBase });
  assert.notEqual(afterCrash, owned, "a leftover must not block a later run");
  assert.equal(await cleanupRuntimeTemp(afterCrash, { tmpdir: tempBase }), true);
  assert.equal(await cleanupRuntimeTemp(owned, { tmpdir: tempBase }), true);
  await assert.rejects(() => stat(owned), /ENOENT/);
  const unowned = path.join(tempBase, "sanbi", "user-owned");
  await mkdir(unowned, { recursive: true });
  await writeFile(path.join(unowned, "keep.txt"), "keep");
  assert.equal(await cleanupRuntimeTemp(unowned, { tmpdir: tempBase }), false);
  assert.equal(await readFile(path.join(unowned, "keep.txt"), "utf8"), "keep");
  await writeFile(path.join(project, "keep.txt"), "project");
  assert.equal(await cleanupRuntimeTemp(project, { tmpdir: tempBase }), false);
  assert.equal(await readFile(path.join(project, "keep.txt"), "utf8"), "project");
});

test("lifecycle exposes semantic signaling, cached VCS, canonical messages, and guarded rollback", async () => {
  const source = await readFile(new URL("../scaffold/.pi/extensions/lifecycle.ts", import.meta.url), "utf8");
  assert.match(source, /name: "sanbi_signal_coder"/);
  assert.match(source, /name: "sanbi_signal_lead"/);
  assert.match(source, /name: "sanbi_runtime_temp"/);
  assert.match(source, /allocatedRuntimeTemps/);
  assert.match(source, /session_shutdown[\s\S]*cleanupRuntimeTemp/);
  assert.match(source, /StringEnum\(\["continue", "rework"\]\)/);
  assert.match(source, /signalMessage\("start"/);
  assert.match(source, /requires changes\.\\nRead \.agent\/reviews/);
  assert.match(source, /is BLOCKED\. Read \.agent\/results/);
  assert.match(source, /is ready for review\. Read \.agent\/results/);
  assert.match(source, /config\?\.herdr\?\.coderAgent|config\?\.herdr\?\.leadAgent/);
  assert.match(source, /transition\(current, "CODING", expected\)/);
  assert.match(source, /taskMutations/);
  assert.match(source, /randomUUID\(\).*\.tmp/);
  assert.match(source, /returned to \$\{expected\}/);
  assert.match(source, /vcsPromise/);
  assert.match(source, /rev-parse", "--is-inside-work-tree/);
  assert.match(source, /VCS: \$\{vcs\}/);
  assert.doesNotMatch(source, /git", \["init"/);
});
