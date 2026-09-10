# Decisions

The reasoning behind the loop, condensed. Each item is a decision, its reason, and
what it costs.

## 1. Unit of work: a GitHub sub-issue

Child of the milestone's parent issue. Declares **file globs**, dependencies
(`Blocked by #N`), verifiable acceptance criteria and its proof. The orchestrator, as
planner, writes the sub-issues — it is owned work, not implicit.

*Why:* an agent can only be held to what is written down where it can read it. The
issue is the only channel that survives context loss.

## 2. Claiming: the remote branch is the lock

The orchestrator pushes `<type>/<n>-<slug>` from `origin/main`; the push of a new ref
fails if it exists. Then it assigns and flips the label. With one orchestrator this is
belt and braces; with two, the ref is what holds.

## 3. Isolation: one worktree per issue

`isolation: worktree` on the implementer. A worktree is born with tracked files only,
so whatever is gitignored and needed (env files) is copied in by a versioned include
list, and the implementer's step 0 proves it arrived. Forbidden: `stash`, `reset --hard`,
`clean`, force-push. `rebase` only before the first push; once published, conflicts
with `main` are resolved with `merge origin/main` — rebase there would need a
force-push, which is denied everywhere.

## 4. Merge without a human

PR to `main` with `Closes`/`Fixes`/`Resolves #N` (several issues may be linked; the diff
must stay inside the union of their globs; a keyword inside backticks or a fence is
ignored); squash when the checks pass and the reviewer returns
approved. **No up-to-date-branch requirement** — CI runs again on `main` after the
merge; rebase only on conflict. Two failed rounds become `state:blocked` **with the
`human` label**, and the orchestrator moves on.

*Cost accepted:* no human review per PR. Quality rests on the checks being truly
blocking and on the negative control being verified by CI, not by the agent.

## 5. Parallelism

Up to four issues in flight, with non-intersecting globs. Schema or contract changes
are their own issues, opened first; features that need them are born blocked.

## 6. PR classes

- `feature` / `bug`: checks + reviewer.
- `db` / schema (or your equivalent serialised class): same, one at a time.
- `docs` (labelled `type:docs`, in practice only touching `docs/**`, `CLAUDE.md`,
  `.claude/**`): lint CI, `land.mts` merges without a review — it reads the PR's label,
  not its path.
- `deps`: only the orchestrator; manifest and lockfile.

## 7. Restart

On start, the orchestrator reconciles from GitHub, not memory: `in-progress` with no
PR and no remote branch goes back to `ready`; `in-review` with green CI and an
approved review is merged; an orphan worktree is deleted. A pass that finds nothing to
do posts what is blocked on the parent issue.

## 8. Explicit human points

Approving these decisions (explicit OK; silence does not approve); secrets and
variables; the main-protection choice below; anything that needs hardware or accounts
the agent lacks; production cut-overs; any `state:blocked` issue.

*2026-09-10 (#110, #111):* the single `human` label became two exclusive states.
`human:pending` is the gate (`reconcile.mts` keeps it out of `ready`, `claim.mts` refuses
it); `human:reviewed` is set by the person who decided and never removed, so an issue
that needed a person stays traceable from its labels. A bare `human` from before the
split is read as pending. Earlier items above keep their original wording.

## 9. Single trunk, and how `main` is protected

`main` is the only trunk. Protection has three layers; use as many as your plan allows.

- **(a) Server-side, preferred:** a GitHub ruleset on `main` — PR required, required
  checks, no force-push, no deletion. Free on public repositories and on paid
  organisations; **not available on private repositories under the free plan** (rulesets
  and branch protection return 403 there).
- **(b) On every machine that runs Claude Code:** the plugin's `protect-main.mts` hook
  plus the permission deny list `/agentic-setup:init` writes (force-push, `reset --hard`,
  `clean`, `stash`, `gh pr merge --admin`). Covers what goes through Claude Code; does
  not cover a push from elsewhere.
- **(c) Detection:** the `guard-main` action. On a push to `main` that belongs to no PR
  it opens an issue labelled `human:pending` and fails the run, so the history turns red and
  someone looks. The escape hatch is a commit message containing `[allow-push-main]`,
  for bootstrap only.

The merge gate itself is (a) when it exists: `scripts/land.mts` queues `gh pr merge
--squash --auto` once the base branch's ruleset has a `required_status_checks` rule, and
falls back to reading `gh pr checks --required` itself only where no such rule is
present. Keep (b) anyway even with (a) in place — the hook is a fast, cheap round-trip
saver on the agent's machine (denying an obviously forbidden command, including
`gh pr merge --admin`, before it ever reaches the server), not a substitute merge gate;
that judgment is `land.mts`'s alone (item 13).

## 10. Negative control is the load-bearing check

Every feature PR carries a `test(red):` commit. CI checks out the PR's base, applies
only the test files from the diff, runs the test command and requires a failure. A PR
whose tests pass without its change has proven nothing; this job is what makes "merge
without a human" honest rather than hopeful.

## 11. Every mutating orchestrator step is a script with a refusal path

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
that ran `land.mts` could write itself.

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

*The reviewer-identity gap and its fix* (#66, `agents/reviewer.md`, `scripts/land.mts`):
before this pass, the same token that ran `land.mts` could also write the
`review:approved` label, so the review it gated on was not independent of the identity
doing the merging. Fix, two sides of the same variable read separately: when
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
