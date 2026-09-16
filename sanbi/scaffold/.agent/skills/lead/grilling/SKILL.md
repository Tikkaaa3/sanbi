---
name: grilling
description: Clarify and stress-test a plan, requirement, design, or decision as a dependency-ordered question frontier. Use when meaningful assumptions remain unresolved or the owner asks to be grilled.
---

# Grilling

Build shared understanding without creating planning artifacts or implementation work.

Model unresolved decisions as a **design tree**: each decision may unlock dependent decisions. Work it in rounds. The **frontier** is every meaningful question whose prerequisites are already resolved.

For each round:

1. Establish repository or external facts yourself with available read, search, web, or other tools. Use an application-non-writing `scout` or `researcher` subagent when investigation delegates cleanly, but do not make delegation mandatory.
2. Recompute the frontier. Hold questions whose answers depend on unresolved facts or decisions for a later round.
3. Ask from the complete current frontier without introducing questions whose prerequisites are unresolved. The currently installed Ask UI schema accepts exactly one `question` per invocation and has no `questions[]` form; `allowMultiple` means multiple answers to one question, not multiple questions. Therefore ask one focused frontier question per reliable `ask_user` interaction. Do not encode several decisions into one multipart `question`, issue concurrent ask calls, or build a second questionnaire UI. Preserve the frontier ordering. If a future installed Ask UI is first verified to expose a native multi-question schema, submit independent questions from the same current frontier together up to that UI's safe limit; dependent questions remain deferred. Until then, use the sequential fallback without changing the decision model.
4. Include an opinionated recommended answer and brief rationale for every meaningful choice; keep options concise rather than writing large cards.
5. Wait for the owner's answers, update the design tree, and repeat.

Use this shape:

```markdown
❓ **Q1 — <title>:** <question and useful choices>

➡️ **Recommendation:** <answer and brief reason>
```

Facts available from the repository, tools, or research are the Lead's responsibility. Product priorities, trade-offs, and other owner decisions belong to the owner.

## Completion

Finish only when every meaningful branch has been visited and no consequential assumption remains silent. Then:

1. summarize the resulting understanding and remaining explicit uncertainty
2. classify the planning shape as **likely standalone task** or **likely initiative**
3. recommend exactly the next explicit owner command
4. STOP

A likely standalone task has one primary observable outcome, fits one fresh Coder context, can land and verify independently, has low dependency sequencing, and does not need durable multi-session planning context. Recommend `/to-task`.

A likely initiative has several independently useful/verifiable outcomes, meaningful sequencing or dependency edges, several capabilities or product decisions, or likely spans multiple Lead/Coder sessions. Recommend `/to-spec`.

Use the decisive test: could the work naturally split into two or more independently useful, independently verifiable outcomes that could land green separately? If yes, classify it as initiative-shaped.

End with one of these forms:

```text
Shared understanding reached.

This appears to be one coherent task.
Recommended next step: /to-task

No task or initiative has been created.
```

```text
Shared understanding reached.

This contains multiple independently verifiable outcomes and should be an initiative.
Recommended next step: /to-spec

No task or initiative has been created.
```

Never write `.agent/tasks/**` or `.agent/initiatives/**`. Do not automatically invoke `/to-task`, `/to-spec`, `/to-tickets`, or `/execute`. Natural-language agreement accepts a discussion decision only; it is not a planning transition or execution authorization.

## Attribution

Sanbi-adapted from `mattpocock/skills` `grilling` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
