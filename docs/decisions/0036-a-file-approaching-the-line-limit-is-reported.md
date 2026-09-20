# 0036. A file approaching the line limit is reported, and every length question is asked of one base

Status: proposed
Date: 2026-09-20

Landed with #413, which implements the rules below in the same diff. Written here rather
than left in that pull request's body because all three change **what a required check
reports**, and one of them changes **what it refuses**: `scope` gains a section, three
JSON keys and a third warning, and the base commit its line rule reads moves. That
obliged the update to `docs/workflow.md` and `skills/issue-and-pr/SKILL.md` in the same
diff, and [`README.md`](README.md)'s own clause makes that a decision — "If a change
obliges that doc update, it is a decision, and the decision is part of the same PR."

**The number.** #413 declared `docs/decisions/0035-…` in its `## Files`, measured when it
was drafted. By the time it was implemented, item 35 had landed in
[`../decisions.md`](../decisions.md) with #442, so 0035 was taken and
`tests/doctrine.test.mts` would have failed a second item carrying it. The number written
here is the one the register's own command computes. #413 anticipated exactly this and
said the orchestrator grants the path actually written with an `authorised:` line rather
than the implementer renumbering into a file outside its globs; an implementer never
widens its own globs (invariant 9).

This item lands `proposed`, like every dated item since 0021. [`README.md`](README.md)
("Silence never accepts") reserves `accepted` to an explicit written OK from the person
running the loop, and no such OK exists for this item.

Symbols rather than `file:line` citations, for the reason item 0029 gives: line citations
written into this register have gone stale inside a day.

## Decision

Three rules, all in `ci/lib/scope.mts` and `ci/scope-check.mts`.

**1. A file left within `FILE_LINE_APPROACH_BAND` lines of `FILE_LINE_LIMIT` is
reported, and is not over the limit.**

- `FILE_LINE_APPROACH_BAND` is `50`, a fixed number of lines. `lengthOutcome` gains a
  fifth name, `approaching-limit`: at or below `FILE_LINE_LIMIT` at the head and within
  the band of it. `approachingLimit` selects it, `ci/scope-check.mts` prints it under
  `### Approaching the line limit` and under the JSON key `approaching`.
- **It does not fail the check.** Nothing about it reaches the expression that decides
  the exit status; `fileGrowth` — the #134 predicate, unchanged — is still the only
  length that does. `scope` has distinguished failing from reporting since #310, and this
  is a third thing reported rather than a second thing refused.
- **A file at exactly `FILE_LINE_LIMIT` is `approaching-limit`, not over it**, and the
  section says so in words: *a file at exactly 800 lines is at the limit, not past it,
  and fails nothing.* The report names each file's head count and its headroom, and names
  what closes it — a pull request that leaves the file room, or splits it, or nothing at
  all if the file is finished — the way #310's inherited report names its own cure.
- Only files the pull request touched are ever reported, because `scope` reads no file
  the diff does not name. That is not a third option beside a band and a percentage; it
  is true of every shape the report could take.

**2. Every length question is asked of one commit: the merge base.**

- `ci/scope-check.mts` computes `mergeBaseOf(base tip, head)` once and reads the
  changed-file list, the removed-path list and both sides of every line count from it.
  `git diff A...B` already resolved to that commit internally; the base side of `showAt`
  did not, and read the base **tip** instead.
- The base tip is deliberately not used for the line counts, and `showAt`'s header — the
  place it would have been read — says so and why. It is still printed in the summary and
  carried in the JSON under `measuredBase`, beside the merge base and the head, so the
  number that is not used is visible rather than merely absent.
- `mergeBaseOf` **fails closed**: when `git merge-base` cannot answer, the two commits
  are not both present and every answer below it would be computed against the wrong
  history.

**3. `scope` says what it audited and where it learned it.**

- The summary prints `Audited N glob(s) from M linked issue(s)`, each issue marked
  `declared` or `from prose`; `audited` carries the same two numbers in the JSON.
- The **declaration** is the run of lines from the first that carry closing-keyword links
  and nothing else. An issue linked only below it draws a `> warning:` naming the phrase,
  its line, the issue and the globs it adds that the declaration did not — distinct
  globs, not a count of bullets. The JSON key is `incidentalLinks`.
- **It warns and does not fail.** A body explaining which earlier pull request closed
  which issue is a good body.
- **`LINKED_ISSUE_RE` is not narrowed, and this is not a discipline.** GitHub closes an
  issue named in prose, so a parser that ignored the form would audit a *narrower* set
  than GitHub actually closes; and this repository has already measured that authorial
  care does not hold a parser reading prose.
