---
name: code-review
description: Review an active Sanbi task in REVIEW against its binding contract and repository engineering standards. Use specifically for task review, rework decisions, and final approval—not unrelated design discussion.
---

# Code Review

Assist Lead's review of the active Sanbi task. Lead remains final reviewer, writes the durable review, and never modifies application or test source.

## Sources of truth

The binding specification is `.agent/tasks/<task-id>.md`, including Decisions Added During Execution; the matching Coder result is also required. For higher-level context consult only what is relevant: `.agent/project.md`, linked initiative, `CONTEXT.md`, ADRs, contribution/coding standards, actual repository delta, and verification output. Optional paths must receive one quiet existence/listing check before inspection. If absent, skip silently and do not re-probe during the flow. A missing required task/result or explicitly linked initiative is an error. External issue trackers are not required.

## Establish repository capability and delta

Read the lifecycle-provided runtime capability first. It is cached for this parent session:

- `VCS: git`: use focused Git status, staged/unstaged diffs, untracked files, and relevant history. Use a reliable task-start fixed point only when already available.
- `VCS: none`: do not run Git status, diff, or log. Review the Coder result's file list, task-relevant current files, tests, and verification output. State that exact task attribution/history is unavailable; lack of Git is non-fatal.

Do not probe repeatedly, run `git init`, require commits solely for review, or permit Git usage/help dumps to consume review context. If pre-existing changes or missing baseline evidence prevent exact attribution even with Git, state that limitation rather than inventing certainty.

## Axis A — Contract

Check the task's Objective, included/excluded scope, Architectural Constraints, Expected Behavior, Edge Cases, Acceptance Criteria, Verification Requirements, implementation-freedom level, and execution decisions.

Find missing, partial, or incorrect requirements; unauthorized scope; unrequested behavior; and verification gaps. Tie each finding to the contract evidence it violates.

## Axis B — Standards

Check documented repository conventions first, then relevant ADR/domain language, shared `codebase-design`, test quality, maintainability, unnecessary abstraction, and applicable Fowler-style smells such as mysterious names, duplication, feature envy, data clumps, primitive obsession, repeated switches, shotgun surgery, divergent change, speculative generality, message chains, middle men, or refused bequests.

Heuristics require judgment and never override repository-specific standards. Do not report formatting or lint speculation already covered by deterministic tooling unless that tooling failed.

For substantial reviews, use this default order:

1. **Authoritative artifacts:** Lead reads the task, Coder result, cached `VCS: git|none`, and only a relevant linked initiative. Do not yet exhaustively read every changed implementation/test file.
2. **Reviewer dispatch:** Promptly launch two fresh application-non-writing `reviewer` subagents—one delegated only Contract and one only Standards—normally in parallel. Supply artifact/delta pointers, VCS capability, and the requested axis, not a Lead-produced source analysis.
3. **While reviewers run:** Lead performs deterministic verification (tests, typecheck, lint, build, and task-required smoke checks; use `sanbi_runtime_process` for ephemeral servers rather than background shell PIDs) plus high-level orientation such as package manifests, the Coder-reported file list, key public APIs, and task-critical configuration. Do not automatically reread every implementation/test file.
4. **Consume results:** Collect evidence-oriented reviewer findings.
5. **Targeted Lead inspection:** Lead directly checks every material finding, reviewer disagreement, surprising claim, verification gap, and critical integration path needed for final judgment. Then Lead decides the verdict.

Reviewer disagreement routes to targeted Lead inspection, not automatic tie-breaker agents or majority voting. Use each axis reviewer at most once in a normal round unless a specific evidence gap justifies a focused follow-up.

For a genuinely tiny review, direct Lead review may skip subagents. On Round 2+, focus reviewer prompts and Lead inspection on prior required changes, regression risk, and newly touched areas; do not restate or reread the entire initiative without need. Subagents advise; Lead remains final authority.

## Durable review and verdict

Write or append `.agent/reviews/<task-id>.md`, keeping Contract and Standards findings distinct and recording independent verification. Classify observations as implementation defect, test/verification gap, or optional improvement. Optional cleanup is not mandatory rework unless it materially violates contract or standards.

If material findings remain, use the existing path:

```text
REVIEW → update review artifact → sanbi_signal_coder(rework) → CODING + same-session signal
```

Do not add a `REWORK` state and do not fix defects yourself. If no material findings remain and verification passes, follow normal approval, initiative reconciliation when relevant, handoff, and final `DONE` behavior.

This skill does not mark `DONE`, invoke Coder independently of the existing rework protocol, commit, or create another review process.

## Attribution

Sanbi-adapted from `mattpocock/skills` `code-review` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; issue-based spec lookup and generic fixed-point assumptions were replaced by the Sanbi task contract and current repository evidence. See `.agent/skills/LICENSE.mattpocock`.
