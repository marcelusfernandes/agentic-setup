# 0026. The changed paths decide the review exemption; the `type:docs` label no longer does

Status: proposed
Date: 2026-09-18

Landed with #308 (this pull request), which implements the rule below in the same diff. It
is written here rather than left in that pull request's body because it changes **what
makes a merge succeed or fail** — mode `docs` is no longer reachable on a label alone, and
two refusal codes, `docs:label-mismatch` and `gh-pr-files`, exist that did not — and
"a check, or what makes one pass or fail" is one of the five categories
[`README.md`](README.md) lists.

This item lands `proposed`, like every dated item since 0021. The orchestrator granted the
three documentation files this pull request touches (#308, `## Files`, 2026-09-18) and that
grant is a grant of scope, not an acceptance: [`README.md`](README.md) ("Silence never
accepts") reserves `accepted` to an explicit written OK from the person running the loop,
and no such OK exists for this item. The pull request that flips this line will cite where
that OK was written.

## Decision

**`scripts/land.mts` enters mode `docs` only when the pull request's changed paths are all
documentation paths *and* it carries `type:docs`. A `type:docs` label on a diff that leaves
those paths is a named refusal, not a merge and not a silent fall back.**

What is in force, as `scripts/land.mts` implements it:

- **The read.** `changedFiles` (`scripts/land.mts:362-367`) runs
  `gh api repos/{owner}/{repo}/pulls/<pr>/files --paginate --jq .[].filename`, once per run,
  after the rules read and before the mode is selected (`:517`).
- **The classes.** `DOCS_PATH_GLOBS` (`:281`) is
  `['docs/**', '.github/**', 'templates/**', '.claude/**', '*.md', '**/*.md']` and
  `NEVER_DOCS_GLOBS` (`:290`) is `['.github/scripts/agentic/**']`. A path is a
  documentation path when it matches the first and not the second (`isDocsPath`, `:369`).
  These are the negative control's own classes — `SKIP_PATH_GLOBS` and `NEVER_SKIP_GLOBS`,
  `ci/negative-control.mts:131` and `:138` — mirrored rather than imported, because that
  file runs its check at import time (`ci/negative-control.mts:145`) and exports nothing.
  `tests/land.test.mts` pins the two copies against a list it writes out itself, so drift in
  either fails a test (CLAUDE.md invariant 10). Consolidating the constant into `ci/lib/` is
  filed as its own change; the pin is what makes deferring it safe.
- **`AGENTIC_SKIP_GLOBS` is not read here.** It extends the negative control's list from the
  environment. `land.mts` ignores it, and two cases in `tests/land.test.mts` hold that:
  the source carries no such read, and setting the variable does not buy the exemption.
- **Both conditions, or neither.** `docsOnly` (`:523`) requires a non-empty list every entry
  of which is a documentation path; `mode` (`:527-533`) is `docs` only when `docsOnly` and
  the `type:docs` label are both true. A docs-only diff with no label is mode `agent` and
  still owes its `<!-- agentic-reviewed-sha: <oid> -->` marker.
- **The mismatch refuses, and is named.** `type:docs` with a diff that is not docs-only
  refuses `{ refused, pr, missing: ['docs:label-mismatch'], mode }` (`:559-571`), naming
  every path outside the classes and the mode that applies instead. It fires at mode
  selection, before the `state` and `review:approved` conditions, because there is no mode
  the pull request can land under until the label or the diff changes.
- **An unreadable file list refuses on its own code.** `missing: ['gh-pr-files']`,
  `mode: null` (`:543-550`), before any mode is selected and before any merge call. A file
  list that cannot be read is not a docs-only diff. An empty list is not one either, and
  takes the mismatch refusal with wording for the empty case (`:562-564`).
- **Nothing else changes.** The exemption is still from the *review* and never from the
  checks; modes `agent` and `approved` are untouched; the gate, the `--match-head-commit`
  pin, the conflict and mergeability refusals and the `--wait` behaviour all stand.
- **The documents that carry it.** [`../workflow.md`](../workflow.md) states that the label
  no longer decides the exemption and that the paths do, in the labels-reading section, the
  mode list, the merge paragraph and the `missing` enumeration.

## Reason

**The label was an override, not a relaxation.** Mode was selected with `isDocs` first, so
`type:docs` beat a base branch whose effective rules require an approving review: the one
condition that a repository can configure to insist on review was reachable past by a label
any agent's orchestrator applies. The label is applied per issue and the paths were never
consulted, so the two disagreed whenever a docs issue touched anything else.

**Measured, twice.** On 2026-09-17: four decision-register pull requests — #189, #195, #200
and #218 — merged carrying `type:docs` with zero reviews and zero review comments, three of
them changing `../decisions.md`, the register the review gate exists to protect. On
2026-09-18/19, worse: of four pull requests landed, `land.mts` printed `mode: docs` for
three — #333, #334 and #346, one of them carrying eight milestone closeouts, the evidence
six phases close on. All three had in fact been reviewed by an isolated reviewer and carried
the marker. The gate was satisfied by the orchestrator's discipline — which had come to
include stripping the label before landing — not by the code. A habit standing in for a
control is the thing this register exists to notice.

**The negative control already decided by path class, and for this reason.** Item 21 and
#135 moved that check off the PR's own labels, because the implementer applies its own PR's
labels and a `type:` label could therefore buy its own exemption. `land` was the last gate
still deciding by label alone, and it is the gate with the larger consequence: the negative
control's label bought a skipped test, this one bought a skipped review.

**The label stays necessary as well as the paths, and that is the load-bearing choice.**
The acceptance criterion says the mode is computed "from the pull request's changed paths,
not from `type:docs`", which read literally would let the paths select mode `docs` on their
own. That reading was rejected. It would newly exempt *every* docs-only pull request from
review — including ones an orchestrator deliberately left unlabelled so they would be
reviewed — and it would do so in the change whose entire subject is a review gate that was
too loose. Requiring both is tightening-only: no pull request that owes a review today stops
owing one, and the override is still gone, because the label can no longer reach mode `docs`
without the diff agreeing. The correct reading of an issue about a gate that was too loose
is the one that cannot loosen it further.

**The mismatch is a refusal rather than a quiet fall back to `agent`, for the same reason
the register exists.** Falling back would land the pull request correctly and leave the
wrong label on it — the label would become inert, and an inert label hides the disagreement
exactly as thoroughly as the override did. Three of tonight's four merges are what that
looks like: each was in fact reviewed, and nobody could tell from the output. A refusal
makes a person or the orchestrator say which the pull request is.

**The read is REST and paginated deliberately.** `gh pr view <pr> --json files` is the
shorter call, but it is GraphQL and asks for one page, so a pull request whose first hundred
entries are Markdown would read as docs-only however much code followed them. This is the
one read here whose incompleteness silently *widens* an exemption, so it is the one read
that must not be capped. REST also answers when the shared GraphQL budget does not.

## Cost accepted

**One more `gh` call on every run, including the ones that refuse early.** `land` now makes
one more read than before, on the refusal paths as well as the merge path, because the mode
must be nameable on every output (item 20). REST and paginated, so it is the cheapest of the
reads against the shared budget; whoever pays it pays it once per land.

**Every mixed `type:docs` pull request now refuses at least once.** The orchestrator's
habit of stripping the label before landing becomes the mechanism's demand, and the first
few refusals will read as a regression to whoever was relying on the old behaviour. That is
the point of the change, and the refusal names the paths so the remedy is a one-line
decision rather than an investigation. Who pays: the orchestrator, once per mislabelled
pull request, until labelling matches diffs.

**A `type:docs` pull request that is closed, or otherwise unmergeable, now reports the label
mismatch rather than the more fundamental thing.** The mismatch fires at mode selection,
before the `state` check, so a CLOSED pull request with a mismatched label says
`docs:label-mismatch` and not `state=CLOSED`. That ordering is deliberate — there is no mode
to judge the other conditions under — but it is a worse first line for that one case.

**Two copies of the path classes exist until the consolidation lands.** `SKIP_PATH_GLOBS`
and `DOCS_PATH_GLOBS` must agree, and "two lists that must agree" is a defect shape this
repository has findings about. The mitigation is a pin, not care: `tests/land.test.mts`
writes the six globs out itself and reads both source files from disk, so drift fails a
test rather than a merge. The cost accepted is the duplication itself, for as long as the
consolidation is deferred, and it is deferred so that a change to the *review* gate and a
change to what the *negative control* reads are not in one pull request.

**The refusal line grows with the diff.** Every path outside the classes is named, joined
with commas, on one line. A very large mixed diff produces a long refusal. Consistent with
the file's other single-line JSON refusals, and the alternative — naming only the first —
would hide how far outside the diff reaches.

## Supersedes

`nothing`. It narrows item 6 of [`../decisions.md`](../decisions.md), whose `docs` class
reads "labelled `type:docs`, in practice only touching `docs/**`, `CLAUDE.md`, …" — the
"in practice" is now enforced rather than observed — and item 20, whose `docs` mode entry
describes the exemption as the `type:docs` exemption. Neither is replaced: their modes,
gates and reasoning all stand, and each gains a cross-reference to this item when the sweep
of the downstream documents lands.

## Updates

None yet.
