# 0028. A diff the overlay carries whole is proved by nothing, and passes

Status: proposed
Date: 2026-09-19

Landed with #384, which implements the rule below in the same diff. It is written here
rather than left in that pull request's body because it changes **what makes a required
check pass or fail** — `negative-control` gains a verdict, `test-only`, and a diff that
was a refusal is now a pass — and "a check, or what makes one pass or fail" is one of the
five categories [`README.md`](README.md) lists. It is the second item in as many hours on
the same mechanism: [item 27](0027-a-pass-names-the-file-the-overlay-placed.md) refused a
red the overlay did not earn; this one stops refusing a change the overlay cannot judge.
The orchestrator granted this path and [`README.md`](README.md) on #355 (`## Files`,
2026-09-19), one glob per grant line.

This item lands `proposed`, like every dated item since 0021. That grant is a grant of
scope, not an acceptance: [`README.md`](README.md) ("Silence never accepts") reserves
`accepted` to an explicit written OK from the person running the loop, and no such OK
exists for this item. The pull request that flips this line will cite where that OK was
written.

## Decision

**A `negative-control` run whose overlay withheld nothing the diff changes is
`test-only`, and `test-only` passes the check.** It is not `vacuous`: the overlay had no
red available to it, so there is nothing for an implementer to clear.

What is in force, as `ci/negative-control.mts` implements it:

- **The class is two facts, both read off `git diff`.** Two module-level constants in
  `ci/negative-control.mts`, computed from `changed` beside `declaredPaths`: `withheld` is
  the changed files the overlay did not carry, `notATestFile` the changed files that are
  not test files. `runOnBase` reads both in its **first** branch on the overlaid run's
  exit 0, the one ahead of the `vacuous` return: the verdict fires only when that run
  exited 0 **and** both lists are empty.
- **The second fact is read from `TEST_FILE_GLOBS` as written in the file**, the constant
  `ci/negative-control.mts` declares beside `SKIP_PATH_GLOBS` and `NEVER_SKIP_GLOBS` —
  *not* as extended by `AGENTIC_TEST_GLOBS`, and *not*
  as replaced by a branch's `proof/<slug>.json` `tests` list. Those two decide what is
  **overlaid** and deliberately do not decide the **class**. The declaration's own path is
  the one addition, because a branch that declares its proof has still changed nothing but
  tests.
- **Nothing a pull request writes is read.** No label, no body flag, no path convention,
  no commit subject. A branch cannot claim this class; it can only be in it.
- **`test-only` joins `skipped` and `pass` in the `ok` disjunction of `finish`**, the one
  expression in `ci/negative-control.mts` that decides the exit status, so the check exits
  0 and `scripts/land.mts` reads its bucket as `pass`.
- **It is a third green, and the three say different things.** `vacuous`: *nothing
  depended on the change* — cleared by writing a test that bites. `unattributed` (item
  27): *something else was already broken* — cleared by fixing that other red.
  `test-only`: *nothing could have depended on the change* — cleared by nothing, because
  there is nothing to clear. The detail says what would put the diff back inside the
  control: one file outside the test globs.
- **`vacuous` now names why it is not `test-only`**, listing the files the overlay
  withheld or that sit outside the globs.

## Reason

### The overlay is a comparison, and a test-only diff removes the other side

`negative-control` checks out the base, overlays head's test files and requires that run
to fail. What makes a red available to it is the part of the diff it **withholds**. When
the diff is nothing but test files, the overlay withholds nothing: the second run is the
pull request's own suite with no part of its change absent for a test to bite on.
Requiring it to fail is requiring the pull request's own tests to fail, which is a
required check no work can clear.

Measured on the pull request the issue was opened for. #348 is one file,
`tests/adopt-record.test.mts`. Against the base and head CI used
(`1ddc867`…`084ed63`), by hand:

| | verdict | exit | baseline | overlaid |
|---|---|---|---|---|
| before | `vacuous` | 1 | `2398 passed, 0 failed` | `2411 passed, 0 failed`, `adopt-record.test.mts: 117 passed, 0 failed` |
| after | `test-only` | 0 | `2398 passed, 0 failed` | `2411 passed, 0 failed`, `adopt-record.test.mts: 117 passed, 0 failed` |

The overlaid run is *greener* than the baseline — 117 cases against 104 — which is the
shape of this class: the change arrives whole and adds only passes.

### The case has never been allowed to occur, which bounds what this can break

This is not a control mishandling a common case. **No pull request confined to the test
globs has ever landed on this repository's `main`**: 150 first-parent commits were walked
against `TEST_FILE_GLOBS` and not one is confined to them. #348 is the first to try, and
it has been held since 2026-09-18 on `vacuous` rather than on merit — its work was
verified independently against the TypeScript compiler's own comment ranges on all 82
`.mts` files of the tree.

So the population this decision changes the verdict for is, to date, empty. Everything
that has ever landed here keeps the verdict it had.

### Why the class is read from the globs as written, and not from the knobs

This is the decision. The obvious implementation asks "was every changed file overlaid?",
which is one condition instead of two, and it is wrong in a way that matters: the overlay
set is `AGENTIC_TEST_GLOBS`-extended and `proof/<slug>.json`-replaceable. Under the
one-condition rule, a repository variable naming `**` — or an implementer's own
declaration listing a production file under `"tests"` — would make every diff
"overlaid whole" and buy a pass for it.

