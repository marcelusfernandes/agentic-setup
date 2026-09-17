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
omitted, and must be one of `feat|fix|refactor|chore|docs|test|ci|deps` either way; a
title outside that set (e.g. `perf(ci): …`) has no type of its own, so pass `--type` with
a value from the set (whichever fits — `ci` for `perf(ci): …`). The push of a new ref
(`origin/<default>:refs/heads/<type>/<n>-<slug>`) is the lock — `git push --porcelain`,
not a local pre-check, decides whether it held.

Before that push, `claim.mts` runs `ci/issue-lint.mts` on the issue itself and refuses when
the result is not `ok: true` — a normal failure, or the lint's own `{ error }` when it
could not even run: `{ refused: "issue-lint failed", lint: <the lint JSON> }`, exit 1,
nothing pushed or relabelled. `issue-lint` checks the contract only — sections, globs,
`Blocked by:` numbers — and has nothing else to pass through: the entry-point-reference
warning it used to run, and its opt-in strict flag, were both removed in #62 (see "Write
sub-issues" below); `--no-lint` skips the check entirely, and the success JSON then
reports `"lint": "skipped"` instead of `"lint": { "ok": true }`.

Exit 0 → `{ issue, branch, base, lint }`: pushed, assigned `@me`, relabelled
`state:in-progress` and labelled `type:` from the branch type (`feat` → `type:feature`,
`fix` → `type:bug`; `chore`, `test` and `ci` all → `type:infra`; `refactor`, `docs` and
`deps` keep their name — the mapping is `TYPE_LABELS` in `scripts/lib/issues.mts`).
Exit 2 → `{ held }`: the branch already exists, another agent has it
— skip, no retry. Exit 1 → `{ refused }` (closed, missing `state:ready`, an open
`Blocked by:` issue, no `## Files` bullet, or a failing `issue-lint` — nothing pushed,
nothing relabelled) or `{ error }` (a usage problem — no type determinable and none given,
or an invalid `--type` — or a `gh`/`git` failure). The implementer is born in a worktree on
that branch and **never creates or renames one**.

## Open the PR (implementer)

```bash
gh pr create --base main --head "$type/$n-$slug" --title "$type($scope): <imperative>" \
  --body-file pr.md --label state:in-review
gh issue edit $n --add-label state:in-review --remove-label state:in-progress
```

`pr.md` follows `.github/pull_request_template.md`: `Closes #N` in plain text (no bold, no
link) as the first line — `Fixes #N` and `Resolves #N` (and their close/closed, fix/fixed,
resolve/resolved forms) are also accepted, and a PR may link several issues this way, in
which case `scope` checks the diff against the union of every linked issue's globs. A
keyword inside backticks or a fenced code block is ignored, so never quote one as a
formatted example. Then the test summary, the globs touched, risks. The implementer sets
`state:in-review` and nothing else: **the orchestrator** copies the issue's `type:` and
`scope:` labels onto the PR at step 4, because an agent that labels its own work could
buy its own exemptions. `negative-control` no longer reads `type:` to decide a skip — it
skips by path class — but `scope` and `land` still read the PR's labels, never the
issue's. Never `gh pr merge`.

**The implementer stops here.** It does not wait on CI and does not poll the PR; the
orchestrator launches the reviewer and watches the checks. If CI or the reviewer sends
it back, the implementer fixes in the same worktree.

## `## Files` and `authorised:` — the parser's rules

- Issue `## Files`: only **bullet lines** count. One or more globs per bullet, backticked
  (`` `src/**` ``) or bare, comma-separated. Prose on a non-bullet line is ignored; prose
  inside a bullet becomes a bogus glob and fails every real file. Put the reason on its own
  line under the bullet.
- Issue `## Files`, `authorised:` lines: a line starting `authorised:` (bullet or bare)
  grants one glob outside those bullets, and **only the orchestrator writes it**. The glob
  stands alone on the line (backticked, or the first token); the justification goes on the
  next line, indented.
- PR `## Files`: prose. It grants nothing — the implementer writes that body, so a grant
  there would be a self-grant, and since #155 `scope` reports it as ignored and fails on
  the file anyway. An implementer that needs a file outside its globs asks the
  orchestrator for a grant **on the issue** and stops.

```
- authorised: `src/api/admin-create-user.ts`
  (orchestrator: needed for AC3; see the issue comment)
```

