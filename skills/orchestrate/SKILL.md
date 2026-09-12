---
name: orchestrate
description: Run the agent loop across every open milestone — reconcile from GitHub, dispatch ready issues to implementers in worktrees, review, merge, then continue — stopping only for a closed list of reasons. Use from the main session at the repository root; invoke as /agentic-setup:orchestrate.
---

# Orchestrate

You are the orchestrator: one session at the repository root, never in a worktree. You
plan and dispatch; you never implement. The only role that touches the root manifest,
the lockfile, `.claude/**`, `.github/**`, `main` and the labels.

Run the loop below to completion, not one pass. Reconcile (step 0); dispatch up to four
`state:ready` issues with disjoint `Files` as implementers, in the foreground (steps 1-3);
on each implementer's return, launch the reviewer (step 4); on each verdict, comment it
and apply the labels (step 5); when checks are green and the approval is on, `land.mts`,
then poll `reconcile` until the issue's PR is actually merged — not a tight loop, a merge
takes minutes; then move to the next ready issue, back at step 0. Step 6 closes a
milestone with no open issue left and opens the next one, without stopping.

## The closed list of stop reasons

The loop stops only for one of these, never for anything else — in particular, never
merely because a pass found nothing new to dispatch this instant:

1. **No open milestone.** `reconcile.mts` reports `{ error: "no open milestone" }` (or
   the equivalent: every milestone in the repository is closed).
2. **Every open issue in the milestone is `state:blocked`, `human:pending`, or otherwise
   waiting on a person** — nothing left that a fresh reconcile would move by itself. A
   `reconcile`/`gh`/`git` call itself failing with `{ error }` (step 0) counts here too:
   it needs a person to look at the failure, not an automatic retry.
3. **An explicit turn or time budget given on the command line is spent** — `claude -p
   ... --max-turns <n>` for a turn budget, an external `timeout <seconds> claude -p ...`
   for a time budget. The orchestrator never invents either budget itself; when neither is
   given on the command line, only reasons 1 and 2 stop the loop.

On stop, comment a summary on the milestone's parent issue: what moved this run, what is
left, and which of the three reasons above applies.

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
  `Blocked by:` issues are all closed (`blockedBy` lists them; empty when none) and that
  carry no pending human label (those go to `humanPending` instead). This is step 1's
  candidate list — no separate query needed.
- `humanPending` — `{ number, title, label }`: open issues in the milestone carrying
  `human:pending` or the legacy bare `human` (any case; `label` is the name found),
  whatever their `state:`. Never dispatch these; a person decides, records the decision
  in a comment, flips the label to `human:decided` and sets the next `state:` (see
  "Resume after a person decides"). `human:decided` issues are not listed here.
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
  `checks` is `'green'`, `'red'` or `'pending'`, from one `gh pr checks <pr> --json
  name,bucket` call per PR (green when every surviving check's bucket is pass/skipping,
  red on any fail/cancel, else pending) — no rollup dedupe of its own.
  `reviewApproved` is the `review:approved` label or an `APPROVED` review. Checks green
  and `reviewApproved` → merge (step 5).
- `stale` — `{ number, reason }`: in-progress issues with no open PR **and** no remote
  branch → back to `state:ready`.
- `orphanWorktrees` — paths of linked worktrees whose branch no longer exists on the
  remote → remove them (stop any local service they started first). A path that also
  appears in `deadWorktrees` follows that bullet's recovery (patch, push) before removal;
  this bullet's plain removal is for worktrees with nothing left to save.
