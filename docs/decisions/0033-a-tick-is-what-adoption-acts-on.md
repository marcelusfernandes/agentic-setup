# 0033. A tick is what adoption acts on; `human:decided` alone authorises nothing

Status: proposed
Date: 2026-09-19

Landed with #368, which implements the rule below in the same diff. Every claim here
about the code carries the command that produced it, pinned to a commit whose tree cannot
contain this file: `bccb040` for what the code was before, and `92a9db3` — the merge of
`origin/main` into the branch, one commit before this item — for what it is now. A tree
named by a sha is immutable, so neither command can ever see the document it supports.

## Decision

`human:decided` on the adoption plan issue is no longer the whole gate on
`node scripts/adopt.mts --pr`. The label says a person answered; the **ticked checkboxes
of the issue body say what they answered**, and both are required.

1. `--pr` requests the plan issue's `body` and parses its checklist with `parseDecision`
   in `scripts/lib/adopt/decision.mts`. A gap is the **first backticked span** of a
   `- [x] …` line; the prose after it is never read. `[X]` is a tick, `*` is as good a
   bullet as `-`, a checkbox whose gap name is not backticked contributes nothing, and a
   gap name this version does not recognise is carried through to the record of the
   decision rather than refused.

   ```
   $ git grep -n "number,title,state,labels" bccb040 -- scripts
   bccb040:scripts/lib/adopt/pr-run.mts:124:    '--state', 'all', '--limit', '100', '--json', 'number,title,state,labels',

   $ git grep -n "number,title,state,labels,body" 92a9db3 -- scripts
   92a9db3:scripts/lib/adopt/pr-run.mts:132:    '--state', 'all', '--limit', '100', '--json', 'number,title,state,labels,body',
   ```

2. A plan carrying `human:decided` with **no box ticked** is refused by its own name:
   `pr:plan-nothing-ticked`, `missing: ["plan:nothing-ticked"]`, exit 1, nothing pushed,
   no comment and no pull request.

3. A **declined** gap whose remedy is a file the pull request would carry leaves that file
   out of the branch, planned as `skipped (declined)`. The map is `GAP_PATHS` in
   `scripts/lib/adopt/decision.mts`, and it holds exactly one entry:

   ```
   $ git grep -n -A 2 "export const GAP_PATHS" 92a9db3 -- scripts
   92a9db3:scripts/lib/adopt/decision.mts:104:export const GAP_PATHS: Record<string, string[]> = {
   92a9db3:scripts/lib/adopt/decision.mts-105-  'workflows:missing': [`${WORKFLOW_DIR}/`],
   92a9db3:scripts/lib/adopt/decision.mts-106-};
   ```

   Every other gap is named as declined and changes no file, because its remedy is a
   GitHub API call, `gh label create`, a file under the directory git runs hooks from, an
   environment variable, or `--record --force` — none of which a diff carries.

4. Before it opens the pull request, `--pr` **comments the decision on the plan issue**:
   the accepted gaps, the declined ones, and the login that applied `human:decided`, read
   from the issue's timeline as the last `labeled` event naming that label. The same two
   lists go into the pull request body under `## The decision this acts on`.

5. Both new reads fail closed and by name. A timeline that *answers* and names nobody is
   `decidedBy: null`, said in those words — a fact about the issue, not a failed read.

   ```
   $ git grep -n "pr:plan-nothing-ticked\|pr:timeline-unreadable\|pr:decision-not-recorded" 92a9db3 -- scripts
   92a9db3:scripts/lib/adopt/pr-run.mts:168:  // be read is `pr:timeline-unreadable`, not a `decidedBy` quietly reported as
   92a9db3:scripts/lib/adopt/pr-run.mts:181:  if (timeline.status !== 0) return failure('pr:timeline-unreadable', firstLine(timeline.stderr || timeline.stdout || ''));
   92a9db3:scripts/lib/adopt/pr-run.mts:186:    return failure('pr:timeline-unreadable', 'the timeline was not JSON');
   92a9db3:scripts/lib/adopt/pr-run.mts:291:  if (comment.status !== 0) return failure('pr:decision-not-recorded', firstLine(comment.stderr || comment.stdout || ''));
   92a9db3:scripts/lib/adopt/pr.mts:99:export type PlanRefusal = 'pr:no-plan-issue' | 'pr:plan-not-decided' | 'pr:plan-ambiguous' | 'pr:plan-nothing-ticked';
   92a9db3:scripts/lib/adopt/pr.mts:204:      reason: 'pr:plan-nothing-ticked',
   ```

`docs/adopt.md` and `docs/adopt-pr.md` are the prose half of this and land with it.

## Reason

The plan issue has ended "Tick what should happen, then move this issue to
`human:decided`" since `--plan-issue` existed, and `--pr` refused with the same sentence.
Nothing read the ticks:

