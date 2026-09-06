---
name: issue-and-pr
description: The exact gh commands and the contract for issues, PRs, labels and the branch lock. Use when claiming an issue, opening a PR, or writing sub-issues as the planner.
---

# Issue and PR

Everything that goes to GitHub is in English. The full contract is in the plugin's
`docs/workflow.md`; this is the operating card.

## Claim (orchestrator only)

**The orchestrator creates the branch, not the implementer.**

```bash
n=42; slug=dashboard-kpis; type=feat
git fetch origin
git push origin "origin/main:refs/heads/$type/$n-$slug" || { echo "branch exists: another agent has #$n"; exit 1; }
gh issue edit $n --add-assignee @me --add-label state:in-progress --remove-label state:ready
```

The push of a new ref is the lock: it fails if the ref exists. Only then assign and
relabel. The implementer is born in a worktree on that branch and **never creates or
renames one**.

## Open the PR (implementer)

```bash
gh pr create --base main --head "$type/$n-$slug" --title "$type($scope): <imperative>" \
  --body-file pr.md --label state:in-review --label "type:<t>" --label "scope:<s>"
gh issue edit $n --add-label state:in-review --remove-label state:in-progress
```

`pr.md` follows `.github/pull_request_template.md`: `Closes #N` in plain text (no bold, no
link) as the first line — `Fixes #N` and `Resolves #N` (and their close/closed, fix/fixed,
resolve/resolved forms) are also accepted, and a PR may link several issues this way, in
which case `scope` checks the diff against the union of every linked issue's globs. A
keyword inside backticks or a fenced code block is ignored, so never quote one as a
formatted example. Then the test summary, the globs touched, risks. Copy the issue's
`type:` and `scope:` labels — the checks read the **PR's** labels, never the issue's.
Never `gh pr merge`.

**The implementer stops here.** It does not wait on CI and does not poll the PR; the
orchestrator launches the reviewer and watches the checks. If CI or the reviewer sends
it back, the implementer fixes in the same worktree.

## `## Files` and `authorised:` — the parser's rules

- Issue `## Files`: only **bullet lines** count. One or more globs per bullet, backticked
  (`` `src/**` ``) or bare, comma-separated. Prose on a non-bullet line is ignored; prose
  inside a bullet becomes a bogus glob and fails every real file. Put the reason on its own
  line under the bullet.
- PR `## Files`: only lines starting with `authorised:` grant anything, and **only the
  orchestrator writes them**. The glob stands alone on the line (backticked, or the first
  token); the justification goes on the next line, indented.

```
- authorised: `src/api/admin-create-user.ts`
  (orchestrator: needed for AC3; see the issue comment)
```

## Write sub-issues (planner)

```bash
n=$(gh issue create --milestone "<milestone>" \
  --label state:ready --label scope:<s> --label type:<t> \
  --title "<type>(<scope>): <goal>" --body-file issue.md | grep -oE '[0-9]+$')
id=$(gh api repos/{owner}/{repo}/issues/$n -q .id)
gh api -X POST repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id=$id
```

`issue.md` follows `.github/ISSUE_TEMPLATE/task.md`. What CI will hold the issue to:
- **Files** are globs; the `scope` check compares `git diff --name-only` against them. Two
  issues in flight cannot have intersecting globs.
- **Proof** names the test command and what it covers; the negative control is the
  `test(red):` commit.
- **Dependencies** as `Blocked by: #N`; the orchestrator does not dispatch a blocked issue.
- Fits in one PR of roughly ≤ 800 useful lines; larger, split first.
- An issue that adds an entry point to an existing table, menu or list **names that file in
  `## Files` from the start**, not only the new feature's directory — otherwise the
  orchestrator ends up granting `authorised:` after the fact.

## Labels

`state:` ready → in-progress → in-review → done; `qa-failed` goes back to the implementer;
`blocked` after two rounds, always with `human`. `review:approved` is set only by the
reviewer. `scope:` and `type:` by whoever writes the issue. A new dependency is a
`type:deps` issue for the orchestrator.
