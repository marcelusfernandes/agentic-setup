# 0029. A file over the line limit is reported, not silently exempt

Status: proposed
Date: 2026-09-19

Landed with #310, which implements the rule below in the same diff. It is written here
rather than left in that pull request's body because it changes **what a required check
reports**, and "a check, or what makes one pass or fail" is one of the five categories
[`README.md`](README.md) lists. The orchestrator granted this path and
[`README.md`](README.md) on #310 (`## Files`, 2026-09-19), one glob per grant line.

This item lands `proposed`, like every dated item since 0021. That grant is a grant of
scope, not an acceptance: [`README.md`](README.md) ("Silence never accepts") reserves
`accepted` to an explicit written OK from the person running the loop, and no such OK
exists for this item. The pull request that flips this line will cite where that OK was
written.

This item names symbols rather than `file:line` citations. Four line citations written
into this register on 2026-09-18 were stale inside a day; a symbol a reader can `git
grep` outlives the line it sits on.

## Decision

**A file over `FILE_LINE_LIMIT` at the head of a pull request is named by `scope`,
whether or not that pull request lengthened it. Only the length the pull request itself
added fails the check.**

What is in force, as `ci/lib/scope.mts` and `ci/scope-check.mts` implement it:

- **Four length relations, four names, decided in one place.** `lengthOutcome` in
  `ci/lib/scope.mts` answers for one file: `exempt-generated` (`@generated` on the first
  line, whatever the length), `under-limit` (at or below `FILE_LINE_LIMIT` at the head),
  `pushed-over` (over the limit at the head and longer than at the base, or new at head
  and landing over it), `inherited-over` (over the limit at the head, and the base was at
  least as long). Every caller reads that one answer, so the two halves of the old
  condition cannot drift apart.
- **`pushed-over` fails; `inherited-over` is reported.** `fileGrowth` selects
  `pushed-over` and `inheritedOverLimit` selects `inherited-over`; `ci/scope-check.mts`
  folds only `fileGrowth` into the expression that decides its exit status. An
  `inherited-over` file appears in the check's JSON under a new `inherited` key and in
  the job summary under `### Already over the line limit`, and the check still exits 0.
- **The two messages are different sentences, on purpose.** The failing section says this
  pull request *took* N file(s) past the limit and gives each file's base and head
  counts. The reported section says the file *was already over at the base*, states the
  exit code is unchanged, and says what closes it: a pull request that brings the file
  back under the limit. A reader who sees one must not be able to mistake it for the
  other.
- **The reported case names its own cure because nothing else will.** Until some pull
  request shortens the file, the message repeats on every pull request that touches it.
- **Nothing a pull request writes moves a file between the two.** No label, no body line,
  no `authorised:` grant, no commit subject. The classification is two numbers and the
  first line of the file.

**What does not change: the condition that fails.** `pushed-over` is the old predicate
verbatim — over `FILE_LINE_LIMIT` at the head, and longer than the base or new at head.
No pull request that passed `scope` before this item would fail it after, and none that
failed would pass. This item is a change to what the check **says**, not to what it
**refuses**. Anyone reading it as a tightening is reading it wrong; the tightening
available here was declined, and the last section of **Reason** says why.

## Reason

### The exemption was permanent, and it was silent

`fileGrowth` flagged a file only when the head was **both** over `FILE_LINE_LIMIT`
**and** longer than the base. The second condition is defensible for the case it was
written for: a pull request should not be blamed for a file someone else made too long.
But read against a file that has already crossed, it means nobody is ever blamed. The
file stays over, every later change to it is exempt, and the invariant stops applying to
exactly the files that have already broken it.

It was silent as well as permanent, which is the half this item fixes. The check printed
nothing for that file, so the only way to learn the situation was to count the lines by
hand. Measured: `tests/init.test.mts` stood at 808 lines on `main` and failed nothing.
The implementer of #229 found it by measuring the file before adding a case and reported
that its budget for new lines was **zero** rather than small — which is not what "under
800 lines" reads as to anyone planning work — and had to split the file into
`tests/init-rules.test.mts` to get room. That file's header still records the reason.

### How `tests/init.test.mts` crossed 800, and what the answer decides

