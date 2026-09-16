---
name: tdd
description: Implement observable behavior through a focused red-green loop. Use for non-trivial coding tasks where meaningful behavior tests can drive a narrow vertical implementation slice.
---

# TDD

Use test-driven development as an engineering discipline inside the active Sanbi task. The task contract and Sanbi lifecycle remain authoritative.

Read [`tests.md`](tests.md) for test-quality rules and [`mocking.md`](mocking.md) when test doubles may be needed.

## Test-seam authority

Choose testing seams in this order:

1. explicit testing or verification seams in the active task contract
2. established repository test conventions and clearly established public interfaces
3. the linked initiative's Testing Strategy, when applicable
4. if still materially ambiguous, use the existing `CODING → BLOCKED` flow and ask Lead

Do not ask the owner directly. Do not block for trivial local choices. Block when choosing a seam would materially change architecture, a public interface, observable behavior, acceptance criteria, or scope. Do not invent an architectural seam merely to make testing easier.

Treat the task's Expected Behavior, Edge Cases, Acceptance Criteria, Verification Requirements, Architectural Constraints, and binding Implementation Guidance as authoritative. Use a future `Testing Seams` section when present, but never require one.

## Applicability gate

TDD is expected for behavioral changes when a meaningful automated seam exists, including pure/domain logic, reducers and state transitions, persistence parsing/validation, controllable API adapters, component behavior, bug regressions, and deterministic orchestration.

TDD is not mandatory for initial toolchain scaffolding, package metadata, config-only changes, mechanical file moves, pure styling without a useful behavior seam, generated boilerplate, or environment repairs. Do not invent a meaningless test to claim compliance; record why TDD was not applicable.

## Red-green slices

For each relevant narrow vertical behavior slice:

1. identify the approved observable behavior
2. before implementing that behavior, write or modify one focused meaningful test
3. run the smallest relevant test command and observe RED
4. confirm RED is caused by the expected missing or incorrect behavior—not a syntax, fixture, import, or environment mistake
5. only then implement the minimum behavior needed
6. rerun the focused command and observe GREEN
7. optionally refactor while green, run relevant neighboring checks, and continue to the next slice

A test added after substantial corresponding behavior already exists is not TDD evidence. Do not implement the whole feature and then write the whole test suite. Use one behavior → RED → minimal GREEN → optional refactor repeatedly.

Keep tests behavior-oriented and exercise public interfaces or established seams. Avoid implementation-coupled and tautological tests. Derive expected values independently from the implementation under test. Do not write all tests first or speculate ahead for future slices.

Use shared `codebase-design` when module/interface/seam reasoning genuinely applies, while remaining inside approved scope.

Record one or a few representative slices in the result artifact: focused RED command and expected failure reason, then the same focused GREEN command and brief implemented behavior. If exempt, record `TDD not applicable — <specific config/scaffolding/etc. reason>`. Do not paste every cycle or claim TDD merely because tests eventually exist.

Focused TDD commands do not replace final task verification. Run every task-required test, typecheck, lint, build, or smoke command before requesting review.

Refactor only when required for approved behavior, clearly within task scope, or necessary for coherent implementation. Escalate material architecture changes.

This discipline does not perform lifecycle transitions itself, write Lead review, commit, or invoke `/next`. After the red-green work is complete, follow the normal Coder protocol, including Coder-owned `CODING → BLOCKED` or `CODING → REVIEW`; Coder still never marks `DONE`.

## Attribution

Sanbi-adapted from `mattpocock/skills` `tdd` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; direct user seam confirmation was replaced by Sanbi task/Lead authority. See `.agent/skills/LICENSE.mattpocock`.
