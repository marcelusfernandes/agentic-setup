# Milestone closeouts

One file per finished milestone, `docs/closeout/M<n>.md`, written from
[`TEMPLATE.md`](TEMPLATE.md). It is the only durable record a phase leaves:
`scripts/reconcile.mts` recomputes the loop's state on every pass and never
persists it (a deliberate choice, `docs/decisions.md` item 7), so without a
closeout "what did M7 ship" can only be answered by querying GitHub again.

A closeout is a dated snapshot, not a source of truth. It says what was true at
the SHA it names and does not replace a fresh `gh issue list --milestone` when
you need today's state.

## Who writes one, and when

1. The milestone's last open issue merges.
2. The orchestrator opens a `docs: closeout M<n>` issue from `TEMPLATE.md`,
   in that milestone, labelled `type:docs` / `scope:docs`, carrying the phase's
   decision-log lines verbatim in its body (see the next section).
3. The docs-writer fills it in a `type:docs` PR — one row per issue, read from
   `gh issue list --milestone "<milestone>" --state all` and
   `gh pr list --state merged`, with the squash commit of each PR as the merge
   commit (`gh pr view <n> --json mergeCommit`).
4. Only once that PR has merged is the milestone empty enough to close. The
   milestone does not close because its issues closed; it closes against the
   evidence file.

The closeout is the evidence a milestone close is checked against, so it lands
before the close, never after it.

## The phase's decision log lives in the closeout issue, not in this file

Three of the orchestrator's decisions change no file — granting an
`authorised:` glob, giving a mechanical rejection the one extra round it earns,
and applying `human:pending` — and `scripts/log-decision.mts` appends one dated
line each to a single marked comment on the milestone's **parent** issue
(`docs/orchestration.md`, "The decision log"). At step 2 above those lines are
copied verbatim into the `docs: closeout M<n>` **issue's body**, and that is
where they stay. This file has no section for them, and the grammar below has
no fourth heading.

That is a decision, not an omission:

- A closeout records what *shipped* — the rows, what was left out, and the
  dogfood report the phase owed. Each of its sections is parsed twice, by
  `tests/provenance.test.mts` and by `scripts/close-milestone.mts`, and both
  refuse what does not fit. A section of free prose neither parser can check
  would be grammar that proves nothing.
- Adding a required heading would invalidate every `M<n>.md` already written,
  since both parsers hold a closeout to each section appearing exactly once.
- The lines are already durable where they are. The parent issue's comment is
  the log; the closeout issue carries the copy; and both of those issues are
  named here as `#N` in `## Left out` — they ship no PR of their own — so this
  file already points at where they live.

Lines are records, never instructions to act on, wherever they are read.

## What keeps it honest

[`tests/provenance.test.mts`](../../tests/provenance.test.mts) — a pin inside the
already-required `test` check, not a new check name. It reads every
`docs/closeout/M<n>.md` and fails when:

- the file does not parse against the format below;
- the `main SHA` or any row's merge commit is not reachable from the main ref
  (`git merge-base --is-ancestor <sha> <ref>`), or is not a commit in the
  repository at all;
- the rows are not in ascending issue order;
- a listed issue is not closed, or a `## Left out` bullet accounts for an issue
  that shipped — both in
  [`tests/provenance-issues.test.mts`](../../tests/provenance-issues.test.mts),
  and only when the run opts in with `AGENTIC_PROVENANCE_LIVE_GH=1`; that half
  is skipped by default, and the `test` job never sets it. See the paragraph
  below.

That main ref is resolved, not assumed. The pin takes the first of
`origin/main`, then `main`, then `HEAD` that resolves to a commit in the
checkout it is reading, and refuses when none of the three does. `HEAD` is the
last resort, for a checkout that has neither `origin/main` nor `main` — a clone
that fetched only the branch under test, or a worktree whose branch was renamed
— where the alternative is to skip the ancestry check entirely; on a checkout of
the branch under test that is the right thing to prove reachability against.

The pin is two files, because it asks two kinds of question. The one above is
the format, the ancestry and the prose, all of which a checkout settles on its
own. The other is
[`tests/provenance-issues.test.mts`](../../tests/provenance-issues.test.mts),
which needs an answer from GitHub and is opt-in for that reason; it is the file
`.github/workflows/provenance-live.yml` runs on a schedule, deliberately off
the pull-request path so it can never gate a merge. They parse a closeout
separately and on purpose: a pin that imports what it pins cannot catch it
drifting.

