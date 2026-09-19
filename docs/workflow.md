# Git, issues and PRs

The contract every agent follows. Code, commits, branches, labels, issues and PRs are
written in English; the language you talk to the agents in is your business.

## Branches

- `main` is the only trunk. Squash merge only.
- Work branch: `<type>/<number>-<slug>` (`feat/42-dashboard-kpis`). **Creating the
  remote branch is the lock on the issue** — `git push origin origin/main:refs/heads/<branch>`
  fails if the ref exists, so two orchestrators cannot claim the same issue.
  Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, `deps`.
- Two branch shapes lock an issue, one per route: `<type>/<number>-<slug>` here, and
  `codex/task-<number>` on the Codex route (`.agents/skills/autonomous-loop/references/contract.md`,
  "the canonical remote branch"). Neither namespace collides
  with the other, so each reads the other's shape instead: both are listed in
  `scripts/lib/issues.mts`, `scripts/reconcile.mts` reports an issue whose only remote
  branch is `codex/task-<n>` under that branch (and its PR) rather than as free, and
  `scripts/claim.mts` reads the remote's heads before it pushes — an issue already locked
  by either route, under any slug, is `{ held: "<the branch found>" }`, exit 2, with
  nothing pushed and no label touched. That read fails closed: a `git ls-remote` that
  cannot answer exits 1 with `{ error }` naming it rather than assuming the issue is
  free. It is an early refusal, not the lock; two agents of *this* route racing for the
  same issue are still decided by the create-only push.
