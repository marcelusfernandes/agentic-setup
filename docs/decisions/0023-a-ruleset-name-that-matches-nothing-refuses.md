# 0023. A `--ruleset-name` that matches nothing refuses, and no failed read on the `--rules` path reaches the create path

Status: proposed
Date: 2026-09-18

Landed with #229 (PR #317), which implements the rule below in the same diff. The rule is
written here because it binds the next agent rather than because it explains that diff:
it changes what `scripts/init.mts --rules` does for an input it used to accept, and
`skills/init/SKILL.md` had to be corrected in the same pull request because its sentence
about that input had become false. That is the register's own test for a decision.

## Decision

**`--ruleset-name` only ever updates. A name that matches no existing branch ruleset
refuses, naming the rulesets that do exist, and creates nothing.** More generally: **every
read the `--rules` path depends on either produces a ruleset the run can act on or refuses
with a named line, and no failed read reaches the create path.**

What is in force, as `scripts/init.mts` implements it:

- **The refusal shape.** `refuseRuleset` (`scripts/init.mts:590`) says
  `  ! ruleset: <reason>` and returns. A refusal makes no POST and no PUT, and the process
  still exits 0 — the refusal is a report line, not a crash. This is the crash policy the
  script's header states for this path, and it is the shape every pre-existing refusal case
  on it already asserted.
- **A refusal names what could not be read.** Each reason names the read — the flag, the
  default branch, the rulesets list, or ruleset `#<id>` and the field — plus gh's first
  stderr line where there is one. An operator who gets a bare failure out of an installer
  cannot tell a missing token from a missing repository from a network problem, and guesses.
- **The five reads that now refuse** (`scripts/init.mts:612-621`, in order): a
  `--ruleset-name` with no name after it or another flag after it
  (`:115-116`, reported as a usage error at `:132`); a default branch `gh repo view` could
  not read (`:494`); a rulesets list that is not valid JSON or not a JSON array
  (`:204-205`); and a ruleset detail that failed, did not parse, is not a ruleset object,
  or whose shape `rulesetShapeProblem` rejects (`:226`, `:250`).
- **The override refuses instead of creating** (`scripts/init.mts:641-645`). When
  `rulesetNameOverride` is set and `matches` is empty, the run refuses and lists the branch
  rulesets that exist, by name and id. Creating is what the flag's *absence* asks for.
- **A created ruleset is therefore always named `agentic-setup`.** The POST path can now
  only be reached with no override in force, so the `rulesetNameOverride ??
  DEFAULT_RULESET_NAME` argument at `:651` can evaluate only to `DEFAULT_RULESET_NAME`
  (`:93`) on a create.
- **The plan diagnosis is a reading of a gh call's own failure.** `reportGhCallFailure`
  (`:598`) takes the call result and matches `/\bHTTP 403\b/` against its stderr. "Not
  available on this plan for a private repository" is never produced by finding those
  digits inside some other message.
- **The docs that carry it.** `skills/init/SKILL.md:30` (the flag list) and `:80` (the
  `--rules` step) state the refusal and the shape it takes; the header of
  `scripts/init.mts` states the crash policy it honours.

