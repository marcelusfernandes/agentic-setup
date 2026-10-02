# 0038. What counts as a dogfood report is decided by two anchored readers, one for a path and one for prose

Status: proposed
Date: 2026-10-02

Landed with #295, which implements the rule below in the same diff. Written here rather
than left in that pull request's body because it changes **what a gate refuses**:
`scripts/close-milestone.mts` decides whether a `## Dogfood` bullet names a report by
this shape, and the narrowing below moves that verdict for three bullet forms that used
to satisfy it. It also changes what the required `scope` check warns about and what
`tests/dogfood-report.test.mts` accepts as a report. That obliged the update to
[`../dogfood/README.md`](../dogfood/README.md) in the same diff, and
[`README.md`](README.md)'s own clause makes that a decision — "If a change obliges that
doc update, it is a decision, and the decision is part of the same PR."

**The number.** 0038, granted by the orchestrator on 2026-10-02 as an `authorised:` line
on #295 naming this exact filename. The register's next-number command, run against
`main`, answers 0037: `main` ends at 0036 and **PR #465 is open carrying 0037**
(`docs/decisions/0037-a-label-edit-does-not-re-run-a-check.md`). A branch cannot see an
open sibling's file, so deriving the number here would have collided with it — the
hazard [`README.md`](README.md) describes under **Where a decision lives**, "two pull
requests that compute the number in the same window compute the same number", arriving
for the second time. The grant names the file rather than the rule for computing it
because only the orchestrator can see both branches, and an implementer never widens its
own globs (invariant 9).

This item lands `proposed`, like every dated item since 0021. [`README.md`](README.md)
("Silence never accepts") reserves `accepted` to an explicit written OK from the person
running the loop, and no such OK exists for this item.

Symbols rather than `file:line` citations, for the reason item 0029 gives: line citations
written into this register have gone stale inside a day.

## Decision

In `ci/lib/scope.mts`, the shape of a dogfood report is written once as a source string
and **two anchored readers are derived from it.** Neither is unanchored, and which one a
caller uses is decided by what the caller holds.

**1. `DOGFOOD_REPORT_PATH_RE` matches a path, and the whole of it.** Anchored `^…$`. It
is the reader for anything that holds a file path: `dogfoodTrigger`'s changed-file
branch, and `tests/dogfood-report.test.mts` deciding which entries of `docs/dogfood/` are
reports.

**2. `DOGFOOD_REPORT_RE` keeps its name and matches a report named inside prose.**
Anchored at both ends by a **boundary** rather than by `^`/`$`, because both of its
callers hand it prose: `scripts/close-milestone.mts` tests a `## Dogfood` bullet, and
`dogfoodTrigger` tests a pull-request body. A path in backticks, inside a Markdown link,
or inside a URL still counts; a name run together with surrounding word characters, `.`
or `-` does not.

**3. One source string, two readers, because two hand-spelled patterns have to agree and
nothing makes them.** This is the shape `LINKED_ISSUE_SOURCE` already uses in the same
file for the same reason — the hazard item 31 named for `authorised:` lines. The
alternation is spelled once; the anchoring is the only thing that differs.

**4. The lookbehind excludes word characters, `.` and `-`, and deliberately not `/`.**
So `templates/docs/dogfood/<date>.md` is still a report *in prose* and is not one *as a
path*. That asymmetry is the whole reason there are two readers and is argued below.

## Reason

### Which shapes change, measured rather than read off the regexes

The orchestrator set the test before deciding: *if anchoring narrows or widens the match
for even one string, it is a rule change and needs a numbered item.* So the old single
unanchored regex and the two new readers were run over the corpus each reader is actually
handed, and over inputs chosen to break them.

**Over the real corpus, nothing changes.** 213 tracked paths (`git ls-files`), 45
`## Dogfood` bullets across every `docs/closeout/M<n>.md` — joined with their continuation
lines, the way `close-milestone.mts` reads them — and 185 merged pull-request bodies.
**Zero verdicts change.** Every report this repository actually cites is cited in a form
both readers agree on, in backticks or in a Markdown link.

**Over adversarial inputs, seven change, and every one of them is `true` → `false`.** The
narrowing is deliberate and **one-directional**: nothing that was not a report becomes
one.

| input | handed as | old | new |
|---|---|---|---|
| `docs/dogfood/2026-09-20.md.bak` | path | report | not a report |
| `docs/dogfood/2026-09-20.mdx` | path | report | not a report |
| `templates/docs/dogfood/2026-09-20.md` | path | report | not a report |
| `xdocs/dogfood/2026-09-20.md` | path | report | not a report |
| `https://github.com/o/r/blob/main/docs/dogfood/2026-09-20.md` | path | report | not a report |
| `a backup at docs/dogfood/2026-09-20.md.bak only` | prose | report | not a report |
| `the file docs/dogfood/2026-09-20.mdx is not a report` | prose | report | not a report |

### Why the narrowing is worth a rule change rather than left alone

A false *positive* on this shape is the expensive direction, because every consumer of it
reads a match as "a report exists".