- `deadWorktrees` — `{ path, branch, pid, dirty, unpushed }`: linked worktrees locked by a
  pid that no longer exists. Claude Code locks an agent's worktree only while that agent
  runs (`claude agent agent-<id> (pid <N> ...)`) and removes the lock on a clean exit — the
  worktree stays, unlocked; a killed session leaves the lock behind, still naming the
  now-dead pid. When `process.kill(N, 0)` throws `ESRCH`, the worktree does not count as
  a live agent's checkout, so its issue is already reported `resumable` above, not
  `inProgress` — this list is only for cleanup, but a dead worktree can still hold work an
  implementer never got to commit or push (#88: four implementers died mid-work in M4, one
  with a local commit never pushed). `dirty` is `true` when `git -C <path> status
  --porcelain` prints anything; `unpushed` is the count of commits on the worktree's `HEAD`
  not on `origin/<branch>`, or `null` when there is no such remote branch. `dirty` itself
  reads `null` when the `git` call behind it fails (a broken or missing worktree) — skip
  step 1 for that entry, but still remove it in step 3; there is nothing to trust a
  status read from. Recover before removing, for each entry:
  1. If `dirty`: `git -C <path> add -N . && git -C <path> diff HEAD > <patch>` — the
     `add -N` (intent-to-add) makes untracked files show up in the diff without staging
     their content, and `diff HEAD` (rather than a bare `diff`, which drops staged
     content) captures staged, unstaged and intent-to-added changes together. Save the
     patch path; it is handed to the round N+1 implementer as a draft to verify, test
     committed first, not applied as-is.
  2. If `unpushed > 0`: `git push origin <branch>` (fast-forward, never force).
  3. `git worktree unlock <path> && git worktree remove --force <path>`; then treat its
     issue as `resumable`.

  This narrows, but does not close, the restart gap (`docs/orchestration.md`, Known
  limits): an unlocked leftover worktree (its agent finished without a PR, in a session
  since dead) still reads `inProgress` and needs a person, or a future liveness signal, to
  resolve.

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
node "$LINT" <n>
```

Prints `{ issue, ok, failures, globs, sequenced }`; dispatch only `ok: true`. issue-lint
checks the issue's contract only — sections present, globs that parse and match
something (or are `new`), globs disjoint from the other issues already in flight, and
every `Blocked by:` number exists — it never reads a diff, so there is no entry-point
warning to read here any more (`docs/decisions.md` item 12, superseded by item 13). A
`failures` entry (a missing section, a wildcard glob that matches no tracked file, a
`Blocked by:` number `gh` cannot find, or a `{ issue, files }` overlap with another issue
in flight) drops the candidate from this pass — a literal path with no `*`, `?` or `**`
that matches no tracked file is reported as `new` in `globs`, not a failure (the issue is
expected to create it), and so is a wildcard glob whose fixed prefix (the part before its
first `*` or `?`) names a directory with no tracked file anywhere — the way an issue
declares a whole new directory. A `sequenced` overlap is not a failure either, it means the
two issues are already ordered by a `Blocked by:` relation.

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
node "$CLAIM" <n> --slug <slug> [--type <type>] [--no-lint]
```

`<type>` defaults to the title prefix (`feat(scope): …` → `feat`) and must be one of
`feat|fix|refactor|chore|docs|test|ci|deps`; a title outside that set (e.g. `perf(ci): …`)
has no type of its own, so pass `--type` with a value from the set (whichever fits — `ci`
for `perf(ci): …`), or `claim.mts` errors out (an invalid `--type` errors too, same set).
Before pushing, `claim.mts` runs `ci/issue-lint.mts` on the issue itself and refuses on
anything but `ok: true` — `{ refused: "issue-lint failed", lint }`, nothing pushed or
relabelled; `--no-lint` skips the check (`"lint": "skipped"` in the success JSON instead
of `"lint": { "ok": true }`).

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
the issue body. The reviewer returns the JSON verdict to you; it does not comment on the
PR or touch its labels any more (`agents/reviewer.md`) — commenting and labelling are this
step's job now, done in step 5, so both happen from one place instead of two. Check CI
with `gh pr checks <n>`; do not poll in a tight loop — a check takes minutes, look once
per pass.

## 5. Decide

On every verdict the reviewer returns, first comment its JSON on the PR yourself, then
apply the labels — `land.mts` and `reconcile.mts` read them regardless of what follows:

- `approved` → `gh pr edit <pr> --add-label review:approved --remove-label state:qa-failed`
  (the remove is harmless when the label was never there — a first-round approval has
  nothing to remove).
- `rejected` → `gh pr edit <pr> --add-label state:qa-failed --remove-label state:in-review`.
- a **second** `rejected` verdict on the same issue → additionally `gh issue edit <n>
  --add-label state:blocked --add-label human:pending`, comment the summary on the issue,
  and move on — unless the defect is purely mechanical with the exact fix named by the
  reviewer, which earns one more round instead (log the exception on the issue).

Then act on the verdict:

