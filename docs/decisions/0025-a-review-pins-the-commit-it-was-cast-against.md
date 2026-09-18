# 0025. In mode `approved`, the server's review pins the commit it was cast against

Status: proposed
Date: 2026-09-18

Landed with #238 (this pull request), which implements the rule below in the same diff. The
rule is written here because it binds the next agent rather than because it explains that
diff: it changes **what makes a check pass or fail** — a merge in mode `approved` now
refuses a head the server-side review did not cover, and a new refusal code,
`gh-pr-reviews`, exists — and that is one of the five categories
[`README.md`](README.md) lists.

This item lands `proposed`, like every dated item since 0021. The orchestrator granted the
five files it touches (#238, `## Files`, 2026-09-18) and that grant is a grant of scope, not
an acceptance: [`README.md`](README.md) ("Silence never accepts") reserves `accepted` to an
explicit written OK from the person running the loop, and no such OK exists for this item.
The pull request that flips this line will cite where that OK was written.

## Decision

**In mode `approved`, `scripts/land.mts` reads the commit the approving GitHub review was
cast against and refuses to merge a head that is not it. A reviews read that cannot answer
refuses with `missing: ['gh-pr-reviews']` and merges nothing.**

What is in force, as `scripts/land.mts` implements it:

- **The read.** `scripts/land.mts:433-434`, in mode `approved` only, runs
  `gh pr view <pr> --json reviews`. Mode `agent` makes no such read — its reviewer casts
  nothing on the server (item 18), so there is no `PullRequestReview` to read a commit off
  — and mode `docs` reviews nothing at all.
- **Which review counts.** `newestApprovedReviewOid` (`scripts/land.mts:233-241`) reads the
  list from the end and takes the **newest** entry whose `state` is `APPROVED`. That is the
  same rule `newestReviewedSha` (`:207-213`) applies to the marker comments, for the same
  reason: the newest is the one in force, and an older approval must not be reachable past
  a newer one.
- **What it must equal.** That entry's `commit.oid`, lowercased, must equal the
  `headRefOid` read in the first `gh pr view` of the run, or the run refuses with
  `missing: ['head:changed']` (`scripts/land.mts:446-456`). The refusal names the commit
  the review was cast against, so the operator reads which commit, not only that it was the
  wrong one.
- **A review that records no commit binds nothing.** An `APPROVED` entry whose `commit.oid`
  is absent, empty or not a full 40-hex oid yields `null` (`scripts/land.mts:235-236`), and
  `null` never equals a head — so it refuses, in the same shape a missing marker does. This
  is deliberate and load-bearing: see **Reason**.
- **The field is `reviews`, never `latestReviews`.** `gh pr view --json latestReviews`
  returns `commit: { oid: "" }` on every entry — measured with gh 2.83.1 against
  `cli/cli#14447`, `#14446` and `#14437`, human and bot reviewers alike — while
  `--json reviews` returns the real oid. The two are **not** interchangeable here, and the
  reason is recorded at `scripts/land.mts:52-57` and in the fixture comment in
  `tests/land.test.mts`, which are the two places the next person to "simplify" this will
  read.
- **The read fails closed.** `gh` answering non-zero, or with something that does not parse
  to an object carrying an array `reviews`, refuses with `missing: ['gh-pr-reviews']`
  (`scripts/land.mts:435-442`) and attempts no merge — invariant 3, and exactly what the
  comments read already did with `gh-pr-comments`.
- **It is added to, never instead of.** Mode `approved` still requires everything mode
  `agent` requires — the `review:approved` label, the marker comment equal to the head, and
  every required check in bucket `pass` — plus `reviewDecision === 'APPROVED'`. This item
  adds one condition to that list; it removes none, and it changes nothing in modes `agent`
  or `docs`.
- **Every output names its mode, the `{ error }` ones included.** The usage line prints
  `mode: null`, because it runs before a mode can be read (`scripts/land.mts:357`), and the
  merge failure, the clean-status retry failure and the disarm failure each print
  `{ error, pr, gate, mode }` (`:480`, `:486`, `:497`) — the shape `--wait` already used.
  Those are precisely the outputs an operator reads when no merge happened, and before this
  they were the only ones that did not say which binding had run.
- **The documents that carry it.** `docs/orchestration.md` step 5 and
  `skills/orchestrate/SKILL.md` name the new code in their `missing` enumerations and say
  that mode `approved` pins the server's review to the head; `docs/workflow.md` carries the
  same in its mode list and its own enumeration; `skills/init/SKILL.md` no longer says the
  label alone merges without the reviewer token.

## Reason

**A stale approval merged an unread head.** #216 bound the merge to the commit the review
approved, but the thing it read was the orchestrator's marker comment, and #255 (#156) then
ran that comparison in both modes. In mode `approved` that leaves the server's own review
unexamined: `latestReviews` and `reviews` appear nowhere in `scripts/land.mts` before this
change. So a review cast at commit A, a push to commit B, a fresh marker naming B, and the
merge goes through with `reviewDecision` still `APPROVED` — because GitHub dismisses a
stale approval only where the repository raised `dismiss_stale_reviews_on_push`, and
`scripts/init.mts --rules --require-review` raising it does not make it true of every base
branch `land` may run against. The marker says what the *orchestrator* reviewed. It has
never said what the server-side reviewer reviewed, and mode `approved` exists precisely
because someone wanted the second answer.

**The marker cannot stand in for it, and this is the narrow point.** `scripts/land.mts`
reads the marker's oid and not its author (item 24's deferred half, and the question #156
and #237 carry): any identity that can comment on the pull request can write one. Mode
`agent` accepts that, because in that mode the marker is the whole record of the review and
the orchestrator is the only thing that writes it. Mode `approved` is opt-in and costs a
second login precisely to buy a record the merging identity did not write — and until this
item, the one commit that record actually pins was the one thing `land` did not read from
it.

**An empty oid must refuse, or the gate is inert rather than absent.** This is why the
`latestReviews` measurement is in the decision and not only in the commit message. Had the
implementation read `latestReviews`, every comparison would have been `"" !== <head>` — a
gate that looks present in every review of the code, passes no pull request, and would have
been "fixed" by loosening the comparison. Treating a review that records no commit as a
refusal keeps the failure loud in both directions: the wrong field refuses everything
instead of merging everything.

## Cost accepted

**One more `gh` call on the mode's happy path, and one more way for it to refuse.** Mode
`approved` now makes four reads before it merges rather than three. A GitHub outage that
answers the PR view and the comments view but not the reviews view turns a mergeable pull
request into a `gh-pr-reviews` refusal. That is the invariant-3 trade this file makes
everywhere: whoever pays it re-runs `land`.

**A repository without `dismiss_stale_reviews_on_push` now feels its absence at merge time
rather than never.** Before this item such a repository merged on a stale approval silently.
After it, the merge refuses `head:changed` and someone has to re-review at the new head —
which is the point, but it is a round trip that did not exist, and it will read as a
regression to whoever was relying on the old behaviour. The remedy is to raise the setting,
which `scripts/init.mts --rules --require-review` already does, so the refusal is loudest
exactly where the installer was not run.

**"Newest approving review" is a choice, and it is the conservative one.** With two
approvers, Alice at the head and Bob at an older commit afterwards, this refuses. The
alternative — any `APPROVED` review whose commit equals the head — would merge it. The
conservative reading is taken because it matches what the marker comparison next to it
already does, and because the failure of the permissive one is a merge; the failure of this
one is a round trip. Who pays: a repository with more than one reviewer, which this one is
not. If that changes, it changes here, with a case in `tests/land.test.mts` for the exact
ordering.

**The author question is still not answered, and this item does not answer it.** Nothing
here checks *who* cast the approving review, any more than anything checks who wrote the
marker. A single-login repository (item 18, #148) cannot distinguish them at all. This item
narrows mode `approved` to a record the server keeps; it does not establish whose record it
is. That remains #156's and #237's, and `scripts/land.mts`'s header says so where it says
the marker binds a commit and not a person.

## Supersedes

`nothing`. It extends item 20 (#156), whose `approved` bullet reads "everything `agent`
requires *plus* `reviewDecision === 'APPROVED'`" and is now one condition short; that bullet
gains a cross-reference to this item in the same pull request. Item 20 is not replaced — its
modes, its gate and its `--match-head-commit` reasoning all stand.

## Updates

None yet.
