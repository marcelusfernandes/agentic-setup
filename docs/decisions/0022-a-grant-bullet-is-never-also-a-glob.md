# 0022. A grant bullet is read once, as a grant, and never as a glob of the issue

Status: proposed
Date: 2026-09-18

Landed with #231 (PR #311), which implements the rule below in the same diff. The rule is
written here because it binds the next agent rather than because it explains that diff:
every future issue's `## Files` is a section this rule governs, and the parsers' own
headers say what they do without saying it was decided.

## Decision

**A bullet in `## Files` whose content starts `authorised:` is a grant. It is read once,
as a grant, and never also as one of the issue's globs.**

What is in force, as `ci/lib/scope.mts` implements it:

- **One recogniser, not two.** `grantRemainder` (`ci/lib/scope.mts:47`) is the single
  answer to "is this line a grant": it strips a `-`/`*` marker, matches `authorised:`
  case-insensitively, and returns the rest of the line, or `null`. Every parser that
  needs the answer asks it, each at the line cited: `parseIssueGlobs` (`:68`),
  `authorisedGlobsIn` (`:95`) and `findMisplacedAuthorisedLines` (`:144`).
- **The glob parser skips it.** `parseIssueGlobs` continues past any bullet for which
  `grantRemainder` is non-null (`:68`), so a granted path reaches `authorisedGlobs` only.
- **What that changes downstream.** `ci/scope-check.mts` lists the path once, under
  `Authorised by #N`, and not among the issue's globs (`:214-216`). `ci/issue-lint.mts`,
  which reads `parseIssueGlobs` alone (`:58`, `:184`, `:367`), now sees an issue's
  *declared* scope and not the files it was granted — so its AC3 disjointness set stops
  treating a grant as scope.
