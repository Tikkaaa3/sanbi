# Behavior-Oriented Tests

## Test the contract

Test observable behavior through a public interface or an established seam. A good test states what a caller can rely on and survives internal refactoring.

Avoid tests that:

- assert private call order or internal structure without contractual significance
- reproduce the implementation algorithm to calculate the expected value
- pass regardless of whether the intended behavior exists
- merely assert a mock was called when the observable outcome is what matters
- widen the approved task to manufacture a convenient seam

## Independent expectations

Expected values need an independent source: explicit examples in the task, domain rules, fixtures with known outcomes, standards, or a separately reasoned calculation. A test that computes expected output with the same logic as production is tautological.

## Vertical slicing

Each red-green cycle should cross enough layers to deliver one complete behavior. Prefer one failing behavior, its minimum implementation, and focused verification over horizontal phases such as “all tests” followed by “all code.”

Adapted from `mattpocock/skills` `tdd/tests.md` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
