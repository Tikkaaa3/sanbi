---
name: diagnosing-bugs
description: Diagnose non-trivial bugs, regressions, flaky failures, or performance problems through a reproducible feedback loop and falsifiable hypotheses before fixing.
---

# Diagnosing Bugs

Use disciplined diagnosis inside the active Sanbi task. Do not jump from a symptom to a favorite hypothesis when a reliable feedback loop can be built.

## 1. Build the feedback loop

Prefer the smallest reliable automated signal that reproduces the reported problem: a focused test, integration test, CLI/curl script, browser automation, trace replay, throwaway harness, differential comparison, controlled stress/fuzz loop, or `git bisect` when appropriate.

The loop should target the actual symptom, be deterministic or high-reproduction for flaky behavior, run reasonably quickly, and avoid owner interaction where possible. Redact secrets and sensitive values from commands, captures, logs, and result artifacts.

Put disposable browser profiles, screenshots, traces, logs, and smoke harness output beneath the OS-temp root in `SANBI_RUNTIME_TEMP`, never directly under durable `.agent/`. Allocate a positively-owned purpose directory with `sanbi_runtime_temp({ action: "allocate", purpose: "browser" })`, then best-effort clean that exact path with `sanbi_runtime_temp({ action: "cleanup", path: "..." })` when the check ends. Crash leftovers are acceptable but remain disposable and must not become workflow truth.

If reproduction requires unavailable credentials, production-only data, external infrastructure, owner action, or inaccessible systems, use the existing `CODING → BLOCKED` flow. Record what was attempted, what is missing, the exact evidence/access needed, and whether partial diagnosis can continue. Never fabricate a root cause.

## 2. Reproduce and minimize

Observe the exact reported failure. Remove inputs, steps, callers, configuration, and data one at a time until every remaining element is load-bearing, when practical.

## 3. Form hypotheses

For non-trivial bugs, generate several ranked, falsifiable hypotheses. State the evidence and a prediction that would distinguish each one. Test them independently without waiting for direct owner approval when work stays within the task.

A hypothesis requiring requirement change, material architecture change, scope expansion, destructive migration, or another Lead-owned decision must be escalated before implementation.

The existing non-implementing `diagnostic-scout` may optionally assist with independent hypotheses, code-path tracing, reproducer investigation, or narrowing causes. It must not implement the fix; Coder owns the final diagnosis. Do not create recursive delegation.

## 4. Instrument narrowly

Change one variable at a time. Prefer debugger, profiler, trace, or focused inspection before logs. Temporary instrumentation must be uniquely tagged, avoid secrets, and be removed before `REVIEW` unless it is deliberately part of the requested solution.

## 5. Fix and verify

When a correct seam exists:

1. turn the minimized reproduction into a failing regression test
2. observe the failure
3. apply the smallest correct fix
4. observe the regression test pass
5. rerun the original reproduction signal and relevant neighboring checks

When no correct seam exists, do not add a misleading shallow test. Record the missing seam in `.agent/results/<task-id>.md`; if fixing it would materially exceed scope, escalate to Lead.

## 6. Clean up and report

Remove temporary instrumentation and best-effort clean Sanbi-created throwaway runtime directories. Never delete an unmarked or user-owned path. Record the supported root cause, evidence, regression coverage, commands run, and remaining uncertainty concisely in the existing result artifact.

This skill introduces no new task states. Finish through the existing `CODING → BLOCKED` or `CODING → REVIEW` protocol; it does not commit, mark `DONE`, or create another handoff.

## Attribution

Sanbi-adapted from `mattpocock/skills` `diagnosing-bugs` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; direct HITL and commit-message assumptions were replaced by BLOCKED/Lead escalation and durable result evidence. See `.agent/skills/LICENSE.mattpocock`.