- **The docs that carry it.** `docs/workflow.md:169` (the `## Files` paragraph) and
  `skills/issue-and-pr/SKILL.md:98` (the card's parser rules) state the exception at the
  same place they state the bullets-only rule.

Unchanged by this item: a grant still counts only in the body of an issue the PR closes
and never from a PR body (#155); a bare, non-bullet `authorised:` line is still a grant;
and the reading of what follows `authorised:` is exactly what it was — every backticked
span on the line when there is one, otherwise the first whitespace-delimited token with a
trailing `,`/`;` stripped (`:95-103`). Only the question "is this line also a glob"
changed answer.

## Reason

**Two parsers read the same lines and neither knew the other existed.** On the base
(`c1e6b413`), `parseIssueGlobs` (`:44-59`) pushed the backticked spans of *every* bullet,
and `authorisedGlobsIn` (`:69-86`) read the same line again as a grant. A grant written
as a bullet — the form `docs/workflow.md` and the card both show — is a bullet, so it was
read twice.

Where the two readings agreed, the cost was a duplicate in the summary and a
misclassification everywhere else. #203 is the live case: its `## Files` carries two
bullet grants, so on the base it parsed as globs `scripts/log-decision.mts`,
`tests/log-decision.test.mts`, `docs/orchestration.md` and `skills/orchestrate/SKILL.md`,
and `issue-lint` reported it as an overlapping sibling for every issue touching
`docs/orchestration.md` — a file it had been granted, not given the scope of.

**Where the two readings disagreed, the check was widened through a path that was never
recorded as a grant.** For a bare, comma-separated grant line, the grant parser took the
first whitespace token (`:82` on the base) while the glob parser split on commas and kept
any fragment without whitespace (`:56` on the base):

```
- authorised: src/a.ts, src/lib/b.ts
  -> grants: ["src/a.ts"]          (the audited route)
  -> globs:  ["src/lib/b.ts"]      (an ordinary issue glob, from a grant line)
```

`src/lib/b.ts` widened what the pull request could touch, never appeared under
`Authorised by #N`, and read in the job summary as if it were the issue's own declared
scope. `docs/workflow.md` compounded it by stating that the parser splits on commas,
which it does not — so the document invited precisely the form that diverged.

**The agreement in the ordinary case was a coincidence, not a guarantee.** Both parsers
landed on the same string only because both called `backticked()` (`:37`). Nothing in
either function referred to the other, and any change to one — taking the last span
rather than all, trimming differently, gaining a punctuation strip — would have made the
canonical form diverge too, silently, with the extra path presenting as declared scope.
The fix is not that the two now agree; it is that there is one answer instead of two that
have to.

**On severity, stated plainly so it is not overclaimed later.** Only the orchestrator
writes an `authorised:` line, so no agent could obtain a path its author had not typed.
This is an audit hole and a cross-consumer misclassification, not an escalation: the
widened path was unattributable in the summary, and the one consumer that reads the glob
parser alone could not tell a grant from scope.

**Why this is a numbered decision and not a note.** The register's own test is whether a
change obliges the documents-and-card update of invariant 8. This one did, in writing:
PR #311 was rejected in review for changing the parser without updating
`skills/issue-and-pr/SKILL.md`, whose `## Files` rule had become false. The tie-break in
`README.md` points the same way — the next agent must read this before touching a file
this pull request never touched, because every future issue's `## Files` is such a file.

Two contrary arguments were made, and both fail. The first, that the code was only being
made to match an invariant already written: nothing written said a grant bullet is not a
glob, and invariant 5 ("`## Files` reads bullets only") if anything implied that it was —
the code changed first and the documents were rewritten to match it. The second and
stronger form, that this is "a measured fact about how the code already behaves, with no
change of contract" and therefore a note by `README.md`'s own list: a contract did change,
and the first paragraph of **Cost accepted** below is the proof of it — an issue whose
`## Files` carries only grants is refused where it previously passed. A change that adds a
refusal is not a measurement of existing behaviour.

## Cost accepted

**A refusal that did not exist before.** An issue whose `## Files` carries only grant
bullets now declares no globs of its own, and `ci/scope-check.mts:215` fails the run with
"the linked issue(s) declare no globs under `## Files`" where the base passed on the
duplicated grant. This is the intended reading — an issue with no scope of its own
declares none — and it is not the only guard: `ci/issue-lint.mts:185-186` already fails
such an issue at dispatch with "`## Files` has no bullet glob", and
`scripts/create-subissue.mts` labels `state:ready` only on a clean lint. So in the normal
path the issue never reaches a pull request, and the scope refusal is a backstop for an
issue edited after dispatch. Who pays: whoever edits a `## Files` down to grants alone,
at CI time rather than at dispatch time.

**The same-line over-grant is documented and not enforced.** `backticked()` (`:37`) takes
*every* backticked span on a line, so a grant whose justification sits on the same line
and quotes anything grants what it quotes:

```
- authorised: `skills/issue-and-pr/SKILL.md` — its line about `## Files` says every
  -> grants: ["skills/issue-and-pr/SKILL.md", "## Files"]
```

Both parsers have always done this identically, so it is not a divergence and this item
does not change it; `docs/workflow.md:179` now names the hazard and prescribes the
justification on the next line, indented. That is a document where a refusal belongs.

The rate is the argument for enforcing it, and the rate is measurable. GitHub retains an
issue body's prior versions, so the instances survive correction: a scan of the
`userContentEdits` of every issue touched since 2026-09-17, keeping `authorised:` lines
that carry more than one backticked span, reproduces **six on 2026-09-18** — one on #168,
four on #229, one on #231 — plus a seventh on #203 from the day before. All seven were
written by the orchestrator; the six fall on the day this very defect class was being
fixed, which is the day of maximum awareness of it.

**One of the six widened a real path; the other five produced dead globs.** #168's line
carried three spans, not two — `AGENTS.md`, the file it meant to grant;
`tests/map-pin.test.mts`, a tracked file silently added to what that pull request could
touch; and `scripts/`, which reads like a path and matches nothing, because every glob is
anchored on the whole path (`ci/lib/globs.mts:21`) and only the recursive `scripts/**`
matches anything under a directory. The other five lines quoted `gh`, `--rules` twice,
`--ruleset-name` and `## Files`, none of which matches any tracked file, and #203's
seventh quoted `parent:type`, likewise nothing. So the hazard is demonstrated rather than
theoretical, at one line in six, and its usual form is noise in the summary rather than
harm.

The two halves are deliberately not the same shape. The harm is one in six; the remedy
proposed below triggers on **every** multi-span line, because the predicate that tracks
the harm is time-varying while the predicate a check evaluates has to be stable. Whether
an extra span names a tracked file is computable today — the lint asks exactly that
question of an issue's declared globs, matching them against the tracked file list
(`ci/issue-lint.mts:361`) — but the answer expires: a span that matches nothing this week
matches something the week the file is added. `gh` is such a span: it compiles to `^gh$`,
matches nothing today, and matches the day a file named `gh` is tracked at the root.
`scripts/` is not one — it compiles to `^scripts/$`, and no path `git diff --name-only`
prints ends in a slash, so it is dead permanently rather than dead for now. The shape of
a grant line is the same every week; which of its spans are live is not.

What makes a document the wrong guard is not that the evidence is unavailable — it is
that nobody runs an edit-history audit as a matter of course. The six were found because
this item was being written; nothing in the loop would have surfaced them otherwise, and
a grant line is read by the check within seconds of being written and by a person
approximately never.

Who pays: the orchestrator, who writes every grant line and is the only one who can write
one wrong; and the reviewer of any pull request whose summary carries a granted path
nobody intended, who has no way to tell an intended grant from a quoted fragment.

**The remedy is refusal, not repair.** An earlier draft of the fix proposed taking only
the first backticked span so that one-glob-per-line became enforced. That is worse than
the defect: taking the first silently discards what the writer wrote and trades a silent
over-grant for a silent under-grant, where the pull request then fails on a file the
orchestrator believed it had granted. The enforcement worth building refuses a grant line
carrying more than one span and names the line. It is filed separately and is not part of
this item.

**One more rule for whoever writes a `## Files`.** The section now holds two bullet
shapes with different meanings, told apart by a prefix. A bullet meant as a glob but
written `- authorised: …` becomes a grant. The forms that stay ordinary globs are fixed
and asserted in `tests/scope.test.mts` — a path merely named `authorised`, the word
appearing mid-bullet, and a line whose first character is a backtick — but it is one more
thing to know about a section that previously had one rule.

## Supersedes

`nothing`. It completes #155 (a grant counts only where the orchestrator wrote it) by
making the grant legible as a grant to every consumer, and it is the reason
`docs/workflow.md`'s account of the grant parser is now accurate, but neither is
replaced.

## Updates

*2026-09-18 (#232, #328):* `ci/issue-lint.mts` reads the grants too now, and holds them
to the two rules it holds the bullet globs to. It calls `parseIssueAuthorisedGlobs`
(`ci/issue-lint.mts:199`), resolves a grant and a bullet glob through one
`classifyGlob(glob, grant)` by the same literal-path/new-prefix rule, and runs the
disjointness comparison over `[...globs, ...grants]` on both sides (`:398`, `:405`).
**The decision above is unchanged and still in force**: a grant bullet is read once, as
a grant, and never as one of the issue's globs — `parseIssueGlobs` still skips it, and
the lint now tells a granted path from a declared one rather than conflating them, which
is what this item said it could not do. What no longer describes the code is the last
sentence of the third bullet of **Decision**, that the lint's disjointness set "stops
treating a grant as scope": it compares grants again, *as grants* and through the second
parser, and each `globs` entry carries `grant: true`/`grant: false` so the two stay
distinguishable in the output. That adds two refusals at dispatch — a grant whose
wildcard matches no tracked file, and a granted file another in-flight issue of the
milestone also covers unless a `Blocked by:` sequences the two — and by this item's own
test, a change that adds a refusal is not a measurement of existing behaviour, which is
what earns this line. **Cost accepted** is untouched: `## Files has no bullet glob`
still counts bullets only, so an issue whose `## Files` carries grants alone still
declares no scope of its own. The same pull request moved this item's citations into
that file (the header gained the sentence naming grants, the body gained the grant
parsing): the three under **Decision** read `:67`, `:193` and `:405`, and the one under
**Cost accepted** reads `:200-201`. A seventh citation moved as well, into a different
cited file: **Decision**'s `skills/issue-and-pr/SKILL.md:98`, the card sentence stating the
bullet exception, is at `:99` because that pull request added a line above it. The wording
above keeps the numbers it was written with, per the template, and every number in this
paragraph is read at the head that records it rather than computed from an earlier one.

**The rule, stated over the relation it has to close: when a branch moves a file, every
citation into that file is re-pointed — every one this item carries, whoever wrote it and
whenever, not only the ones the moving pull request typed — corrected where a glob or a
grant covers the document the citation sits in, and reported where neither does.** Three
rounds of #328 each read that relation too narrowly and each missed what the narrowing hid:
one corrected a citation in a workflow header and left six here; the next swept those six,
all into one cited file, and left the seventh, which points into another; the third stated
the rule with an authorship qualifier — "citations this pull request has written" — that
would itself have excluded four of those seven, the seventh included, since they were
written by the pull request that created this item and not by the one that moved them.
