---
name: issue-and-pr
description: The exact gh commands and the contract for issues, PRs, labels and the branch lock. Use when claiming an issue, opening a PR, or writing sub-issues as the planner.
---

# Issue and PR

Everything that goes to GitHub is in English. The full contract is in the plugin's
`docs/workflow.md`; this is the operating card.

## Claim (orchestrator only)

**The orchestrator creates the branch, not the implementer.** Run `scripts/claim.mts`,
located the way `skills/orchestrate` locates every plugin script — `CLAUDE_PLUGIN_ROOT`
with a `find ~/.claude/plugins` fallback (see that skill's step 0 for the three-line
locator) — and run from the repository root, since it reads the current working
directory's git:

```bash
node "$CLAIM" 42 --slug dashboard-kpis --type feat
```

`<type>` defaults to the title prefix (`feat(scope): …` → `feat`) when `--type` is
omitted. The push of a new ref (`origin/<default>:refs/heads/<type>/<n>-<slug>`) is the
lock — `git push --porcelain`, not a local pre-check, decides whether it held. Exit 0 →
`{ issue, branch, base }`: pushed, assigned `@me`, relabelled `state:in-progress`. Exit 2 →
`{ held }`: the branch already exists, another agent has it — skip, no retry. Exit 1 →
`{ refused }` (closed, missing `state:ready`, an open `Blocked by:` issue, or no `## Files`
bullet — nothing pushed, nothing relabelled) or `{ error }` (a `gh`/`git` failure). The
implementer is born in a worktree on that branch and **never creates or renames one**.

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

`issue.md` follows `.github/ISSUE_TEMPLATE/task.md`. An issue is not dispatchable until
`ci/issue-lint.mts <n>` reports `ok: true` (run it, or wait for the `issue-lint` workflow's
comment, before it reaches `state:ready`) — see `skills/orchestrate` step 1 for the exact
invocation and what `--strict` does. What CI, and now `issue-lint`, will hold the issue to:
- **Files** are globs; the `scope` check compares `git diff --name-only` against them. Two
  issues in flight cannot have intersecting globs — `issue-lint` fails a sub-issue over
  this itself, against every other `state:ready`/`state:in-progress`/`state:in-review`
  issue in the same milestone, unless a `Blocked by:` relation orders the two (then it is
  reported as `sequenced`, not a failure).
- **Proof** names the test command and what it covers; the negative control is the
  `test(red):` commit.
- **Dependencies** as `Blocked by: #N`; the orchestrator does not dispatch a blocked issue.
- Fits in one PR of roughly ≤ 800 useful lines; larger, split first.
- An issue that adds an entry point to an existing table, menu or list **names that file in
  `## Files` from the start**, not only the new feature's directory — otherwise the
  orchestrator ends up granting `authorised:` after the fact. `issue-lint` warns about
  exactly this gap: for every file the issue's globs cover, it `git grep`s every other
  tracked file for that path or basename and reports a hit as `{ file, referencedBy }` in
  `warnings`. This is the check #3's shape needed and didn't have: its globs covered
  `tests/**` to rename the entry point (`tests/smoke.mts` → `tests/run.mts`), while
  `.github/workflows/test.yml` referenced the old path by name from outside `## Files` —
  fixed inside the same PR under an `authorised:` grant on the workflow file, not caught by
  any check before dispatch. A warning alone does not fail the lint unless `--strict` was
  passed (the orchestrator's default for `type:feature`/`type:bug`); either way, widen
  `## Files` to cover the referencing file up front rather than needing the grant.

## Labels

`state:` ready → in-progress → in-review → done; `qa-failed` goes back to the implementer;
`blocked` after two rounds, always with `human`. `review:approved` is set only by the
reviewer. `scope:` and `type:` by whoever writes the issue. A new dependency is a
`type:deps` issue for the orchestrator.
