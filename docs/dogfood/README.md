# Dogfood reports

One file per pass, `docs/dogfood/<YYYY-MM-DD>.md`, written from
[`TEMPLATE.md`](TEMPLATE.md). A pass is this repository's mechanism — the hooks,
the checks, the scripts and the skill cards — run against a real repository by an
agent, and the report is what the pass leaves behind once the transcripts are
gone.

Two things the format is for, and the whole grammar below follows from them:

- **Comparability.** Every case carries the same three numbers (exit code, error
  class, tool calls) and every pass the same three totals (turns, minutes, cost),
  so two passes a month apart can be put side by side. Prose cannot be compared;
  #96 and #129 hold thirty-four findings between them and no two of them are
  measured the same way.
- **Follow-through.** Every case ends in a `keep` or a `fix`, and every finding
  ends in an issue number, in the pull request or issue that already covered it,
  or in a written reason it is not work. A finding parked as a bullet in a mother
  issue comes back: F12 of #96 returned as L21 of #129 because the first time it
  was never scheduled. A report may not leave a finding as a candidate, and
  [`tests/dogfood-report.test.mts`](../../tests/dogfood-report.test.mts) fails
  when one does.

Transcripts stay outside this repository — they are long, they carry the contents
of another repository, and they are not evidence anyone re-reads. The report links
to where they are kept; the numbers are the part that lands here.

## Who writes one, and when