```
$ git grep -n "Tick what should happen" bccb040 -- scripts
bccb040:scripts/adopt.mts:648:    'Tick what should happen, then move this issue to `human:decided`.',
```

The search asked for `number,title,state,labels` (the first command above) and the gate
branched on the label alone, so the form asked a question whose answer nothing consumed: a
person who ticked two gaps out of five and one who ticked all five got the same pull
request, and neither was told.

Found on the first end-to-end adoption run, 2026-09-19, by the owner, who ticked the boxes
and then asked how the run would know they had been ticked and where the decision was
recorded. It would not, and nowhere: no step wrote a comment on the plan issue, the pull
request body named no gap, and the only trace of what was decided was the issue body's
edit history, which no script and no closeout reads.

This is a decision rather than a note because it changes **what a label gates**
([`README.md`](README.md), *What becomes a numbered decision*). The next person to answer a
plan issue has to know that the boxes are consumed, and that is not readable from the diff
that implements it. It is the register's own "in doubt" test: it has to be read before
touching a file this pull request never touched — every future plan issue.

### The decision has to key off the *reason*, and the first cut proved it

Which checks the branch produces is what the generated deliberate red asserts and what the
pull request body names, and a declined workflow has to empty both. The first cut of #368
decided that by asking whether any planned workflow carried content:

```
$ git grep -n "const checks = workflows" 26facaa -- scripts/lib/adopt/pr.mts
26facaa:scripts/lib/adopt/pr.mts:471:  const checks = workflows.some((file) => file.content !== null) ? rendering.checks : [];
```

That is wrong, because **a planned workflow carries no content for three reasons and only
one of them is a decision**. `planWorkflow` answers `declined` and `not-generated` itself
and delegates the rest to `planFile`, which answers `unchanged` when the base tree already
holds the generated bytes:

```
$ git grep -n "outcome: 'skipped'" 92a9db3 -- scripts/lib/adopt/pr.mts
92a9db3:scripts/lib/adopt/pr.mts:376:  if (base === content) return { path, content: null, outcome: 'skipped', reason: 'unchanged', commit };
92a9db3:scripts/lib/adopt/pr.mts:388:    return { path, content: null, outcome: 'skipped', reason: 'declined', commit: 'adopt' };
92a9db3:scripts/lib/adopt/pr.mts:391:    return { path, content: null, outcome: 'skipped', reason: 'not-generated', commit: 'adopt' };
92a9db3:scripts/lib/adopt/pr.mts:406:      return { path: SETTINGS_FILE, content: null, outcome: 'skipped', reason: 'not-parsable', commit: 'adopt' };
92a9db3:scripts/lib/adopt/pr.mts:416:    return { path: SETTINGS_FILE, content: null, outcome: 'skipped', reason: 'deny-not-strings', commit: 'adopt' };
92a9db3:scripts/lib/adopt/pr.mts:422:    return { path: SETTINGS_FILE, content: null, outcome: 'skipped', reason: 'unchanged', commit: 'adopt', deny: merge };
```

The last three lines are `planSettings`, on `.claude/settings.json`, and never reach a
workflow — which is why the count is three and not six. In `unchanged` and `not-generated`
the workflow exists at the head and nobody declined anything, yet the body would have
rendered *"No generated workflow is in this pull request, because the box for it was left
empty"* and `## Proof` would have said the decision left it out. **A false sentence about
the decision, in the artefact whose only purpose is recording the decision** — the exact
failure this item exists to prevent, produced by the change that introduced the item. So
the test is the reason:

```
$ git grep -n "const checks = workflows" 92a9db3 -- scripts/lib/adopt/pr.mts
92a9db3:scripts/lib/adopt/pr.mts:479:  const checks = workflows.some((file) => file.reason === 'declined') ? [] : rendering.checks;
```

The next person to add an entry to `GAP_PATHS` inherits this: a planned file's *absence*
is not evidence of anything, because four other things produce it. Only the reason says
why it is absent.

### Two sub-decisions that will look arbitrary later

Both are the fail-closed half of a choice that could have gone the other way, which is why
they are written down rather than left in the diff.

- **The token, never the prose.** A remedy is generated text a person rewrites while
  answering — *"no: we maintain these by hand"* is how somebody declines something. A
  parser reading the remedy would lose the decision the moment anyone answered in their
  own words, which is the one thing a form asking for an answer must survive. Only the
  *first* backticked span counts, so a remedy quoting a second path does not become a
  second decision. That is the same failure mode `issue-lint` refuses on `authorised:`
  lines — one line, two spans, and the parser silently taking both — recorded as
  [item 31](0031-a-bare-glob-with-a-backticked-justification-is-refused.md). That item
  *is* the #357 rule, and it describes itself as "the direct mirror of #316, which refused
  a grant line carrying more than one backticked span" — #316 is the multi-span refusal,
  and item 31 is its mirror, not the other way round. Here the direction is
  narrowing rather than refusal, because a plan issue is answered by a person who is not
  writing a grant, and a refusal over a second backtick would stop an adoption over
  punctuation.
