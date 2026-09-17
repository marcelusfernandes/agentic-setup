# Decisions

The reasoning behind the loop, condensed. Each item is a decision, its reason, and
what it costs.

[`decisions/README.md`](decisions/README.md) is the rule this register runs by: what
becomes a numbered decision rather than a note, what the three `Status:` values mean
and who may move an item between them (silence never accepts one), and where a new
decision lands — items 1 to 13 keep their numbers here, and a decision after them is one
dated file under `decisions/`. Four pieces of later material are still in this file and
are not what the rule prescribes: items 16, 18 and 19, and the dated note under item 13.
The index in [`decisions/README.md`](decisions/README.md) says which item lives where.

## 1. Unit of work: a GitHub sub-issue

Status: accepted

Child of the milestone's parent issue. Declares **file globs**, dependencies
(`Blocked by #N`), verifiable acceptance criteria and its proof. The orchestrator, as
planner, writes the sub-issues — it is owned work, not implicit.

*Why:* an agent can only be held to what is written down where it can read it. The
issue is the only channel that survives context loss.

## 2. Claiming: the remote branch is the lock

Status: accepted

The orchestrator pushes `<type>/<n>-<slug>` from `origin/main`; the push of a new ref
fails if it exists. Then it assigns and flips the label. With one orchestrator this is
belt and braces; with two, the ref is what holds.

## 3. Isolation: one worktree per issue

Status: accepted

`isolation: worktree` on the implementer. A worktree is born with tracked files only,
so whatever is gitignored and needed (env files) is copied in by a versioned include
list, and the implementer's step 0 proves it arrived. Forbidden: `stash`, `reset --hard`,
`clean`, force-push. `rebase` only before the first push; once published, conflicts
with `main` are resolved with `merge origin/main` — rebase there would need a
force-push, which is denied everywhere.

## 4. Merge without a human

Status: accepted

PR to `main` with `Closes`/`Fixes`/`Resolves #N` (several issues may be linked; the diff
must stay inside the union of their globs; a keyword inside backticks or a fence is
ignored); squash when the checks pass and the reviewer returns
approved. **No up-to-date-branch requirement** — CI runs again on `main` after the
merge; rebase only on conflict. Two failed rounds become `state:blocked` **with the
`human` label**, and the orchestrator moves on.

*Cost accepted:* no human review per PR. Quality rests on the checks being truly
blocking and on the negative control being verified by CI, not by the agent.

## 5. Parallelism

Status: accepted

Up to four issues in flight, with non-intersecting globs. Schema or contract changes
are their own issues, opened first; features that need them are born blocked.

## 6. PR classes

Status: accepted

- `feature` / `bug`: checks + reviewer.
- `db` / schema (or your equivalent serialised class): same, one at a time.
- `docs` (labelled `type:docs`, in practice only touching `docs/**`, `CLAUDE.md`,
  `.claude/**`): lint CI, `land.mts` merges without a review — it reads the PR's label,
  not its path.
- `deps`: only the orchestrator; manifest and lockfile.

## 7. Restart

Status: accepted

On start, the orchestrator reconciles from GitHub, not memory: `in-progress` with no
PR and no remote branch goes back to `ready`; `in-review` with green CI and an
approved review is merged; an orphan worktree is deleted. A pass that finds nothing to
do posts what is blocked on the parent issue.

## 8. Explicit human points

Status: accepted

Approving these decisions (explicit OK; silence does not approve); secrets and
variables; the main-protection choice below; anything that needs hardware or accounts
the agent lacks; production cut-overs; any `state:blocked` issue.

