# 0031. A bare glob with a backticked justification is refused

Status: proposed
Date: 2026-09-19

Landed with #357, which implements the rule below in the same diff. It is written here
rather than left in that pull request's body because it changes **what makes a required
check pass or fail**: an issue that `ci/issue-lint.mts` reports `ok: true` for today is
reported `ok: false` for, and a grant `scope` honours today grants nothing. The register's
rule ([`README.md`](README.md), "What becomes a numbered decision") makes a change to a
check a numbered item in the pull request that makes it.

This item lands `proposed`, like every dated item since 0021. A grant of scope is not an
acceptance: [`README.md`](README.md) ("Silence never accepts") reserves `accepted` to an
explicit written OK from the person running the loop, and no such OK exists for this item.

It is the second half of [item 0022's](0022-a-grant-bullet-is-never-also-a-glob.md) family
and the direct mirror of #316, which refused a grant line carrying more than one backticked
span.

## Decision

**On an `authorised:` line, the granted glob stands at the head of the line — and a line
that carries a backticked span somewhere else grants nothing.**

`grantRefusal`, a new function in `ci/lib/scope.mts`, is the one place a grant line is
judged. It returns at most one of two reasons, and a line therefore draws at most one
refusal:

1. `multi-span` — more than one backticked span. Unchanged from #316, and it takes
   precedence, so a line that is both shapes is reported as this one.
2. `bare-glob-backticked-justification` — exactly one backticked span, but the line does
   not open with it. The glob is the bare token in front; the span is a justification.
   New here.

Three consequences, all in the same diff:

- **`authorisedGlobsIn` grants nothing for either reason.** Where the line used to grant
  its span, it now grants neither the span nor the bare token. Both grant parsers —
  `parseIssueAuthorisedGlobs` and `parseAuthorisedGlobs` — read that one function, so the
  issue side and the pull-request side cannot answer differently.
- **`findBareGlobBacktickedJustificationLines` reports the refused line**, carrying the
  line as written, the bare token that was meant to be the glob and the span that was not.
  `findMultiGlobGrantLines` keeps its shape and its name.
- **`ci/issue-lint.mts` turns each into a failure at dispatch**, in wording of its own. The
  two messages share no distinguishing phrase: only the bare-glob one says "bare glob",
  only the multi-span one says "more than one backticked span". An author fixing one is
  never handed the other's remedy.

`docs/workflow.md` and `skills/issue-and-pr/SKILL.md` stated this rule as advice and
enforced nothing. Both now state it as enforced and show the two refused shapes side by
side.

## Reason

The line the shape produces is this, and both halves of it went wrong at once:

```
authorised: src/a.ts (see `src/lib/b.ts`)
```

Measured on the branch that lands this item, against the parser as it stood at `2f87354`
and as it stands here — the body is the line above under a `## Files` heading:

```
$ node --input-type=module -e "
import { parseIssueAuthorisedGlobs as base } from '<2f87354:ci/lib/scope.mts>';
import { parseIssueAuthorisedGlobs as head } from './ci/lib/scope.mts';
… print both over the same body …"
base grants: ["src/lib/b.ts"]
head grants: []
```

`src/lib/b.ts` is the path the author was *pointing at*. It entered the audited scope in
silence, and `scope` then passed on a file nobody meant to grant — an over-grant, which
fails **open**, the same direction as the defect #316 fixed. And `src/a.ts`, the glob the
author actually wrote, was granted to nobody, so the path they meant went unaudited too.
One line, both halves wrong, and neither visible to a reader of the check's output.

#316 scoped its refusal to "more than one backticked span", so this survived it and is not
a regression of it. What did not survive was the claim that the rule was in force. Both
documents told the writer that a same-line justification must be unbackticked, and neither
had anything behind it — at `2f87354`:

```
$ git grep -n "allowed only unbackticked" 2f87354 -- docs/workflow.md skills/issue-and-pr/SKILL.md
2f87354:docs/workflow.md:213:justification is allowed only unbackticked, since it must add no span. On the
2f87354:skills/issue-and-pr/SKILL.md:125:  - A justification on the **same** line is allowed only unbackticked — it adds no span.
```

(The revision is named on the command so it reads the tree rather than this file, which
quotes the same string twice.)

That gap is the one #316's own reasoning argues against: documentation prevented none of
the six over-granting lines that issue measures, and only rewriting them by hand did.
A rule stated in two documents and enforced by no parser is a convention, and a convention
is what the orchestrator breaks at three in the morning.

**Refusing rather than narrowing** is #316's argument unchanged. The parser could take the
bare token, which is almost certainly the glob meant. It would then be discarding the span
the author wrote, without saying so — trading a silent over-grant for a silent
under-grant. A line of this shape is a line whose author meant something the format cannot
express: the check names it and a person rewrites it.

**Keeping the two refusals apart** is a separate requirement, not a courtesy. The remedies
differ — one line needs a span removed, the other needs its justification unbackticked or
moved to the next line — so an author told the wrong one either edits at random until the
check goes quiet, or concludes the check is wrong. `grantRefusal` returning at most one
reason is what makes that structural rather than a matter of message wording.

## Cost accepted

**A line that is legal today starts being refused at dispatch, and the population it breaks
is measured at zero only until someone writes one.** That is the whole of the cost, and it
is the same bargain #316 took. The measurement, over every issue in the repository, open
and closed, run on this branch with the parser this branch lands:

```
$ gh issue list -R marcelusfernandes/agentic-setup --state all --limit 1000 \
    --json number,body > issues.json
$ node measure-357.mts issues.json     # imports the two finders from this branch's ci/lib/scope.mts
issues read: 236
bare glob with a backticked justification (#357, newly refused): 0
more than one backticked span (#316, already refused): 0
```

236 issues, not the 208 the issue quotes — the count grew while the issue waited, and the
answer did not. `--limit 1000` is well above 236, so nothing was truncated. Zero means no
issue in flight is broken by this landing and no order of repair is owed; it does not mean
the shape is rare, because until this branch nothing refused it, so nobody had a reason to
stop writing it.

**The refusal is deliberately wider than the shape the issue names.** `grantRefusal` asks
whether the line *opens* with its span, not whether a bare path precedes it, so any prose
in front of a backticked glob is refused as well. Measured the same way as above:

```
prose-first  base: ["src/a.ts"]  head: []      # authorised: see `src/a.ts`
bare+2 spans base: []            head: []      # authorised: src/a.ts (see `b.ts` and `c.ts`)
```

The first line granted `src/a.ts` before and grants nothing now. That is a second
under-grant introduced on
purpose: "the glob stands at the head of the line" is one rule a writer can hold in their
head and a parser can check, where "a *path-shaped* token in front of the span" is a
judgement about what looks like a path. The cost lands on the writer of an unusual line,
who is told exactly which line and why.

**Precedence resolves one ambiguity by fiat.** A line with a bare token and *two* spans is
reported as `multi-span`, because that reason is checked first — over the second body
above, `findMultiGlobGrantLines` returns the line with both spans and
`findBareGlobBacktickedJustificationLines` returns `[]`. The author is told about
the spans and not about the bare token; fixing the spans leaves a line that is then
refused for the other reason, on the next run. Two rounds for one line, in exchange for
never printing two refusals for one line — which is what the "different mistakes" rule
above is worth.

**What this does not close.** The continuation line — indented, not a bullet — is still
read by no parser, so backticks there still grant nothing and are still only a habit. And
the refusal reaches the writer at dispatch, through `ci/issue-lint.mts`; `ci/scope-check.mts`
honours the same parser, so a line added to an issue after dispatch is refused when the
`issue-lint` workflow reruns on the edit, not by the `scope` job reporting it in words.
Naming it at `scope` time as well is not attempted here.

## Supersedes

`nothing`. It extends #316's refusal to the mirror shape that issue's AC1 scoped out;
the multi-span rule and its wording are untouched.

## Updates

*(none yet)*
