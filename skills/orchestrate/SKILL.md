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
git fetch --prune origin
node "$RECONCILE" --milestone "<current>"
```

Without `--milestone`, it picks the open milestone with the lowest number. Fields:

- `milestone` — the title it reconciled against.
- `ready` — `{ number, title, blockedBy }`: `state:ready` issues in the milestone whose
  `Blocked by:` issues are all closed (`blockedBy` lists them; empty when none). This is
  step 1's candidate list — no separate query needed.
- `inProgress` — `{ number, branch, hasRemoteBranch, pr }`: `state:in-progress` issues.
  `pr` is the open PR's number on that branch, or `null`.
- `inReview` — `{ number, pr, checks, reviewApproved }`: `state:in-review` issues.
  `checks` is `'green'`, `'red'` or `'pending'` from the PR's status rollup;
  `reviewApproved` is the `review:approved` label or an `APPROVED` review. Checks green
  and `reviewApproved` → merge (step 5).
- `stale` — `{ number, reason }`: in-progress issues with no open PR **and** no remote
  branch → back to `state:ready`.
- `orphanWorktrees` — paths of linked worktrees whose branch no longer exists on the
  remote → remove them (stop any local service they started first).

A failing `gh` or `git` call prints `{ "error": "..." }` and exits 1; stop and report
rather than guessing the state.

## 1. Candidates

Use `ready` from the JSON above — it already excludes issues with an open blocker.

## 2. Pick up to 4 with disjoint globs

Read each candidate's `## Files`. Two issues whose globs could match the same file do not
run together. Four is the practical ceiling; file conflict is the real limit, not the
subagent count.

## 3. Lock, then launch

For each pick (skill `issue-and-pr`, "Claim"): push `origin/main:refs/heads/<type>/<n>-<slug>`
— if it exists, someone has it, skip — assign, `state:in-progress`. Then launch the
`implementer` agent with **the whole issue body in the prompt** (subagents do not see this
conversation). One agent per issue, in parallel.

## 4. PR opened → review

When an implementer returns with a PR: launch the `reviewer` agent with the PR number and
the issue body. Check CI with `gh pr checks <n>`; do not poll in a tight loop — a check
takes minutes, look once per pass.

## 5. Decide

- Checks green **and** `review:approved` → `gh pr merge <n> --squash --delete-branch`
  (the protect-main hook re-verifies both). Label the issue `state:done`. Remove the
  worktree **after** the merge, never before.
- Rejected by CI or reviewer, first time → relaunch the implementer with the PR's failure
  summary and the reviewer's JSON (round 2; skill `safe-worktree` §C).
- Rejected a second time → `state:blocked` + `human`, comment with the summary, move on.
  Exception: a purely mechanical defect with the exact fix named by the reviewer earns one
  short extra round. Log the exception in the issue.
- Conflict with `main` → the implementer runs `git merge origin/main` on the branch.
- `type:docs` PR with green CI → merge without a reviewer.

## 6. Close the pass

- Nothing left to do → comment on the milestone's parent issue with what is blocked and why.
- Milestone with no open issue → open the next milestone's parent issue and, as planner,
  its sub-issues (skill `issue-and-pr`, "Write sub-issues").

## Escalate to a person (label `human`, comment on the issue)

A missing secret or variable; validation that needs hardware or an account you lack; a
production-affecting decision; a product decision the docs do not cover; any issue in
`state:blocked`.
