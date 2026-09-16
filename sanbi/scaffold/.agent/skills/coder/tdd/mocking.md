# Mocking and Test Doubles

Prefer real in-process collaborators and faithful local substitutes when they keep tests reliable and fast. Use mocks at genuine system seams such as remote services, time, randomness, or destructive external effects.

A test double should represent an established interface. Do not create a public interface solely so a mock can exist. One production implementation plus a justified test adapter can make variation real; otherwise added indirection may be speculative.

Assert the module's observable outcome whenever possible. Interaction assertions are appropriate only when the interaction itself is contractual behavior.

Never place secrets or production-sensitive values in fixtures, snapshots, or mock diagnostics.

Adapted from `mattpocock/skills` `tdd/mocking.md` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