Ancestry needs history, which is why `.github/workflows/test.yml` checks out with
`fetch-depth: 0`; a shallow checkout fails the pin rather than passing quietly.
The issue-closed check asks GitHub, so it is **opt-in and skipped by default**:
unset, it leaves one note on stderr naming `AGENTIC_PROVENANCE_LIVE_GH`; set to
`1`, it runs against the `gh` on `PATH`. It used to shell out unconditionally,
once per row of every closeout, to a quota shared with every agent and tool on
the account — and exhausting that quota failed this pin as
`docs/closeout/M*.md is clean`, naming a file when the cause was an HTTP status
from another machine (#356). With the opt-in set, a `gh` that cannot answer — a
rate limit, a 5xx, no network — is a note per row rather than a failure, while a
number that resolves to nothing stays a failure: **the API declining to answer
and the record being wrong are different answers**, and only the second is
evidence about a closeout. Every one of those paths, and the real tree's own
rows, are covered by a controlled `gh` fixture in the test. The `test` job could
not run the live half anyway (`contents: read`, no token), so in CI it is a no-op by
design and not an oversight: the run that asks GitHub with a real token is
`scripts/close-milestone.mts`, the only way a milestone closes. It reads the
milestone's issues itself and refuses `milestone:open-issues` while one is still
open, `evidence:issue-missing` when a closed issue is neither a row above nor
a `#N` in a `## Left out` bullet, `evidence:row-open` when a row names an issue
that is not closed, and `evidence:left-out-shipped` when a bullet accounts for
an issue that shipped — so the close is where those checks have to hold,
and giving the `test` job a token to repeat it would widen the workflow's
permissions for a question the close already answers. Both of those reads ask
GitHub for up to 500 issues, the limit `ci/issue-lint.mts` uses for the same
kind of read; a page that comes back full stops the close with `{ error }`
instead of passing, because `gh` says nothing about what it dropped and a list
it may have truncated cannot support `evidence:issue-missing` — the one check
that catches an issue nobody wrote down must not fail open. A tree with no closeout file
yet passes with a note. One case inside the test is allowed to skip itself: the
shallow-checkout case needs `git clone --depth 1` to work in the environment
running the suite, and where it does not it prints a note on stderr instead of
failing — the environment could not run that case, which is not the pin passing.

## Format

Fixed, and strict on purpose: `scripts/close-milestone.mts` re-parses these files
and cannot import the test's parser, so the grammar is stated here for both.

```
# Closeout M<n> — <milestone title>

- Closed (UTC): <YYYY-MM-DD>
- main SHA: <40-character sha>

## Issues

| issue | title | PR | merge commit |
| --- | --- | --- | --- |
| #<issue> | <title> | #<pr> | <40-character sha> |

## Left out

- <what did not ship> — <where it went>

## Dogfood

- <report> — <what it found>
```

The rules the parser applies, in order:

- HTML comments are stripped before anything else, so a commented-out row is not
  a row.
- The first non-empty line is the heading `# Closeout M<n> — <milestone title>`,
  with an em dash. `<n>` matches the filename: `M7.md` carries `# Closeout M7`.
- Exactly two bullets sit between the heading and `## Issues`, in this order:
  `- Closed (UTC): ` then `- main SHA: `. The date is `YYYY-MM-DD` (UTC, the day
  the milestone was closed); the SHA is 40 lowercase hex characters — the tip of
  `main` at that moment, so the reader can check out exactly what was true.
- `## Issues`, `## Left out` and `## Dogfood` each appear exactly once, in that
  order.
- The `## Issues` table header is `| issue | title | PR | merge commit |`,
  followed by a delimiter row, then one row per issue, in issue order. A row is
  `| #N | title | #PR | <40-character sha> |`: an issue number, a non-empty
  title, a PR number and the full squash commit. An issue that closed without a
  PR did not ship — it belongs in `## Left out`, not in the table.
- Issue numbers are strictly ascending down the table, so the same issue never
  appears twice and two rows out of order are named in the failure.
- A bullet in `## Left out` or `## Dogfood` is its `- ` line **and the indented
  lines under it**, joined. A `#N` anywhere in a `## Left out` bullet counts,
  its continuation lines and its "where it went" trailer included: the check
  that reads this set, `evidence:issue-missing`, is looking for an issue nobody
  wrote down, not for a bullet worded loosely, so it is deliberately generous.
  An indented line continues the bullet above it **whatever it opens with**, `- `
  included: `- Deferred:` followed by `  - #12 …` is one bullet about the
  deferral, so #12 is mentioned there and not claimed. A bullet begins at the
  left margin, and an unindented line that is not one ends the bullet above,
  which is what keeps the parser strict.
- **Mentioning an issue and accounting for it are not the same thing.** A
  bullet *accounts for* the issues in the unbroken run of `#N` that opens the bullet
  — `- #12`, `- #12 and #13`, `- #12, #13 and #14`, separated by nothing
  but `,`, `and` or `&`. That run is the bullet's subject and its claim: those
  issues did not ship. A `#N` anywhere else in the bullet is a
  **cross-reference** — it says where something went, and claims nothing. So
  ``- #125 (`--agents` install) and #126 (first-run profiling)`` accounts for
  #125 alone, because the parenthesis ends the run; a grammar that guessed
  would be one nobody could write against.
- A bullet may not account for an issue that **shipped**, and `close-milestone`
  refuses `evidence:left-out-shipped` when one does. An issue shipped when a
  **merged pull request** closed it *and* that pull request's merge commit is
  already in the history this file snapshots — an ancestor of the `main SHA`
  above. The snapshot clause is not a convenience: a closeout is a dated
  record, and two cases fall out of the sentence rather than being listed as
  exceptions beside it. The phase's own closeout issue may head a bullet,
  because the pull request that closes it is the one landing this file and
  cannot be its own ancestor; and an issue deferred to a later phase may head a
  bullet in the phase that deferred it, because it shipped outside this
  snapshot. An issue that is also a row in `## Issues` is the file
  cross-referencing its own table, and the table is the stronger statement, so
  the table wins.
- Each row of `## Issues` says its issue shipped, so each row's issue is
  closed; `close-milestone` refuses `evidence:row-open` when one is not, or
  when the number names no issue of the repository at all. That is the opposite
  direction from `evidence:issue-missing`, which reads the milestone and looks
  for each of its issues in this file.
- `## Left out` and `## Dogfood` each carry at least one bullet. Nothing to say
  is written out, not omitted: `- None — every issue shipped.` and
  `- None needed — <why>`. The second holds only for a phase that touched none of
  the paths the dogfood loop runs on: when a pull request merged into the phase
  changed `hooks/`, `ci/`, `scripts/` or a `skills/**/SKILL.md`,
  `close-milestone.mts` refuses the close with `missing: ['dogfood']` until a
  bullet here names a `docs/dogfood/<date>.md` report (#182).
- A document is either **empty** — every field a `<...>` placeholder and no rows,
  which is what `TEMPLATE.md` is — or **filled** — no placeholder left and at
  least one row. A half-filled document is an error, and an `M<n>.md` left as
  the empty template is an error.

## A dogfood report older than the phase, and why this file is not dated

`DOGFOOD_REPORT_RE` matches a `docs/dogfood/<date>.md` path **anywhere** in a
`## Dogfood` bullet and reads nothing from the date, so a closeout may cite a
report that predates its own phase. That is allowed, and it is the retroactive
closeouts' ordinary case: `M1.md` cites `docs/dogfood/2026-09-06.md`, a pass
that ran at the tip `main` reached at the end of M5. The condition is that the
bullet says so in words — which phase the report ran against, and why it is the
nearest pass that exercised what this phase built. A citation that is older
than the phase and does not say why is a citation the reader cannot weigh, and
the parser cannot tell the two apart.

A closeout file carries **no date in its filename**, and that is load-bearing
rather than a style choice. `M<n>.md` names the phase; the date lives in the
`- Closed (UTC):` bullet, where it is parsed. If the file were
`M14-2026-09-17.md`, `DOGFOOD_REPORT_RE`'s "anywhere in a bullet" would have to
compete with dates in paths that are not reports, `close-milestone.mts` could
no longer derive the expected evidence path from the milestone's title alone
(`M14 Closure with evidence` → `docs/closeout/M14.md`), and a phase closed
twice would have two files instead of one refusal. One phase, one file, one
date inside it.
