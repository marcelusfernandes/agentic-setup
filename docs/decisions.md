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

PR to `main` with `Closes`/`Fixes`/`Resolves #N` (several issues may be linked; the diff
must stay inside the union of their globs; a keyword inside backticks or a fence is
ignored); squash when the checks pass and the reviewer returns
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
- **(b) On every machine that runs Claude Code:** the plugin's `protect-main.mts` hook
  plus the permission deny list `/agentic-setup:init` writes (force-push, `reset --hard`,
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

## 11. Every mutating orchestrator step is a script with a refusal path

Every orchestrator step that mutates GitHub — locking an issue, dispatching one, merging a
PR — is a script that reads live state and refuses rather than guessing, not a prose
instruction the model is trusted to follow correctly under load: `scripts/claim.mts`
(lock), `ci/issue-lint.mts` (dispatch gate), `scripts/land.mts` (merge). The model still
plans and decides which issue to pick, which PR to send back, whether to wait; the script
verifies the precondition and performs the write, and prints what it refused and why
instead of a stack trace or a silent no-op.

*Why:* two M1 incidents, both from a step that was prose with nothing between its arrows
verifying anything.
- **#25's premature `done`.** Step 5 read "green checks and `review:approved` → merge →
  label done → remove the worktree". In PR #28 (closing #25) the orchestrator ran
  `gh pr merge`, the server refused it (a label change had re-triggered a required check,
  so its latest run was no longer the one the orchestrator had seen), and the orchestrator
  labelled the issue `state:done` anyway — `scripts/reconcile.mts` exposed the
  inconsistency a minute later. `scripts/land.mts` closes this by re-reading `gh pr view`
  itself at the moment of the call and labelling only after a follow-up `gh pr view`
  reports `state: MERGED`.
- **#3's missing glob.** Nothing checked, before dispatch, that an issue's `## Files`
  covered every file the change would touch — `scope-check` only enforces the boundary
  *after* the diff exists. Issue #3 renamed `tests/smoke.mts` to `tests/run.mts` inside its
  `tests/**` glob, while `.github/workflows/test.yml` referenced the old path from outside
  it; fixed inside the same PR under an `authorised:` grant on the workflow file, not by
  any check. `ci/issue-lint.mts`'s AC4 now `git grep`s every tracked file for a reference
  to each file an issue's globs cover and reports a hit as a `warnings` entry before the
  issue is ever dispatched.

*Cost accepted:* one more script to maintain per mutating step, each with its own test
file and its own refusal shapes to keep in sync with the skills that call it.

## 12. Issue-time entry-point warnings are advisory, not a gate

`ci/issue-lint.mts`'s AC4 warns when a tracked file outside an issue's `## Files` names a
path the issue's globs cover — the check #3's shape needed (item 11 above). But the same
`git grep` fires on every reference, not only the ones a diff would break: at issue time,
before the diff exists, it cannot tell a rename or removal from an in-place edit. Folding
the warning into `ok` by default (`--strict` for `type:feature`/`type:bug`, the original
plan) blocks every bug or feature that touches an already-documented or already-imported
file. In the 2026-09-06 pass, #41 (nine warnings: workflows, docs, skills, `ci/lib/issue.mts`
naming `ci/issue-lint.mts`) and #42 (three warnings: imports of `ci/lib/globs.mts`) both
edit in place and rename nothing, so no widening of `## Files` short of listing every file
in the repository that references them could have reached `ok: true` under `--strict` —
and that widening would have overlapped every other issue in the milestone's globs.

*Decision (2026-09-06, by the person running the loop):* `--strict` stays an opt-in flag
on `ci/issue-lint.mts` and `scripts/claim.mts`, never applied by issue type. The
orchestrator reads every `warnings` entry itself: a path the issue renames or removes gets
`## Files` widened before dispatch; any other warning — an in-place edit or import, like
#41 and #42 — is logged as a one-line classification on the issue when it is dispatched,
and it is `ok: true` without `--strict` that gets dispatched.
