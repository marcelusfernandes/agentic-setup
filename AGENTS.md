# agentic-setup

A Codex-first development setup with a separately available, opt-in Claude Code plugin.
Preserve both routes. Consolidating Codex does not authorize removing Claude or require
feature parity between the two runtimes.

## Commands

- `npm test` — all `tests/*.test.mts`: real scripts and throwaway Git repositories;
  external GitHub/Codex responses use controlled CLI fixtures where needed.
- `npm run check` — `tsc` over the `.mts` sources (`erasableSyntaxOnly`, `verbatimModuleSyntax`).
- `npm run setup:codex -- --target /path/to/repo --dry-run` — preview local Codex installation.

## Map

- `.agents/skills/autonomous-loop/` — Codex procedure, contract, GitHub state helper and
  optional bounded runner; `scripts/setup-codex.mts` installs this self-contained route.
- `plugins/agentic-setup/` — isolated native Codex package; regenerate its skill snapshot
  with `npm run sync:codex-plugin` after source edits and verify `npm run check:codex-plugin`.
  `.agents/plugins/marketplace.json` is the repository distribution catalog.
- `.claude-plugin/`, `agents/`, `skills/`, `hooks/` — the existing Claude plugin package.
- `docs/codex.md` and `docs/legacy-claude.md` — route-specific setup and operation.
- `hooks/` — the two `PreToolUse` hooks (`protect-main.mts`, `protect-worktree.mts`) and
  `lib/common.mts`; `hooks.json` wires them.
- `ci/` — `scope-check.mts`, `negative-control.mts`, `issue-lint.mts` (an issue's contract,
  checked before dispatch), `lib/detect.mts` (the test-command detection `negative-control.mts`
  uses). Copied into adopting repositories by `init`; **this** repository's workflows point
  at `ci/` directly.
- `scripts/` — `init.mts` (the installer: `agents/`, `skills/`, `templates/`, `docs/`),
  `reconcile.mts` (the loop's state as JSON), `claim.mts` (locks an issue or refuses),
  `land.mts` (the only way the orchestrator merges a PR: queues `gh pr merge --squash
  --auto`, gated by the base branch's ruleset when it has one, else by `gh pr checks
  --required`).

## Invariants (the reviewer holds every PR to these)

1. **No runtime dependencies, anywhere under `hooks/`, `ci/`, `scripts/`.** `node:` built-ins
   only. `package.json` devDependencies are for `tsc` alone.
2. **`.mts` only, erasable TypeScript only** — no `enum`, no parameter properties, no
   namespaces, no decorators. Node ≥ 22.18 runs the files directly; there is no build step.
3. **Every hook states its crash policy in its header and honours it.** `protect-*` hooks
   fail open on their own errors; `land.mts` fails closed (refuses) when `gh` cannot
   answer.
4. **Detection is a default, never a contract.** New stacks go in `ci/lib/detect.mts` with an
   env override path; no config file.
5. **The parsers stay strict.** `## Files` reads bullets only; `authorised:` is one glob per
   line; the closing-keyword line (`Closes`/`Fixes`/`Resolves #N`, several allowed) is
   plain text — a keyword inside backticks or a fence is ignored. Loosening a parser
   needs a test for the exact prose that used to break it.
6. **Tests spawn the real script.** A case for a hook, a CI script or the installer runs
   the actual file against a real git repository; external CLI responses may use controlled
   fixtures, not replacements for production functions. Pure functions in
   `ci/lib/` (`detect`, `scope`, `globs`) may be imported and tested directly.
7. **English throughout; no references to private projects.** Lessons yes, provenance no.
8. **Docs equal code.** A change to a hook, flag, label or check updates `docs/` and the
   relevant `SKILL.md` in the same PR.

## Select one workflow

- For a user-authorized Codex objective, use `$autonomous-loop` and its contract.
  Ordinary edits do not start or resume an objective. GitHub is the durable state;
  starting the loop grants routine publication and validated merge within its boundaries,
  unless the user restricts either. Record that standing authority once. Codex synchronizes
  status labels from evidence; `human:pending` blocks affected work and `human:reviewed`
  records a past decision, while labels never grant approval.
  Do not import the Claude scheduler,
  hooks, PID cleanup or merge exceptions into the Codex objective loop.
- The Claude route remains available through its plugin commands and `CLAUDE.md`.
  Its operating contracts are `docs/workflow.md`, `docs/orchestration.md` and
  `skills/issue-and-pr/SKILL.md`. Do not launch it against an objective owned by Codex.
- One coordinator owns an objective at a time. Preserve existing sessions/worktrees;
  an absent remote branch or a label is not proof that another session is abandoned.
- Maintenance PRs in this repository retain the existing issue/CI contract during
  migration: valid closing keywords, issue Files globs, accurate type labels and the
  required checks. Review independently before integrating. Do not change server
  protections or switch merge procedures to get around a refusal.
- Installing either route must preserve the other's files and user configuration.
  Never commit local permission settings or enable model/global defaults as part of setup.
- Prefer codebase-memory MCP for discovery when available; fall back to `rg` for
  unavailable/insufficient graph results, strings and configuration. MCP is optional.