1. A pull request changes the mechanism the loop runs on: anything under
   `hooks/`, `ci/` or `scripts/`, or a `skills/**/SKILL.md`. `scope` names those
   files in a `warning:` and still exits 0, because whether a run was owed is a
   judgement no file name settles (#182).
2. The phase runs a pass against a disposable repository and writes it up here,
   dated the day the pass ran. That repository is created **private**, never public,
   under the fixed `agentic-setup-dogfood-` name prefix — one name prefix so every
   leftover is findable by a single search, and `--private` because a pass installs
   this repository's mechanism into it and then pushes whatever the run produced:
   `gh repo create agentic-setup-dogfood-<issue or date> --private`. The **pull-request
   body that carries the report names it under a line asking a person to delete it**,
   in that exact form so it is greppable:

   ```text
   Delete after review: <owner>/agentic-setup-dogfood-<issue or date>
   ```

   The line is owed because the agent cannot do the deletion itself: `gh repo delete` is
   denied to agents by design (`.claude/settings.json`, shipped as
   `templates/claude-settings.json`), and that denial is not something a pass argues its
   way around. A pass that skips the line leaves the repository behind with nobody told —
   which is how a **public** one was left behind once
   (`docs/dogfood/2026-09-10.md`, finding L18).
3. The milestone's closeout names that file in its `## Dogfood` section.
   `scripts/close-milestone.mts` refuses the close with `missing: ['dogfood']`
   while a merged pull request touched one of those paths and no bullet there
   names a `docs/dogfood/<date>.md` report — see
   [`docs/closeout/README.md`](../closeout/README.md).
4. Each finding worth doing becomes its own `state:ready` issue carrying an
   `Origin:` line in `## Context`, copied from the finding's `origin` cell. The
   report's `outcome` cell then names that issue. See
   [`docs/workflow.md`](../workflow.md), "Issue (one template)".

The warning is per pull request; the refusal is once per phase. Neither of them
writes the report.

## What keeps it honest

[`tests/dogfood-report.test.mts`](../../tests/dogfood-report.test.mts) — a pin
inside the already-required `test` check, not a new check name. It reads every
file in this directory and fails when:

- the directory holds anything but `README.md`, `TEMPLATE.md` and files whose
  path matches `DOGFOOD_REPORT_RE` (`ci/lib/scope.mts`) — the same shape `scope`
  and `close-milestone.mts` count as a report, so a file this test accepts and
  that regex does not would silence the nudge or fail the close;
- a report does not parse against the format below, or its heading date does not
  match its filename;
- a case row is missing one of its three numbers, carries a decision other than
  `keep` or `fix`, or gives no reason for it;
- a finding row carries no origin, or an outcome that parks it — empty, or one of
  `candidate`, `todo`, `tbd`, `open`, `later`, `unresolved`, `maybe`, `none`,
  `n/a` on its own;
- a report is half-filled: rows in a document that still carries a `<...>`
  placeholder, or a dated report left as the empty template.

What it does **not** check is the `finding` column's prose. The pin holds a
finding row to its shape — that it has a description at all, an `origin` and an
outcome that does not park it — and holds the description itself to nothing. So
the finding column is not held to the standard the numbers are: every number in
a report is checkable against the thing it measures, and a description is
checkable only by resolving the `origin` and the outcome it names and reading
them. That is a writer's obligation and a reader's, not a check's. A writer of
the next report should expect the column to be swept end to end before the
report lands, with the count written into the pull request — sampling it is how
`docs/dogfood/2026-09-17.md` reached its eighth review round with every number
verified and seven of its hundred and two descriptions still false (#332).

The test states the grammar itself rather than importing a parser, the way
[`tests/proof-declarations.test.mts`](../../tests/proof-declarations.test.mts)
does: a pin that reuses the parser it pins cannot catch that parser drifting.
This file and that test are meant to be read against each other when either
changes.

## Format

```
# Dogfood <YYYY-MM-DD> — <what this pass exercised, in one line>

- Repository: <owner/name the pass ran against>
- Commit: <40-character sha>
- Turns: <n>
- Minutes: <n>
- Cost (USD): <n.nn>
- Transcripts: <where they are kept, outside this repository>
- Retroactive: <#N this report reproduces — only on a pass that predates this format>

## Scoreboard

| case | exit | error class | tool calls | decision | reason |
| --- | --- | --- | --- | --- | --- |
| <case> | <exit code> | <error class or none> | <n> | keep or fix | <why> |

## Findings

| finding | origin | outcome |
| --- | --- | --- |
| <what the pass found> | <the case, run or pull request it came from> | <#N, the PR or issue that covered it, or why it is not work> |
```

The rules the parser applies, in order:

- HTML comments are stripped before anything else, so a commented-out row is not
  a row.
- The first non-empty line is the heading `# Dogfood <YYYY-MM-DD> — <title>`, with
  an em dash. The date matches the filename: `2026-01-31.md` carries
  `# Dogfood 2026-01-31`.
- Exactly six bullets sit between the heading and `## Scoreboard`, in this order:
  `Repository`, `Commit`, `Turns`, `Minutes`, `Cost (USD)`, `Transcripts`, each
  one non-empty, optionally followed by a seventh, `Retroactive`. `Commit` is 40 lowercase hex characters — the tip this
  repository was at when the pass ran, so a later reader can check out exactly
  what was exercised. `Turns` and `Minutes` are whole numbers and `Cost (USD)` a
  number; a pass whose runtime reports none of them is not comparable to the next
  one, which is the only reason the report exists.
- `Retroactive: #N` is the one exception, and it exists for a single case: a pass
  that ran before this format did, whose record is a prose issue that never
  carried the numbers. A report carrying it names the issue it reproduces and may
  write the literal `not recorded` in `Commit`, `Turns`, `Minutes`, `Cost (USD)`
  and a case row's `exit` and `tool calls` — the alternative being a
  reconstructed number, which is worse than an absent one in a file whose whole
  purpose is putting two passes side by side. A report without the bullet may
  write it nowhere, so a pass run from now on is still held to its numbers.
  Nothing else is relaxed: an `error class`, a `keep`-or-`fix` `decision` and a
  `reason` are owed either way, and so is a resolved `outcome` on every finding.
  `docs/dogfood/2026-09-06.md` and `docs/dogfood/2026-09-10.md` are the two
  reports it was written for — #96 and #129, reproduced by #184.
- `## Scoreboard` and `## Findings` each appear exactly once, in that order.
- The `## Scoreboard` header is `| case | exit | error class | tool calls |
  decision | reason |`, followed by a delimiter row, then one row per case. `exit`
  and `tool calls` are whole numbers; `error class` is the class of the failure
  (`none` for a case that ended clean, otherwise a short, reusable name such as
  `checks-queued` or `no-tests`, so two passes classify the same failure the same
  way); `decision` is exactly `keep` or `fix`, and `reason` says why in one line.
  `keep` is a cost accepted as it is; `fix` is a defect, and the finding row that
  carries it is what names the work.
- The `## Findings` header is `| finding | origin | outcome |`, followed by a
  delimiter row, then one row per finding. `origin` names where the finding came
  from and is copied verbatim into the issue's `Origin:` line. `outcome` is one
  of: a `#N` (the issue it became, or the merged pull request or closed issue that
  already covered it), or a one-line reason it is not work. A pass that found
  nothing carries no rows here; a pass that found something and did not decide
  what to do about it does not have a valid report.
- A document is either **empty** — every field a `<...>` placeholder and no rows,
  which is what `TEMPLATE.md` is — or **filled** — no placeholder left and at
  least one case row. A half-filled document is an error, and a dated report left
  as the empty template is an error.
