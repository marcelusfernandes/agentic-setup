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
   in that milestone, labelled `type:docs` / `scope:docs`.
3. The docs-writer fills it in a `type:docs` PR — one row per issue, read from
   `gh issue list --milestone "<milestone>" --state all` and
   `gh pr list --state merged`, with the squash commit of each PR as the merge
   commit (`gh pr view <n> --json mergeCommit`).
4. Only once that PR has merged is the milestone empty enough to close. The
   milestone does not close because its issues closed; it closes against the
   evidence file.

The closeout is the evidence a milestone close is checked against, so it lands
before the close, never after it.

## What keeps it honest

[`tests/provenance.test.mts`](../../tests/provenance.test.mts) — a pin inside the
already-required `test` check, not a new check name. It reads every
`docs/closeout/M<n>.md` and fails when:

- the file does not parse against the format below;
- the `main SHA` or any row's merge commit is not reachable from the main ref
  (`git merge-base --is-ancestor <sha> <ref>`), or is not a commit in the
  repository at all;
- the rows are not in ascending issue order;
- a listed issue is not closed — only where `gh` is authenticated, which the `test` job
  is not; see the paragraph below.

That main ref is resolved, not assumed. The pin takes the first of
`origin/main`, then `main`, then `HEAD` that resolves to a commit in the
checkout it is reading, and refuses when none of the three does. `HEAD` is the
last resort, for a checkout that has neither `origin/main` nor `main` — a clone
that fetched only the branch under test, or a worktree whose branch was renamed
— where the alternative is to skip the ancestry check entirely; on a checkout of
the branch under test that is the right thing to prove reachability against.

Ancestry needs history, which is why `.github/workflows/test.yml` checks out with
`fetch-depth: 0`; a shallow checkout fails the pin rather than passing quietly.
The issue-closed check needs credentials the `test` job does not have
(`contents: read`, no token), so against the real tree it runs only when `gh` is
authenticated and leaves a note on stderr when it is not — its refusal path is
covered by a controlled `gh` fixture in the test. In CI that half is a no-op by
design and not an oversight: the run that asks GitHub with a real token is
`scripts/close-milestone.mts`, the only way a milestone closes. It reads the
milestone's issues itself and refuses `milestone:open-issues` while one is still
open, or `evidence:issue-missing` when a closed issue is neither a row above nor
a `#N` in a `## Left out` bullet — so the close is where that check has to hold,
and giving the `test` job a token to repeat it would widen the workflow's
permissions for a question the close already answers. A tree with no closeout file
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
