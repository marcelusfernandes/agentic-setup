# Git, issues and PRs

The contract every agent follows. Code, commits, branches, labels, issues and PRs are
written in English; the language you talk to the agents in is your business.

## Branches

- `main` is the only trunk. Squash merge only.
- Work branch: `<type>/<number>-<slug>` (`feat/42-dashboard-kpis`). **Creating the
  remote branch is the lock on the issue** — `git push origin origin/main:refs/heads/<branch>`
  fails if the ref exists, so two orchestrators cannot claim the same issue.
  Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, `deps`.
- The orchestrator creates the branch; the implementer never creates or renames one.
- Commits: `<type>(<scope>): <imperative description>`. A test that is red on purpose is
  committed as `test(red): …`. `negative-control` reads the PR's diff, not any commit, to
  decide the red: it copies the changed test files onto a checkout of the base and requires
  the suite to fail there. It reads the commits for one thing only — when that red is
  *structural* (a missing module or export, a syntax error), a `test(red):` commit in
  `base..head` touching one of those test files is what makes it acceptable (#135).

## Milestones

One GitHub milestone per phase, each with a **parent issue** that lists the sub-issues.
A milestone does not close while it has an open issue. Opening the next milestone's
parent issue is the orchestrator's job when the current one has nothing left.

Every milestone **description** follows one format — `.github/MILESTONE_TEMPLATE.md`
(shipped to adopting repositories as `templates/.github/MILESTONE_TEMPLATE.md`, beside
`ISSUE_TEMPLATE/` so GitHub never offers it as an issue template):

```text
<objective, one to three sentences>

Out of this phase:
- <what this phase deliberately does not do>

Exit criteria:
- [ ] <a criterion someone else can check>

Depends on: <milestone or issue, or "none">
```

The exit criteria are the point: without them, "the phase is done" is decided by the last
issue closing rather than by a criterion. `reconcile.mts` reads the reconciled milestone's
description and reports `milestoneLint: { ok, missing }`, where `missing` names the absent
parts — `objective`, `out-of-phase`, `exit-criteria` (the label and at least one `- [ ]`
item under it), `depends-on`. It reports and never refuses: a milestone whose description
has not been migrated yet still reconciles, still dispatches, and the orchestrator migrates the
description as part of the phase.

## Labels

| group | values | who changes it |
|---|---|---|
| `state:` | `ready`, `in-progress`, `in-review`, `qa-failed`, `blocked` | agents |
| `scope:` | project-defined (`web`, `api`, `db`, `ops`, `docs`, …) | whoever writes the issue |
| `type:` | `feature`, `bug`, `refactor`, `infra`, `spec`, `docs`, `deps` | seeded by whoever writes the issue; re-derived from the branch type (`TYPE_LABELS`) and written by `scripts/claim.mts` at claim time |
| `review:approved` | the reviewer returned approved | orchestrator |
| `human:pending` | a person must decide; not dispatched until they do | orchestrator (and `guard-main`) |
| `human:decided` | the decision is recorded; kept as the audit trail, never blocks (named `decided`, not `reviewed`, so it is never mistaken for `review:approved`) | a person |

The two human states are exclusive and matched by exact name. `reconcile.mts` lists
`human:pending` issues under `humanPending` and keeps them out of `ready`; `claim.mts`
refuses them. Agents never add, remove or replace `human:decided`. A bare `human` label
from a repository initialized before the split is read exactly like `human:pending`.

`/agentic-setup:init` seeds `state:`, `type:`, `review:approved`, `human:pending` and
`human:decided`; you add the
`scope:` values that match your repository. The `state:` set above has no `done` value:
`Closes #N` closes the linked issue when its PR merges, and a closed issue is a done
issue — nothing left to relabel.

## Issue (one template)

```
## Context
Why it exists. Links to the spec, the report, or the code it changes (file:line).

## Goal
One verifiable sentence.

## Acceptance criteria
- [ ] AC1 … (with the test that proves it)

## Proof
The test command and what it covers.
Negative control: which assertions must fail before the change (CI verifies this).
(`## Validation`, the Codex route's name for this section, is accepted instead.)

## Files
Globs this issue may touch (the `scope` check enforces them):
- `src/dashboard/**`
- `src/lib/coverage.ts`

## Dependencies
Blocked by: #N (or "none")
```

**`## Files` accepts only plain globs on bullet lines, one or more per bullet,
comma-separated, backticked or not.** The parser reads bullets and ignores every other
line in the section as prose. Prose inside a bullet (a parenthetical, an em-dash aside)
gets comma-split too and becomes a bogus glob that matches nothing — the `scope` job
then reports a false violation on every real file. Put the reason on its own
non-bullet line under the glob.

A sub-issue fits in one PR of roughly ≤ 800 lines of useful diff. If it does not, split
it before dispatching. That figure is a per-PR recommendation for whoever plans the
work — nothing enforces it mechanically. Separately, `scope` enforces a per-file rule in
CI: a PR fails if it adds a file over 800 lines or grows an existing one past 800 lines,
counted against the base; a file already over 800 that shrinks or holds steady is not a
violation, and a file whose first line reads `@generated` is exempt.

Sub-issues are linked to the parent through GitHub's sub-issue API, which wants the
issue **id**, not the number:

```bash
n=$(gh issue create --milestone "<milestone>" --label state:ready --label scope:<x> \
  --label type:<y> --title "..." --body-file issue.md | grep -oE '[0-9]+$')
id=$(gh api repos/{owner}/{repo}/issues/$n -q .id)
gh api -X POST repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id=$id
```

## PR (one template)

```
Closes #N

## What changed

## Proof
Test output summary (command, counts, duration).

## Files
Globs touched (must match the issue).

## Risks
```

`Closes #N` in plain text — no bold, no link — because the `scope` job reads it to find
the issue whose globs apply. `Fixes #N` and `Resolves #N` are also accepted (and their
close/closed, fix/fixed, resolve/resolved forms, an optional colon before the `#N`), and
a PR may link several issues this way — `scope` checks the diff against the union of
every linked issue's globs.

**`authorised:` is written only by the orchestrator, and the glob stands alone on the
line.** It grants a file outside the issue's globs. The parser splits everything after
`authorised:` on commas; any prose on the same line becomes a second, invalid glob and
the `scope` job fails even though the grant was legitimate. The justification goes on
the next line, indented, which the parser skips:

```
- authorised: `src/api/admin-create-user.ts`
  (orchestrator: needed for AC3, see the issue comment)
```

The **orchestrator** copies the issue's `type:` and `scope:` labels onto the PR, at step 4
of `skills/orchestrate` — the implementer opens the PR with `state:in-review` alone. An
agent that labels its own work could buy its own exemptions, so `type:` is written by the
orchestrator at claim time (`scripts/claim.mts`, mapped from the branch type through
`TYPE_LABELS` in `scripts/lib/issues.mts`: `feat` → `type:feature`, `fix` → `type:bug`,
`chore`/`test`/`ci` → `type:infra`) and copied across from there. `scope` and `land` still
read the PR's labels and body, never the issue's.

## Required checks

| check | what it does |
|---|---|
| `test` | the project's check + test commands, as detected or configured |
| `scope` | `git diff --name-only base...head` ⊆ union of the globs of every issue linked by `Closes`/`Fixes`/`Resolves #N`, plus whatever an `authorised:` line grants. Also: a path the diff deletes or renames-from must not still be named, outside the diff, by another tracked file — the #3 shape (a rename that drops a path a workflow or doc still names by string), decidable here because the diff is known, unlike at issue-lint time (#51). A hit is a failure unless the referencing file is itself inside the linked issue's globs (the reviewer sees it in the diff) or is granted with `authorised:`; lockfiles, `docs/research/**`, and a basename under 4 characters are excluded as noise. Also: a file new at head over 800 lines, or grown past 800 against the base, fails; one already over 800 that shrinks or holds steady does not; `@generated` on the first line exempts (#134) |
| `negative-control` | checkout of the PR base, first run **unchanged** (the baseline), then with **only the test files from the diff** overlaid on top, the test command run again — which **must fail**. Outcomes: baseline fails = fail (`inconclusive` — the base does not pass its own tests, so the check cannot discriminate); baseline passes and the overlaid run fails = pass; baseline passes and the overlaid run also passes = fail (vacuous tests); no test files in the diff = fail (`no-tests`); the test command could not be found or executed = fail (`cannot-run`); the overlaid run failed only structurally and no `test(red):` commit vouches for it = fail (`structural`, see below). Skipped (`skipped`) when **every** file the diff changes sits in a skipped path class: `docs/**`, `.github/**`, `templates/**`, `*.md` (root-level Markdown — `*` never crosses a `/`), plus whatever the `AGENTIC_SKIP_GLOBS` repository variable adds (comma-separated globs, env only, no config file) |

The exemption is by **path class**, not by the PR's own labels (#135): the implementer
applies its own PR's labels, so a `type:` label could buy its own exemption. A diff that
touches any file outside those classes runs the check, whatever it is labelled — a
refactor that changes behaviour is a `bug` or a `feature` and owes a failing test either
way. For one release `type:docs`, `type:deps`, `type:infra`, `type:refactor` and
`type:spec` are still read, only to print a `note:` line saying they no longer skip on
their own and to name the label in a skip the path class already decided.

A `pass` whose overlaid run fails with a structural signature (a missing module, a missing
export, a syntax error) says the test file could not run on the base at all, not that an
assertion caught the change — and an opaque test command cannot tell one crashing file
apart from several real failures. It is accepted only when the PR shows the red was
written first, on purpose: a commit in `base..head` whose subject starts `test(red):` and
which touches at least one of the overlaid test files. Then the outcome stays `pass` and
the job summary and stdout carry a `warning:` line asking for a throwing stub instead, so
the red is a runtime red. Without such a commit the outcome is `structural` and the check
fails.

## Merge

Once checks are green and the PR carries an approved review (or the `type:docs` label,
which skips the reviewer), `scripts/land.mts` queues `gh pr merge --squash --auto` — it
is the only way the orchestrator merges a PR, never `gh pr merge` by hand. The server
merges the instant its own rules are satisfied: a base-branch ruleset with a
`required_status_checks` rule when one exists, else whatever `gh pr checks --required`
reports at the moment of the call. **The branch is not required to be up to date** — CI
runs again on `main` after the merge; a conflict goes back to the implementer, who runs
`git merge origin/main` on the published branch (rebase only before the first push;
force-push is denied on every branch).

"Never `gh pr merge` by hand" is enforced, not asked for. `protect-main.mts` denies **any**
command segment starting with `gh pr merge` — with or without `--admin`, with any merge
flag — and refuses with a message naming `node scripts/land.mts <pr>` as the way to merge;
the permission deny list in `.claude/settings.json` (and its copy
`templates/claude-settings.json`, which `init` merges into an adopting repository) says the
same declaratively as `Bash(gh pr merge *)`. `node scripts/land.mts <pr>` in the same
session is untouched: `land.mts` spawns `gh` from inside Node, while the hook and the deny
list only ever see the session's Bash command string, which reads `node scripts/land.mts
<pr>`.

**No environment variable lifts that rule.** `AGENTIC_ALLOW_PUSH_MAIN=1` covers pushing to
`main` for bootstrap only — never deleting `main`/`master`, and never a merge. An operator
who genuinely has to merge a pull request by hand does it outside the agent session: their
own terminal, or the GitHub UI. The layer that must not be bypassed is still the ruleset;
this one is a round-trip saver.

Apart from the merge rule, `protect-main.mts` is a fallback for a machine with no
server-side ruleset yet: it denies a force-push and a push or delete of `main`/`master`. It
never gates a merge on green checks by itself — the ruleset, or `land.mts`'s own gate, already
covers that.