Traced commit by commit with a line count of the file at each (`git log --follow`, then
`git show <commit>:tests/init.test.mts`). The crossing is a single step, 798 to 808, at
the squash commit of **#290**, merged 2026-09-18. The rule was not missing: it has been
in `ci/lib/scope.mts` since #138 (2026-09-12) and was fully wired into `ci/scope-check.mts`
at that very commit, which the checked-out tree at the merge confirms.

The check did not fail because **no head of that pull request was ever over 800**:

| ref | `tests/init.test.mts` |
|---|---|
| merge base of the branch and `main` | 785 |
| head of #290, the commit CI judged | 795 |
| base sha CI was handed, the tip of `main` | 798 |
| the squash commit that landed | 808 |

`scope` reads the head's line count first and stops there when it is at or below the
limit. At 795 it stopped, correctly. In parallel, `main` had taken the same file from 785
to 798 through #283. The squash replayed the branch's own +10 on top of that 798 and
produced 808, and nothing re-read the file afterwards: `agentic-checks` runs on
`pull_request` only, so the merge result is never measured.

So the answer the issue asked for is: **a gap in when the rule runs, not a gap in the
rule.** The rule became a gap in the rule only afterwards, once 808 was on `main` — from
that moment `headLines <= baseLines` exempted the file from every later pull request, and
that second gap is the one this item closes.

### What this does not close, and two things found on the way

Stated plainly so nobody reads this item as more than it is.

- **This change would not have caught #290.** That pull request's head was 795, which is
  `under-limit` under the new classifier exactly as it was under the old condition. What
  crossed the limit was the merge result, and no pull-request check ever sees it. Closing
  that needs a check on `main` after the merge, or a growth comparison against the merge
  result rather than the head. Neither is in this issue's `## Files`; both are the
  orchestrator's to open.
- **`scope` mixes two base references in the same rule.** The changed-file list comes from
  a three-dot `git diff`, which resolves to the merge base, while the base line count is
  read from the base **tip**. On #290 those were different commits, and a branch that had
  added 10 lines to the file was measured as having removed 3. It cannot produce a false
  *failure* — the head count decides that alone — but it makes the reported base number
  the wrong one whenever `main` has moved. Also outside this issue, also the
  orchestrator's to open.

### Why reporting, and not failing

Failing the inherited case was available and was declined. It would make an unrelated
pull request answerable for a file it did not lengthen, which is the exact harm the
original exemption exists to prevent, and the pull request's only route out would be to
split somebody else's file inside a diff that has nothing to do with it. That is how a
required check becomes something to route around.

Reporting keeps the exemption and removes what was wrong with it, which was never the
exemption itself but its silence. The judgement — is this file worth splitting now, by
whom, in which issue — stays with the reviewer and with whoever plans the work, and they
now have the fact in front of them instead of having to count lines to find it.

## Cost accepted

- **An inherited over-limit file now produces a message on every pull request that
  touches it, including ones that shorten it.** This is the cost, and it is the one worth
  writing down. A pull request that takes a 900-line file to 850 — real, useful work in
  the right direction — still gets the section, because 850 is still over 800 and the
  check has no way to reward partial progress that would not also reward standing still.
  On a file nobody splits, the message is permanent noise on every diff that goes near
  it, and noise on a green check is read once and skipped afterwards. Nothing in this
  item mitigates that beyond the sentence naming what closes it. The honest form of the
  mitigation is that the message is supposed to be annoying enough to get the file split,
  and if it is not, this item bought a line of text.
- **A green check that carries a bolded refusal-shaped line.** `**REPORTED, not failed**`
  sits in the same job summary as `**FAILED**`, under a heading of the same shape. A
  reader scanning for bold will stop at it, and a reader who has stopped at it twice on
  pull requests that passed will stop reading the section. The wording is the whole of
  the defence.
- **The failing section's wording changed.** It read "new or grown past 800 lines" and
  now reads "this pull request took N file(s) past 800 lines", because the two sections
  had to be distinguishable by sentence and not only by heading. Anything outside this
  repository that matched the old string matches nothing now. Nothing in the tree did,
  which is why the change was cheap here and may not be in an adopting repository that
  grepped the summary.
- **One more key in the check's JSON.** `inherited` is always present, empty on a run
  with no base and head. A consumer that enumerates the keys sees a new one.

## Supersedes

Nothing. The 800-line rule of #134 stands, and its `@generated` exemption is untouched.
This item names a case that rule always had and never spoke about.

## Updates

*(none yet)*
