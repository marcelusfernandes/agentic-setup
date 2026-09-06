---
name: orchestrate
description: Run one pass of the agent loop for the current milestone — reconcile from GitHub, dispatch ready issues to implementers in worktrees, review, merge. Use from the main session at the repository root; invoke as /agentic-setup:orchestrate.
---

# Orchestrate

You are the orchestrator: one session at the repository root, never in a worktree. You
plan and dispatch; you never implement. The only role that touches the root manifest,
the lockfile, `.claude/**`, `.github/**`, `main` and the labels.

Run **one pass**. At the end, report what moved and stop; the person decides whether to
run another.

## 0. Reconcile from GitHub — never from memory

`scripts/reconcile.mts` prints the loop's current state as one JSON document,
instead of running `gh issue list`, `gh pr list` and `git worktree list` and
cross-referencing them by hand. Locate it the way `skills/init` locates
`init.mts` — `CLAUDE_PLUGIN_ROOT` is set for hook processes but not for the
Bash tool:

```bash
RECONCILE="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mts}"
[ -f "$RECONCILE" ] || RECONCILE="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/reconcile.mts' 2>/dev/null | head -1)"
[ -f "$RECONCILE" ] || { echo "agentic-setup: reconcile.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
node "$RECONCILE" --milestone "<current>"
```

`reconcile.mts` runs `git fetch --prune origin` itself before reading remote branches, so
this makes one network call for git, not two. Without `--milestone`, it picks the open
milestone with the lowest number; `--no-fetch` skips the fetch and reads the local refs
left by the last one, for an offline check against the last fetch. Fields:

- `milestone` — the title it reconciled against.
- `ready` — `{ number, title, blockedBy }`: `state:ready` issues in the milestone whose
  `Blocked by:` issues are all closed (`blockedBy` lists them; empty when none). This is
  step 1's candidate list — no separate query needed.
- `inProgress` — `{ number, branch, hasRemoteBranch, pr }`: `state:in-progress` issues
  that are not `resumable` (below) — an open PR, a branch checked out in a *live* local
  worktree of this checkout (an agent of this checkout may be alive — a worktree in
  `deadWorktrees` does not count), or no remote branch at all. `pr` is the open PR's
  number on that branch, or `null`.
- `resumable` — `{ number, branch, commitsAheadOfMain }`: `state:in-progress` issues with
  a remote branch, no open PR, and no *live* local worktree checked out on that branch
  (a worktree in `deadWorktrees` does not count as a checkout). A fresh orchestrator
  session has no live agents by definition, so this is not "an implementer is working
  right now" — it is round N+1 of that issue, resumed from `origin/<branch>` (skill
  `safe-worktree` §C). `commitsAheadOfMain` is `0` when the previous implementer never
  pushed past the lock branch's starting point.
- `inReview` — `{ number, pr, checks, reviewApproved }`: `state:in-review` issues.
  `checks` is `'green'`, `'red'` or `'pending'` from the PR's status rollup;
  `reviewApproved` is the `review:approved` label or an `APPROVED` review. Checks green
  and `reviewApproved` → merge (step 5).
- `stale` — `{ number, reason }`: in-progress issues with no open PR **and** no remote
  branch → back to `state:ready`.
- `orphanWorktrees` — paths of linked worktrees whose branch no longer exists on the
  remote → remove them (stop any local service they started first).
- `deadWorktrees` — `{ path, branch, pid }`: linked worktrees locked by a pid that no
  longer exists. Claude Code locks an agent's worktree only while that agent runs
  (`claude agent agent-<id> (pid <N> ...)`) and removes the lock on a clean exit — the
  worktree stays, unlocked; a killed session leaves the lock behind, still naming the
  now-dead pid. When `process.kill(N, 0)` throws `ESRCH`, the worktree does not count as
  a live agent's checkout, so its issue is already reported `resumable` above, not
  `inProgress` — this list is only for cleanup. For each entry, before step 3: `git
  worktree unlock <path> && git worktree remove --force <path>`; then treat its issue as
  `resumable`. This narrows, but does not close, the restart gap (`docs/orchestration.md`,
  Known limits): an unlocked
  leftover worktree (its agent finished without a PR, in a session since dead) still
  reads `inProgress` and needs a person, or a future liveness signal, to resolve.

