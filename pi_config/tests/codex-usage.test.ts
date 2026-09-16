import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  classifyWindow,
  default as codexUsage,
  formatBar,
  formatPlan,
  formatReset,
  formatUsage,
  isRpcResponse,
  queryCodexUsage,
  remainingPercent,
} from "../extensions/codex-usage.ts";

const now = new Date(2026, 8, 16, 12, 0, 0);
const resetSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

function window(usedPercent: unknown, windowDurationMins: number, reset: Date) {
  return { usedPercent, windowDurationMins, resetsAt: resetSeconds(reset) };
}

test("usedPercent=22 renders 78 percent remaining", () => {
  assert.equal(remainingPercent(22), 78);
});

test("remaining percentage clamps both bounds", () => {
  assert.equal(remainingPercent(-12), 100);
  assert.equal(remainingPercent(140), 0);
});

test("remaining percentage rejects malformed values", () => {
  assert.equal(remainingPercent("22"), null);
  assert.equal(remainingPercent(Number.NaN), null);
  assert.equal(remainingPercent(undefined), null);
});

test("approximately 300 minutes is classified as 5-hour", () => {
  assert.equal(classifyWindow(300), "5-hour");
  assert.equal(classifyWindow(310), "5-hour");
});

test("approximately 10080 minutes is classified as Weekly", () => {
  assert.equal(classifyWindow(10080), "Weekly");
  assert.equal(classifyWindow(10000), "Weekly");
});

test("unknown duration is not mislabeled", () => {
  assert.equal(classifyWindow(1440), undefined);
  assert.equal(classifyWindow(null), undefined);
});

test("20-character bar reflects remaining quota", () => {
  assert.equal(formatBar(100), "████████████████████");
  assert.equal(formatBar(50), "██████████░░░░░░░░░░");
  assert.equal(formatBar(0), "░░░░░░░░░░░░░░░░░░░░");
  assert.equal([...formatBar(78)].length, 20);
});

test("reset below 24 hours is relative", () => {
  const reset = new Date(now.getTime() + (2 * 60 + 14) * 60_000);
  assert.equal(formatReset(resetSeconds(reset), now), "Resets in 2h 14m");
  assert.equal(formatReset(resetSeconds(new Date(now.getTime() + 43 * 60_000)), now), "Resets in 43m");
});

test("passed reset is safe", () => {
  assert.equal(formatReset(resetSeconds(new Date(now.getTime() - 60_000)), now), "Reset due now");
});

test("reset at least 24 hours away uses local date and time", () => {
  assert.equal(
    formatReset(resetSeconds(new Date(2026, 8, 20, 18, 42, 0)), now),
    "Resets Sep 20, 18:42",
  );
});

test("missing plan omits the plan suffix", () => {
  assert.equal(formatPlan(undefined), "OpenAI Codex");
  assert.equal(formatPlan("unknown"), "OpenAI Codex");
  assert.equal(formatPlan("prolite"), "OpenAI Codex — Pro Lite");
});

test("missing standard windows render Unavailable", () => {
  const weeklyOnly = {
    account: { type: "chatgpt", planType: "pro" },
    snapshot: { primary: window(39, 10080, new Date(2026, 8, 20, 18, 42)), secondary: null },
  };
  const output = formatUsage(weeklyOnly, now);
  assert.match(output, /5-hour\nUnavailable/);
  assert.match(output, /Weekly\n████████████░░░░░░░░ 61% remaining/);

  const fiveHourOnly = {
    account: { type: "chatgpt", planType: "pro" },
    snapshot: { primary: window(22, 300, new Date(now.getTime() + 134 * 60_000)), secondary: null },
  };
  assert.match(formatUsage(fiveHourOnly, now), /Weekly\nUnavailable/);
});

test("malformed percentage does not crash rendering", () => {
  const output = formatUsage({
    account: { type: "chatgpt", planType: "plus" },
    snapshot: { primary: window("bad", 300, new Date(now.getTime() + 60_000)), secondary: null },
  }, now);
  assert.match(output, /5-hour\nUnavailable/);
});

test("command conflict detection waits until Pi runtime is active", async () => {
  let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const registered: string[] = [];
  let active = false;
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      assert.equal(name, "session_start");
      sessionStart = handler;
    },
    getCommands() {
      if (!active) throw new Error("Extension runtime not initialized");
      return [];
    },
    registerCommand(name: string) { registered.push(name); },
  };

  assert.doesNotThrow(() => codexUsage(pi as never));
  active = true;
  await sessionStart?.({}, { hasUI: false, ui: { notify() {} } });
  assert.deepEqual(registered, ["usage"]);
});

test("JSON primitives are rejected as malformed RPC messages", () => {
  assert.equal(isRpcResponse(null), false);
  assert.equal(isRpcResponse(42), false);
  assert.equal(isRpcResponse("message"), false);
  assert.equal(isRpcResponse({ id: 1, result: {} }), true);
});

test("stdin pipe errors reject cleanly and terminate the child", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: (signal?: string) => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let killCalls = 0;
  child.kill = () => {
    killCalls += 1;
    child.killed = true;
    queueMicrotask(() => child.emit("exit", 1));
    return true;
  };

  const query = queryCodexUsage(5_000, () => child as never);
  queueMicrotask(() => {
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    child.stdin.emit("error", error);
  });

  await assert.rejects(query, /protocol/);
  assert.ok(killCalls >= 1);
});
