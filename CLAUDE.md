# agentic-setup

A Claude Code plugin: one GitHub issue per unit of work, one worktree per agent, PRs merged
by CI and a reviewing agent. This repository runs its own loop — the plugin dogfoods itself.

## Commands

- `npm test` — `tests/run.mts` discovers and runs every `tests/*.test.mts` file (per area:
  hooks, CI scripts, the installer), real throwaway git repositories, no mocks.
- `npm run test:bun` — the same suite under Bun; both must pass.
- `npm run check` — `tsc` over the `.mts` sources (`erasableSyntaxOnly`, `verbatimModuleSyntax`).

## Map

- `hooks/` — the three hooks and `lib/common.mts`; `hooks.json` wires them.
- `ci/` — `scope-check.mts`, `negative-control.mts`, `lib/detect.mts` (shared with the
  stop-gate hook). Copied into adopting repositories by `init`; **this** repository's
  workflows point at `ci/` directly.
- `scripts/init.mts` — the installer. `agents/`, `skills/`, `templates/`, `docs/`.

## Invariants (the reviewer holds every PR to these)

1. **No runtime dependencies, anywhere under `hooks/`, `ci/`, `scripts/`.** `node:` built-ins
   only. `package.json` devDependencies are for `tsc` alone.
2. **`.mts` only, erasable TypeScript only** — no `enum`, no parameter properties, no
   namespaces, no decorators. Node ≥ 22.18 runs the files directly; there is no build step.
3. **Every hook states its crash policy in its header and honours it.** `protect-*` and
   `stop-gate` fail open on their own errors; the merge gate in `protect-main` fails closed
   when `gh` cannot answer.
4. **Detection is a default, never a contract.** New stacks go in `ci/lib/detect.mts` with an
   env override path; no config file.
5. **The parsers stay strict.** `## Files` reads bullets only; `authorised:` is one glob per
   line; the closing-keyword line (`Closes`/`Fixes`/`Resolves #N`, several allowed) is
   plain text — a keyword inside backticks or a fence is ignored. Loosening a parser
   needs a test for the exact prose that used to break it.
6. **Tests spawn the real script.** A case for a hook, a CI script or the installer runs
   the actual file against a real git repository; nothing is mocked. Pure functions in
   `ci/lib/` (`detect`, `scope`, `globs`) may be imported and tested directly.
7. **English throughout; no references to private projects.** Lessons yes, provenance no.
8. **Docs equal code.** A change to a hook, flag, label or check updates `docs/` and the
   relevant `SKILL.md` in the same PR.

## Workflow

`docs/workflow.md` and `docs/orchestration.md` are the contract; `skills/issue-and-pr` is
the operating card. Branch `<type>/<n>-<slug>`; commit `test(red):` first; PR with
`Closes`/`Fixes`/`Resolves #N` (several issues may be linked, globs unioned); the
orchestrator merges on green checks + `review:approved`.
