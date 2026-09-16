---
task: T-000
---

# Review — T-000

## Round 1

**Verdict:** `CHANGES_REQUIRED` or `APPROVED`

### Contract Axis

Check the binding task contract:

- Objective: PASS / FAIL
- Included/excluded scope: PASS / FAIL
- Architectural Constraints: PASS / FAIL
- Expected Behavior and Edge Cases: PASS / FAIL
- Acceptance Criteria: PASS / FAIL
- Verification Requirements: PASS / FAIL
- Implementation freedom and execution decisions: PASS / FAIL

#### Findings

Use IDs `C1`, `C2`, ... for material findings. Include classification, evidence path/line, violated contract requirement, and required correction. If none, state none.

### Standards Axis

Assess the actual implementation against repository-specific conventions, relevant ADR/domain language, test quality, maintainability, and applicable engineering heuristics.

#### Findings

Use IDs `S1`, `S2`, ... for material findings. Include classification, evidence path/line, violated standard, and required correction. If none, state none.

### Optional Improvements

Clearly non-blocking observations only. Do not mix these into required changes.

### Independent Verification

| Command / Check | Result |
| --- | --- |
| `...` | PASS / FAIL / NOT RUN |

Record checks Lead actually ran and any Coder results independently confirmed.

### Required Changes

Include only for `CHANGES_REQUIRED`. Every required change must be concrete and actionable. Lead returns the same task/session to `CODING`; Lead does not implement the fix.

---

When another review is needed, append another section:

`## Round 2`

Focus it on prior required finding IDs, newly touched areas, and relevant regression risk. Do not erase previous rounds or restate the entire contract. An approval round must state that no material findings remain.
