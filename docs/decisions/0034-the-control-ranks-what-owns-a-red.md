# 0034. A `structural` verdict rests on a diagnostic that owns the red, not on one that mentions a path

Status: proposed
Date: 2026-09-20

Landed with the pull request that closes #412, which implements the rule below in the same
diff. It is written here rather than left in that pull request's body because it changes
**what makes a required check pass or fail**: runs that report `structural` and exit 1
today report `pass` and exit 0.

#412 is a consolidation sweep over four absorbed issues, and it owes **one** numbered item
rather than four. This item covers the one rule change the sweep makes — what a
`structural` verdict rests on. The sweep's other change, moving the documentation path
classes into `ci/lib/skip-paths.mts` so both gates read one list (#370), is recorded as a
**note** at the end: it moves no boundary and no verdict, and the register's own rule
("What stays a note") keeps it out of the item. The two rule changes the sweep did *not*
make — what an attribution rests on (#380) and where a declaration is resolved (#391) — are
named under "What this item does not cover", so a later item is not read as a correction of
this one.

This item lands `proposed`, like every dated item since 0021.
[`README.md`](README.md) ("Silence never accepts") reserves `accepted` to an explicit
written OK from the person running the loop, and no such OK exists for this item.

## Decision

**A diagnostic block makes the overlaid run `structural` only when something in that block
*owns* the structural signature.** `structuralInOverlay`, now in
`ci/lib/attribution.mts`, counts a block when either:

- a line carrying the signature (`Cannot find module`, `ERR_MODULE_NOT_FOUND`,
  `SyntaxError`, `does not provide an export named`) **also names** one of the overlaid
  paths — the shape a missing module prints,
  `Error: Cannot find module '/…/scripts/added.mts'`; or
- the block carries the signature on one line and **locates** an overlaid file on another,
  as `<file>:12` or a `file://` URL — the shape a missing export prints, where the
  signature line names the *imported* module and only the header two lines above says
  which file failed to load.

**A mention is not an owner.** A line that merely contains an overlaid path anywhere — a
test case whose own *name* quotes one, of which this repository writes nineteen — no longer
makes the block structural. **Nor is a per-file verdict line** (`one.test.mts: 0 passed, 2
failed`): it owns an *assertion* red and says nothing about whether the file loaded.

**The two rankings stay separate functions and disagree on exactly that point.**
`attributeFailures` reads a per-file verdict line as an owner, because for an assertion red
it is one; `structuralInOverlay` does not, because loading is a different question from
failing. Both now live in `ci/lib/attribution.mts`, which is pure and directly importable
under invariant 6, and both are tested there as well as through the real check.

**Consequence, stated as a verdict change.** An overlaid run whose only structural evidence
is a mention, over ordinary assertion failures, reports `pass` and exits 0 where it reported
`structural` and exited 1. No run that reported `pass` before reports anything else: the
rule is strictly narrower than the one it replaces.

## Reason

`structuralInOverlay` asked two independent questions of a block — does any line carry the
signature, does any line name an overlaid path — and never asked whether they were the same
evidence. `ci/negative-control.mts` already knew better one function further down: the
comment on `overlayNames` names the prose-mention hazard in full and says both costs are
"answered by ranking the evidence in `attributeFailures` rather than by narrowing the
match". The ranking was written in one function and not in the other.

The gap is not theoretical, and the tree carries its scar. `tests/run.mts` prints
`<file>: N passed, M failed` and then writes that file's own output immediately after it
with no blank line, so a failing case, the file's verdict line and the aggregate all land
in **one** diagnostic block. A case whose name quotes `Cannot find module` therefore put the
signature and an overlaid file's name in the same block without anything in it blaming that
file. Measured while implementing #297: this repository's own honest red was reported
`structural`, and the implementer renamed two cases in
`tests/negative-control-structural.test.mts` — `a failure's detail carries the
\`Cannot find module\` header` and `an overlaid run whose harness output carries
\`Cannot find module\` is \`structural\`` — to buy a green run, recording the reason in a
comment (#390). Both names are restored in the same diff as this rule, and restoring them
is the proof it works.

The check errs closed in the direction that matters: a red the overlay did not earn is
still refused, because this changes only how a *structural* red is recognised, never
whether an unattributed one passes.

## Cost accepted

**A genuine structural red whose diagnostic neither names nor locates the overlaid file is
now read as an ordinary red.** It would have to be the implementer's own `test(red):`
business anyway — the verdict then rests on `attributeFailures`, which refuses a red no
overlaid file owns — but the specific "prefer a throwing stub" advice the `structural`
verdict gives is not printed for it. That direction is chosen deliberately: the old rule's
error was a *false refusal of honest work*, which stops a pull request, and the new rule's
error is a *less specific message on a verdict that still has to be earned*.

**One shape known to be missed, before and after.** Node prints a plain `SyntaxError` with a
blank line between the `file://` header and the signature, so the two land in different
blocks and neither rule sees it. That is pre-existing and untouched here; it is named so a
later reader does not mistake it for a regression this item caused.

## Supersedes

`nothing`. [Item 30](0030-the-structural-signature-sees-this-repositorys-own-output.md) made
the structural distinction fire at all on this repository's output; this item decides what
it fires *on*. Item 30's rule is unchanged and its vouch (`test(red):` in `base..head`)
still decides a genuine structural red.

## What this item does not cover

Two rule changes #412 asked for are **not** in this diff, and a later item owes them:

- **What an attribution rests on (#380).** `ci/negative-control.mts` still reports `pass`
  when the only overlaid evidence is a prose mention and no other file owns a red.
  Tightening it needs a corpus of real `jest`/`vitest`, `pytest` and `go test` failure
  output first — the issue's own instruction — because the strict rule would turn a false
  `pass` into a false refusal of honest work in every adopting repository. That corpus could
  not be produced here.
- **Where a declaration is resolved (#391).** `headDeclarationPath`
  (`ci/lib/proof.mts:182`) still hardcodes `proof/` while the runner honours the adoption
  record's `proof.dir`. The disclosure in that file's header and in `proof/README.md` is
  therefore left standing: the gap is open and the tree should keep saying so.

## Note (not part of the item): one list of documentation path classes

#370 asked for the six documentation path classes to stop being two literal copies.
`SKIP_PATH_GLOBS` now lives in `ci/lib/skip-paths.mts`; `ci/negative-control.mts` imports
it, and `scripts/land.mts` imports it as `DOCS_PATH_GLOBS`. The drift pin in
`tests/land.test.mts` is repointed at the single list and additionally asserts that neither
gate declares a second copy.

This is a note and not a numbered decision because it changes no contract: the same paths
are in the same classes before and after, both gates classify every diff exactly as they
did, and no verdict moves. What each gate *asks* of the list is unchanged and still
different — the check asks "does this diff owe a failing test", `land.mts` asks "may this
diff merge unreviewed" — which is why the two **carve-outs** stay separate lists and only
the class list is shared. `AGENTIC_SKIP_GLOBS` still extends the check's skip and is still
never read by `land.mts`. The new module sits on the `ci/` side of the adoption boundary,
where `scripts/init.mts` copies it into an adopting repository; `scripts/` is not copied,
which is why the shared list could not live there.

## Updates

*(none yet)*
