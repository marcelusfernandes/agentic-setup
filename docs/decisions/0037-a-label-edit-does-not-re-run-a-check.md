# 0037. A label edit does not re-run a check whose verdict cannot depend on a label

Status: proposed
Date: 2026-10-02

Landed with #424, which consolidated #347 and #383. Written here rather than left in that
pull request's body because it changes **when a required CI job runs**, which
[`README.md`](README.md)'s first list calls a decision — *"a **check** — a required CI
job, or what makes one pass or fail"*, the first clause and not only the second. It also
obliged an update to `skills/orchestrate/SKILL.md` and `docs/orchestration.md` in the same
diff, and the same file's clause makes that a decision on its own: *"If a change obliges
that doc update, it is a decision, and the decision is part of the same PR."*

The consolidation's other half — the pin that holds the two copies of the workflow
together — contributes no rule and is **not** in this item. It is a measured fact about how
the code already behaves with no change of contract, which [`README.md`](README.md)'s
**What stays a note** section puts in the pull request body. It is there.

This item lands `proposed`, like every dated item since 0021. [`README.md`](README.md)
("Silence never accepts") reserves `accepted` to an explicit written OK from the person
running the loop, and no such OK exists for this item.

Symbols and event names rather than `file:line` citations, for the reason item 0029 gives,
and the reason is measured here rather than asserted. The issue carried **fifteen**
`file:line` citations, each measured when it was drafted. Re-measured at `d698b56`, **seven
had drifted and eight had held**, counted as one per cited line or range:

| citation | count | at implementation |
|---|---|---|
| `ci/negative-control.mts:205` — `LEGACY_SKIP_LABELS` | 1 | drifted to `:290` |
| `ci/negative-control.mts:471` — its one read of a label | 1 | drifted to `:416` |
| `ci/negative-control.mts:203-204` — the comment above the constant | 1 | drifted to `:287-289` |
| `ci/issue-lint.mts:376-383` — "reads only open issues into the graph" | 1 | drifted; `:376-383` holds `fixedDirPrefix`, and the read is at `:269` with its comment at `:41` |
| `skills/orchestrate/SKILL.md:373-386` | 1 | drifted to `:380-394` |
| `docs/orchestration.md:470-471` | 1 | drifted to `:506-507` |
| `tests/doctrine.test.mts:363` | 1 | drifted to `:369` |
| `.github/workflows/agentic-checks.yml:9-10`, `:31`, `:33-35`, `:55`, `:78` | 5 | all held |
| `tests/guard-main.test.mts:35-36`, `:42`, `:52` | 3 | all held |

Seven drifted rows of one, and two rows holding five and three: 7 + 8 = 15.

So the claim worth making is narrower than "every citation drifts", and it is made by
listing the files rather than by naming a category they fall into. **The seven that
drifted:** three into `ci/negative-control.mts`, one into `ci/issue-lint.mts`, one into
`skills/orchestrate/SKILL.md`, one into `docs/orchestration.md`, one into
`tests/doctrine.test.mts`. **The eight that held:** five into
`.github/workflows/agentic-checks.yml` — the pair this issue is about — and three into
`tests/guard-main.test.mts`, the test this issue's pin was written from.

The shape is deliberate. This summary was rewritten repeatedly, each time by describing the
table instead of enumerating it, which is why it now enumerates and why the table carries a
`count` column. A category claim over a table can shed a row in silence, because nothing in
the sentence has to add up; an enumeration whose counts sum cannot.

Three of the four file *lengths* the issue recorded had also moved —
`skills/orchestrate/SKILL.md` 670 → 684, `docs/orchestration.md` 552 → 588,
`docs/decisions/README.md` 186 → 212, while `tests/guard-main.test.mts` held at 241.

## Decision

