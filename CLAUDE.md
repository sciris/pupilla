# pupilla

A Claude Code mod (plugin of function hooks) that predicts the user's next prompt. See README.md for the design and its sources.

## Checks

Run all three after any change:

- `claude plugin validate .`: reads the manifest and hooks module the way the engine will.
- `claude plugin test .`: runs `tests/*.test.ts(x)` against the engine.
- `npx -y -p typescript@5 tsc -p .`: type-checks against the declarations the engine lays in `.claude-plugin/types/` (gitignored; written at every load of the mod, so load it once before type-checking a fresh clone).

## Constraints the engine imposes

- `$` may only be passed to functions declared at the top level of `register.tsx`, never to closures inside `register`. The validator refuses otherwise.
- Session state (`pupilla.phase`, `pupilla.pending`) is declared in `types/index.d.ts` and written with `update($, atom, fn)`, not `$.state.set` on the atom.
- `hooks/learn.ts` stays free of engine calls so the learning rules can be unit-tested directly.

## Versioning

Bump `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (`metadata.version`) together.
