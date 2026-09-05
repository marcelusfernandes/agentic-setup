# Decisions

The reasoning behind the loop, condensed. Each item is a decision, its reason, and
what it costs.

## 1. Unit of work: a GitHub sub-issue

Child of the milestone's parent issue. Declares **file globs**, dependencies
(`Blocked by #N`), verifiable acceptance criteria and its proof. The orchestrator, as
planner, writes the sub-issues — it is owned work, not implicit.

*Why:* an agent can only be held to what is written down where it can read it. The
issue is the only channel that survives context loss.

## 2. Claiming: the remote branch is the lock

The orchestrator pushes `<type>/<n>-<slug>` from `origin/main`; the push of a new ref
fails if it exists. Then it assigns and flips the label. With one orchestrator this is
belt and braces; with two, the ref is what holds.

## 3. Isolation: one worktree per issue

`isolation: worktree` on the implementer. A worktree is born with tracked files only,
so whatever is gitignored and needed (env files) is copied in by a versioned include
list, and the implementer's step 0 proves it arrived. Forbidden: `stash`, `reset --hard`,
`clean`, force-push. `rebase` only before the first push; once published, conflicts
with `main` are resolved with `merge origin/main` — rebase there would need a
force-push, which is denied everywhere.

## 4. Merge without a human

PR to `main` with `Closes #N`; squash when the checks pass and the reviewer returns
approved. **No up-to-date-branch requirement** — CI runs again on `main` after the
merge; rebase only on conflict. Two failed rounds become `state:blocked` **with the
`human` label**, and the orchestrator moves on.

*Cost accepted:* no human review per PR. Quality rests on the checks being truly
blocking and on the negative control being verified by CI, not by the agent.

## 5. Parallelism

Up to four issues in flight, with non-intersecting globs. Schema or contract changes
are their own issues, opened first; features that need them are born blocked.

## 6. PR classes

- `feature` / `bug`: checks + reviewer.
- `db` / schema (or your equivalent serialised class): same, one at a time.
- `docs` (only `docs/**`, `CLAUDE.md`, `.claude/**`): lint CI, merge without reviewer.
- `deps`: only the orchestrator; manifest and lockfile.

## 7. Restart

On start, the orchestrator reconciles from GitHub, not memory: `in-progress` with no
PR and no remote branch goes back to `ready`; `in-review` with green CI and an
approved review is merged; an orphan worktree is deleted. A pass that finds nothing to
do posts what is blocked on the parent issue.

## 8. Explicit human points

Approving these decisions (explicit OK; silence does not approve); secrets and
variables; the main-protection choice below; anything that needs hardware or accounts
the agent lacks; production cut-overs; any `state:blocked` issue.

## 9. Single trunk, and how `main` is protected

`main` is the only trunk. Protection has three layers; use as many as your plan allows.

- **(a) Server-side, preferred:** a GitHub ruleset on `main` — PR required, required
  checks, no force-push, no deletion. Free on public repositories and on paid
  organisations; **not available on private repositories under the free plan** (rulesets
  and branch protection return 403 there).
- **(b) On every machine that runs Claude Code:** the plugin's `protect-main.mjs` hook
  plus the permission deny list `/agentic:init` writes (force-push, `reset --hard`,
  `clean`, `stash`, `gh pr merge --admin`). Covers what goes through Claude Code; does
  not cover a push from elsewhere.
- **(c) Detection:** the `guard-main` action. On a push to `main` that belongs to no PR
  it opens an issue labelled `human` and fails the run, so the history turns red and
  someone looks. The escape hatch is a commit message containing `[allow-push-main]`,
  for bootstrap only.

If you have (a), keep (b) anyway — the hook's merge gate (green checks **and** the
review label) is stricter than what a ruleset expresses, and it fails fast on the
agent's machine instead of at the server.

## 10. Negative control is the load-bearing check

Every feature PR carries a `test(red):` commit. CI checks out the PR's base, applies
only the test files from the diff, runs the test command and requires a failure. A PR
whose tests pass without its change has proven nothing; this job is what makes "merge
without a human" honest rather than hopeful.
