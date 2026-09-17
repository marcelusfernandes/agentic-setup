# 0001. The decision nudge stays a warning, over five mechanism globs

Status: accepted — written OK: the owner's decision comment on issue #180 (https://github.com/marcelusfernandes/agentic-setup/issues/180#issuecomment-5708342223), recorded by the orchestrator under the standing M11–M16 delegation on #161, which the owner may veto by reopening the issue.
Date: 2026-09-17

## Decision

The `scope` check's decision nudge stays a `warning:` that never fails the check, with no
end date and no follow-up `feat(ci)` issue to make it blocking. Option (a) of #180; options
(b) — a failure once every item carries a `Status:` line — and (c) — a failure for `hooks/`
and `ci/` only — are both refused.

What is in force, as `ci/lib/scope.mts` already implements it since #196:

- **Sensitive paths.** `MECHANISM_GLOBS` (`ci/lib/scope.mts:171`) is the closed list
  `hooks/**`, `ci/**`, `scripts/**`, `skills/**/SKILL.md`, `.github/workflows/**`. The
  fifth glob is confirmed in: a workflow file is as much a mechanism as the check it runs.
  `tests/**` and `templates/**` stay out — a test changes what is proven, not what the next
  agent is bound by, and `templates/**` is the copy shipped to another repository, where
  the decision belongs to that repository's register.
- **What silences it.** Any path under `DECISION_GLOBS` (`ci/lib/scope.mts:176`) —
  `docs/decisions.md` or anything under `docs/decisions/` — in the same diff.
  `decisionNudge` (`ci/lib/scope.mts:191`) then returns nothing.
- **Strength.** `ci/scope-check.mts:216` composes the warning line, and the nudge is
  computed whatever the other rules decided and is never folded into `ok`: a diff that
  changes a mechanism and records no decision still exits 0 and still merges.
  `docs/workflow.md:178` states the same thing in the `scope` row of the checks table.

No check changes in this PR. This file records the answer #180 asked for; the mechanism it
describes landed with #196.

## Reason

A required check cannot tell from a file name whether a change binds the next agent.
`scope` is one of the three required checks on `main` (`docs/workflow.md:178`), so a nudge
that failed would gate every PR touching `hooks/`, `ci/`, `scripts/`, `skills/**/SKILL.md`
or `.github/workflows/**` on a judgement the check is not able to make — a typo fix in a
comment inside `ci/scope-check.mts` is a mechanism file by name and no decision by
substance.

That is the mistake a sibling project already paid for: as the owner's decision comment on
#180 cites, `lohra-ts`'s dogfooding trigger fired "by file name" and cost a full lost round
on two trivial PRs (lohra-ts #684 and #685), and was replaced by a closed list of
substantive keys in lohra-ts #687. The same failure mode is available here at the same
price, and the same remedy — judge on substance, not on the path — is why the nudge is
advisory.

The binding half is not dropped; it is placed where a judgement is possible. Invariant 8 of
`AGENTS.md:55` ("Docs equal code: a change to a hook, flag, label or check updates `docs/`
and the relevant `SKILL.md` in the same PR") is the rule, `docs/decisions/README.md` says
what earns a number against what stays a note, and the reviewer reads the invariants of
`CLAUDE.md` against the diff (`agents/reviewer.md`, "Check, in this order", step 4). The
milestone closeout is meant to carry the second half — see the cost below for how much of
that exists today.

This is also the shape the register already chose once: item 12 of `../decisions.md` made
issue-time entry-point warnings advisory rather than a gate for the same reason, and item 13
kept that choice while trimming the loop to its core.

## Cost accepted

**A mechanism change can merge with no decision entry.** If both the reviewer and the
milestone closeout miss it, the warning is the only trace, and a warning nobody has to
answer is how a gap survives — the risk #180 was opened to weigh. The loop accepts it
rather than pay the false-positive cost of a name-based gate.

**Half of the compensating control is a commitment, not yet code.** At this commit:

- `agents/reviewer.md` names no decision entry of its own; the nudge reaches the reviewer
  only through step 4, "Invariants: whatever `CLAUDE.md` names as such", and invariant 8.
- `scripts/close-milestone.mts` does not exist in `scripts/`. It is named as the closeout
  script by `docs/closeout/README.md:51` and `tests/provenance.test.mts:40`, and the
  closeout format at `docs/closeout/README.md:55-70` has `## Issues`, `## Left out` and
  `## Dogfood` — no decisions section for it to refuse on (#209 is open on making the
  closeout evidence file a required step).

So the sentence "the closeout refuses without the decisions section filled" is what this
decision commits to, not what runs today. Until it runs, the reviewer and invariant 8 are
the whole of the binding half.

**Revisit trigger.** After the first milestone closed through `close-milestone.mts`. That
closeout is the first evidence of how often a mechanism change reaches `main` with no
decision recorded; if it is often, this item is superseded rather than argued about again.

## Supersedes

`nothing`.

## Updates

None yet.
