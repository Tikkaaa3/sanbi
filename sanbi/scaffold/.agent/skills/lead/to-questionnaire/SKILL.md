---
name: to-questionnaire
description: Interview the owner about a stakeholder information gap and write a concise questionnaire for that stakeholder.
disable-model-invocation: true
---

# To Questionnaire

Turn information or decisions held by another person into a Markdown questionnaire they can complete asynchronously or in a meeting.

**Grill the send, not the subject.** Interview the owner only about information they can supply:

1. **Recipient:** role, expertise, relationship to the owner, and what context they already have.
2. **Needed outcome:** the concrete facts or decisions the owner must get back.

Then write a concise questionnaire that:

- states its purpose and how answers will be used
- gives only enough context to answer well
- orders questions by importance
- groups larger sets by theme
- asks one idea per question
- adds why a question matters only when needed to prevent misunderstanding
- provides an answer space
- explicitly welcomes partial answers and “I don't know”
- ends with an open catch-all

Cover every needed outcome identified in the interview. Follow an existing project convention when obvious; otherwise write `docs/questionnaires/<slug>.md`, creating the directory lazily. Report the path.

This is project/product discovery documentation. Do not place it in `.agent/tasks/` and do not create a Sanbi implementation task automatically.

## Attribution

Sanbi-adapted from `mattpocock/skills` `to-questionnaire` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
