# 0021. The negative control never exempts a change to its own installed code, and no operator override re-admits it

Status: proposed
Date: 2026-09-17

Landed with #214 (PR #290), which implements the rule below in the same diff. The rule is
written here because it binds the next agent, not because it explains that diff: the
mechanism's own header says the carve-out exists, and only this file says it was decided
and may not be traded away.

## Decision

**`negative-control` never treats a change to its own installed code as sitting in a
skipped path class, and there is no way to switch that off.**

What is in force, as `ci/negative-control.mts` implements it:

- **The carve-out.** `NEVER_SKIP_GLOBS` (`ci/negative-control.mts:108`) is the closed list
  `.github/scripts/agentic/**` — the directory `scripts/init.mts:332` copies this
  repository's `ci/` into when it installs the loop in another repository.
- **How it applies.** `inSkippedClass` (`:199-200`) is `matchesAny(file, skipGlobs) &&
  !matchesAny(file, NEVER_SKIP_GLOBS)`, and the skip at `:205` requires **every** changed
  file to satisfy it. So one file under that path keeps a whole diff out of the skip, even
  when the rest of it is docs and workflows.
- **No override.** The carve-out is subtracted after `AGENTIC_SKIP_GLOBS` has been added
  (`:197`), so naming `.github/scripts/agentic/**` in that repository variable does not put
  it back. This is the first place in this check where an operator has no override:
  every other path class is theirs to extend, and this one is not theirs to remove.
- **It says so in the log.** When a diff carries such a file the run prints a `note:`
  naming the files and the reason (`:201-204`), so the reason the check ran is read rather
  than inferred from its absence.
- **The docs that carry it.** `docs/workflow.md` (the `negative-control` row and the
  path-class paragraph), `agents/docs-writer.md:38`, and `proof/README.md:64` — the three
  places that spell the path-class list out.

Unchanged by this item: the skip is still by path class and not by the PR's own labels
(#135), `*.md` is still root-level Markdown only, and `AGENTIC_SKIP_GLOBS` still adds
classes freely. Only subtraction is refused.

## Reason

The gate's code becomes an ordinary file of the repository it guards. `scripts/init.mts:332`
writes `ci/` — `negative-control.mts` among them — into `.github/scripts/agentic/`, and
the skip's `.github/**` class covered everything under `.github/`. So in every adopting
repository, a pull request that rewrote the negative control was a pull request the
negative control skipped: the outcome was `skipped`, the check was green, and no failing
test was ever owed for a change to the thing that requires failing tests. A mechanism that
can exempt a change to itself is not a gate; it is a gate-shaped file.

That is the same class of defect as #135, and the reason #135's answer is not enough here.
#135 removed the *label* from the skip decision because the implementer applies its own
PR's labels, so a `type:` label could buy its own exemption. The path class was the fix:
a property of the diff, not a claim the author makes about it. This item closes the case
#135 left open — the author does not need to claim anything when the path class already
covers the file being changed.

An operator override would give the exemption straight back, and it would be reached for
in good faith. `AGENTIC_SKIP_GLOBS` exists to let a repository declare "this path owes no
negative control", which is exactly the sentence someone will write about a comment-only
edit to `.github/scripts/agentic/negative-control.mts`. The variable is set once and read
by every run afterwards, so one plausible entry silently disarms the check for every
future change to the gate — a cost paid long after the person who typed it has stopped
thinking about it. A rule that holds only while nobody finds the switch is not a rule.

The trade is asymmetric, which is what makes the missing escape hatch affordable. Refusing
the skip on a genuinely doc-shaped change under that path costs one run of the suite and a
sentence in the PR body. Granting it on a real change to the gate costs the guarantee the
whole loop rests on — item 10 of `../decisions.md` calls the negative control the
load-bearing check, and this is the one path where its failure is invisible rather than
loud.

## Cost accepted

**An adopting repository loses the skip for real documentation under that path.** A README
or a comment-only edit inside `.github/scripts/agentic/` now runs the full check and, with
no test file in the diff, fails as `no-tests`. **What to do instead of relaxing the rule:**
keep such a change in the same pull request as the doc it belongs to, so the diff carries
a test file or is confined to another class — the remedy `agents/docs-writer.md:38` already
prescribes for `.claude/**`. If that is genuinely impossible, the answer is a new decision
superseding this item, not an entry in `AGENTIC_SKIP_GLOBS`: the point of writing the rule
here is that relaxing it has to be argued, in public, once.

**The glob and the install destination are coupled by comment only.** `NEVER_SKIP_GLOBS`
is a string in `ci/negative-control.mts:108`; the destination is a `join` in
`scripts/init.mts:332`. Both now name the other in a comment, and `tests/map-pin.test.mts`
holds the installer line in `CLAUDE.md` to a real `copyTree` call, but a rename that moved
only the destination would leave the carve-out pointing at nothing and the hole reopened
silently. A test that derives one from the other would close this and does not exist.

**The protection is shaped like this project's installer, not like the idea.** It names one
destination. A repository that vendors the checks somewhere else — a different directory, a
submodule, a package — gets none of it, and nothing warns them. The general rule ("the code
of the check is never in a skipped class, wherever it lives") is not expressible in
`ci/lib/globs.mts:10-24`, which has no negation and no notion of which files are the
check's own.

**One less place an operator can tune.** Every other path class is extensible per
repository; this one is not. That is the cost of the guarantee, and it is stated rather
than hidden so that a repository which cannot live with it opens an issue instead of
discovering the refusal in CI.

## Supersedes

`nothing`. It completes #135 (the skip is a property of the diff, never a claim the author
makes) and it is the sharpest case of item 10 of `../decisions.md`, but neither is
replaced.

## Updates

None yet.
