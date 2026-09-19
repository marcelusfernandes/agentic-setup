# 0030. The structural signature sees this repository's own harness output

Status: proposed
Date: 2026-09-19

Landed with #389, which implements the rule below in the same diff and closes #297. It is
written here rather than left in that pull request's body because it changes **what makes
a required check pass or fail**: runs that report `pass` and exit 0 today report
`structural` and exit 1. Three of the four items dated today are about `negative-control`
and this is the third of them: [item 27](0027-a-pass-names-the-file-the-overlay-placed.md)
refused a red the overlay did not earn,
[item 28](0028-a-diff-the-overlay-carries-whole-is-proved-by-nothing.md) stopped refusing a
change the overlay cannot judge, and this one makes a distinction that was written in #135
and never once fired. ([Item 29](0029-a-file-over-the-line-limit-is-reported.md) is the
fourth and is about `scope`.)

This item lands `proposed`, like every dated item since 0021. A grant of scope is not an
acceptance: [`README.md`](README.md) ("Silence never accepts") reserves `accepted` to an
explicit written OK from the person running the loop, and no such OK exists for this item.

## Decision

**Three changes to what a required check does, in one diff.**

1. **`tests/lib/harness.mts` prints a failure's error header ahead of its truncated
   tail**, so `ci/negative-control.mts` can see a structural red in this repository's own
   output. The detail stays truncated to six lines; the header is prepended when the tail
   does not already carry it. Consequence for the check: an overlaid run that fails with
   `Cannot find module` now reports `structural` (exit 1) where it reported `pass`
   (exit 0), unless a `test(red):` commit in `base..head` touches one of the overlaid
   files — the vouch #135 defined and that had never been consulted.
2. **The check and the proof runner read one declaration parser**, `ci/lib/proof.mts` —
   `ci/negative-control.mts` imports it directly, `scripts/proof.mts` through
   `scripts/lib/proof.mts`, which re-exports it. The check therefore gains two
   `cannot-run` causes it did not have:
   a key outside `tests`/`command`/`describes`, and a `describes` that is not a non-empty
   sentence. Both were already refusals for `scripts/proof.mts`.
3. **Both runners bound their run in two dimensions**, each an explicit named constant
   with an environment override: `AGENTIC_RUN_MAX_BUFFER` (default 64 MiB) and
   `AGENTIC_RUN_TIMEOUT_MS` (default 30 minutes). A run killed by either is `cannot-run`
   under a cause of its own — `proof:output-too-large`, `proof:command-timed-out` — and
   never `proof:command-not-runnable`, which says the command never started.

## Reason

A distinction that never fires is not a safeguard, it is a comment. #135 introduced
structural-versus-runtime and PR #217 built the proof declaration on it; on this
repository it had never operated. Measured in the review of PR #236: the base run with
`tests/proof.test.mts` overlaid failed with `MODULE_NOT_FOUND` 79 times, CI printed no
`warning:` line, and the vouch was never consulted. The cause was one line of the test
harness. Node prints `Error: Cannot find module …` about ten lines above the end of a
diagnostic; the harness kept the last six, so what reached the check was
`code: 'MODULE_NOT_FOUND'` — deliberately not in `STRUCTURAL_SIGNATURE`, because
`MODULE_NOT_FOUND` without the `ERR_` prefix is the CommonJS loader's property name and
appears in ordinary logs.

Two parsers for one file is the same defect in a different place. The runner was strict
and the check was loose, so a branch could declare a proof one reader honoured and the
other refused — and the looser reader is the one that decides what CI overlays, so the
looser half won by default.

The two limits are the plainest of the three: `spawnSync` defaults to a 1 MiB buffer and
to no timeout at all, so a suite that was merely noisy was reported as a broken command,
on a check whose entire job is reading that output, and a command that hung hung the job
until the workflow's own limit.

## Cost

**The signature has never been tuned against real output, because it has never seen
any.** Every judgement `STRUCTURAL_SIGNATURE` has made on this repository until now was
made on output the header had already been truncated out of. Turning it on is therefore
the first measurement, not a refinement of an existing one: the shapes it will now match
in this repository's own suite are unknown until a red run produces them. The direction
fails closed — a run that used to pass may now be refused — which is the safe direction
for a gate and the expensive one for a green build.

**The first thing it caught was itself, and the cost of that is a vocabulary.** Measured
on the branch that lands this item: `node ci/negative-control.mts --base origin/main
--head HEAD --branch fix/297-negctl-structural-signature` came back `pass` **with** the
structural `warning:`, and nothing structural had happened. Two case names in
`tests/negative-control-structural.test.mts` quoted `Cannot find module` literally;
`tests/run.mts` prints a file's `N passed, M failed` line immediately above its `FAIL`
lines with no blank line between, so a case name and the overlaid file's own name sat in
one diagnostic block — which is all `structuralInOverlay` asks for. `attributeFailures`
ranks a mention against an owner ([item 27](0027-a-pass-names-the-file-the-overlay-placed.md));
`structuralInOverlay` does not. The names were changed rather than the check (commit
`4c16c02`, `fix(tests):`), because changing the check is a second contract change and
this item already carries three. The re-run of that same command afterwards reports `pass`
with no `warning:` line at all.

**So the accepted cost is that a case about `Cannot find module` may not say
`Cannot find module` in its name.** A check whose own vocabulary is unusable in the names
of the cases that test it is a bad trade, taken knowingly: the alternative was a false
`structural` on an honest red, in the very pull request that makes the signature fire.
The gap is filed as **#390**, which asks whoever takes it to restore those two names as
the proof the fix works. It is a gap this change did not invent but made *reachable* — a
fail-open path nobody can reach cannot be measured, and until the signature fired on this
repository's own output nobody could.

**The two flags are configuration that can silence the limit they impose.** An override
can raise `AGENTIC_RUN_MAX_BUFFER` or `AGENTIC_RUN_TIMEOUT_MS` until it stops limiting
anything, which is a repository variable reintroducing the unbounded run the defaults
remove. That is invariant 4's bargain — detection is a default, never a contract, and the
override path is env — and the bargain is being taken here knowingly: without an override
neither limit could be reached by a case, and a limit no case reaches is a second comment.

**One half of the divergence is left standing.** The two readers agree on what a
declaration *means* and still disagree on *where it lives*: the runner honours the
adoption record's `proof.dir`, the check hardcodes `proof/`. Closing that means moving
`scripts/lib/adopt/record.mts` under `ci/`, because `scripts/init.mts` does not copy
`scripts/` into an adopting repository. It is named in `ci/lib/proof.mts` and in
`proof/README.md` rather than left to be rediscovered, and filed as **#391** — which asks
whether any repository has ever set `proof.dir`, since that is what decides whether this
half is latent or live.

**Deferred, on purpose:** the `negative-control` row of `docs/workflow.md` lists that
check's `cannot-run` causes and, at `3ab6d3d`, still names neither of the two this item
adds and neither run limit: `git grep AGENTIC_RUN_ -- docs/workflow.md` finds nothing.
It is #379's, the sweep that holds that file, because #310 held it while #297 ran and two
open pull requests on one file is how a clean merge silently invalidates something.
`proof/README.md`, the sharper of the two because it stated that the check does not read
`describes` at all, is corrected in this same diff.
