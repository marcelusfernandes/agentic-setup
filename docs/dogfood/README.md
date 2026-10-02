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
  path matches `DOGFOOD_REPORT_PATH_RE` (`ci/lib/scope.mts`) — the same shape
  `scope` and `close-milestone.mts` count as a report, so a file this test
  accepts and that regex does not would silence the nudge or fail the close.
  **Both of that file's two readers are anchored** (#295), and the path one
  matches the whole string and nothing else. Measured against the regex it
  replaces: `docs/dogfood/2026-09-20.md.bak`, `docs/dogfood/2026-09-20.mdx` and
  `templates/docs/dogfood/2026-09-20.md` all counted as reports, so any of the
  three in a diff silenced the nudge for a pull request carrying no report.
  `docs/dogfood/nested/2026-09-20.md` was never matched by either reader, because
  the date has to follow the directory immediately, and the anchored one refuses
  it too;
- a report does not parse against the format below, or its heading date does not
  match its filename;
- a case row is missing one of its three numbers, carries a decision other than
  `keep` or `fix`, or gives no reason for it;
- a finding row carries no origin, or an outcome that parks it — empty, or one of
  `candidate`, `todo`, `tbd`, `open`, `later`, `unresolved`, `maybe`, `none`,
  `n/a` on its own;
- a report is half-filled: rows in a document that still carries a `<...>`
  placeholder, or a dated report left as the empty template;
- a report whose `Retroactive:` bullet names an issue while its own heading date
  is on or after **2026-09-17**, the day this format landed. The escape exists
  for a pass that ran before the format did and for nothing else, so a live pass
  cannot opt into writing `not recorded` in five cells by adding a bullet;
- a case row whose `error class` is the literal `not recorded`, in any report,
  retroactive or not: the escape covers `Commit` and the five numeric cells, and
  that column is not one of them;
- a `Cost (USD)` that is a number and whose HTML comment says neither
  `reconstruction` nor `billed` — see "What `Cost (USD)` means" below.

What it does **not** check is the `finding` column's prose. The pin holds a
finding row to its shape — that it has a description at all, an `origin` and an
outcome that does not park it — and holds the description itself to nothing. So
the finding column is not held to the standard the numbers are: every number in
a report is checkable against the thing it measures, and a description is
checkable only by resolving the `origin` and the outcome it names and reading
them. That is a writer's obligation and a reader's, not a check's.

So, writing the next report: **sweep the `finding` column end to end before the
report lands, and write the count into the pull request** — how many
descriptions the table holds, how many were checked, how many held, and every
one that did not. Check each description against the evidence its own row names
— the outcome's issue, the review comment its `origin` cites, the tree at the
commit the header states rather than at `main` — and not against whether it
sounds right. Correct a description that was false in the row itself, never in
an appended note: a note cannot stop a sentence asserting what it still says.
Name, with a count, any description whose evidence did not outlive the run, so
the next reader can tell an unverifiable row from an unchecked one.