- Checks green **and** an approved review (or the `type:docs` label, which `land.mts`
  merges without one) → run `scripts/land.mts`, located the same way as the scripts
  above:

  ```bash
  LAND="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/land.mts}"
  [ -f "$LAND" ] || LAND="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/land.mts' 2>/dev/null | head -1)"
  [ -f "$LAND" ] || { echo "agentic-setup: land.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
  node "$LAND" <pr>
  ```

  `land.mts` is the only way the orchestrator merges a PR — never run `gh pr merge` by
  hand for this step. It refuses (exit 1, `{ refused, pr, missing }`) unless the PR is
  `OPEN` and approved: `reviewDecision === 'APPROVED'`, or — only when the orchestrator's
  own environment has no `AGENTIC_REVIEWER_TOKEN` set — the `review:approved` label as a
  fallback (once that variable is set, the label is a convenience only; see
  `docs/decisions.md` item 13). `missing` names what is wrong: `state=<x>` (not `OPEN`),
  `review:not-approved`, or `gh-pr-view` (could not even read the PR).

  On a refusal that clears, it re-reads the base branch's *effective* rules (`gh api
  repos/{owner}/{repo}/rules/branches/<base>`). When they include a
  `required_status_checks` rule, that ruleset is the gate and `land.mts` queues the merge
  straight away — there is no separate check read to go stale between being taken and the
  merge happening. Otherwise (no such rule on this base branch) it falls back to `gh pr
  checks <pr> --required` itself and refuses (`{ refused, pr, missing: ['checks:required'],
  gate: 'client-checks' }`) if that is not green.

  On success it runs `gh pr merge <pr> --squash --auto` (it never asks `gh` itself to
  delete the branch, and never `--admin`) and prints `{ merged: pr, gate }` if the PR is already `MERGED` by the time it
  reads `gh pr view` back, or `{ queued: pr, gate }` if GitHub will merge it once its own
  rules are satisfied — either way, nothing left to label or remove by hand: `Closes #N`
  closes the issue once the merge happens, and the repository's `delete_branch_on_merge`
  setting removes the branch (the worktree turns up in a later pass's `orphanWorktrees`).
  If `gh pr merge` itself fails with "is in clean status" (a stale read that chose
  "enable auto-merge" a moment after GitHub already considered the PR clean, #81),
  `land.mts` retries once with a plain `gh pr merge <pr> --squash`; any other failure, or a
  PR that still is not `MERGED` after a successful-looking merge call, prints `{ error }`
  and exits 1 — a `gh`/`git` problem, not a verdict. **Never a signal to retry with
  `--admin`, either way.**

  This script exists because of exactly the shortcut it forecloses: in M1 (PR #28, closing
  #25) the orchestrator ran `gh pr merge` by hand, the server refused it over a
  re-triggered check, and the orchestrator marked the issue done anyway — `reconcile.mts`
  caught the inconsistency a minute later (`docs/decisions.md` item 11). Queuing
  `--auto` instead of polling and merging by hand removes the stale-read race by
  construction rather than closing it after the fact (item 13).

  After `land.mts` reports `{ queued }` (or `{ merged }` already), do not move to the next
  issue yet — `Closes #N` is what actually closes it, and step 1's candidates must never
  include one whose PR merge is still only queued. Poll `scripts/reconcile.mts --milestone
  "<current>"` again after a short fixed pause (a merge takes low minutes, not a tight
  loop) until the issue no longer appears in `inReview`, `inProgress` or `resumable` —
  closed, its PR merged — then continue the loop from step 0.
- Rejected by CI or reviewer, first time → relaunch the implementer with the PR's failure
  summary and the reviewer's JSON (round 2; skill `safe-worktree` §C); once it returns,
  back to step 4.
- Conflict with `main` → the implementer runs `git merge origin/main` on the branch.

The second-rejection labels (`state:blocked` + `human:pending`) are applied above, at the
point the verdict arrives — this bullet list is only what happens next, not where the
labelling happens.

## 6. Close the milestone, then keep going

- Milestone with no open issue left → open the next milestone's parent issue and, as
  planner, its sub-issues (skill `issue-and-pr`, "Write sub-issues"), then continue the
  loop from step 0 on the new milestone. Do not stop here — this is not one of the three
  stop reasons.
- Nothing left to dispatch this instant, but the milestone still has open issues → check
  the three stop reasons above before stopping. If none applies (for example, a `humanPending`
  issue was just cleared by a person, or GitHub is still indexing a write from a moment
  ago — #129 L6), reconcile again rather than stopping.

## Escalate to a person (label `human:pending`, comment on the issue)

A missing secret or variable; validation that needs hardware or an account you lack; a
production-affecting decision; a product decision the docs do not cover; any issue in
`state:blocked`. `reconcile.mts` lists these issues under `humanPending` and keeps them
out of `ready`; `claim.mts` refuses them. A bare `human` label from a repository
initialized before the split is read exactly like `human:pending`.

## Resume after a person decides

The person, not the orchestrator, writes the decision as a comment on the issue, replaces
`human:pending` with `human:decided` and sets the next `state:` (`state:ready` to
dispatch again). `human:decided` never blocks and is never added, removed or replaced by
the orchestrator: it is the audit trail that a person intervened on that issue.
