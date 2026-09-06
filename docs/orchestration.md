# Orchestrating agents in worktrees

## The orchestrator

One Claude Code session at the repository root (not in a worktree), running
`/agentic-setup:orchestrate` one pass at a time. Two roles:

- **planner:** decomposes the milestone's parent issue into self-sufficient sub-issues
  (context with `file:line` references, acceptance criteria, proof, globs,
  dependencies). Schema or contract changes become their own issues, opened first;
  feature issues that depend on them are born blocked.
- **dispatcher:** the loop below. The only role that touches the root `package.json`
  (or equivalent), the lockfile, `.claude/**`, `.github/**`, `main` and the labels.
  It never implements.

```
0. RECONCILE from GitHub (never from memory):
   in-progress with no PR and no remote branch → ready
   in-review with green CI and review:approved → merge
   local worktree with no remote branch → delete
1. read state:ready issues of the current milestone with no open dependency
2. pick up to 4 whose globs do not intersect
3. for each: push the remote branch <type>/<n>-<slug> (the lock; skip if it exists),
   assign, label in-progress, launch an `implementer` in its own worktree with the
   whole issue in the prompt
4. PR opened → launch a `reviewer` (read-only) and wait for CI
5. green checks + review:approved → squash merge → label done → back to 1
   rejected (CI or reviewer) → back to the implementer with the summary (round 2)
   main moved and conflicts → implementer runs `git merge origin/main` (never rebase
   a published branch)
   second rejection → state:blocked + human, comment with the summary, move on
     (exception: a mechanical defect with the exact fix named by the reviewer earns
      one short extra round; a rejection with judgment pending blocks)
6. docs-only PR (`docs/**`, `CLAUDE.md`, `.claude/**`) → merge on green CI, no reviewer
7. pass with nothing to do → summary of what is blocked on the parent issue;
   milestone with no open issue → open the next milestone's parent issue
```

Why "reconcile from GitHub": the orchestrator's context is summarised, restarted and
lost. Labels, branches and PRs are not. Every pass starts by reading them.

## The implementer, step by step

0. Prove the secrets arrived in the worktree (a worktree is born with tracked files
   only; `.worktreeinclude` or your equivalent copies the rest).
1. Prove the base is right: `git fetch`, and `grep` for a symbol the prerequisite issue
   delivered. A stale worktree does not see what another issue merged.
2. Prove you can write (a throwaway edit). The write guard complains now, not on the
   third edit.
3. Read the issue and everything it links.
4. Write the failing test. Commit it as `test(red): …`. That commit is the negative
   control CI will verify; without it the PR fails.
5. Implement until the test command is green. Commit at every green.
6. Run the project's check command (types, lint, fast scans). Green.
7. Open the PR with the template (a closing keyword — `Closes`/`Fixes`/`Resolves #N`,
   several may be linked, the diff must fit the union of their globs, never quote a
   keyword inside backticks or a fence — test summary, globs touched). Label
   `state:in-review`. Copy the issue's `type:`/`scope:` labels onto the PR.
8. Stop. Do not merge. If CI or the reviewer sends it back, fix in the same worktree
   and update the PR.

Forbidden: `git stash`, `git reset --hard`, `git checkout <file>`, `git clean`,
force-push, editing outside the globs, touching the root manifest or lockfile. Need a
new dependency? Comment on the issue and stop: that is a `type:deps` issue for the
orchestrator. Conflict with `main`: `git rebase` only before the first push; a published
branch uses `git merge origin/main` (the final squash flattens it).

## The reviewer

Read-only. Checks each acceptance criterion against the diff and the test summary; the
scope; the negative control; the project's invariants (whatever `CLAUDE.md` names as
such). Returns JSON:

```json
{"verdict": "approved" | "rejected", "reasons": [{"ac": "AC2", "file": "path:line", "missing": "..."}]}
```

and sets `review:approved`, or `state:qa-failed` with the reasons. Never edits, never
merges, never offers to fix.

## Hooks (deterministic, instead of prose)

| event | hook | what it does |
|---|---|---|
| PreToolUse Bash | `protect-main.mts` | denies push to `main`/`master`, deleting them, and `gh pr merge` without green checks and the review label. Force-push, `reset --hard`, `clean`, `stash` and `--admin` merges are also denied declaratively by the permission deny list `/agentic-setup:init` writes — the hook catches the forms a prefix pattern cannot |
| PreToolUse Edit/Write | `protect-worktree.mts` | denies a subagent's write that resolves inside the main checkout but outside its own worktree. A real failure mode: under load the model writes with an absolute path rooted at the main repository, and a prose rule does not stop it |
| Stop | `stop-gate.mts` | runs the detected check + test commands before an agent on a `<type>/<n>-<slug>` branch may stop, **except** when the last commit is `test(red):`. On `main`, on an unrecognised branch, or with no detectable test command it skips with a note on stderr; the real gate is CI |

Hooks run with Claude Code's environment (`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin,
the payload's `cwd` to the agent's worktree). A change to a hook takes effect after the
plugin updates, for every agent at once. Hooks fail **open** when Node is missing — the
git `pre-push` hook and the `guard-main` action are the other layers.

## Escalation to a person

Five reasons, always with the `human` label and a comment on the issue: a missing
secret or variable; validation that needs hardware or an account the agent lacks; a
production-affecting decision; a product decision the docs do not cover; **an issue in
`state:blocked`** after two rounds.

## Known limits

- **Every subagent is born pinned to a fresh worktree** (`.claude/worktrees/agent-<id>`)
  and the sandbox refuses git in another worktree. Round N+1 of an issue starts from
  `origin/<branch>` on a local branch `<branch>-rN` and pushes fast-forward to `<branch>`;
  the state that matters is always on the remote (commit at every green). The
  orchestrator removes the old worktree **after** the merge, never before: pruning a
  worktree still in use is what decides whether round N+1 resumes the same agent
  (`SendMessage`, context kept) or starts from zero — delete early and the decision was
  made by accident.
- **Shared local services are the hidden coupling.** If two worktrees point at the same
  local database, cache or dev server, one agent's reset lands under another's test run.
  Derive ports and instance names from the worktree path, and stop the instance before
  removing the worktree — an orphaned stack is how a machine runs out of memory.
- Subagents do not see the orchestrator's conversation: the issue must be
  self-sufficient.
- What limits parallelism is file conflict, not the subagent ceiling. Four issues with
  disjoint globs is the practical number.
- The implementer does not wait on CI. Polling CI burns tokens; the reviewer follows the
  checks and the orchestrator reconciles.
- Agent Teams do not isolate in worktrees; the loop does not use them.