**`agentic-checks.yml` does not run on `labeled` or `unlabeled`.** Its one trigger is

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
```

in both copies — this repository's `.github/workflows/agentic-checks.yml` and the copy
`scripts/init.mts` ships, `templates/.github/workflows/agentic-checks.yml`.

**`edited` stays, and it stays on evidence rather than by omission.** `scope` reads the
pull request body: `parseLinkedIssues` over it decides which issues' `## Files` globs the
run audits, so an edit to the body genuinely can change the verdict, and #347's own second
criterion names two pull requests (#337, #334) that reached six runs each because their
bodies were edited during review. The trigger is a real share of the cost and it buys a
correct answer.

**The consequence an orchestrator must know before it reads step 4 of the card.** Applying
`review:approved` — the label `scripts/land.mts` reads before it merges — no longer
cancels an in-flight check run and no longer starts a fresh one. The ordering rule step 5
of `skills/orchestrate/SKILL.md` used to carry, *"label before the push that starts the
round, not after it"*, is withdrawn by this item: it existed only to sequence around that
cancellation. Step 4's single `gh pr edit` carrying both `type:` and `scope:` is kept for a
smaller reason — one `gh` round trip and one timeline entry instead of two — and not
because it saves a run.

**What is lost, stated rather than discovered later.** `negative-control` reads the pull
request's labels to compute one `note:` line and one clause of its `skipped` message
(`LEGACY_SKIP_LABELS`). Those are now computed from the labels present at the last
`opened`/`synchronize`/`reopened`/`edited` event, so a legacy `type:` label applied after
that event is not named in them. Nothing else changes, because nothing else about either
check reads a label.

## Reason

### Neither check's verdict can depend on a label, and this was measured rather than read

Both halves of the sentence the workflow's header used to carry — *"Both read the PR body
and labels, so they re-run when the PR is edited or relabelled"* — are false.

`scope` reads **no label at all**. `git grep -n "label" -- ci/scope-check.mts
ci/lib/scope.mts` prints nothing and exits 1, and the script has no `--labels` flag and
reads no `labels` field from the event. Run twice against one throwaway repository with
event payloads identical but for `labels` — `[]` against
`[type:docs, review:approved, state:in-review, scope:ci]` — its output is **byte-identical**,
JSON and job summary together.

`negative-control` reads labels, and only to annotate. `LEGACY_SKIP_LABELS` feeds
`legacyLabel`, which reaches exactly two places: a `note:` line, and an `alsoLabelled`
clause appended to a `skipped` message the path classes had already decided. The verdict
itself is `changed.length > 0 && changed.every(inSkippedClass)` — the diff, never the
labels. Run for real against a throwaway repository, with `--labels type:docs` and without:
a code diff is `pass` both ways, a docs-only diff is `skipped` both ways, exit status
identical, and the only differences in the output are the `note:` line and that clause.

The comment above `LEGACY_SKIP_LABELS` already said so in the script: *"Read for one release
only, to print a `note:` and to name the label in a skip the path class already decided.
They never skip on their own."* The header above the trigger list contradicted the code it
was describing.

### It was self-inflicted by the documented procedure, and the procedure is the whole cost

The label that authorises the merge is the one that invalidated the checks the merge waits
on. Reproduced on PR #449 at `ef3f2b7`, from the check-runs API, with nothing constructed:

| check | started | ended | conclusion |
|---|---|---|---|
| `test` | 16:50:28Z | 16:54:08Z | success |
| `negative-control` | 16:50:44Z | 16:51:09Z | cancelled |
| `scope` | 16:50:44Z | 16:50:50Z | success |
| `scope` | 16:51:12Z | 16:51:18Z | success |
| `negative-control` | 16:51:14Z | 16:57:42Z | success |
| *the orchestrator applies `review:approved`* | | | |
| `negative-control` | 17:10:17Z | 17:15:32Z | success |
| `scope` | 17:10:18Z | 17:10:27Z | success |

All three required checks were green and complete at 16:57. `node scripts/land.mts 449`
then refused, correctly and for the wrong reason:
`{"refused":"PR #449: not every required check is in bucket pass.","missing":["checks:required"]}`.
The re-run of `negative-control` cost **5m15s** of wall clock to recompute a verdict whose
input had not changed by a byte.

**`test` did not re-run and the other two did**, which is the asymmetry a reader diagnosing
this from a green `test` would look at the wrong file for. `.github/workflows/test.yml`
declares a bare `pull_request:`, whose default types are `opened`, `synchronize` and
`reopened` — no `edited`, no `labeled`. The `labeled` trigger reached `agentic-checks.yml`
and nothing else.

### The excess is most of the runs, not a rounding error

Over the window #347's own measurement names — workflow runs created 2026-09-18 and
2026-09-19, read from the Actions API and keyed on `head_sha`:

| workflow | runs | distinct head commits | runs per head |
|---|---|---|---|
| `agentic-checks.yml` | 435 | 126 | 3.45 |
| `test.yml` | 166 | 166 | 1.00 |

`test.yml` ran **exactly once per head commit**, over *more* heads than
`agentic-checks.yml` saw — it also runs on `push` to `main`, so it covers the merge
commits. `agentic-checks.yml` ran **309 times on a head some earlier run had already
judged**: 71% of its runs. 205 of its 435 runs ended `cancelled`, which is the
`cancel-in-progress` group killing a run a later event superseded. Only 11 of the 126 heads
got a single run; 19 got six and two got seven.

Those are not the figures #347's comment of 2026-09-19 carried — *"eleven pull requests
… `test` ran 11 times … `scope` and `negative-control` ran 42 each"* — and the issue asked
that they be re-measured if they moved. They did not move; they do not reproduce as
written. 43 pull requests merged in that window, not eleven. The shape of the claim is
right and the asymmetry it reports is real; the numbers above are this item's, measured by
the method stated, and are the ones to cite.

## Cost accepted

- **A label applied after the last real event is not named in `negative-control`'s
  `note:`.** The line exists to tell an author that `type:docs` no longer skips the control
  on its own, and it is a courtesy on a check that has already decided. It will now
  sometimes be absent where it used to appear. The verdict it sits beside is unaffected,
  which is the whole reason this is affordable.
- **A body edit still costs a full re-run of both checks.** `edited` covers the body and the
  title with one activity type; GitHub does not split them, so a title-only edit re-runs
  `negative-control` for nothing. That is a real residual cost — #337 and #334 paid it six
  times each — and it is kept because the alternative is a job-level `if` that skips, and a
  skipped job publishes a *newer* run of the same check name. `gh pr checks` picks the
  survivor by `startedAt` within a name/workflow/event key, so a `skipping` bucket could
  replace a `pass` on the same commit and `land.mts` reads buckets in both of its gates.
  Narrowing `edited` is a separate change with a separate risk, and it is not made here.
- **The `labeled` trigger was load-bearing for one thing and it is gone.** Three dogfood
  reports and a closeout recorded the re-trigger as accepted design
  (`docs/dogfood/2026-09-10.md` L5, `docs/dogfood/2026-09-17.md` D10,
  `docs/closeout/M10.md`). Those are reports of what was true on their dates and are left
  as they are; this item is what a reader consults instead.
- **Prose outside this pull request's `## Files` now describes a mechanism that is gone.**
  `scripts/land.mts` and `scripts/reconcile.mts` each explain their cancelled-run dedupe by
  citing "a label edit re-triggers the workflow and cancels the run in flight (D16)", and
  `docs/decisions.md` item 11's narrative cites a label change re-triggering a required
  check. Every one of those rules is still **correct** — a push re-triggers the workflow
  exactly the same way, and the dedupe is about cancelled runs whatever caused them — but
  the example each one reaches for is now the one case that cannot happen. The pull request
  that landed this item declared neither file and did not widen its own globs (invariant 9);
  it lists them instead.
- **One fewer opportunity for the orchestrator to notice a stale read.** The window
  `docs/orchestration.md` describes — a PR seen green a moment ago with a required check
  back to `IN_PROGRESS` — is narrower now, and the commonest way it opened is closed. It is
  not closed, nothing in `land.mts` rests on it being closed, and a reader who takes this
  item as permission to read check state client-side and merge on it has read it wrong.

## Supersedes

Nothing. No numbered item asserted the re-trigger; it was asserted by
`skills/orchestrate/SKILL.md` step 5 and by `docs/orchestration.md`, which this item's
pull request corrects in place. Both of those were **wrong when they were written** rather
than overtaken: the sentence *"Both read the PR body and labels"* was never true of either
check, and the card called the consequence *"the design, not a bug"* on a premise its own
code contradicted. [`README.md`](README.md) ("Correcting an item that is already written")
prescribes a correction in the body for exactly that case, and that is what was done.

## Updates

*(none yet)*
