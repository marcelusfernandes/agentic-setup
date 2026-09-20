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
  ``clo`X`ses #1`` no longer reads as `closes #1` and links nothing. The splice can no
  longer invent a keyword (invariant 5), and `tests/scope-linked.test.mts` holds that
  exact prose as a case that is red on the base.

  **What the inline pattern does not do, because a draft of this change made it do it
  and was wrong.** It still crosses newlines, as it always did. An earlier draft
  excluded `\n` from it and described that as a second tightening; it was a loosening,
  and in the direction a gate must never loosen. A span written across a line break
  stopped being a span, so a body reading ``See `git log⏎closes #5` `` linked #5 where
  the base linked nothing, and `scope` would have unioned another issue's globs into its
  audit because a quotation happened to wrap. CommonMark allows an inline span to cross
  a line, so the base's reading was the correct one and the exclusion was a markdown bug
  rather than a policy. It is named here, in the item rather than only in a commit,
  because the draft of this item asserted the opposite — that the change was two
  tightenings — and an item is what the next agent reads *instead of* measuring. The
  sentence was false on its own date, so it is corrected in the body, which is what
  [`README.md`](README.md) ("Correcting an item that is already written") prescribes for
  a statement that was never true rather than one the ground moved under.
  `tests/scope-linked.test.mts` holds the wrapped-span case as a regression guard, green
  on the base on purpose, so the next edit to that pattern reds instead of widening the
  gate in silence.

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
  warning.** The method is stated first, because an earlier draft of this bullet measured
  a narrower set of files and reported figures that do not reproduce: population is the
  eighty most recent **first-parent** landings on `main` at `38bff59`; one observation per
  changed `.mts`/`.md` file that existed at that landing's parent with **700 lines or
  more**; growth is head minus parent. That gives **36 observations**, of which 23 grew at
  all, **12 grew by more than 20 lines and 4 by more than 50**. A band of B gives no
  warning where growth exceeds B, because the file crosses from outside the band in one
  landing: **band 20 misses 33%, band 50 misses 11%.**
- **The cost runs the other way, and it runs flat.** Of the same eighty landings, 17
  touched a file standing at 795 or above at their head, 20 at 790, 24 at 780, 26 at 770,
  28 at 750. Moving from 780 to 750 buys **twenty-two points of coverage for five points
  of noise**. Below 750 the curve is flat for a different reason — nothing in this tree
  sits between 750 and 770 — so a wider band would cost nothing today and would cost on a
  tree that is not this one.
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
number — and it has **four** reachable shapes, not two, because the base side of the
comparison can be *absent* as well as different. An earlier draft of this item said two;
that was a statement about the fixtures that had been written, not about the code, and it
was false on its own date. All four are pinned in `tests/scope-line-limit.test.mts` with
their verdicts, not only their counts:

| what `main` does | what the branch does | against the base tip | against the merge base |
|---|---|---|---|
| lengthens the file past the head (785 → 815) | 785 → 810 | `inherited-over`, passes | **`pushed-over`, fails** |
| shortens it below the head (900 → 840) | 900 → 850 | **`pushed-over`, fails** | `inherited-over`, passes |
| **deletes** it (900 → absent) | 900 → 850 | **new at head, `pushed-over`, fails** | `inherited-over`, passes |
| **adds** it (absent → 900) | absent → 850 | `inherited-over`, passes | **new at head, `pushed-over`, fails** |

Two of the four have the base **refusing** a branch that shortened a file or left it
alone, and those are the ones worth naming twice: a check that wrongly fails loudly gets
argued with, and a check that wrongly refuses honest work gets routed around, so nobody
reports it. The fourth is the only shape where the base lets something through — a branch
that creates an 850-line file reads as having shortened somebody else's.

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
- **A file can jump into the band and past it in one landing, and the report says nothing
  first.** The band warns the pull request *after* the one that used the room, not the one
  that used it. Measured on this tree: #360 took `scripts/reconcile.mts` from 743 to
  exactly 800 in a single landing, and #437 took `tests/close-milestone.test.mts` from 650
  to 798. No band narrower than 60 and 150 respectively would have spoken before either,
  and a band that wide is a warning on most of the suite. This report is a floor under the
  silence, not a guarantee of notice; what it does buy is that the landing after each of
  those two is told, which is the case #229 and #310 both met by counting lines by hand.
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
  merged bodies, measured before landing. It is a correction that runs both ways rather
  than a tightening: it removes a link the splice invented and reveals one the splice hid,
  both towards what GitHub does. It is still a parser that behaves differently than it
  did.
- **A measurement over merged bodies did not catch the one thing that went wrong with
  it.** All 178 agreed either side of the newline-excluding draft, and that draft widened
  the gate. The corpus was real and the inference from it was not: no merged body of this
  repository happens to carry a closing keyword inside a wrapped code span, so agreement
  across it was evidence about those bodies and not about the parser. What caught it was
  a reviewer enumerating what the *pattern* could match, and the lesson is written down
  here rather than in a pull request because it generalises past this one: a corpus can
  only falsify, and a parser change needs a case built from the rule it changed, not only
  a replay of what has already been written.

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