- **The last `labeled` event, and an unreadable timeline is an error.** Last, because a
  label removed and applied again is ordinary — a person decides, changes their mind,
  decides again — and the decision in force is the standing one. An error rather than an
  absent field, because `decidedBy: null` would otherwise mean two different things,
  "nobody is recorded" and "the read failed", in a record other people rely on.

## Cost accepted

- **An adoption can now be refused for a reason a person will read as pedantic.** Moving
  the issue to `human:decided` without ticking anything is a natural way to say "yes, do
  it", and it is refused. The refusal message says what to do, and the alternative —
  treating an empty checklist as "everything" — would make the ticks decorative again,
  which is the defect this item exists to close.
- **`--pr` makes two more GitHub calls** on every run that gets past the gate, a timeline
  read and a comment, and carries two more named failure paths with them. One of them,
  `pr:decision-not-recorded`, leaves a pushed branch behind with no pull request;
  `docs/adopt.md`'s crash-policy section states it, and re-running is safe because the
  push is then `{ held }`.
- **A declined `workflows:missing` weakens the pull request's own proof**, deliberately:
  the deliberate red then asserts only the adoption record, because a generated test
  asserting a file no commit carries would be red at the head as well as on the base. That
  is strictly less proof than a full adoption carries, and it is accepted because the
  alternative is a branch whose deliberate red cannot go green, which is worse and reads
  as a broken adoption.
- **`GAP_PATHS` is a second place the gap vocabulary is written.** It names gaps that
  `scripts/lib/adopt/inventory.mts` defines, without importing them, so a renamed gap
  silently stops mapping to its files. The alternative — importing the list — would make
  an unknown tick a refusal, and a typo in a box is not a reason to stop an adoption.
- **The timeline is read as one page of a hundred**, not paginated, because `gh api
  --paginate` prints one JSON document per page and that is not a JSON document. A plan
  issue with more than a hundred timeline events reports `decidedBy: null` — the direction
  that never attributes a decision to the wrong person.

## Supersedes

nothing.

## Updates

- **2026-09-20 (#423).** The cost above names one direction of the `GAP_PATHS` drift and
  reads as if it were the whole of it. The forward direction is the vocabulary drifting
  under the **person**: a plan lists seven gaps, a person ticks `workflow:missing`
  instead of `workflows:missing`, the typo is accepted and carried through, the real box
  is counted as declined, and `.github/workflows/` is left out of the branch while every
  artefact records the decision correctly in the person's own words. Nothing in the
  output distinguished an accepted name nobody defines from a declined name everybody
  does. The bullet is not false and was not overtaken — it is incomplete, which is what
  this section is for.

  Both directions are now covered without making an unknown tick a refusal, which the
  bullet was right to refuse. `scripts/lib/adopt/decision.mts` writes the seven names
  out as the keys of `GAP_REMEDIES`, typed `Record<Gap, string>` against
  `scripts/lib/adopt/inventory.mts`'s `Gap` through an `import type` that
  `verbatimModuleSyntax` erases. **The names the parser branches on are still this
  module's own literals, so an unknown tick is still carried through rather than
  refused** — that is the property the bullet protects, and it is what the erasure buys.
  It is not a claim that nothing of `inventory.mts` runs: `decision.mts` imports
  `./workflows.mts`, which imports `OWNED_WORKFLOWS` from `inventory.mts`, so importing
  the decision module has evaluated the inventory module all along, at this item's date
  and at the date of this update alike. The type import adds no edge that was not there.
  What it adds is the check: `npm run check` now refuses a gap renamed in one file and
  not the other — the reverse drift this bullet accepted as silent. The forward
  direction is answered in the report rather than in the parser: an unrecognised tick is
  named as one in the plan-issue comment and the pull-request body, beside the declined
  gap it was a near-miss of. `docs/adopt-pr.md` carries both.

  Decision point 3's "named as declined and changes no file" also had no mirror on the
  accepted side, and the same pull request adds it: a gap no file of the diff closes is
  reported as **recorded, not performed**, with the command that performs it. Accepting
  `labels:missing` and running nothing was what left `review:approved` absent and
  `scripts/land.mts` refusing the adoption pull request with `review:not-approved`.

  One thing the first version of that mirror got wrong, corrected before it landed and
  recorded here because the item is where the rule lives: **whether a gap is carried is
  a fact about the diff, not about the gap.** Reading it off `GAP_PATHS` alone reported
  `workflows:missing` as carried on a branch that wrote no workflow — the base already
  held them, so every one planned as `skipped (unchanged)` — which is decision point 3's
  own failure mode with the sign flipped. It is read off the paths the plan writes.