Today both of those fail **closed**: widen `AGENTIC_TEST_GLOBS` and the overlaid tree
holds the whole change, the run passes, and the verdict is `vacuous` — a refusal. So
admitting them to the class would not have preserved an existing escape, it would have
opened a new one, on the one check that asks whether a change is proved at all. Two cases
pin both routes shut (`tests/negative-control.test.mts`), and they are green before this
change as well as after: a pin that only passes afterwards is not guarding anything.

The remaining way to claim the class is to move production code under `tests/`. That is
self-limiting rather than closed by a rule: the moved file's importers sit outside the
test globs, so they enter the diff, `notATestFile` is non-empty, and the class re-opens.
Code that genuinely has no importer outside the test tree is test machinery.

### Why a pass and not a refusal

The issue asked for the choice to be stated either way. A refusal was not available: an
implementer facing `test-only` has nothing to do. Every route out is closed and closed for
its own reason — `TEST_FILE_GLOBS` includes `**/tests/**`, so extracting the machinery to
`tests/lib/` overlays it too; moving it to `ci/lib/` makes the base's import unresolvable
and is correctly refused as `structural`; `proof/<slug>.json` runs both passes in the base
worktree with the overlay applied; `AGENTIC_SKIP_GLOBS` silences by configuration, which
is how a control becomes decoration. A gate that refuses what it cannot judge refuses
forever.

The escape this repository already uses is not available either. A case asserting on a
file the overlay does **not** carry gives a real red —
`tests/provenance.test.mts` did exactly that in `9be1b1b` and #376, asserting on
`docs/closeout/**`. It needs a non-test file in the diff to bite on, which a test-only
diff has none of by definition. That escape belongs to a **mixed** diff and is not the
mechanism for this class.

What carries the weight instead, since this control is the only gate that asks whether a
change is proved at all:

- **no file outside the test globs changed**, so there is no unproved production change
  for it to hold — structural, not a claim;
- **the overlaid run is the pull request's own suite**, which is the `test` check's
  business, and this verdict is only ever reached after that run came back green, so it
  reports what was measured;
- **`scope`** still holds those test paths to the linked issue's globs;
- **the reviewer** holds whether the change strengthens or weakens the suite.

## Cost accepted

- **A test-only diff that weakens the suite now passes this check, deletion included.**
  This is the cost, and it is the one worth writing down. A pull request that deletes a
  test file changes only paths in the test globs; the overlay replays the deletion on the
  base, the run passes, and the verdict is `test-only`. The same holds for gutting
  `tests/run.mts` into `process.exit(0)`, or for quietly dropping assertions from a file
  while leaving it in place. Before this item those diffs were blocked — **by accident,
  not by design**: `vacuous` refused them because it refuses *every* test-only diff, and
  the same accident blocked every honest test-only change, which is the defect this item
  exists for. The block was never a judgement about weakening, and the control could not
  have made one: the overlay carries the weakening with it either way, and it does not
  catch the same weakening in a mixed diff today. The judgement moves, undiminished but
  now unassisted, to the reviewer's checklist, and nothing automated replaces it. Anyone
  reading this item for the improvement should read this paragraph for what it was bought
  with.
- **A third green in the vocabulary.** `pass`, `skipped` and now `test-only` all exit 0,
  and `vacuous`, `unattributed`, `structural`, `no-tests`, `cannot-run` and
  `inconclusive` all exit 1. Nine outcomes is more than a reader holds at once, and three
  of them are about a run that produced no attributable red. The wording of each states
  what would have to be true for a pass; that is the whole of the mitigation.
- **Two full suite runs for a verdict decided at the end.** The class is knowable from
  `git diff` before any worktree is made, so a test-only pull request could be answered in
  a second. Deciding early was declined: it would lose `inconclusive` on a base that
  cannot run its own tests, and the verdict would then be asserted rather than measured.
  A test-only pull request pays for both runs.
- **The gap this leaves in the cards, deliberately.** `agents/implementer.md` and
  `skills/issue-and-pr/SKILL.md` both enumerate the verdicts and neither names
  `test-only`; five open issues claim those two files, and the sweep is #379, widened to
  cover this verdict and item 27's. Between #384 landing and that sweep landing, the check
  returns a verdict its own cards do not name. The orchestrator accepted that knowingly on
  #355, for a shorter interval than the sequencing would have cost.

## Supersedes

Nothing. Item 21 (the gate does not exempt its own installed code) and item 27 (a pass
names the file the overlay placed) both stand unchanged. Item 27 refused a red the overlay
did not earn; this item stops refusing a change the overlay cannot judge. They are the two
sides of the same reading — that a non-zero exit is not by itself evidence, and that a
zero exit is not by itself a failure to prove.

## Updates

*2026-09-20 (#412, #436):* `SKIP_PATH_GLOBS`, named here as a constant
`ci/negative-control.mts` declares, has moved to `ci/lib/skip-paths.mts` and is imported by
that file and by `scripts/land.mts`. `NEVER_SKIP_GLOBS` is unmoved. The decision is
unchanged; only where one of the constants it cites is declared.
