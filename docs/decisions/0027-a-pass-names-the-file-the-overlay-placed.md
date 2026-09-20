# 0027. A `negative-control` pass names the file the overlay placed

Status: proposed
Date: 2026-09-19

Landed with #354 (this pull request), which implements the rule below in the same diff. It
is written here rather than left in that pull request's body because it changes **what
makes a required check pass or fail** — `negative-control` gains a verdict,
`unattributed`, that did not exist, and a red that used to be a `pass` can now be a
refusal — and "a check, or what makes one pass or fail" is one of the five categories
[`README.md`](README.md) lists. The grant for this path was missing rather than withheld:
`scope` printed its `decisionNudge` for three rounds while the implementer declined to
widen its own globs, and the orchestrator issued the path once the gap was named.

This item lands `proposed`, like every dated item since 0021. The orchestrator granted the
`docs/decisions/` paths this pull request touches (#354, `## Files`, 2026-09-19) and that
grant is a grant of scope, not an acceptance: [`README.md`](README.md) ("Silence never
accepts") reserves `accepted` to an explicit written OK from the person running the loop,
and no such OK exists for this item. The pull request that flips this line will cite where
that OK was written.

## Decision

**A `negative-control` `pass` requires that at least one failure in the overlaid run be
attributable to a file the overlay placed. A non-zero exit with no such failure is
`unattributed` — a named refusal, not a pass and not `vacuous`.**

What is in force, as `ci/negative-control.mts` implements it:

- **The evidence is ranked, not matched.** Two tiers. A failure is **owned** when it says
  which file it belongs to and that file is overlaid: a source location (`<path>:<line>`,
  or a `file://` URL) anywhere in its diagnostic block, or the name carrying its own
  non-zero count on the same line (`land.test.mts: 61 passed, 14 failed`). A failure is
  **mentioned** when the line merely contains an overlaid path anywhere.
- **A mention is believed until something better contradicts it.** When the only overlaid
  evidence is a mention *and* some other file is reported as owning a red, the verdict is
  `unattributed`. With nothing contradicting it, a mention still passes.
- **`unattributed` fails the check** (exit 1), names the failures the run did report, and
  prints the two-argument invocation that reproduces it.
- **A `pass` whose run also carries a red owned by another file stays a `pass`**, with a
  `warning:` naming that red. Only a failure line carrying a file-shaped token *and* a
  non-zero count may be called another file's red; a bare `FAIL <case name>` names no file
  and an aggregate names the suite.
- **The structural path is unchanged in shape.** `structuralInOverlay` already required an
  overlaid path, so a vouched structural red is attributed by construction and the
  `test(red):` vouch of item 21 still decides it.

## Reason

### Why the check needed this at all

`negative-control` decided a real pass by asking whether the overlaid run exited non-zero.
It never asked whether any failure in that run named a file the overlay placed. So any red
— a flake, a regression already on the base, a rate limit — was read as "the tests bite".

Observed, not hypothesised. Run `35405433899`, job `105794181719`, on #349 at head
`594481b`: the pristine base was green (`2398 passed, 0 failed`), the overlaid run was red
(`2397 passed, 1 failed`), and the one failure was in `tests/negative-control.test.mts` —
the control's own unit test, failing inside the run the control spawned, named by neither
overlaid file. Both overlaid files reported `0 failed`. The control printed `pass`. The
honest verdict was `vacuous`, which two hand runs reported.

A control that can be configured into silence becomes decoration. A control that accepts
any red as its own becomes a rubber stamp, and that is worse, because it reports `pass` and
nobody looks again.

### Why `unattributed` is not `vacuous`

This is the part that makes the rest legible, so it is written out rather than assumed.

`vacuous` means **nothing depended on the change**: the overlay ran on the base and passed,
so the tests prove nothing about the code the pull request touches. The remedy is to write
a test that bites.

`unattributed` means **something else was already broken**: the overlay may well bite, but
this run could not tell, because the red it produced belongs to a file the overlay did not
place. The remedy is to fix or quarantine that other red and run it again — and it is a
remedy that belongs to a different file, often a different pull request, sometimes a
different person.

Collapsing the two would send every operator to the wrong place. An implementer reading
`vacuous` goes and strengthens a test that may already be perfectly good; the unrelated red
stays on the base, and the next pull request inherits it. Two verdicts cost one word in the
vocabulary and save that round trip every time the base is not clean. The check already
distinguishes `inconclusive` (the *baseline* was red) from both; `unattributed` is the same
distinction one step later, for a baseline that was green and an overlaid run that was not.

### Why the attribution is ranked rather than strict

This is the decision. The obvious rule is strict: attribute only on an **owned** failure —
a source location, or a name carrying its own count — and refuse everything else. It is
simpler, it has no tiers, and it closes a hole that ranking leaves open (below). It was
proposed in review and it was **measured before being declined**, by patching it into a
copy of the script and running real runner output through both.

What the strict rule costs:

| runner and invocation | owned? | strict rule | ranked rule (in force) |
|---|---|---|---|
| this repository's `tests/run.mts` | yes | `pass` | `pass` |
| `pytest`, default long traceback | yes | `pass` | `pass` |
| `pytest -q --tb=no` (summary only) | no | **`unattributed`** | `pass` |
| `jest` default reporter | no | **`unattributed`** | `pass` |

`jest`'s default reporter prints `FAIL src/x.test.ts` and a code frame: a path, no count,
no source location. Under the strict rule an honest jest red becomes a refusal — **a false
refusal of correct work in every adopting repository using jest**, which is a worse failure
than the false pass being fixed, because it fires on work that is right rather than on work
that is unproven.

`pytest` is in the table because an earlier draft of this argument named it alongside jest
and was wrong: its default long traceback prints `tests/test_x.py:5: AssertionError` with
no blank line before the `short test summary info` banner, so the location and the `FAILED`
line share one diagnostic block and the source-location read finds it. Default pytest would
have survived the strict rule. The argument rests on jest, and on pytest's summary-only
shape, and on nothing wider than that.

The ranked rule keeps those runners passing and still closes the case that matters: the run
that says `pass` while reporting that its only owned red belongs elsewhere. That
contradiction is now unreachable.

### What ranking does not close

A prose mention with **no** contradicting owner still attributes. A test case whose own
*name* quotes an overlaid path — this repository writes nineteen, and eight more in
`tests/run.test.mts` begin `run.mts ` while `tests/run.mts` is itself overlaid by
`**/tests/**` — is read as that file failing. Closing it needs a rule that separates a
marker's subject from a path inside a sentence, and textually those are the same line.
Tracked as #380, with a demonstration. This item is narrower than the "any red" it
replaces and not a claim that the question is settled.

## Cost accepted

- **A verdict a runner that reports nothing cannot earn.** A test command that exits
  non-zero in silence now reports `unattributed`, because there is nothing to attribute.
  That is a real cost for an adopting repository whose command says only `exit 1`, and the
  detail says so and names the remedy — report the failures, or let a thrown error name the
  file in its stack. This repository's own fixtures were changed to the throwing shape
  `skills/safe-worktree/SKILL.md` §B7 already prescribed.
- **Two tiers instead of one rule.** `owned` and `mentioned` are more to hold in the head
  than "names an overlaid file". The measurement above is why the simpler rule was not
  taken; the tiers exist to avoid refusing honest work.
- **Basename matching, with its own exposure.** Attribution matches the repository path and
  the file's basename, because a runner spawning one process per test file prints the
  basename. It is a substring match, so a same-named file elsewhere in the tree, and a
  prose mention, can both credit the overlay. The path form alone missed nearly every
  honest red this repository has produced, which was the worse error. The same widened list
  is shared with `structuralInOverlay`, which is a behaviour change there and not a neutral
  one: a block naming only a basename beside `Cannot find module` now reads `structural`
  where it read `pass`. That direction fails closed.
- **A `pass` can now carry a warning that is noise in one known shape.** A negative-control
  fixture running *inside* the negative control echoes its own inner runner's output into
  the outer log, and those lines are read as another file's reds. Six of them appear on this
  pull request's own run. A warning is not a verdict, and teaching the check to recognise
  its own echo is more cleverness than it is worth.

## Supersedes

Nothing. Item 21 (the gate does not exempt its own installed code) and the
`structuralInOverlay` discrimination written for #214 both stand unchanged; this item adds
the same discrimination one level up, where the pass is decided.

## Updates

*2026-09-20 (#412, #436):* the last sentence of the third bullet under "Cost accepted" no
longer holds. A block naming only a basename beside `Cannot find module` is no longer read
as `structural`: `structuralInOverlay` (now `ci/lib/attribution.mts`) requires a line that
owns the signature, and that direction was failing closed onto honest work rather than onto
a dishonest pass — item 34 records the rule and the transition it costs. Everything else
here stands: `owned`/`mentioned`, the basename widening and `attributeFailures` itself are
unchanged.