- **`scripts/close-milestone.mts` refuses a close with `missing: ['dogfood']` until a
  `## Dogfood` bullet names a report.** Under the old reader a bullet naming
  `docs/dogfood/<date>.md.bak` or `docs/dogfood/<date>.mdx` satisfied that gate. A phase
  could close on a citation that resolves to no report. Three bullet forms move from
  satisfying the gate to not satisfying it, and that is a change to what a gate refuses,
  which is the first thing [`README.md`](README.md) lists under **What becomes a numbered
  decision**.
- **`scope`'s dogfood nudge is suppressed by a changed file that looks like a report.**
  A diff touching `hooks/`, `ci/`, `scripts/` or a `skills/**/SKILL.md` while carrying
  `docs/dogfood/<date>.md.bak` had its nudge silenced. That one is a warning and not a
  refusal, so it is the cheaper half; it is still a mechanism going quiet for the wrong
  reason.
- **`tests/dogfood-report.test.mts` reads the directory through the same shape**, and the
  pin's own header says why the coupling is deliberate: a file the pin accepts as a report
  and the regex does not would silence the nudge or fail the close. Anchoring keeps the
  two in step on the shapes above instead of only on the shapes that happen to exist.

### Why two readers and not one, and why the surviving asymmetry is intentional

One pattern cannot be anchored for both kinds of caller. `^…$` is right for a path and
refuses every prose citation, which would break `close-milestone.mts` outright. Measured
over the 45 `## Dogfood` bullets in this tree: **21 cite a report, 19 of them as a
Markdown link and 2 as a backticked path in a sentence, none as a bare path — and an
anchored `^…$` reader would match none of the 21.** Every phase that has closed on a
dogfood citation would stop closing. A boundary form is right for prose and still accepts a path
with a directory prefix, because the lookbehind has to let `/` through: a closeout bullet
may legitimately cite a report **by URL**, and in a URL the path is preceded by `/`.

So one asymmetry survives, and it is a choice rather than an oversight:

**A report cited by URL in prose still counts; the same URL handed as a path does not.**
That is correct in both directions. A closeout bullet or a pull-request body may name a
report by link, and should still count. A changed-file list never contains a URL —
`git diff --name-only` prints repository-relative paths — so the path reader loses nothing
by refusing one, and gains the refusal of `templates/docs/dogfood/<date>.md`, which *is* a
path a diff can contain. The next reader should not file this as an inconsistency between
the two readers: it is the reason there are two.

### What did not change, so that it is not attributed to this item

**`docs/dogfood/nested/2026-09-20.md` is not among the seven.** The old regex never
matched it either, because the date has to follow `docs/dogfood/` immediately and `nested/`
does not. Both readers refuse it, and both always did. It is named here because a reader
comparing the before and after would otherwise reasonably assume a nested path was part of
what this item fixed — #295's own first draft of this reasoning assumed exactly that, in
its pull-request body and in [`../dogfood/README.md`](../dogfood/README.md), and both were
corrected by running the comparison instead of reading the pattern. Stating what did not
change is the cheaper half of stating what did.

## Cost accepted

- **Two exported names where there was one, and a caller can now pick the wrong one.**
  Handing a path to the prose reader accepts a directory prefix; handing a prose line to
  the path reader matches nothing at all. Nothing enforces the pairing — the bound is
  written at each export and the four live call sites are correct as of this item. A fifth
  caller is a place to get it wrong, and that is the price of the asymmetry the previous
  section argues for.
- **A lookbehind, which this file did not use before.** `(?<!…)` needs a runtime that
  supports it; Node ≥ 22.18 is already the floor (invariant 2) and this adds no new
  dependency, but it is a construct a reader has to parse and a construct an adopting
  repository's tooling has to support.
- **A closeout that cited a report by a non-report filename now blocks its own phase.**
  None exists in this tree — measured, 21 citing bullets of 45, zero verdict changes — so
  the cost is paid by a future closeout that gets the filename wrong, which is the point.
  It is still a refusal that did not exist before, and it arrives at the moment a phase is
  being closed.
- **The real corpus could not have falsified this change, and did not.** All 213 paths,
  45 bullets and 185 bodies agree either side of it. That is evidence about what has been
  written, not about the readers, and item 0036 already paid for learning the difference
  the hard way: *"a corpus can only falsify, and a parser change needs a case built from
  the rule it changed, not only a replay of what has already been written."* The seven
  adversarial inputs are that case, and they live in `tests/scope.test.mts` and
  `tests/dogfood-report.test.mts` rather than only in this item.
- **`.mdx` is refused by shape and not by intent.** Nothing in this repository writes
  `.mdx`, and the extension is excluded because the path reader ends at `.md` and the
  prose reader's lookahead excludes a following word character. If a report format ever
  gains a second extension, both readers change, and this bullet is where to look.

## Supersedes

Nothing. The shape was introduced by #182 and carries no number of its own; this item is
the first decision about it. `DOGFOOD_GLOBS`, the dogfood nudge's warn-not-fail policy
(the decision on #180's shape) and `close-milestone.mts`'s once-per-phase refusal are all
untouched: what changes is only which strings count as a report.

## Updates

*(none yet)*