Sampling the column instead is how `docs/dogfood/2026-09-17.md` reached its
eighth review round with every number verified and seven of its hundred and two
descriptions still false (#332). A report that says it checked them all without
a count leaves a reader unable to tell "swept and clean" from "not swept",
which is the whole difference.

The test states the grammar itself rather than importing a parser, the way
[`tests/proof-declarations.test.mts`](../../tests/proof-declarations.test.mts)
does: a pin that reuses the parser it pins cannot catch that parser drifting.
This file and that test are meant to be read against each other when either
changes.

### A finding is a symptom until it is reproduced

A finding written from **one failing command states a symptom.** It becomes a
**mechanism** only once the diagnosis has been reproduced — the named cause made
to produce the same failure a second time, or the cause removed and the failure
gone with it. Write which of the two the row is, in the row. The format asks a
finding for an origin and an outcome and has never asked whether the diagnosis
was tested, which is how finding L22 of `docs/dogfood/2026-09-10.md` landed
stating a symptom as a mechanism, and only a reproduction caught it two reports
later — finding D24 of `docs/dogfood/2026-09-17.md:239`.

Correcting a description has two cases and they have different remedies:

- **Inside the pass, before the report lands** — correct the row itself, never an
  appended note, as the sweep above already says.
- **A later report correcting an earlier, landed report** — say so **in the
  corrected row of the later report's own table**, naming the report and the
  finding it corrects, and **do not rewrite the landed file.** A landed report is
  the record of what one pass found and believed; editing it leaves no trace that
  the belief was ever held, and every reader who cited it is reading a file that
  no longer says what they cited. The correction is itself a finding and belongs
  where findings go. That D24 row is the worked example: its `outcome` cell says
  that `docs/dogfood/2026-09-10.md` finding L22 "is left as it landed with this
  row as its correction", which is the shape this rule now states.

### A finding row may cite evidence from after the window

**Yes, it may, and it says so in its `outcome` cell.** The six header bullets and
a case row's three numbers measure one window and the report states which. The
findings table has no window in its grammar at all, and that is not an omission:
its contract is follow-through rather than measurement, and a row's outcome is
the issue the finding became, which is filed after the pass found it. A row that
could cite nothing past the close could not carry an outcome.

So a row may rest on evidence the window does not contain, and the marker is
words in the `outcome` cell saying when — "done during the run, after the day
this report counts", "already covered during the pass". The `origin` cell is the
other half and is not relaxed: it names where **inside** the window the finding
came from. A reader can then tell a row measured inside the window from one
resolved after it, which is the thing that was undecidable before.

### What `Cost (USD)` means

Two different measurements could sit in that cell, so **the report says which one
it is.** A **billed** figure is one a runtime or an account statement stated. A
**reconstruction** is one the writer computed from token counts at published list
prices. Every pass written up here is the second, because a Claude Code agent has
no cost accounting exposed to it at all: it can read the token counts in its own
transcripts and nothing else. The derivation and the per-model totals go in an
HTML comment at the bullet — the only place this format has for them — and the
pin fails a numeric `Cost (USD)` whose comment claims neither word.

A reconstruction is derived from these inputs and from nothing else:

- the transcripts the `Transcripts` bullet names — the orchestrating session's
  own, and every subagent transcript beside it;
- each assistant response's token usage in them, **deduplicated by response id**,
  because one response is written to more than one file;
- **restricted to the window the header measures**, by each response's own
  timestamp;
- summed per model over five token classes — input, 5-minute cache write, 1-hour
  cache write, cache read, output — and priced at the list price per million
  tokens published for that model, **with the price table written out in the
  comment.**

Responses the sum cannot price — no usage block, or a model id with no published
price — are excluded and **counted** in the comment, never dropped quietly.

**What the number excludes**, and no reader may take it as covering: what a
subscription account is actually billed, which list price is not; and what the
operator's own interactive turns cost outside the sessions the window reads.

**How far it reproduces, which is the only warrant it has.** Given the same
transcripts, the same two window bounds and the same price table, two readers get
the same figure to the cent: `docs/dogfood/2026-09-20.md`'s 555.83 was recomputed
from the same corpus by a second, independently written script during the work on
#295, to the cent and to the token on all five classes of both models it prices.
That is why a report may compare its cost to the previous pass's at all — **the
warrant is the reproduction, never the number.** Across a corpus **re-collected
later** it drifts, and the size of the drift is on record: run against the
2026-09-17 window the later script answers 743.16 where that report states
742.59, +0.08% — two of that pass's three models reproducing to the token and
only the third differing, because the set of transcripts summed was no longer the
same set. A report states its comparison as a reproduction or does not make it.

**Why the figure survives the report's own corrections, and the one way to lose
that.** The window is bounded by two **named events** — a merge, a dispatch —
never by "the last event so far". A bound that means *now* turns the cost into a
measurement of the report's own production: every correction is another push,
another turn and another cost, so the number is false again as soon as it is
fixed. `docs/dogfood/2026-09-20.md` removed a whole class of claim for exactly
that reason, and its own close bound had to be rewritten after two wrong forms
before it named an event instead of a moment. Define the window against events
first; the cost follows and then holds still.

Finally, **a later reader cannot recompute the figure at all.** The transcripts
are outside this repository and are not kept; the derivation, the per-model
totals and the price table in the comment are the whole of what survives the
pass. That is why the format asks for them rather than for the number alone.

### Two pins that ask GitHub, and the one question neither answers

Two checks in the same file read GitHub rather than the checkout, because the
rules they hold are about issues. Both are **opt-in**: unset,
`AGENTIC_DOGFOOD_LIVE_GH` leaves one note on stderr naming itself and neither
runs, so the required `test` job — which carries no token and could not
authenticate anyway — asks nothing. Run them with
`AGENTIC_DOGFOOD_LIVE_GH=1 node tests/dogfood-report.test.mts` and put the output
in the pull request that carries a report. A `gh` that cannot answer, or a number
that cannot be read, is a **note and not a failure**, so neither pin needs the
network to pass; a token refused the scope the query needs **is** a failure,
because that one never fixes itself and its whole symptom would be a green run
that checked nothing.

- **origin → issue.** Every finding row whose `outcome` is a bare `#N` naming an
  issue: that issue's `## Context` must carry an `Origin:` line equal to the
  row's `origin` cell. This is the rule
  [`docs/workflow.md`](../workflow.md) states — the `Origin:` line is copied
  verbatim from the cell — and nothing checked it, which is why two hand sweeps
  of `docs/dogfood/2026-09-17.md` both reported clean while rows disagreed. An
  `#N` that resolves to a pull request is not compared: a pull request has no
  `## Context`, and the README allows a merged one as an outcome.
- **proof → files.** For the same issues, a **test path** named in the issue's
  `## Proof` that lies outside that issue's own `## Files` globs **and does not
  exist in the tree** is a failure: the pull request has nowhere to produce it,
  so the issue has either the wrong scope or the wrong proof.

Both pins **join a wrapped line before comparing**, and that is load-bearing
rather than tidy. Prose here wraps at about seventy-two columns, so an `Origin:`
line or a `## Proof` sentence longer than that lives on two lines, and a
comparison that reads one line at a time reports a false clean — measured: over
the 117 bare-`#N` rows in this directory the line-at-a-time comparison reports
seven disagreements, six of which are the wrap and one of which is real, and #295
records three hand sweeps in the run that filed it reporting zero disagreements
for exactly that reason. A pin that inherits the blindness is worse than none,
because it turns a false clean into an automated one.

**What the proof pin deliberately does not read**, stated because the unqualified
rule is false and was measured so. Over 153 issues of this repository: "every
path named in `## Proof` sits inside `## Files`" reads 184 paths and reports
**43** of the 153, and what it reports is a check's name written as a path
(`ci/negative-control.mts`), a glob, and an illustrative placeholder. Narrowed to
test paths it reads 79 and reports **six**, and all six are correct issues naming
an **existing** pin as the instrument that will read their new file — a proof may
rest on an instrument it does not change. With absence from the tree added it
reports **none**, which is the shape that is shipped: it refuses only the case
where the pull request has nowhere to produce the file it proves itself with. The
judgement that is left — an issue meaning to add cases to a test it forgot to
declare — is a reader's, below.

**Neither pin answers coverage, and coverage may not be mechanically answerable
at all.** A matching `Origin:` line proves **provenance** — this row and that
issue describe the same finding's source — and says nothing about whether the
issue would actually resolve the finding. #295 records two rows of
`docs/dogfood/2026-09-17.md` that passed the same comparison while resolving to
issues covering neither, and the reviewer of PR #307 saying the coverage question
may not be mechanically checkable at all. Nothing in an issue body states the
finding's own condition, so there is nothing to compare a goal against, and
nothing since has shown otherwise.
**So coverage is assigned, not checked:** the writer owes it in the
sweep above, row by row, and the isolated reviewer of the pull request carrying
the report owes it a second time, reading each `outcome` against the finding
beside it. The same two readers own a written reason — "already covered by
PR #905", "accepted: …" — of which the pins check only what is mechanical: every
`#N` such a reason names must resolve, and a pull request it names as the cover
must be merged.

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
  one, which is the only reason the report exists. A numeric `Cost (USD)` carries
  an HTML comment at its bullet saying whether the number is `billed` or a
  `reconstruction`, with the derivation and the per-model totals — see
  "What `Cost (USD)` means" above, which is where that word's meaning is stated.
- `Retroactive: #N` is the one exception, and it exists for a single case: a pass
  that ran before this format did, whose record is a prose issue that never
  carried the numbers. **Only a report whose own heading date is before
  2026-09-17, the day this format landed, may carry it**, so a live pass cannot
  opt into the escape by adding a bullet. A report carrying it names the issue it
  reproduces and may write the literal `not recorded` in `Commit`, `Turns`,
  `Minutes`, `Cost (USD)` and a case row's `exit` and `tool calls` — the
  alternative being a reconstructed number, which is worse than an absent one in a
  file whose whole purpose is putting two passes side by side. A report without the
  bullet may write it nowhere, so a pass run from now on is still held to its
  numbers. Those six cells are the whole of the escape and `error class` is not one
  of them: `not recorded` there is refused in **every** report, retroactive or not,
  because a pass that ran at all produced an outcome per case and a class is a name
  for it, not a measurement its runtime had to report. Nothing else is relaxed
  either: a `keep`-or-`fix` `decision` and a `reason` are owed both ways, and so is
  a resolved `outcome` on every finding. `docs/dogfood/2026-09-06.md` and
  `docs/dogfood/2026-09-10.md` are the two reports it was written for — #96 and
  #129, reproduced by #184 — and neither writes `not recorded` in an `error class`
  cell.
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