Unchanged by this item: the ruleset the run updates without an override is still the one
that **governs the default branch**, found by its conditions and never by its name
(#143); several matching rulesets still mean the first is updated and the rest named in
the report, never created over; and `--rules` without an override still creates when
nothing governs the branch. Only "an override that matched nothing" and "a read that
failed" changed answer — from *create* to *refuse*.

## Reason

**A tool that cannot see the current state must not go on to change it.** Every entrance
this item closes ended at the same place: `existing = null`, which the run reads as
"nothing governs this branch", followed by a POST. The outcome is a repository with two
rulesets over one branch where the operator asked for one — the exact defect #143 was
written to remove, arriving through doors #143 did not close.

On the base (`c1e6b413`), five reads answered "there is no ruleset" for a failure that was
not that:

- `scripts/init.mts:167-168` — the rulesets list was parsed with `parseJson(…, [])`, so a
  `{ "message": … }` error body returned `{ rulesets: [], unreadable: null }`, and
  `unreadable: null` is what the caller reads as "nothing to refuse over". A detail fetch
  that could not be read was already fatal by design; the list itself was not.
- `scripts/init.mts:411-412` — `defaultBranch` was parsed out of `repoView.out` without
  checking `repoView.ok`, falling back to `'main'`. On a repository whose default branch is
  not `main`, a failed `gh repo view` made every `governsDefaultBranch` test compare against
  the wrong ref, nothing matched, and the run created a ruleset over the branch that was
  already governed.
- `scripts/init.mts:90` — `--ruleset-name` passed as the last argument silently became "no
  override" (`argv[idx + 1] ?? null`), and the run fell back to matching by conditions with
  nothing in the report to say the operator's choice had been dropped.
- `scripts/init.mts:518` — an override matching nothing gave `matches = []` and the run
  POSTed a new ruleset named after the override, over a default branch another ruleset may
  already have governed.
- `scripts/init.mts:501-502` — `reportRulesetError` matched `/403/` anywhere in the message
  and was handed the `unreadable` refusal text, so a ruleset id containing those digits was
  reported as a billing problem rather than an unreadable ruleset.

**The override case is the one that changes a behaviour an operator could have relied on,
and it is the one worth arguing.** The operator named one specific ruleset to update.
Creating a second one is not a smaller version of that request; it is a different request,
and the one shape #143 exists to prevent. Refusing costs a rerun. Creating costs a
repository whose default branch is governed by two rulesets whose rules have to be
reconciled by hand, discovered later, by someone else.

**Refusing is affordable here because the run is not all-or-nothing.** The ruleset step is
the last of six; the filesystem work is done and reported by the time it runs. So a refusal
is a named line in a report the operator is already reading, and the remedy — rerun with a
name that exists, or without the flag — is in the line itself. That is why this path refuses
with a report line and exit 0 rather than `process.exit(1)`, which is the shape the labels
dictionary uses because *that* read happens before the first byte is written.

## Cost accepted

**An operator who wanted a new ruleset under a chosen name has to say so another way.**
There is no longer any input that both names a ruleset and creates it: `--rules` with no
override creates `agentic-setup`, and `--rules --ruleset-name <name>` only updates. Someone
who ran `--ruleset-name house-rules` against a fresh repository and got a ruleset called
`house-rules` now gets a refusal instead. The remedy is to create with `--rules` and rename
in the GitHub UI, or to create the ruleset by hand and then point `--ruleset-name` at it.
**If that turns out to be the common case, the answer is a `--create-ruleset`-style opt-in
argued as a new decision superseding this item — not a quiet return to creating on no
match.** AC3 of #229 offered both shapes and left the choice to the implementer; this is
the choice, and it is written here so that reversing it has to be argued once, in public.

**Two reads now refuse that no issue asked about, found while verifying #229.** Both are
the same defect as the listed ones and are fixed here rather than left for a later issue,
which means this item's scope is slightly wider than the criteria that prompted it:

- *A rulesets list that is not valid JSON at all.* `parseJson(…, [])` swallowed it into
  `[]`, which passed `Array.isArray` and reached the create path exactly as quietly as the
  non-array error body the issue did name. One entrance, two doors.
- *A `conditions.ref_name.include` that is a string.* This one never threw: `.includes`
  substring-matches a string, so a ruleset could be "found" by a fragment of a branch name
  and updated in place of the one that actually governs the branch. It is the only entrance
  here whose failure was a **wrong write** rather than an extra one.

**A stricter shape check can refuse a detail the API legitimately serves.**
`rulesetShapeProblem` (`:250`) rejects four fields whose shape this path reads. If GitHub
ever serves one of them in another shape, `--rules` refuses where it used to work. The
check is limited to those four fields and every refusal names the field, so such a case is
diagnosable from the report rather than silent — but it is a refusal the operator did not
ask for, and it is the price of never throwing a `TypeError` out of the process and never
shipping a malformed request body.

**A failed `gh repo view` now prints a line in every `gh` run**, not only under `--rules`
(`:494`, `:502-503`). Previously it printed nothing and guessed `main`, on the stated
grounds that a guess is not a finding worth printing. The guess *is* the finding, so the
report gained a line that some runs will show without anything being wrong beyond a
transient read.

## Supersedes

`nothing`. It completes #143 — which made the *match* by what a ruleset governs rather
than by its name, and made an unreadable detail refuse — by closing the reads #143 left
able to reach the create path. Item 9(a) of `../decisions.md` (the checks the merge model
depends on) is untouched: what `--rules` writes is unchanged, only what it refuses to
write.

## Updates

None yet.