*2026-09-10 (#110, #111; renamed by #116 on 2026-09-11):* the single `human` label became two exclusive states.
`human:pending` is the gate (`reconcile.mts` keeps it out of `ready`, `claim.mts` refuses
it); `human:decided` is set by the person who decided and never removed, so an issue
that needed a person stays traceable from its labels. A bare `human` from before the
split is read as pending. Earlier items above keep their original wording.

## 9. Single trunk, and how `main` is protected

Status: accepted

`main` is the only trunk. Protection has three layers; use as many as your plan allows.

- **(a) Server-side, preferred:** a GitHub ruleset on `main` — PR required, required
  checks (`scope`, `negative-control`, and the adopting repository's own test workflow),
  no force-push, no deletion. `node scripts/init.mts --rules` is the way in: it reads
  `repos/{owner}/{repo}/rulesets`, updates (PUT) the ruleset that already governs the
  default branch — found by its conditions, whatever it is named — or creates (POST) one
  named `agentic-setup` when none does, reporting `= ruleset updated` or
  `+ ruleset created`. It resets `required_approving_review_count` to 0 and carries the
  ruleset's own stale-approval fields through; `--require-review` is the explicit opt-in
  that raises that gate to one approving review, and item 13 is why it waits for a second
  identity. Free on public repositories and on paid organisations; **not available
  on private repositories under the free plan** (rulesets and branch protection return
  403 there) — `--rules` reports that as `! ruleset: not available on this plan for a
  private repository` rather than surfacing `gh`'s raw error, and refuses to fall back to
  anything silently: make the same three checks required by hand instead.
- **(b) On every machine that runs Claude Code:** the plugin's `protect-main.mts` hook
  plus the permission deny list `/agentic-setup:init` writes (force-push, `reset --hard`,
  `clean`, `stash`, and — since item 14 — any `gh pr merge`, not just `--admin`). Covers
  what goes through Claude Code; does not cover a push from elsewhere.
- **(c) Detection:** the `guard-main` action. The commit → PR lookup retries up to 4
  times, 15 seconds apart (about 45s of tolerance): right after a squash merge the
  association can still be unindexed, and a single call risks a false `human:pending`
  issue for a commit that did come from a PR (#80). A `gh api` error is retried the same
  way as an empty result. Once the retries run out without finding a PR, it opens an
  issue labelled `human:pending` and fails the run, so the history turns red and someone
  looks; if the lookup itself was still erroring on the last attempt, the issue says the
  lookup failed rather than claiming a confirmed direct push. The escape hatch is a
  commit message containing `[allow-push-main]`, for bootstrap only.

The merge gate itself is (a) when it exists: `scripts/land.mts` queues `gh pr merge
--squash --auto` once the base branch's ruleset has a `required_status_checks` rule, and
falls back to reading `gh pr checks --required` itself only where no such rule is
present. Keep (b) anyway even with (a) in place — the hook is a fast, cheap round-trip
saver on the agent's machine (denying an obviously forbidden command, including any
hand-typed `gh pr merge`, before it ever reaches the server), not a substitute merge gate;
that judgment is `land.mts`'s alone (items 13 and 14).

## 10. Negative control is the load-bearing check

Status: accepted

Every feature PR carries a `test(red):` commit. CI checks out the PR's base, applies
only the test files from the diff, runs the test command and requires a failure. A PR
whose tests pass without its change has proven nothing; this job is what makes "merge
without a human" honest rather than hopeful.

## 11. Every mutating orchestrator step is a script with a refusal path

Status: accepted

Every orchestrator step that mutates GitHub — locking an issue, dispatching one, merging a
PR — is a script that reads live state and refuses rather than guessing, not a prose
instruction the model is trusted to follow correctly under load: `scripts/claim.mts`
(lock), `ci/issue-lint.mts` (dispatch gate), `scripts/land.mts` (merge). The model still
plans and decides which issue to pick, which PR to send back, whether to wait; the script
verifies the precondition and performs the write, and prints what it refused and why
instead of a stack trace or a silent no-op.

*Why:* two M1 incidents, both from a step that was prose with nothing between its arrows
verifying anything.
- **#25's premature "done".** Step 5 read "green checks and `review:approved` → merge →
  label the issue done → remove the worktree". In PR #28 (closing #25) the orchestrator
  ran `gh pr merge`, the server refused it (a label change had re-triggered a required
  check, so its latest run was no longer the one the orchestrator had seen), and the
  orchestrator marked the issue done by hand anyway — `scripts/reconcile.mts` exposed the
  inconsistency a minute later. Today `scripts/land.mts` closes this without a relabelling
  step to get wrong at all: it queues `gh pr merge --squash --auto` and lets `Closes #N`
  close the issue only once GitHub itself merges the PR (item 13).
- **#3's missing glob.** Nothing checked, before dispatch, that an issue's `## Files`
  covered every file the change would touch — `scope-check` only enforces the boundary
  *after* the diff exists. Issue #3 renamed `tests/smoke.mts` to `tests/run.mts` inside its
  `tests/**` glob, while `.github/workflows/test.yml` referenced the old path from outside
  it; fixed inside the same PR under an `authorised:` grant on the workflow file, not by
  any check. That gap now has a mechanical, PR-time check instead of an issue-time
  warning: `ci/scope-check.mts` fails a PR that deletes or renames a tracked path still
  named by another tracked file outside the diff, unless the referencing file is inside
  the linked issue's globs or granted with `authorised:` (item 13, #51).

*Cost accepted:* one more script to maintain per mutating step, each with its own test
file and its own refusal shapes to keep in sync with the skills that call it.

## 12. Issue-time entry-point warnings are advisory, not a gate (superseded — see item 13)

Status: superseded by item 13

`ci/issue-lint.mts`'s AC4 used to warn when a tracked file outside an issue's `## Files`
named a path the issue's globs cover — the check #3's shape needed (item 11 above). But
the same `git grep` fired on every reference, not only the ones a diff would break: at
issue time, before the diff exists, it could not tell a rename or removal from an
in-place edit. Folding the warning into a hard failure by default for
`type:feature`/`type:bug` (the original plan) would have blocked every bug or feature
that touches an already-documented or already-imported file. In the 2026-09-06 pass,
#41 (nine warnings: workflows, docs, skills, `ci/lib/issue.mts` naming
`ci/issue-lint.mts`) and #42 (three warnings: imports of `ci/lib/globs.mts`) both edit in
place and rename nothing, so no widening of `## Files` short of listing every file in the
repository that references them could have turned the warning off — and that widening
would have overlapped every other issue in the milestone's globs.

*Decision (2026-09-06, by the person running the loop):* the entry-point warning stayed,
but only behind an opt-in flag on `ci/issue-lint.mts` and `scripts/claim.mts`, never
applied by issue type. The orchestrator read every warning itself: a path the issue
renames or removes got `## Files` widened before dispatch; any other warning — an
in-place edit or import, like #41 and #42 — was logged as a one-line classification on
the issue when it was dispatched.

**Superseded, same date, second pass (item 13, #71):** the audit that produced item 13
found the check itself undecidable at issue time, not merely too strict by default — the
same `git grep` cannot distinguish the shape it exists to catch (a rename that drops a
reference) from the overwhelming majority of hits it actually produces (an ordinary
in-place reference). Keeping it opt-in did not fix that; it only meant nobody was forced
to read the noise. `ci/issue-lint.mts` dropped the warning and the flag entirely and
checks the issue's contract only now (sections, globs, disjointness, `Blocked by:`
numbers); the mechanical form of the #3 gap moved to PR time instead, where a diff
exists to tell a rename from an in-place edit (item 13).

## 13. The 2026-09-06 audit: trim to the core, and a separate reviewer identity

Status: accepted

*Trigger:* the maintainer asked for an independent, sceptical audit of overengineering —
an opus agent with no history on this project, reading the code (not just the docs).
Kept verbatim as an appendix: `docs/research/2026-09-06-auditoria-overengineering.pt-BR.md`.

*The audit's core finding:* the project had grown client-side re-implementations of
checks GitHub already enforces server-side — a shell scanner and a merge gate inside
`protect-main` duplicating the ruleset; a Stop/SubagentStop hook (`stop-gate.mts`)
duplicating CI; `reconcile.mts`'s own status-rollup dedupe duplicating `gh pr checks`;
`land.mts`'s polling, relabelling and worktree removal duplicating auto-merge, `Closes
#N` and step 0 of the orchestrator loop — plus an issue-time lint that could not decide
what it was warning about (the entry-point warning and its opt-in flag, item 12), and a
Bun test leg that was a claim rather than a requirement (§ "Where this comes from" never
named a version, and no test had ever failed under Node and passed under Bun, or the
reverse). The one genuinely under-built thing the audit named: the reviewer and the
merging identity shared one token, so `review:approved` was a label the same identity
that ran `land.mts` could write itself. **Item 18 supersedes this item's answer to that
one finding** — what the label was missing was a binding to the commit that was reviewed,
not a second GitHub identity; everything else in item 13 stands.

*Choice* (the maintainer's, from three options laid out in the audit — (a) keep as is,
(b) trim to the core, (c) markdown + shell only): **(b), plus the land model of (c)** —
delete the duplicates, keep `.mts` scripts for the orchestrator's mechanical steps
(`reconcile.mts`, `claim.mts`, `land.mts`, `issue-lint.mts`) and the CI checks (`scope`,
`negative-control`), and make `gh pr merge --auto` plus the ruleset *the* merge; add the
separate reviewer identity.

*What was cut, with line counts* (measured from `git diff --stat`/`--numstat` between
`20486f0` — the commit before PR #70 — and this repository's current `main`, over
`hooks/`, `ci/` and `scripts/`; net across those three directories: 395 insertions(+),
1120 deletions(-)):

| file | before | after | net | PR |
|---|---|---|---|---|
| `hooks/stop-gate.mts` | 82 | deleted | -82 | #70 |
| `hooks/lib/common.mts` | 467 | 101 | -366 | #70 |
| `hooks/protect-main.mts` | 119 | 69 | -50 | #70 (60-line third layer), #79 (deletion valve) |
| `hooks/hooks.json` | 48 | 26 | -22 | #70 (stop-gate entry removed) |
| `scripts/land.mts` | 368 | 122 | -246 | #69 (delegates to `--auto`), #74 (reviewer identity), #81 (clean-status retry) |
| `ci/issue-lint.mts` | 446 | 354 | -92 | #71 (contract only, entry-point warning removed) |
| `scripts/claim.mts` | 241 | 238 | -3 | #71 (`--strict` passthrough removed) |
| `ci/scope-check.mts` | 98 | 190 | +92 | #76 (the mechanical, PR-time replacement: dangling-reference check) |
| `scripts/reconcile.mts` | 350 | 356 | +6 | #77 (checks via `gh pr checks`, not its own rollup dedupe) |
| `scripts/init.mts` | 196 | 227 | +31 | #69, #74 (auto-merge, delete_branch_on_merge, reviewer-token setup printed) |
| `hooks/git-pre-push` | 45 | 52 | +7 | #73 (deletion valve never lifts, even under the bootstrap valve) |

Also named in the audit and fixed the same pass: #68 collapsed the test workflow to a
single `test` job on Node (the Bun leg is gone — nothing in this repository's history
ever depended on it passing under both runtimes).

*What was kept, and why:* `.mts` on Node ≥ 22.18 with `tsc` as the type gate (no build,
no runtime dependencies — items 2/3 of this file, unchanged); the four orchestrator
scripts, because each one replaced a mistake the orchestrator had made by hand in M1
(item 11); `negative-control` and `scope`, because they are the loop's only mechanical
proof that a PR did what its issue said it would; the two remaining `PreToolUse` hooks,
because they are a round-trip saver and the fallback for a repository with no ruleset yet
(a private repository on the free plan — item 9).

*The rule that came out of it:* **a client-side check that duplicates a server-side rule
is deleted, not maintained.** A new guard goes server-side first — a ruleset rule, a
required CI check — and client-side only where no server-side rule can exist for it (a
free-plan private repository has no ruleset; nothing server-side stops a local `git push
--force` before it leaves the machine).

*Note, 2026-09-17 (#137): the `SubagentStop` gate is an exception to that rule, admitted
by the rule's own second clause.* `hooks/stop-gate.mts` is back — registered on
`SubagentStop` this time, and on `Stop` where the trunk rule makes it a no-op — running
the detected check and test commands in the implementer's worktree and blocking the stop
while either is red. It does not duplicate a server-side rule, because **no server-side
rule can run the project's tests in the agent's worktree before the PR exists**: the
`test` check needs a pushed branch and a pull request, which is precisely the round trip
this saves. The 2026-09-06 cut above was not a finding that gating a stop is wrong — the
82-line `stop-gate.mts` in the table was registered on `Stop` alone and therefore never
fired for an implementer at all (M3), so what the audit measured was dead code, not a
duplicated check.

Four bounds are what make it a gate and not a second CI, and they are the terms of the
exception: `main`/`master` is never gated; a last commit whose subject starts with
`test(red):` is exempt; a project with no detected test command is let through with a note
(detection is a default, never a contract — item 4 of `AGENTS.md`); and three consecutive
blocks on the same branch is the cap, after which the stop goes through and CI is the gate
again. Crash policy ALLOW covers the rest: a command that times out or cannot be spawned,
a counter that cannot be written, an unreadable payload — each one lets the stop through
with a note, because a gate that cannot judge must not hold the agent.

Where a decision lands, per `docs/decisions/README.md`, is a dated file under
`docs/decisions/`. This note lives here instead because #137's `## Files` lists
`docs/decisions.md` and no path under `docs/decisions/`, and an implementer never widens
its own globs. It records what is in force; renumbering it as a dated file is a docs
change for whoever holds the next decision issue.

*The reviewer-identity gap and its fix* (#66, `agents/reviewer.md`, `scripts/land.mts`) —
**superseded by item 18: everything in this paragraph describes the opt-in `approved`
mode, which no repository gets by default.** Read it as the setup guide for that mode, not
as the state to reach. Before this pass, the same token that ran `land.mts` could also
write the `review:approved` label, so the review it gated on was not independent of the
identity doing the merging. Fix, two sides of the same variable read separately: when
`AGENTIC_REVIEWER_TOKEN` is set in the reviewer agent's own environment, the reviewer
authenticates as that separate identity and casts a real `gh pr review
--approve`/`--request-changes` (`agents/reviewer.md`); when it is set in the
orchestrator's own environment — `land.mts:95` reads `process.env.AGENTIC_REVIEWER_TOKEN`
from the process running `land.mts` itself, not from the reviewer — `land.mts` requires
`reviewDecision === 'APPROVED'` from GitHub itself, and the label becomes a convenience
that `reconcile.mts` still reads but that no longer gates anything. Setup is by hand
(printed by `scripts/init.mts`, mirrored in `skills/init/SKILL.md`): create a machine
user or a GitHub App installation with pull-request write, store its token as
`AGENTIC_REVIEWER_TOKEN` wherever the orchestrator and reviewer run (never in this
repository), and set the base branch ruleset's `required_approving_review_count` to 1.
**Order matters:** raise the ruleset's required-review count *before* setting the token —
GitHub computes `reviewDecision` only on a branch where a review is actually required, so
setting the token first (with no such rule yet) leaves `reviewDecision` `null` forever,
and every PR refuses in `land.mts` with no way to satisfy it (`scripts/land.mts`'s own
header names this trap). Init also turns on `allow_auto_merge` and
`delete_branch_on_merge` on the repository itself, so `--auto` has something to enable
and a merged branch does not need a person, or `claim.mts`'s stale-ref handling alone, to
go away.

## 16. 2026-09-17: one label dictionary, a union with a per-route marker

Status: accepted — written OK: issue #145 (the owner's specification of this change),
under the standing M11–M16 delegation recorded on #161.

Two dictionaries held the same vocabulary and disagreed about it: `scripts/init.mts`
seeded 15 labels with no `state:done`, `.agents/skills/autonomous-loop/scripts/github.mts`
seeded 9 including `state:done` and the legacy `human`, and `docs/workflow.md` stated that
the `state:` set "has no `done` value" while `gh label list` showed one. Only a comment
kept the two lists together, and it had already failed.

There is now one file, [`../labels.json`](../labels.json): one entry per label, each with
its name, colour, description and the `routes` that seed it. `scripts/init.mts` seeds the
`claude`-routed entries through `scripts/lib/labels.mts` and refuses the run — before it
writes anything — when the file does not validate. The Codex helper ships as a standalone
file inside the plugin package (`scripts/sync-codex-plugin.mts` copies `github.mts`
alone), so it cannot import a module: its list stays inline and `tests/labels.test.mts`
reads it out of the source and fails when it drifts from the dictionary's `codex` entries,
name, colour and description. The dictionary is JSON, not YAML, because invariant 1 allows
`node:` built-ins only and there is no YAML parser among them; the precedent is
`templates/agents/index.json`.

`state:done` stays, marked `["codex"]`. It is not dead vocabulary: the Codex route's state
synchronisation writes it from verified GitHub state
(`.agents/skills/autonomous-loop/scripts/github.mts`). Removing it is a behaviour change on
that route, not a documentation fix, so the union records it and `docs/workflow.md` now says
who writes it instead of denying it exists. The bare `human` is marked `legacy: true`,
which is a statement about this route only: `scripts/init.mts` never seeds it, while the
Codex helper still does from its own inline list (`github.mts`, asserted by
`tests/codex-loop.test.mts`).

The union is less symmetric than #145's "everything else is both" reads: only the five
`state:` labels and the two `human:` states are marked for both routes. The seven `type:`
values and `review:approved` are `["claude"]`, because the Codex helper has never seeded
them — it labels state, and `type:`/`review:` are written by `scripts/claim.mts` and the
orchestrator on this route. Marking them `["claude", "codex"]` would have made the drift
test demand eight labels the Codex route does not seed.

*Why:* two lists kept identical by a comment is the shape this repository has already paid
for (item 15 names it as the reason the adoption record is generated). A union with a
per-route marker is the only form that is true of both routes at once, and a test that
fails on drift is what makes the file load-bearing rather than decorative.

*Cost accepted:* three of them. First, the Claude route reads a label it never writes —
someone reading `labels.json` sees `state:done` and has to read the marker to learn it is
not theirs. Second, one value per label means the five labels the two routes described
differently now carry the Codex route's colour and description, because `github.mts` is a
standalone file this issue does not touch. Three change both: `state:ready`
(`0e8a16` → `1d76db`, "Ready to be picked up by an agent" → "Ready for the next authorized
transition"), `state:in-review` (`1d76db` → `5319e7`, "PR open, waiting for CI and the
reviewer" → "Awaiting review, checks, or objective verification") and `state:qa-failed`
(`d93f0b` → `d73a4a`, "Sent back by CI or the reviewer" → "Review or required checks need
repair"); two change description only, `state:in-progress` ("An agent holds the branch
lock" → "Implementation is in progress") and `state:blocked` ("Two failed rounds; needs a
person" → "Blocked by specification, dependency, cancellation, or decision"). `init` passes
`--force`, so the next run rewrites those five in an adopting repository. What survives is
the names, which is what every parser, hook and script matches on; the one test that reads a
colour (`tests/codex-loop.test.mts`, on `human:pending` and `human:decided`) reads two this
change leaves untouched. Third, `scripts/lib/adopt/inventory.mts` still restates the seeded names in its
own `SEEDED_LABELS`; it is outside this issue's `## Files` and reading the dictionary there
is a separate change.

*Open, for the owner (deferred):* whether `state:done` is retired altogether — the Codex
route stopping writing it, the entry leaving the dictionary — and whether the 30 closed
issues that carry it today, and the 83 closed issues that still carry some `state:` label,
are cleaned. Both are behaviour, not documentation: the first changes what the Codex loop
writes, the second rewrites history that is no longer read. Nothing in this item decides
them, and the veto is to reopen #145.

## 18. 2026-09-17: one review mode — an isolated agent, a label the orchestrator writes

Status: accepted — written OK: the owner's 2026-09-17 decision on #148, specified in #142,
under the standing M11–M16 delegation recorded on #161.

The review gate is **one isolated, agnostic agent** reading the pull request in a separate
context and returning only `{verdict, reasons}` (`agents/reviewer.md`). It is not a second
person and not a second GitHub login. The orchestrator is what turns the verdict into
state: at step 5 of `skills/orchestrate/SKILL.md` it comments the JSON, applies
`review:approved` (or `state:qa-failed`, and `state:blocked` + `human:pending` on a second
rejection) and posts the `<!-- agentic-reviewed-sha: <oid> -->` marker naming the head the
reviewer actually read. The merge condition is then exactly two things: every required
status check green on that head, and that label — pinned to the reviewed commit by the
marker, which `scripts/land.mts` compares with the pull request's current `headRefOid` and
passes to the server on `--match-head-commit`, refusing with `missing: ['head:changed']`
when the head moved or no marker exists (#144). Humans act only at `human:pending` gates.

*Why:* this is the gate the loop copies (ADR 0004 item 4 of the reference TypeScript
project, `lohra-ts`), and a workflow in which a person acts only when necessary does not
gain a second person. The premise that the absence of `reviewDecision: APPROVED` on this
repository's merges was a defect was simply wrong, and several issues in M11 and M12 were
written against it. The evidence: `lohra-ts`'s own ruleset `protege-main` carries
`required_approving_review_count: 0` with 7 required status checks, and 0 of 200 merged
pull requests there carry `APPROVED`; the companion project `apollo` is 0 of 147. A
missing `APPROVED` is what the model being copied looks like, not the gap in it. Item 13
read the opposite and is amended in place: the sentence naming the shared token as the
audit's one under-built finding now points here, and its *reviewer-identity gap* paragraph
is marked as the setup guide for the opt-in mode below.

*Cost accepted, stated plainly:* **the server does not verify the review.** `review:approved`
is written by the same identity that runs `land.mts`, so nothing at GitHub attests that a
review happened. What holds the line instead is everything that is not prose: the base
branch ruleset's required status checks (`scope`, `negative-control`, `test`), which no
label can satisfy; the reviewed-SHA marker, which makes a push after the review a refusal
rather than a silent merge; `hooks/protect-main.mts` and the permission deny list, which
refuse every hand-typed `gh pr merge` including `--admin` (item 14, #154); the
`hooks/git-pre-push` hook `init` installs and the `guard-main` workflow, which refuse a
push to `main`. A reviewer agent that approves badly is a real risk; a merge that walks
past the checks is not.

*The opt-in `approved` mode.* A second identity is available and is nobody's default. It
turns on when `scripts/init.mts --require-review` is run, or against a base branch whose
ruleset already requires approving reviews. It needs, in this order: a second login or a
GitHub App installation with pull-request write; the base branch ruleset's
`required_approving_review_count` raised to 1 with `dismiss_stale_reviews_on_push`
(`init --require-review` writes both); and only then the token stored as
`AGENTIC_REVIEWER_TOKEN` wherever the reviewer and the orchestrator run — the ruleset
first, because GitHub computes `reviewDecision` only on a branch where a review is
actually required, so a token set before the rule leaves `reviewDecision` `null` forever.
In that mode the reviewer also casts a real `gh pr review --approve`/`--request-changes`
as the separate identity and `land.mts` gates on `reviewDecision === 'APPROVED'` (mode
`approved`) instead of reading the marker. The orchestrator still writes `review:approved`
in both modes; in neither is the label a fallback for a missing token.

*What it costs, and why it is not the default:* a repository with a single identity freezes
at its first merge. With `required_approving_review_count: 1` and no second login, nobody
can cast the review GitHub now requires, and every pull request refuses with no way to
satisfy it. `scripts/init.mts` therefore resets the count to 0 on every `--rules` run and
warns when `--require-review` is used with no `AGENTIC_REVIEWER_TOKEN` in the environment
(#143, `skills/init/SKILL.md`).

Where a decision lands, per [`decisions/README.md`](decisions/README.md), is a dated file
under `decisions/`. This item lives here for the same reason item 16 and the 2026-09-17
note under item 13 do: #148's `## Files` lists `docs/decisions.md` and no path under
`decisions/`, and an implementer never widens its own globs. Its index row is in
[`decisions/README.md`](decisions/README.md) all the same, under the orchestrator's
`authorised:` grant on that file; relocating this item and item 16 to dated files is its
own issue, as it was for items 14 and 15 (#211).

## 19. 2026-09-17: the M9 discipline agent catalogue is retired

Status: accepted — written OK: issue #150 (the owner's decision comment of 2026-09-17,
recorded by the orchestrator), under the standing M11–M16 delegation recorded on #161.

M9 ("Discipline agent presets and milestone moulds") shipped one issue, #124, and left
five open. What #124 merged is a catalogue of fourteen preset agent cards under
`templates/agents/`, one directory per card in both routes' formats, plus
[`agents.md`](agents.md) describing it. It is **retired**: the catalogue is source
material nothing reads, and the four questions #150 put to the owner are answered as
follows.

**1. The catalogue (#123 spec, #125 the `--agents` install, #126 first-run profiling) —
retire.** `templates/agents/`, [`agents.md`](agents.md) and the catalogue's two README
sections go, and with them `tests/agents-catalogue.test.mts`, which is the only consumer
the catalogue ever had (it reads the fourteen directories off disk; it installs nothing).
#123, #125 and #126 are closed `not_planned` with this decision linked. The removal is
#152's diff, not this item's.

**2. #128 (scope-based card dispatch, a security reviewer, labels applied by the
orchestrator) — closed, superseded by #135.** GitHub has no "superseded" reason, so the
issue reads `not_planned` and the supersession is stated in its closing comment: the one
half worth keeping — every label write moves from the reviewer to the orchestrator — is
what #135 (PR #187) delivered. The dispatch half dies with the catalogue it dispatched.

**3. #127 (delivery / investigation / hardening milestone moulds) — closed
`not_planned`,** in favour of a single milestone description format (objective, problem,
out of this phase, completion criteria as checkboxes, depends on), which is #171 in M14.
No reference project types its milestones; `## Kind: delivery` is written in prose today
(#131, and #142's own body) and read by nothing.

**4. M9 — closed,** 0 open and 6 closed issues, with this decision linked in its
description: "Closed 2026-09-17 without delivery: the catalogue was retired by the
decision recorded on #150". No closeout file, because the milestone predates the closeout
rule (M14, `docs/closeout/README.md`).

**The consequence #152 needs, stated so it needs no further question:**
`templates/agents/index.json` is **removed with the rest of the catalogue, not
rewritten.**

*Why:* three pieces of evidence, none of them a preference.

First, nothing installs it, by its own documentation. `docs/agents.md:4-8` says "Nothing
in the repository installs this catalogue yet … this is source material for a person (or
a future installer) to read and adapt by hand", and `README.md:269-275` repeats it —
"Nothing installs it yet; it is source material". (#150 cites `README.md:144-145` for that
sentence; the line moved, the sentence is at 269-275 and the map row at `README.md:305`.)
The installer agrees with the prose: `scripts/init.mts:318-342` copies
`templates/.github`, `templates/.worktreeinclude` and `templates/claude-settings.json` by
name and never the directory, so `templates/agents/` reaches no adopting repository.

Second, its vocabulary is not this repository's. The eleven `scopes` keys in
`templates/agents/index.json:4-14` are `scope:qa`, `architecture`, `backend`, `frontend`,
`design`, `product`, `research`, `security`, `data`, `infra` and `release`. Against the
`scope:` labels that exist on this repository — `scope:ci`, `scope:hooks`,
`scope:scripts`, `scope:tests`, `scope:docs`, `scope:infra` — exactly one of the eleven,
`scope:infra`, resolves. Against [`../labels.json`](../labels.json), the one dictionary
item 16 made load-bearing, **none** of them resolves: the dictionary's 17 entries carry
no `scope:` value at all, because `scope:` is chosen by whoever writes the issue and is
never seeded by `init`. That is the B8 defect #142 names, and it is why rewriting the
index has no target to rewrite it to.

Third, the shape the reference practices actually ask for is already here: one file per
role with minimal `tools` (`lohra-ts`, `apollo`), which is what `agents/implementer.md`,
`agents/reviewer.md` and `agents/docs-writer.md` are. Fourteen discipline cards are a
second, unreferenced answer to a question three files already answer, and the choice the
2026-09-06 audit produced (item 13) was to "delete the duplicates" and keep the core.
(#150 attributes that rule to "the M4 audit"; the register carries it as item 13, the
2026-09-06 audit, and M4 is named nowhere in it.) "Reduce" — keeping
`security-reviewer` as a fourth read-only role — needs a real case for that role, and
none exists yet; it can be opened as its own issue the day one does.

*Cost accepted:* the fourteen cards are lost from the working tree, and anyone who
expected per-discipline prompts writes their own. They are not lost from the repository:
`git checkout a67b1aa -- templates/agents docs/agents.md` restores them from the commit
that merged #124 (PR #130). A second cost is smaller and real: `tests/agents-catalogue.test.mts`
goes with them, so the test count drops by that file's cases — a fall in the total that
#152's PR states rather than hides.

Where a decision lands, per [`decisions/README.md`](decisions/README.md), is a dated file
under `decisions/` — `0019-<slug>.md` is the next free number. This item lives here for
the same reason items 16 and 18 and the 2026-09-17 note under item 13 do: #150's
`## Files` lists `docs/decisions.md` and no path under `decisions/`, and an implementer
never widens its own globs. Its index row in
[`decisions/README.md`](decisions/README.md) and its relocation to that dated file are
owed, as they are for items 16 and 18 (#211).
