---
task: T-000
outcome: IN_PROGRESS
---

# Result — T-000

## Outcome

`IN_PROGRESS`, `BLOCKED`, or `COMPLETE`. Keep this aligned with task state: `IN_PROGRESS` while `CODING`, `BLOCKED` with `BLOCKED`, and `COMPLETE` when requesting `REVIEW`.

## Implementation Summary

Describe what was actually implemented.

## Files Changed

- `path/to/file` — what changed and why

## Tests Added or Changed

- ...

## Focused Engineering Evidence

Include only when relevant:

- approved observable behavior and testing seam
- focused red command/result, then green command/result
- bug reproduction signal
- supported root cause and distinguishing evidence
- missing correct test seam

Keep this concise; do not include a debugging or test-run transcript.

## TDD Evidence

Use when behavioral work had a meaningful automated seam:

- RED: `<focused test command>` — failed because `<expected missing or incorrect behavior>`.
- GREEN: `<same focused test command>` — passed after `<brief behavior implemented>`.

One or a few representative slices are enough. If TDD reasonably did not apply, record `TDD not applicable — <specific config/scaffolding/etc. reason>`. Tests written only after the corresponding implementation are not RED evidence.

## Verification Performed

| Command / Check | Result |
| --- | --- |
| `...` | PASS / FAIL / NOT RUN |

Do not report a check as passing unless it was actually run successfully.

## Deviations From Task Contract

None.

If implementation differs meaningfully from the task guidance or expected design, explain it here.

## Blockers Encountered

None.

If blocked, explain:

- exact blocker
- repository evidence
- what decision or information is needed
- reasonable options when useful

## Review Findings Addressed

For rework rounds only; omit otherwise.

| Finding | Change | Verification |
| --- | --- | --- |
| `C1` / `S1` | ... | ... |

## Risks / Unresolved Concerns

None.

## Follow-up Notes

None.