A failing `gh` or `git` call prints `{ "error": "..." }` and exits 1; stop and report
rather than guessing the state.

## 1. Candidates

Use `ready` from the JSON above — it already excludes issues with an open blocker. Before
picking, lint every candidate — locate `ci/issue-lint.mts` the same way as `reconcile.mts`
above:

```bash
LINT="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/ci/issue-lint.mts}"
[ -f "$LINT" ] || LINT="$(find ~/.claude/plugins -path '*agentic-setup*/ci/issue-lint.mts' 2>/dev/null | head -1)"
[ -f "$LINT" ] || { echo "agentic-setup: issue-lint.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
node "$LINT" <n> [--strict]
```

Prints `{ issue, ok, failures, warnings, globs, sequenced }`; dispatch only `ok: true`. A
`failures` entry (a missing section, a wildcard glob that matches no tracked file, a
`Blocked by:` number `gh` cannot find, or a `{ issue, files }` overlap with another issue
in flight) drops the candidate from this pass — a literal path with no `*`, `?` or `**`
that matches no tracked file is reported as `new` in `globs`, not a failure (the issue is
expected to create it), and so is a wildcard glob whose fixed prefix (the part before its
first `*` or `?`) names a directory with no tracked file anywhere — the way an issue
declares a whole new directory. A `sequenced` overlap is not a failure either, it means the
two issues are already ordered by a `Blocked by:` relation.

`--strict` folds `warnings` into `ok`/exit code; it is an opt-in flag, never something this
step passes by issue type — a warning fires on every in-place reference to a covered file,
not only a rename, so folding it into `ok` by default would block a bug fixing an
already-referenced file (`docs/decisions.md` item 12). Read every `warnings` entry
yourself on every `ok: true` candidate: `{ file, referencedBy }` says a tracked file
outside `## Files` names a path the candidate's globs cover (the `#3` shape). If that path
is one the issue renames or removes, widen `## Files` to include the referencing file
before dispatching. Otherwise, log a one-line classification of the warning as a comment
on the issue when you dispatch it.

## 2. Pick up to 4 with disjoint globs

Read each candidate's `## Files`. Two issues whose globs could match the same file do not
run together — `issue-lint`'s own `failures`/`sequenced` already checked this against every
other issue in flight in the milestone, so a candidate that reached `ok: true` has no
undeclared overlap left to find by hand. Four is the practical ceiling; file conflict is
the real limit, not the subagent count.

## 3. Lock, then launch

For each pick (skill `issue-and-pr`, "Claim"), run `scripts/claim.mts` — located the same
way:

```bash
CLAIM="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/claim.mts}"
[ -f "$CLAIM" ] || CLAIM="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/claim.mts' 2>/dev/null | head -1)"
[ -f "$CLAIM" ] || { echo "agentic-setup: claim.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
node "$CLAIM" <n> --slug <slug> [--type <type>] [--strict] [--no-lint]
```

`<type>` defaults to the title prefix (`feat(scope): …` → `feat`) and must be one of
`feat|fix|refactor|chore|docs|test|ci|deps`; a title outside that set (e.g. `perf(ci): …`)
has no type of its own, so pass `--type` with a value from the set (whichever fits — `ci`
for `perf(ci): …`), or `claim.mts` errors out (an invalid `--type` errors too, same set).
Before pushing, `claim.mts` runs `ci/issue-lint.mts` on the issue itself and refuses on
anything but `ok: true` — `{ refused: "issue-lint failed", lint }`, nothing pushed or
relabelled. `--strict` is opt-in, passed through verbatim when given (not applied by issue
type — same rule as step 1); `--no-lint` skips the check (`"lint": "skipped"` in the
success JSON instead of `"lint": { "ok": true, "warnings": <n> }`).

Exit 0 → `{ issue, branch, base, lint }`: the push succeeded (the lock), the issue is
assigned and `state:in-progress`. Exit 2 → `{ held }`: the branch already exists — another
agent (or a previous, still-live claim) holds it; skip, do not retry. Exit 1 with
`{ refused }`: the issue is not claimable (closed, missing `state:ready`, an open
`Blocked by:` issue, no `## Files` bullet, or a failing `issue-lint`) — drop it from this
pass, it needs a person or a prior issue to close first. Exit 1 with `{ error }`: a usage
problem (no type determinable and none given, or an invalid `--type`) or a `gh`/`git`
failure — not a verdict on the issue; stop and report rather than guessing.

