---
name: codebase-design
description: Design deep modules and testing seams. Use when shaping or refactoring a module interface, evaluating abstraction depth, placing a seam or adapter, or improving testability without speculative indirection.
---

# Codebase Design

Design **deep modules**: substantial behavior behind a small interface, placed at a clean seam and testable through that interface. Optimize leverage for callers and locality for maintainers.

## Vocabulary

- **Module:** anything with an interface and implementation: function, class, package, or larger slice.
- **Interface:** everything callers must know—types, invariants, ordering, errors, configuration, and relevant performance characteristics.
- **Implementation:** behavior hidden inside the module.
- **Depth:** capability and behavior available per unit of interface a caller must learn.
- **Seam:** a location where behavior can vary without editing the caller.
- **Adapter:** a concrete implementation occupying an interface at a seam.
- **Leverage:** capability callers gain from learning one compact interface.
- **Locality:** concentration of change, knowledge, bugs, and verification in one place.

Use **seam**, not an overloaded “boundary,” when discussing substitutable behavior.

## Discipline

- Reduce interface surface while hiding useful complexity.
- Apply the **deletion test**: if deleting the module makes complexity reappear across callers, it earned its place; if complexity simply disappears, it was likely pass-through.
- Treat the interface as the test surface. Tests crossing internal structure often indicate the wrong module shape.
- Accept dependencies rather than constructing hard-wired external behavior when variation is real.
- Prefer observable returned results over hidden side effects when the domain allows.
- Avoid speculative seams: **one adapter is hypothetical; two adapters make variation real**. Production plus a justified test adapter can be real variation.
- Avoid shallow wrappers whose interface is nearly as complex as their implementation.

For dependency classification and deepening tests, read [`DEEPENING.md`](DEEPENING.md). When genuinely comparing alternate interfaces, read [`DESIGN-IT-TWICE.md`](DESIGN-IT-TWICE.md).

## Sanbi role boundary

Lead may apply this vocabulary to architecture discussion, task design, and review, but delegates source and test changes to Coder.

Coder may apply it only within the approved task. It is not authority to expand scope or perform an unapproved redesign. If the task appears to require materially different architecture, escalate through the existing Sanbi protocol rather than silently changing direction.

## Attribution

Sanbi-adapted from `mattpocock/skills` `codebase-design` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