- One consequence of making a line number reportable: `stripCode` now blanks code in
  place instead of deleting it, so an offset in the stripped text is an offset in the
  body. That also stops an inline span splicing the text either side of it together, so
  ``clos`e`s #1`` no longer reads as a link. The parser gets stricter, never looser
  (invariant 5), and `tests/scope-linked.test.mts` holds the exact prose.

## Reason

### The approach report is the half item 0029 left out, and 0029 said so

Item 0029's last cost bullet is the argument for this one: *"This item removes the
silence for a file that has **crossed** the limit and buys nothing at all for one
approaching it, which is the shape both measured incidents actually had. A check that
warned on approach is a different rule with a different cost — a threshold to argue
about, and a warning on every large file — and is not proposed here."*

Both halves of that are right, and neither is a reason not to do it. It is a different
rule: it is here, numbered separately, with its threshold argued and its cost written
down. The two incidents 0029 cites are both approach cases, not crossing cases. #229's
implementer measured `tests/init.test.mts` before adding a case and found its budget for
new lines was **zero** — which is not what "under 800 lines" reads as to anyone planning
work — and had to split the file to get room. #310's own implementer wrote that
`tests/scope.test.mts` stood at 798 of 800 "with no room for the next case", and
discovered it the same way: by counting.

The threshold is the part that has to be argued rather than asserted.

- **A fixed band, not a percentage.** `FILE_LINE_LIMIT` is a constant, so a percentage is
  the same threshold with a rounding rule attached and one more thing to get wrong. If
  the limit ever varies per path class, a percentage becomes worth revisiting; it does
  not today.
- **Fifty, because a report that arrives with the pull request that crosses is not a
  warning.** Measured over the eighty most recent landings on `main` at `38bff59`: of the
  twenty-three that lengthened a file already at 700 lines or more, seven added more than
  20 lines and four added more than 50. A band of 20 therefore gives no warning at all in
  about 30% of the cases it exists for, and a band of 50 in about 17%.
- **The cost runs the other way, and it runs flat.** 17 of those eighty landings touched a
  file at 795 or above, 20 at 790, 24 at 780, 26 at 770, 28 at 750. Moving from 780 to 750
  buys thirteen points of coverage for five points of noise. Below 750 the curve is flat
  for a different reason — nothing in this tree sits between 750 and 770 — so a wider band
  would cost nothing today and would cost on a tree that is not this one.
- **Over the tracked files rather than over landings**, the same thresholds report 8 files
  at 795, 9 at 790, 11 at 780 and 16 at 750, of 208 tracked. #392 computed nine at 780 and
  six at 795 when it was drafted; both figures had drifted by the time this landed, which
  is why they are re-measured here.

The one crossing this repository has had is the check on the decision. `tests/init.test.mts`
went 785 at the merge base, 795 at the head `scope` judged, 798 at the base tip, 808 at the
squash. A band of 50 reports it at 795 — and so does a band of 20. Neither would have
refused #290, because the report never refuses; what it changes is that the pull request
before the crossing says the file has five lines left.

### Two base references answered one question, and the wrong one answered it

`changedFiles` diffed `base...head`, which git resolves to the merge base. `growthEntries`
read `git show <base tip>:<path>`. The two coincide only while the branch is level with
`main`. On #290 they were different commits, and the branch that had taken
`tests/init.test.mts` from 785 to 795 was measured against a tip that held 798 — so a
branch that had added 10 lines was reported as having removed 3. Item 0029 found this
while investigating the crossing and recorded it as outside its own issue.

The merge base is the answer because of what the rule asks. `pushed-over` means *this
diff added the length, so this diff is answerable for it*, and "this diff" is what the
branch did since it forked — the merge base. The base tip answers a different and also
useful question, "what will `main` look like", but no rule in `scope` asks it: the
changed-file list never did, and the line rule should not have.

The error it could produce ran both ways, which is why it is a verdict and not only a
number. Against the tip, a branch that added lines to a file `main` lengthened further
reads as `inherited-over` and passes; a branch that shortened a file `main` shortened
more reads as `pushed-over` and fails. `tests/scope-line-limit.test.mts` pins the first
shape with the verdict, not just the count: fork at 785, branch head at 810, `main` at
815 — exit 0 measured against the tip, exit 1 measured against the merge base.

### What was silent was never the match

