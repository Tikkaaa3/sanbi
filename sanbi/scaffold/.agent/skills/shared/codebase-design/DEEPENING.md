# Deepening Modules

Use the vocabulary in [`SKILL.md`](SKILL.md).

## Dependency categories

1. **In-process:** pure computation or in-memory state. Deepen and test through the resulting interface directly.
2. **Local-substitutable:** infrastructure with a faithful local stand-in. Keep the seam internal and test through the module interface using the stand-in.
3. **Remote but owned:** define a port at the real network/process seam. Use a production transport adapter and an in-memory test adapter.
4. **Truly external:** inject a narrow port around behavior the project needs; test with a controlled adapter.

## Seam discipline

A deep module may have private internal seams without exposing them to callers. Introduce a public seam only when variation is real. Production and test adapters can justify one; a lone implementation usually does not.

## Testing strategy

Test observable behavior through the deepened module's interface. Prefer tests that survive implementation refactors. When replacement interface-level coverage makes old shallow implementation tests redundant, remove rather than layer duplicate tests—but only within the approved task scope.

Adapted from `mattpocock/skills` `codebase-design/DEEPENING.md` at commit `3cca18b368ae95cdbdebbff572ccafa662551015`; see `.agent/skills/LICENSE.mattpocock`.