- An issue locked by the other route is reported, never taken. `reconcile.mts` marks it
  `foreignLock: true` under `inProgress` and keeps it out of `resumable` even when it has
  no pull request yet (the Codex loop's state between its claim push and its PR):
  `resumable` is dispatched as round N+1 *without* a claim
  (`skills/orchestrate/SKILL.md`), so a foreign lock left in that list would reach an
  implementer with `claim.mts`'s refusal never consulted. `inReview` carries the same flag
  for the same reason — the Codex loop labels its own tasks `state:in-review`, so such an
  entry now names that route's pull request, which this route reports but never reviews
  and never lands. Nobody on this route claims, resumes, reviews, lands or pushes to a
  `codex/task-<n>` branch.
- The orchestrator creates the branch; the implementer never creates or renames one.
- Commits: `<type>(<scope>): <imperative description>`. A test that is red on purpose is
  committed as `test(red): …`. `negative-control` reads the PR's diff, not any commit, to
  decide the red: it copies the changed test files onto a checkout of the base and requires
  the suite to fail there (unless the branch declares its own list in `proof/<slug>.json`,
  read from the head commit — see "The proof a branch declares" below). It reads the
  commit *log* for one thing only — when that red is
  *structural* (a missing module or export, a syntax error), a `test(red):` commit in
  `base..head` touching one of those test files is what makes it acceptable (#135).
  That outcome is the convention's mechanical consumer at PR time, and it is why the
  reviewer's check 3 (`agents/reviewer.md`) still asks for the commit: the card and this
  document name one mechanism — without the commit a structurally red overlay fails as
  `structural`, so the commit is what buys it its `pass`.
  The convention has a second mechanical consumer before the PR exists: the `SubagentStop`
  gate (`hooks/stop-gate.mts`) runs the detected check and test commands when an
  implementer tries to stop and blocks the stop while either is red, and a **last** commit
  whose subject starts with `test(red):` is exempt — that red is what the commit is for.
  The gate caps at three consecutive blocks per branch and never runs on `main`/`master`;
  `docs/orchestration.md` has the row, and item 13 of `docs/decisions.md` the 2026-09-17
  note on why it is the one client-side check that earns an exception (#137).

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

**An issue may carry no milestone**, and that is allowed: a small fix does not always belong
to a phase, and nothing refuses one. `scripts/claim.mts` reads the issue's own state, labels
and `## Files` — never its phase — and `scripts/land.mts` gates on the pull request's checks,
so a milestone-less issue is **claimed and landed with the scripts** exactly like any other,
**by hand**: the orchestrator passes the issue number to `claim.mts` itself instead of taking
it from a list. `ci/issue-lint.mts`, the gate `claim.mts` runs before the push, tolerates the
absent milestone — it reads the issue's own sections as usual and compares its globs against
an empty set of issues in flight, since the set it would compare against is a milestone's. What it loses is visibility. `scripts/reconcile.mts` reconciles one milestone
— it picks the lowest-numbered open one or takes `--milestone <title>`, and lists that
milestone's issues (`gh issue list --milestone <title>`) — so `reconcile` does not see it, it
never appears in `ready`, and step 0 of the loop never offers it. Four issues of this shape
were claimed and landed by hand in one pass for exactly this reason
(`docs/dogfood/2026-09-10.md`, finding L9). #259 is the issue that adds the milestone-less
view to `reconcile`; until it lands, a milestone-less issue is tracked by whoever opened it.

## Labels

| group | values | who changes it |
|---|---|---|
| `state:` | `ready`, `in-progress`, `in-review`, `qa-failed`, `blocked` | agents |
| `state:done` | `done` — Codex route only; read here, never written | the Codex route's state synchronisation |
| `scope:` | project-defined (`web`, `api`, `db`, `ops`, `docs`, …) | whoever writes the issue |
| `type:` | `feature`, `bug`, `refactor`, `infra`, `spec`, `docs`, `deps` | seeded by whoever writes the issue; re-derived from the branch type (`TYPE_LABELS`) and written by `scripts/claim.mts` at claim time |
| `review:approved` | the reviewer returned approved | orchestrator |
| `human:pending` | a person must decide; not dispatched until they do | orchestrator (and `guard-main`) |
| `human:decided` | the decision is recorded; kept as the audit trail, never blocks (named `decided`, not `reviewed`, so it is never mistaken for `review:approved`) | a person |

The two human states are exclusive and matched by exact name. `reconcile.mts` lists
`human:pending` issues under `humanPending` and keeps them out of `ready`; `claim.mts`
refuses them. Agents never add, remove or replace `human:decided`. A bare `human` label
from a repository initialized before the split is read exactly like `human:pending`.

[`labels.json`](../labels.json) at the plugin root is the one dictionary both routes
read: one entry per label, each carrying its colour, its description and the `routes`
that seed it. `/agentic-setup:init` seeds exactly the `claude`-routed entries of that
file — `state:` (without `done`), `type:`, `review:approved`, `human:pending` and
`human:decided` — and refuses the whole run, naming the reason, when the dictionary does
not validate; you add the `scope:` values that match your repository. Editing the label
set means editing that file, not a list inside a script.

`state:done` is in the dictionary marked `["codex"]`, and `human` is marked legacy:
both are read here, neither is seeded or written by anything on the Claude route.
`state:done` is written by the Codex route's state synchronisation
(`.agents/skills/autonomous-loop/scripts/github.mts`), which derives every task's state
from verified GitHub state and labels a finished one `state:done`. On this route the
`state:` set has no `done` value and needs none: `Closes #N` closes the linked issue when
its PR merges, and a closed issue is a done issue — nothing left to relabel. Whether
`state:done` is retired on both routes is an open owner question, recorded as item 16 of
[`decisions.md`](decisions.md).

## Issue (one template)

```
## Context
Why it exists. Links to the spec, the report, or the code it changes (file:line).
Optional, a line "Origin: <where this came from>" — see "Findings become issues" below.

## Goal
One verifiable sentence.

## Acceptance criteria
- [ ] AC1 … (with the test that proves it)

## Proof
The test command and what it covers.
Negative control: which assertions must fail before the change (CI verifies this).
Optional, a line "Declaration: proof/<slug>.json" — see "The proof a branch declares" below.
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
non-bullet line under the glob. The one bullet that is *not* a glob is a bullet whose
content starts `authorised:`: that is a grant, read once by the grant parser below and
never as an ordinary glob of the issue (#231).

**`authorised:` is written only by the orchestrator, in the issue's `## Files`, and the
glob stands alone on the line.** It grants a file outside the issue's globs, and `scope`
reads it from the body of an issue the PR closes — never from the pull request, because
the implementer writes that body and would be granting itself (#155). An implementer that
needs a file outside its globs asks the orchestrator and stops. **That is enforced, not
asked for:** `hooks/protect-main.mts` denies `gh issue edit` outright when the session
typing it carries an `agent_id` and stands in a linked worktree — an agent is born in one
and never leaves it, the orchestrator runs in the main checkout, so the hook can tell the
session a grant would exempt from the session allowed to write one (#237,
`docs/decisions/0024-a-grant-is-never-written-from-a-worktree.md`). The whole subcommand
is denied, not the body-writing flags, so moving the issue to `state:in-review` is the
orchestrator's step 4 as well; `gh issue view`, `gh issue comment` and `gh issue list` are
untouched, and so is the orchestrator's own edit. Like every rule in that hook this is
layer three and an indirect form walks past it — `gh api -X PATCH` on the issue does not
contain the words `issue edit` — so it saves a round trip and does not replace the reading
of the diff. The line may be a bullet
or bare, and the word is matched in any case. What follows it is read once, like this:
**exactly one backticked span on the line is the granted glob**; **more than one grants
nothing at all**, and `issue-lint` fails the issue over it, naming the line and every
span on it (#316). Where there is no backticked span, **the first whitespace-delimited
token** is the glob, with a trailing `,` or `;` stripped and the rest of the line
ignored. There is no comma split: `authorised: a.ts, b.ts` grants `a.ts` alone — an
under-grant a person reads, which is why that shape is left as it is. One glob per line;
a second grant gets a second line.

A line with two spans is **refused, not narrowed to the first one.** Every span used to
be granted, so a justification that quoted a path on the same line granted that path too
— and an over-grant fails *open*: the path enters the audited scope in silence and
`scope` passes on a file nobody meant to grant. Taking only the first span would trade
that for a silent under-grant, discarding what the writer wrote without saying so; a line
carrying two spans is a line whose author meant something this format cannot express, so
the check says which line and leaves the rewriting to a person. Fixing one means writing
the grant again, not deleting a backtick until the check goes quiet.

The refusal lands at dispatch, where the line is written: `claim.mts` runs the lint before
it pushes the lock branch, and the `issue-lint` workflow runs it again on every edit of
the issue, so a grant added after dispatch is refused too.

The justification goes on the next line, indented and **not** a bullet, which the parser
skips. Give it no backticks of its own. On the line itself that is the rule — a same-line
justification is allowed only unbackticked, since it must add no span. On the
continuation line it is a habit rather than a rule: an indented non-bullet line is read
by no parser, so backticks there grant nothing, but the habit is what keeps them off the
grant line. A *bulleted* continuation line is a different hazard — bullets are globs, so
its backticks become declared scope rather than prose.

```
- authorised: `src/api/admin-create-user.ts`
  (orchestrator: needed for AC3, see the issue comment)
```

A grant left in a pull-request body counts for nothing; `scope` prints it under
"An authorised: line in the pull-request body grants nothing" and fails on the file
anyway.

### Findings become issues

A finding from a dogfood report — `docs/dogfood/<date>.md`, format and rules in
[`docs/dogfood/README.md`](dogfood/README.md) — is opened **directly as its own
`state:ready` issue**, carrying an `Origin:` line in `## Context` copied verbatim from
the finding's `origin` cell:

```
## Context
Origin: docs/dogfood/2026-01-31.md, "the wait loop spins on a conflicting PR"
`scripts/land.mts` cannot tell a conflicting pull request from one whose checks are
still queued, so the orchestrator waits out the timeout instead of reporting the
conflict.
```

It is never parked as a bullet in a mother issue: a finding that is only a bullet is a
candidate, and a candidate comes back — F12 of #96 returned as L21 of #129 because the
first time it was never scheduled. The report is the other half of that rule: its
`outcome` cell must name the `#N` the finding became, the merged PR or closed issue that
already covered it, or a one-line reason it is not work, and
[`tests/dogfood-report.test.mts`](../tests/dogfood-report.test.mts) fails a report that
names none of the three.

The `Origin:` line adds no rule to `issue-lint`: `## Context` is already required and
non-empty (`ci/issue-lint.mts:163-171`), and the line is prose inside it. It is there for
whoever reads the issue a month later, and for the reviewer who wants to see the pass it
came out of.

A sub-issue fits in one PR of roughly ≤ 800 lines of useful diff. If it does not, split
it before dispatching. That figure is a per-PR recommendation for whoever plans the
work — nothing enforces it mechanically. Separately, `scope` enforces a per-file rule in
CI: a PR fails if it adds a file over 800 lines or grows an existing one past 800 lines,
counted against the base; a file already over 800 that shrinks or holds steady is not a
violation, and a file whose first line reads `@generated` is exempt.

Sub-issues are created and linked by one script — the three-line snippet that used to
stand here (create, resolve the issue **id**, POST it to the parent) is no longer the
contract:

```bash
node scripts/create-subissue.mts <parent> --title "<type>(<scope>): <goal>" \
  --body-file issue.md --label scope:<x> --label type:<y>
```

It refuses with `{ refused, parent, missing }` and exit 1 **before creating anything**
when the parent does not exist or is closed (`parent:state`), the parent carries no
milestone (`parent:milestone`), the title is not `<type>(<scope>): <goal>`
(`title:format`), or `--body-file` is missing or unreadable (`body:missing`). On success
it inherits the parent's milestone, links the child by its id, and applies `state:ready`
only after `ci/issue-lint.mts` reports `ok: true` for the new issue — a body that fails
the contract stays created and linked, without `state:ready`, and the script exits 1. Do
not pass `--label state:ready`: the lint is what applies it, and the script drops it from
the creation either way.

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

An `authorised:` line in **this** body grants nothing: the grant belongs in the issue
(see "Issue" above). The implementer asks the orchestrator for one instead of writing it.

The **orchestrator** copies the issue's `type:` and `scope:` labels onto the PR, at step 4
of `skills/orchestrate`, **and moves the issue itself to `state:in-review` at the same
step** — the implementer opens the PR with `state:in-review` alone and touches the issue
not at all (#237: `gh issue edit` is denied from inside its worktree, because the issue
body is where a grant would be written). An agent that labels its own work could buy its
own exemptions, so `type:` is written by the
orchestrator at claim time (`scripts/claim.mts`, mapped from the branch type through
`TYPE_LABELS` in `scripts/lib/issues.mts`: `feat` → `type:feature`, `fix` → `type:bug`,
`chore`/`test`/`ci` → `type:infra`) and copied across from there.

**Which check reads a label, and which reads only the body.** `scope` reads no label at
all: it takes the globs and the `authorised:` grants from the **issues** the PR links
(`ci/lib/scope.mts`, `ci/scope-check.mts`). It reads the PR's **body** for two things,
and grants nothing from either: the closing keywords that name those issues, and
`authorised:` lines, which it reports as ignored when they sit in the PR's `## Files`
(`parseAuthorisedGlobs`) and as misplaced when they sit anywhere else in that body
(`findMisplacedAuthorisedLines`, #83). Two things do read labels, and both read the
**PR's**, never the issue's: `negative-control` reads the `type:` labels — only to print a `note:` line, since
#135, because the skip is by path class (below) — and `land.mts` reads two, `type:docs`
(the exemption from the *review*, never from the checks, and **never on its own**: see
below) and `review:approved` (the marker label an agent review leaves behind in both
modes; mode `approved` requires the server's own `APPROVED` on top of it, cast against
this very head, and never falls back to the label alone).

**`type:docs` no longer decides the review exemption. The changed paths do** (#308, item
26). `land.mts` reads the pull request's diff — `gh api repos/{owner}/{repo}/pulls/<pr>/files
--paginate` — and enters mode `docs` only when every changed path sits in a documentation
path class and none sits in the carve-out. The classes are the ones the negative control
skips by (`SKIP_PATH_GLOBS`), mirrored in `land.mts` as `DOCS_PATH_GLOBS`. The carve-out,
`NEVER_DOCS_GLOBS`, is the negative control's `NEVER_SKIP_GLOBS` — `.github/scripts/agentic/**`,
the gate's own installed code — **narrowed** by `.github/workflows/**` and
`templates/.github/workflows/**`, because those declare the required checks `land.mts`
itself gates on and `.github/**` would otherwise exempt a change to them from the review
(#308, item 26). The two lists answer different questions, so one is narrower; both are
pinned against each other by `tests/land.test.mts`, so the divergence cannot read as drift;
`AGENTIC_SKIP_GLOBS` extends the negative control's list and is deliberately **not** read
by `land.mts`, because an environment variable that widened a *review* exemption would be a
hole openable from outside the repository. The label stays necessary as well: a docs-only
diff carrying no `type:docs` is mode `agent` and still owes its marker, so #308 took an
override away without handing a new exemption to anyone. A file list that cannot be read is
not a docs-only diff — it refuses `gh-pr-files` — and neither is an empty one.

One flow has no `claim.mts` to write those labels: the **docs-writer** is launched
directly after a merge, not dispatched from `state:ready`, so the orchestrator applies
`type:docs`/`scope:docs` to its issue when it opens it and copies both onto its PR itself
(`agents/docs-writer.md` step 4). Without them `land.mts` is in mode `agent` and demands
the review this flow exists to skip — and with them its diff must still be docs-only.

The two readings now ask the same question of the same paths, and the label is what is
checked against them: `type:docs` on a PR whose diff reaches outside those classes — one
`tests/**` file added under an `authorised:` grant is enough — refuses with
`missing: ['docs:label-mismatch']`, naming the paths that put it outside. It owes a failing
test as it always did, and it is no longer docs-only in the sense the label claims. Relabel
it to what the diff is; the refusal is named rather than silent because a label that had
quietly become inert would hide that disagreement exactly as the old override did.

## Required checks

| check | what it does |
|---|---|
| `test` | the project's check + test commands, as detected or configured |
| `scope` | `git diff --name-only base...head` ⊆ union of the globs of every issue linked by `Closes`/`Fixes`/`Resolves #N`, plus whatever an `authorised:` line in one of those **issue** bodies grants — a grant in the pull-request body is ignored and reported as such (#155). Also: a path the diff deletes or renames-from must not still be named, outside the diff, by another tracked file — the #3 shape (a rename that drops a path a workflow or doc still names by string), decidable here because the diff is known, unlike at issue-lint time (#51). A hit is a failure unless the referencing file is itself inside the linked issue's globs (the reviewer sees it in the diff) or is granted with `authorised:`; lockfiles, `docs/research/**`, and a basename under 4 characters are excluded as noise. Also: a file new at head over 800 lines, or grown past 800 against the base, fails; one already over 800 that shrinks or holds steady does not; `@generated` on the first line exempts (#134). Finally, a **warning that never fails the check**: when the diff changes a mechanism file — anything under `hooks/`, `ci/`, `scripts/` or `.github/workflows/`, or a `skills/**/SKILL.md` — and records no decision (`docs/decisions.md` or a file under `docs/decisions/`), the JSON and the job summary carry a `warning:` line naming each of those paths, and the check still exits 0. It is asking for an entry under `docs/decisions/`; `docs/decisions/README.md` says what earns a number and what stays a note. It stays a warning because a required check cannot judge from a file name whether a change binds the next agent — the reviewer's checklist and the milestone closeout hold the binding half (#177, decided on #180). `tests/**` and `templates/**` are not mechanism files. And a **second warning of the same shape, which also never fails the check**: when the diff changes the mechanism the dogfood loop runs on — anything under `hooks/`, `ci/` or `scripts/`, or a `skills/**/SKILL.md`, deliberately *without* `.github/workflows/**` — and neither the pull-request body nor the diff names a `docs/dogfood/<date>.md` report, the JSON carries `dogfoodTrigger` and `dogfoodWarning` and the job summary a second `> warning:` line, and the check still exits 0. It stays a warning for the same reason: whether a dogfood run was owed is a judgement no file name settles. **The binding half of this one is not the check but the close of the phase**: `scripts/close-milestone.mts` refuses with `missing: ['dogfood']` when a pull request merged into the milestone touched one of those paths and the closeout's `## Dogfood` section names no dated report, so a phase that skipped a run does not close (#182). A phase whose merged pull requests touched nothing sensitive closes with no report |
| `negative-control` | checkout of the PR base, first run **unchanged** (the baseline), then with **only the test files from the diff** overlaid on top, the test command run again — which **must fail**. Outcomes: baseline fails = fail (`inconclusive` — the base does not pass its own tests, so the check cannot discriminate); baseline passes and the overlaid run fails = pass; baseline passes and the overlaid run also passes = fail (vacuous tests); no test files in the diff = fail (`no-tests`); the test command could not be found or executed = fail (`cannot-run`); the branch's `proof/<slug>.json` could not be read as written = fail (`cannot-run` too, naming the path it rejected — the declaration is unreadable at head, does not parse, is not a JSON object, has no `tests` array, has a `command` that is not a non-empty string, names a path that is absolute or escapes the repository root once normalised, or names a path the head commit does not have); the overlaid run failed only structurally and no `test(red):` commit vouches for it = fail (`structural`, see below). Skipped (`skipped`) when **every** file the diff changes sits in a skipped path class: `docs/**`, `.github/**`, `templates/**`, `.claude/**` (session configuration), and Markdown anywhere in the tree (`**/*.md` as well as the root-level `*.md`, because `*` never crosses a `/`), plus whatever the `AGENTIC_SKIP_GLOBS` repository variable adds (comma-separated globs, env only, no config file) — and minus `.github/scripts/agentic/**`, which no class covers, because that is where `scripts/init.mts` copies this repository's `ci/` in an adopting repository and a gate that exempts a change to itself is not a gate (#214). When the head branch declares its proof in `proof/<slug>.json`, that file replaces "the test files from the diff" and, if it names a `command`, the detected test command — see below |

The exemption is by **path class**, not by the PR's own labels (#135): the implementer
applies its own PR's labels, so a `type:` label could buy its own exemption. A diff that
touches any file outside those classes runs the check, whatever it is labelled — a
refactor that changes behaviour is a `bug` or a `feature` and owes a failing test either
way. One path is outside every class and stays there, `AGENTIC_SKIP_GLOBS` included:
`.github/scripts/agentic/**`, the copy of this repository's `ci/` that `scripts/init.mts`
writes into an adopting repository (`scripts/init.mts:332`). `.github/**` would otherwise
cover it, and a pull request rewriting the negative control would be skipped by the
negative control. For one release `type:docs`, `type:deps`, `type:infra`, `type:refactor` and
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

The signature is read per **diagnostic block** — a maximal run of consecutive non-blank
lines, which is how a runtime prints one diagnostic: the header, the offending source
line, then its frames. A block counts only when it both carries a structural signature and
names one of the overlaid test files or a file the diff touches. Matching the overlaid
run's whole output let a structural-looking line from anywhere decide the verdict: a
dependency that logs `Cannot find module` and carries on prints it in a block of its own,
and flipped an honest assertion red to `structural` (#214).

### The proof a branch declares

By default the negative control overlays whatever test files the diff happens to contain,
matched by generic globs (`**/*.test.*`, `**/tests/**`, …). A branch can say it exactly
instead. `proof/<slug>.json`, where `<slug>` is the `<slug>` of the branch
`<type>/<n>-<slug>` (the value `scripts/claim.mts` takes as `--slug`):

```json
{ "tests": ["tests/proof-declarations.test.mts"], "command": "npm test" }
```

`tests` is required and is exactly what gets overlaid on the base — the declaration file
itself is copied too, and no test glob is consulted, so a proof that lives outside the
usual test paths is overlaid all the same. `command` is optional and replaces the detected
test command for **both** runs, the baseline and the overlaid one. `describes` (one
sentence, optional) is carried for the proof runner of #164. `proof/README.md` holds the
format; `tests/proof-declarations.test.mts` validates every declaration in the repository,
so a typo fails a test instead of quietly narrowing the control.

**The whole thing is optional.** No file, no change: the globs and the detected command
apply, exactly as before. A file that is present but unusable is `cannot-run`, never a
fallback to the globs — a broken declaration must not narrow the control silently. The
full list of unusable, each naming the path it rejected: it is in the head tree and
cannot be read (a corrupt or missing object, or a `git` that will not run); it does not
parse as JSON, or is not a JSON object; it has no `tests` array of non-empty paths; its
`command` is present and is not a non-empty string; a `tests` entry is absolute or
escapes the repository root once normalised (`..`); a `tests` entry names a file the
head commit does not have — a typo, never a deletion replayed on the base. Presence is
decided from the head tree (`git ls-tree`), not from the exit status of `git show`,
which fails the same way for an absent path and for one it cannot read: only "absent
from the head commit" means "this branch declares nothing". The path-class skip above is decided *before* the declaration
is read, so a diff that owes no negative control still owes none.

The workflows pass `--branch "$GITHUB_HEAD_REF"`, and the slug comes from that branch; the
declaration is read from the head **commit**. An issue never names the file that is
executed: it may carry one `Declaration: proof/<slug>.json` line under `## Proof`, which
`issue-lint` checks against `^proof/[a-z0-9-]+\.json$` and never opens (the branch need not
exist yet). The line is optional — its absence is never a failure — but a `Declaration:`
line naming something that is not such a path fails the lint. This is invariant 9 in
practice: issue text points, it never decides what runs.

## Merge

Once checks are green and the PR carries an approved review (or is a docs-only diff
carrying the `type:docs` label, which skips the reviewer), `scripts/land.mts` queues
`gh pr merge --squash --auto
--match-head-commit <headRefOid>` — it is the only way the orchestrator merges a PR,
never `gh pr merge` by hand. The server merges the instant its own rules are satisfied: a
base-branch ruleset with a `required_status_checks` rule when one exists, else whatever
`gh pr checks --required` reports at the moment of the call. **The branch is not required
to be up to date** — CI runs again on `main` after the merge; a conflict goes back to the
implementer, who runs `git merge origin/main` on the published branch (rebase only before
the first push; force-push is denied on every branch).

**Two review modes, each complete, neither reached by falling out of the other** (#156).
`land.mts` declares the mode before it judges any condition, and merges only when every
condition of that mode is met:

- `agent`, the default and what this repository runs: the `review:approved` label, the
  `<!-- agentic-reviewed-sha: <oid> -->` marker equal to the head, and **every required
  check in bucket `pass`**.
- `approved`, opt-in: everything `agent` requires *plus* `reviewDecision === 'APPROVED'`
  from the server, **cast against the head being merged**: the newest `APPROVED` entry of
  `gh pr view <pr> --json reviews` carries the commit it was submitted on, and that commit
  must be `headRefOid` too, or the run refuses `head:changed`. GitHub dismisses a stale
  approval only where the repository raised `dismiss_stale_reviews_on_push`, so without
  that read a review of an older commit merged the head whenever some marker equal to it
  existed (item 25). `--json latestReviews` cannot answer it — gh returns
  `commit: { oid: "" }` on every entry there — so `reviews` is the field. It is selected by
  `node scripts/land.mts <pr> --require-review`, or by
  a base branch whose effective rules already carry a `pull_request` rule with
  `required_approving_review_count > 0` — **never** by whether `AGENTIC_REVIEWER_TOKEN`
  happens to be set, which selects nothing at all (it only gives the reviewer the second
  identity to cast a review with). The mode costs that second identity: a repository whose
  only login is the one running `land.mts` cannot cast the review it asks for, and freezes
  at its first merge — which is why `agent` is the default and this is opt-in
  (`docs/decisions.md` items 18 and 20).
- `docs`, the documentation exemption: no review at all, and so no marker to read. It is an
  exemption from the *review*, never from the checks. It is selected by the pull request's
  **changed paths and** the `type:docs` label, both (#308, item 26): every changed path in
  a documentation class (`DOCS_PATH_GLOBS`, mirroring the negative control's
  `SKIP_PATH_GLOBS`), none in the carve-out (`NEVER_DOCS_GLOBS`: the gate's own installed
  code, plus `.github/workflows/**` and `templates/.github/workflows/**`, which declare the
  required checks this very script gates on), and the label on the pull request. The label alone used to select it, which let it beat a
  base ruleset that *requires* a review — an override, not a relaxation. A label on a diff
  that leaves those classes refuses `docs:label-mismatch` instead; a docs-only diff without
  the label is mode `agent` and still owes its marker.

The base branch's effective rules are read first, because one selector lives in them and
because the gate does too, then the pull request's changed paths, where the other selector
lives; a rules read that cannot answer refuses with `missing: ['gh-rules']` and a files read
that cannot answer with `missing: ['gh-pr-files']`, both `mode: null`, rather than settling
for the mode left over when a read fails. A file list that cannot be read is not a
docs-only diff.

**Required checks are verified, not assumed.** In both gates `land.mts` reads `gh pr checks
<pr> --required --json name,bucket,state` and refuses unless that list, once the
cancellations a newer run of the same check superseded are dropped, is non-empty and holds
nothing but runs whose *effective* bucket is `pass` — a run whose `state` says it has not
completed is `pending` whatever it was bucketed, since `gh` derives the bucket from a
snapshot that can be older than the run. An empty list is not "nothing is red", it is
"nothing held the line"; a
`pending` or `skipping` bucket is not `pass`; and `gh` prints the JSON while exiting
non-zero, so the buckets are read from its output rather than guessed from its exit code.
`gate` names who *else* holds the line — `ruleset` when the base branch's effective rules
include `required_status_checks`, `client-checks` otherwise — never whether the buckets
were read.

**The merge is pinned to the commit the review approved.** The reviewer here is an
isolated agent that returns its verdict to the orchestrator and casts nothing on the
server, so the commit it read is recorded by the orchestrator: at the moment it applies
`review:approved` it also comments the marker `<!-- agentic-reviewed-sha: <oid> -->` with
the head it reviewed (`skills/orchestrate/SKILL.md` step 5). `land.mts` reads the newest
such marker and compares it with the `headRefOid` from its own `gh pr view` call; the same
oid goes to the server on `--match-head-commit`, so a head that moves between the read and
the call is refused there too. **A push after the review sends the pull request back
instead of merging**: the marker no longer names its head, `land.mts` refuses, and the
issue goes round again — a new review, a new marker. A `review:approved` label with no
marker at all is the same refusal, because a label records no commit and so binds nothing.
The marker is read in mode `approved` as well: that mode adds the server's review to
everything `agent` requires, it does not replace it.

`land.mts` names the review mode it applied on every output — `agent` for that
label-plus-marker path, `approved` when the server's own review is required on top of it,
`docs` for the documentation exemption, which merges with no review at all and so reads no
marker, and `null` on the refusals with no mode to name: a PR it could not read at all, a
base branch whose rules it could not read, and a diff whose file list it could not read.
The `{ error }` lines name it too — the usage
line as `mode: null`, because it is printed before a mode can be read, and the merge
failure, the clean-status retry failure and the disarm failure as
`{ error, pr, gate, mode }` — since those are exactly what an operator reads when no merge
happened. `missing` names what is wrong on a refusal:
`state=<x>` (not `OPEN`), `review:not-approved` (the label, or in mode `approved` the
server's `APPROVED` decision), `head:changed` (the head is not the reviewed commit, or no
marker records one, or in mode `approved` it is not the commit the approving review was
cast against), `gh-pr-comments` (the comments read could not answer — the script
fails closed rather than merging), `gh-pr-reviews` (mode `approved` only: the reviews read
could not answer, so the commit that review was cast against is unknown — the same failing
closed), `pr:conflict` (GitHub reports the head as `CONFLICTING` — refused before any
merge call, and named apart from the next one because it is the one state here with a
remedy: the implementer merges `origin/<base>` on the published branch, and the new head
is reviewed again and gets a fresh marker),
`merge:not-mergeable` (anything else GitHub does not report as `MERGEABLE`, `UNKNOWN`
included, which is not a mergeability this script may assume),
`checks:required` (a required check outside bucket `pass`, an empty list, or a bucket read
that could not answer), `merge:not-clean` (mode `agent` only, below), `gh-rules` (the base
branch's effective rules could not be read), `gh-pr-files` (the changed-path read could not
answer, so whether the diff stays inside the documentation classes is unknown — a file list
that cannot be read is not a docs-only diff), `docs:label-mismatch` (the PR carries
`type:docs` and its diff leaves those classes, or gh reported no changed files at all —
refused at mode selection, before any other condition, because the label has to come off
before any verdict about the PR means anything) or `gh-pr-view` (could not read the PR at
all).

**In mode `agent` nothing is left queued.** `--match-head-commit` is checked by GitHub when
auto-merge is *enabled*, not when it later fires, so a queue left armed merges whatever the
branch carries by then — which is how #191 landed a merge commit nobody reviewed, and why
#241 armed `--auto` on a pull request that could not merge at all. So `land.mts` refuses
outright when GitHub does not report the head as `MERGEABLE`, and when the post-merge state
read says the PR is still open it runs `gh pr merge <pr> --disable-auto` and refuses with
`missing: ['merge:not-clean']`: mode `agent` binds the review to one commit on the client,
so it merges *that* commit or nothing — clear what blocks it and run `land` again. Modes
`approved` and `docs` still print `{ queued }` when GitHub queues the merge: there the
server's own review requirement, or the absence of any review to outrun, is what the queue
answers to.

**Which mode prints which.** Only `approved` and `docs` can print `{ queued }`. In
`agent` — the default, and what this repository runs — a queue is disarmed and the run
refuses, so that output never appears there: `agent` prints `{ merged }` or a refusal.
Read any older description of `land.mts` as printing "`{ merged }` or `{ queued }`" with
that in mind; it stopped being true of the default mode when #156 made the merge
synchronous there.

**`--wait` bounds that queue.** `node scripts/land.mts <pr> --wait [--timeout <seconds>]`
returns only once `gh pr view <pr> --json state` reads `MERGED`, printing the same
`{ merged, gate, mode }` a merge that happened at once prints. On the bound (default 900
seconds, read every 10 seconds or every quarter of the budget, whichever is shorter) it
prints `{ queued, gate, mode, timeout }` and exits 0 — a queue that is still a queue is not
an error — and leaves the auto-merge armed for the server to fire. A pull request `CLOSED`
without merging, and a state the poll cannot read, each stop the wait with `{ error }` and
exit 1 instead of being polled to the timeout. `--timeout` without `--wait` is a usage
error. In mode `agent` there is nothing to wait for — it merges the reviewed commit at once
or disarms and refuses — so the flag is accepted there and changes nothing: it is about
`approved` and `docs`, the two modes that print `{ queued }`. The poll reads the *outcome*
after the server already owns the merge and decides nothing itself, so it is not a
client-side read a merge can go stale behind (measured: `docs/dogfood/2026-09-10.md`, L3 —
every merge that printed `{ queued }` in that pass was finished by a person polling by
hand).

"Never `gh pr merge` by hand" is enforced, not asked for. `protect-main.mts` denies **any**
command segment that invokes `gh pr merge` — with or without `--admin`, with any merge
flag, and whether or not a global flag is typed before the subcommand
(`gh -R owner/repo pr merge`, `--repo`, `--hostname`); `--admin` only chooses the reason
text — and refuses with a message naming `node scripts/land.mts <pr>` as the way to merge;
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

Apart from the merge rule and the issue-edit rule above, `protect-main.mts` is a fallback
for a machine with no server-side ruleset yet: it denies a force-push and a push or delete
of `main`/`master`. It never gates a merge on green checks by itself — the ruleset, or
`land.mts`'s own gate, already covers that. Four denials in all, numbered in the hook's own
header: force-push, a push or delete of `main`/`master`, `gh pr merge`, and `gh issue edit`
from inside an agent's worktree. `AGENTIC_ALLOW_PUSH_MAIN=1` lifts the second one's push
form and nothing else — never the deletion, never the merge, never the issue edit.