## Write sub-issues (planner)

```bash
node scripts/create-subissue.mts <parent> \
  --title "<type>(<scope>): <goal>" --body-file issue.md \
  --label scope:<s> --label type:<t>
```

One script, not the three-line snippet that used to stand here (create, resolve the
issue **id**, POST it to the parent's `sub_issues`) — that snippet is no longer the
contract. It refuses with `{ refused, parent, missing }` and exit 1 **before creating
anything** when the parent does not exist or is closed (`parent:state`), the parent
carries no milestone (`parent:milestone`), the title is not `<type>(<scope>): <goal>`
(`title:format`), or `--body-file` is missing or unreadable (`body:missing`). On success
it prints `{ issue, parent, milestone, linked: true, lint }`: the child inherits the
parent's milestone and is linked by its id.

`issue.md` follows `.github/ISSUE_TEMPLATE/task.md`. An issue is not dispatchable until
`ci/issue-lint.mts <n>` reports `ok: true` — `create-subissue.mts` runs that lint itself
and is the only thing that applies `state:ready` (never pass `--label state:ready`; it is
dropped from the creation). A body that fails the lint leaves the issue created and
linked, without `state:ready`, and the script exits 1 with the lint result, so it never
reaches `reconcile`'s `ready` list. See `skills/orchestrate` step 1 for the standalone
lint invocation. What CI, and `issue-lint`, will hold the issue to:
- **Files** are globs; the `scope` check compares `git diff --name-only` against them. Two
  issues in flight cannot have intersecting globs — `issue-lint` fails a sub-issue over
  this itself, against every other `state:ready`/`state:in-progress`/`state:in-review`
  issue in the same milestone, unless a `Blocked by:` relation orders the two (then it is
  reported as `sequenced`, not a failure).
- **Proof** names the test command and what it covers; `negative-control` reads the PR's
  diff, not the `test(red):` commit, to decide the red — the changed test files are copied
  onto the base and the suite must fail there. The commit subject matters in one case: a
  red that is *structural* on the base (a missing module or export, a syntax error) is
  accepted only when a commit in `base..head` starting `test(red):` touches one of those
  test files; otherwise the check fails as `structural`. `issue-lint` accepts `## Validation` (the Codex route's
  name for the same section) in place of `## Proof`; one non-empty heading is enough.
- **Dependencies** as `Blocked by: #N`; the orchestrator does not dispatch a blocked issue.
- Fits in one PR of roughly ≤ 800 useful lines; larger, split first.
- An issue that adds an entry point to an existing table, menu or list **names that file in
  `## Files` from the start**, not only the new feature's directory — otherwise the
  orchestrator ends up granting `authorised:` after the fact. `issue-lint` cannot catch a
  missing one itself any more: it used to `git grep` every covered path/basename against
  the rest of the tree and warn on a hit, but that fired on any ordinary import, doc or
  workflow mention of a covered path (not only a rename or removal), so it was removed in
  #62 along with its opt-in strict flag — `issue-lint` checks the contract only now
  (sections, globs, `Blocked by:` numbers). The mechanical form of this gap — a path a PR
  removes or
  renames while another tracked file outside the diff still names it, the shape #3 needed
  — moved to PR time instead, where a diff exists to tell a rename from an in-place edit:
  the `scope` job fails on it unless the referencing file sits inside the linked issue's
  globs or is granted with `authorised:` (#51). Widen `## Files` to cover the referencing
  file up front rather than relying on that check or the grant.

## Labels

`state:` ready → in-progress → in-review; `qa-failed` goes back to the implementer;
`blocked` after two rounds, always with `human:pending`; a person flips that to
`human:decided` when the decision is recorded, and the decided label stays as the audit
trail (bare `human` from before the split reads as pending). There is no `done` value: `Closes #N`
closes the issue when its PR merges, and a closed issue is a done issue — nothing to
relabel. `review:approved` is applied by the orchestrator after the reviewer returns
`approved` (the reviewer itself only returns the verdict — see `skills/orchestrate`
step 5); when `AGENTIC_REVIEWER_TOKEN` is
configured for the reviewer's own environment, it also casts a real GitHub review as that
separate identity, and `scripts/land.mts` then requires that review, not the label
(`docs/decisions.md` item 13). `scope:` and `type:` by whoever writes the issue. A new
dependency is a `type:deps` issue for the orchestrator.
