# agentic-setup

A Claude Code plugin for running a repository with autonomous agents: **one GitHub
issue per unit of work, one git worktree per agent, PRs merged by CI and a reviewing
agent** — no human in the loop except at the points the loop names.

Project-agnostic by construction. Nothing here assumes a language or framework: the
test command is detected from the repository (`package.json`, `pyproject.toml`,
`go.mod`, `Cargo.toml`, …) and can be overridden with one setting. The hooks are two
small Node scripts with no dependencies; they run unchanged under Bun.

## Install

```
/plugin marketplace add marcelusfernandes/agentic-setup
/plugin install agentic-setup@agentic-setup
```

Then, in the repository you want to run this way:

```
/agentic-setup:init --milestone "M1 foundation"
```

It copies the GitHub templates and the two CI checks, writes the permission deny list,
installs the git `pre-push` hook and seeds the labels — and prints the few steps only a
person can do (required checks, ruleset). From then on, one pass of the loop is:

```
/agentic-setup:orchestrate
```

## The loop

One Claude Code session at the repository root is the **orchestrator**. It never
implements; it plans and dispatches.

```
0. RECONCILE from GitHub, never from memory
   in-progress with no PR and no remote branch → ready
   in-review with green CI and review:approved → merge
   local worktree with no remote branch → delete
1. read state:ready issues of the current milestone with no open dependency
2. pick up to 4 whose file globs do not overlap
3. for each: push the remote branch <type>/<n>-<slug> (the push IS the lock;
   if it already exists, skip), assign, label in-progress, launch an
   implementer in its own worktree with the whole issue in the prompt
4. PR opened → launch a reviewer (read-only) and wait for CI
5. green checks + review:approved → squash merge → label done → back to 1
   rejected (CI or reviewer) → back to the implementer with the summary (round 2)
   second rejection → state:blocked + human, comment with the summary, move on
6. docs-only PR → merge on green CI, no reviewer
7. nothing left to do → post a summary of what is blocked on the milestone issue;
   milestone with no open issue → open the next milestone's parent issue
```

Everything the loop needs to be safe is mechanical, not prose: a remote branch as
the lock, a Stop hook that runs the tests, a CI job that checks the diff stays inside
the globs the issue declared, and a **negative control** job that proves the tests
the PR added actually fail without the change.

## What is inside

| piece | what it does |
|---|---|
| `agents/` | `implementer` (one issue → one PR, test first, own worktree), `reviewer` (read-only, JSON verdict, sets the label), `docs-writer` (docs equal to code, `type:docs` PRs) |
| `skills/` | `orchestrate` (one pass of the loop, for the main session), `init` (set a repository up), `safe-worktree` (how not to lose work), `issue-and-pr` (the exact `gh` contract) |
| `hooks/` | `protect-main.mjs` (no push to main, no merge without green checks and the review label), `protect-worktree.mjs` (a subagent may not write into the main checkout), `stop-gate.mjs` (run the detected check and test commands before an agent on a work branch stops), and the git `pre-push` the init installs |
| `ci/` | `scope-check.mjs` (diff ⊆ the issue's globs), `negative-control.mjs` (the PR's tests must fail on the base), `lib/detect.mjs` (the test-command detection both the hook and CI share). Copied into the target repository by `init`. |
| `templates/` | issue and PR templates, `guard-main` and `agentic-checks` workflows, `.worktreeinclude`, the permission deny list |
| `docs/` | the contract in full: [workflow](docs/workflow.md), [orchestration](docs/orchestration.md), [decisions](docs/decisions.md) |
| `tests/smoke.mjs` | 60+ cases against real throwaway repositories; `node tests/smoke.mjs` or `bun tests/smoke.mjs` |

## Requirements

- Node.js ≥ 18 on the machine that runs Claude Code (Bun runs the same files; the smoke
  suite is run under both). The hooks fail **open** when Node is missing — they are one
  layer of three, not the only one.
- Override detection when it guesses wrong: `AGENTIC_TEST_CMD`, `AGENTIC_CHECK_CMD`,
  `AGENTIC_TEST_GLOBS`. Valves, always declared inline and visible in the transcript:
  `AGENTIC_ALLOW_PUSH_MAIN=1`, `AGENTIC_ALLOW_MERGE=1`. Review label: `AGENTIC_REVIEW_LABEL`.
- `gh` authenticated against the repository.
- git ≥ 2.38 (`git worktree`, `git push` refspec locks).

## Where this comes from

Distilled from a private project that ran ~200 issues and ~160 PRs through this loop
over its first weeks, with a written lesson for each rule that bit. The lessons are
kept; the project's stack, names and PR numbers are stripped. The upstream ideas
that survived: branch-as-lock, the issue section contract, worktree safety rules,
"a milestone does not close with an open issue".

## License

MIT.