Then launch the `implementer` agent with **the whole issue body in the prompt** (subagents
do not see this conversation). One agent per issue, in parallel.

For each issue in reconcile's `resumable` list, do not claim it again — the lock is
already held by this orchestrator's own `state:in-progress` label and remote branch.
Dispatch it straight to an implementer as round N+1: tell it to start from
`origin/<branch>` (skill `safe-worktree` §C), that the previous agent is gone, and to
verify what is already pushed, finish the work, and open the PR.

## 4. PR opened → review

When an implementer returns with a PR: launch the `reviewer` agent with the PR number and
the issue body. Check CI with `gh pr checks <n>`; do not poll in a tight loop — a check
takes minutes, look once per pass.

## 5. Decide

- Checks green **and** `review:approved` (or `type:docs`, which `land.mts` merges without
  approval) → run `scripts/land.mts`, located the same way as the scripts above:

  ```bash
  LAND="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/land.mts}"
  [ -f "$LAND" ] || LAND="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/land.mts' 2>/dev/null | head -1)"
  [ -f "$LAND" ] || { echo "agentic-setup: land.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
  node "$LAND" <pr> [--wait <seconds>]
  ```

  `land.mts` re-reads the PR's live state itself and is the only thing that merges it —
  never run `gh pr merge` by hand for this step. It **replaces** `protect-main`'s merge
  gate for this call, it does not rely on it: that hook matches `gh pr merge` in the Bash
  *command string* and never sees a `gh` process spawned from node, so `AGENTIC_ALLOW_MERGE`
  has no effect here and there is no bypass for `land.mts`'s own checks
  (`scripts/land.mts` header). On success it prints `{ merged, pr, issues, worktreeRemoved }`
  — every closed issue is already `state:done` and its worktree already gone; there is
  nothing left to label or remove by hand.

  A precondition failing prints `{ refused, pr, missing, rulesetChecks }`, exit 1, and
  changes nothing. **A `refused` is never a signal to retry with `--admin`** — read
  `missing` and decide between waiting and sending the PR back:
  - `state=<x>` / `mergeStateStatus=<x>` (not `OPEN`/`CLEAN`) → the PR is closed, dirty or
    behind `main`; a conflict sends it to the implementer (`git merge origin/main`),
    anything else needs a look.
  - `review:not-approved` → wait for the reviewer; this is not a merge failure.
  - `checks:<name>=<status>` → that required check's latest run is not green. If it is
    still `IN_PROGRESS`/`QUEUED`, wait or re-run with `--wait <seconds>` to poll instead of
    refusing immediately; if it finished red, send the PR back to the implementer like any
    other CI rejection.
  - `checks:none-registered` → no check ran at all on this PR; investigate before waiting.

  `{ error }` (also exit 1) means the merge command itself failed, or the PR never reached
  `MERGED` after `gh pr merge` returned — a `gh`/`git` problem, not a verdict; stop and
  report, touch no label or worktree.

  This script exists because of exactly the shortcut it forecloses: in M1 (PR #28, closing
  #25) the orchestrator ran `gh pr merge`, the server refused it over a re-triggered check,
  and the orchestrator labelled the issue `state:done` anyway — `reconcile.mts` caught the
  inconsistency a minute later (`docs/decisions.md` item 11). `land.mts` only ever labels
  after `gh pr view` itself reports `state: MERGED`.
- Rejected by CI or reviewer, first time → relaunch the implementer with the PR's failure
  summary and the reviewer's JSON (round 2; skill `safe-worktree` §C).
- Rejected a second time → `state:blocked` + `human`, comment with the summary, move on.
  Exception: a purely mechanical defect with the exact fix named by the reviewer earns one
  short extra round. Log the exception in the issue.
- Conflict with `main` → the implementer runs `git merge origin/main` on the branch.

## 6. Close the pass

- Nothing left to do → comment on the milestone's parent issue with what is blocked and why.
- Milestone with no open issue → open the next milestone's parent issue and, as planner,
  its sub-issues (skill `issue-and-pr`, "Write sub-issues").

## Escalate to a person (label `human`, comment on the issue)

A missing secret or variable; validation that needs hardware or an account you lack; a
production-affecting decision; a product decision the docs do not cover; any issue in
`state:blocked`.