Two runs widened their audited scope on prose nobody meant as a declaration. The review of
PR #389 found a body reading `main moved while this was in review (#385 landed and closed
#310)`, backticked here for the reason this item exists, which linked #310 and added six
globs — five of them paths nothing else
granted, including the one file that body said it was deliberately not touching. PR #440's
body did the same with #299. A third of a sweep's worth of scope arrived from a sentence.

Two instincts are wrong here and both were argued down before this item.

- **Narrowing `LINKED_ISSUE_RE`** would make `scope` audit less than GitHub closes. GitHub
  linked the prose; a parser that did not would leave the extra issue closed and unaudited,
  which is worse than auditing it and saying so.
- **Making it a discipline** — "do not write a closing keyword in prose" — is a rule held
  by care, and this repository has already measured that care does not hold a parser
  reading prose.

What was actually silent is that `ci/scope-check.mts` printed the merged glob list and
never the issue numbers behind it, so a widened run and a correct run produced identical
output. Both incidents were found by a person reading a diff, not by the check. Stating
the count with its sources is what makes them different, and the warning is what makes
the difference legible without reading the glob list twice.

The declaration form is the one every well-formed body in this repository already has:
`docs/workflow.md` and `skills/issue-and-pr/SKILL.md` have always asked for `Closes #N` at
the top and have always allowed several issues. Measured before landing over all 178
merged pull requests of this repository, exactly **one** would warn — #440 — and it is a
true positive. A form that cannot be produced by accident in ordinary prose is one that is
positional and exclusive at once: a sentence has to be the first thing in the body, and the
whole of its line, before it counts.

## Cost accepted

- **A third `**REPORTED, not failed**` block on a green check.** Item 0029 already accepted
  one and named the hazard: a reader who has stopped twice at a bold line on a passing
  check stops reading the section. This adds a second such block, on roughly a third of
  landings rather than on the rare inherited file — measured, 28 of the last 80. That is
  the real cost of this item and nothing here mitigates it beyond the wording. If the band
  is turned down later, this bullet is the reason and the numbers above are the data.
- **A threshold to argue about.** 50 is defended by a measurement of this repository's own
  landings, which is a measurement of *this* tree at *this* size. An adopting repository
  with different file sizes inherits the number without the argument. `FILE_LINE_LIMIT` has
  the same property and has never been made configurable; this follows it rather than
  opening a second configuration surface.
- **A verdict moves, and it is the only one this item moves deliberately.** A pull request
  whose head is over `FILE_LINE_LIMIT`, whose merge base is shorter and whose base tip is
  longer used to pass and now fails. That is the #290 shape and the failure is correct, but
  it is a pull request that would have landed and now will not. It is unreachable on this
  tree today: no tracked file is over 800 at `38bff59` — `scripts/reconcile.mts` sits at
  exactly 800 and nothing is above it — so the over-limit path is not reached by any live
  pull request, and the flip is demonstrable only by fixture. That is a statement about
  today's tree, not a guarantee.
- **`git merge-base` is a new way for the check to refuse.** It fails closed, so a checkout
  too shallow to hold both commits now fails `scope` rather than measuring against the
  wrong history. This repository's workflow sets `fetch-depth: 0`; an adopting repository
  that did not would meet the refusal, by name, with the cause in the message.
- **Four more keys in the check's JSON** — `audited`, `measuredBase`, `approaching` and,
  when non-empty, `incidentalLinks`. A consumer that enumerates keys sees them.
- **A body that is merely discursive now draws a warning.** One merged body of 178 would,
  and it is a true positive, but the rule is stated over future bodies and not over past
  ones. A body that names an earlier pull request's closed issue in prose is good writing
  and will be warned about; the remedy is a backtick, which costs one character and is
  already what the cards ask for a quoted example.
- **`stripCode` changed shape.** The issue numbers it yields are unchanged over all 178
  merged bodies, measured before landing, and the change is a tightening. It is still a
  parser that behaves differently than it did.

## Supersedes

Nothing. This item **stands beside item 0029** and does not replace it. Everything 0029
put in force stays in force: the four length relations it named keep their names and their
meanings, `pushed-over` is still the only one that fails, and the inherited report is
untouched. What this item adds is a fifth name below them and a report of its own.

It answers 0029 rather than superseding it. 0029 declined the approach report with a
reason — a different rule, a threshold to argue, a warning on every large file — and this
item accepts all three and pays them: the threshold is argued from measurement above and
the noise is written down under **Cost accepted**. Supersession would in any case be
unavailable here and it is worth saying why: it is written on both sides in one diff
([`README.md`](README.md), "The three statuses"), and `docs/decisions/0029-*.md` is not in
#413's `## Files`. The argument does not need it.

## Updates

*(none yet)*
