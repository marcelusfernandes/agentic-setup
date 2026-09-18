---
name: orchestrate
description: Run the agent loop across every open milestone — reconcile from GitHub, dispatch ready issues to implementers in worktrees, review, merge, then continue — stopping only for a closed list of reasons. Use from the main session at the repository root; invoke as /agentic-setup:orchestrate.
---

# Orchestrate

You are the orchestrator: one session at the repository root, never in a worktree. You
plan and dispatch; you never implement. The only role that touches the root manifest,
the lockfile, `.claude/**`, `.github/**`, `main` and the labels.

Run the loop below to completion, not one pass. Reconcile (step 0); dispatch up to four
`state:ready` issues with disjoint `Files` as implementers, in the foreground (steps 1-3);
on each implementer's return, launch the reviewer (step 4); on each verdict, comment it
and apply the labels (step 5); when checks are green and the approval is on, `land.mts`,
then poll `reconcile` until the issue's PR is actually merged — not a tight loop, a merge
takes minutes; then move to the next ready issue, back at step 0. Step 6 closes a
milestone with no open issue left and opens the next one, without stopping.

## The closed list of stop reasons

The loop stops only for one of these, never for anything else — in particular, never
merely because a pass found nothing new to dispatch this instant:

1. **No open milestone.** `reconcile.mts` reports `{ error: "no open milestone" }` (or
   the equivalent: every milestone in the repository is closed).
2. **Every open issue in the milestone is `state:blocked`, `human:pending`, or otherwise
   waiting on a person** — nothing left that a fresh reconcile would move by itself. A
   `reconcile`/`gh`/`git` call itself failing with `{ error }` (step 0) counts here too:
   it needs a person to look at the failure, not an automatic retry.
3. **An explicit turn or time budget given on the command line is spent** — `claude -p
   ... --max-turns <n>` for a turn budget, an external `timeout <seconds> claude -p ...`
   for a time budget. The orchestrator never invents either budget itself; when neither is
   given on the command line, only reasons 1 and 2 stop the loop.

On stop, comment a summary on the milestone's parent issue: what moved this run, what is
left, and which of the three reasons above applies.

## 0. Reconcile from GitHub — never from memory

`scripts/reconcile.mts` prints the loop's current state as one JSON document,
instead of running `gh issue list`, `gh pr list` and `git worktree list` and
cross-referencing them by hand. Locate it the way `skills/init` locates
`init.mts` — `CLAUDE_PLUGIN_ROOT` is set for hook processes but not for the
Bash tool:

```bash
RECONCILE="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/reconcile.mts}"
[ -f "$RECONCILE" ] || RECONCILE="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/reconcile.mts' 2>/dev/null | head -1)"
[ -f "$RECONCILE" ] || { echo "agentic-setup: reconcile.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
node "$RECONCILE" --milestone "<current>"
```

`reconcile.mts` runs `git fetch --prune origin` itself before reading remote branches, so
this makes one network call for git, not two. Without `--milestone`, it picks the open
milestone with the lowest number; `--no-milestone` reconciles the other set instead — the
open issues that carry no milestone at all, so a small fix that reasonably went without
one is claimed and landed through the scripts rather than by hand — and passing it
together with `--milestone` is a usage error naming both, never a precedence;
`--no-fetch` skips the fetch and reads the local refs
left by the last one, for an offline check against the last fetch. Fields:

- `milestone` — the title it reconciled against, or `null` under `--no-milestone`: there
  is no milestone to name.
- `milestoneLint` — `{ ok, missing }`, or `null` under `--no-milestone` (no milestone, so
  no description to lint): whether that milestone's description holds the one
  format of `.github/MILESTONE_TEMPLATE.md` (`docs/workflow.md`, "Milestones"). `missing`
  names the absent parts — `objective`, `out-of-phase`, `exit-criteria` (the label and at
  least one `- [ ]` item under it), `depends-on` — and `ok` is `missing` being empty. It is a
  report, never a refusal: `ok: false` is **not** a stop reason and never blocks a
  dispatch. Rewrite the description to the template during this phase, as work inside it
  (`gh api -X PATCH repos/{owner}/{repo}/milestones/<n> -f description="$(cat
  milestone.md)"`, the number looked up by title the way step 6 does), and keep the loop
  running meanwhile.
- `ready` — `{ number, title, blockedBy }`: `state:ready` issues in the milestone whose
  `Blocked by:` issues are all closed (`blockedBy` lists them; empty when none) and that
  carry no pending human label (those go to `humanPending` instead). This is step 1's
  candidate list — no separate query needed.
- `humanPending` — `{ number, title, label }`: open issues in the milestone carrying
  `human:pending` or the legacy bare `human` (any case; `label` is the name found),
  whatever their `state:`. Never dispatch these; a person decides, records the decision
  in a comment, flips the label to `human:decided` and sets the next `state:` (see
  "Resume after a person decides"). `human:decided` issues are not listed here.
- `inProgress` — `{ number, branch, hasRemoteBranch, foreignLock, pr }`:
  `state:in-progress` issues that are not `resumable` (below), for one of four reasons —
  an open PR; a branch checked out in a *live* local worktree of this checkout (an agent
  of this checkout may be alive — a worktree in `deadWorktrees` does not count); no remote
  branch at all; or a branch that is the other route's `codex/task-<n>` lock. That fourth
  reason is `foreignLock: true`, and it is where such an issue belongs, not a misfiling:
  it stays here whether or not it has a pull request yet, because round N+1 is dispatched
  *without* a claim (step 3). Report it and leave it to the coordinator that owns it — do
  not claim it, do not dispatch an implementer to it, do not push to that branch and do
  not wait on it. `pr` is the open PR's number on that branch, or `null`; on a
  `foreignLock: true` entry that number is the *other route's* pull request, never one to
  review or `land` from here.
- `resumable` — `{ number, branch, commitsAheadOfMain }`: `state:in-progress` issues with
  a remote branch **of this route's own `<type>/<n>-<slug>` shape**, no open PR, and no
  *live* local worktree checked out on that branch (a worktree in `deadWorktrees` does not
  count as a checkout). A `codex/task-<n>` branch is never listed here — it stays in
  `inProgress` with `foreignLock: true`, above. A fresh orchestrator session has no live
  agents by definition, so this is not "an implementer is working right now" — it is round
  N+1 of that issue, resumed from `origin/<branch>` (skill `safe-worktree` §C).
  `commitsAheadOfMain` is `0` when the previous implementer never pushed past the lock
  branch's starting point.
- `inReview` — `{ number, pr, checks, reviewApproved, foreignLock }`: `state:in-review`
  issues. `foreignLock: true` means the pull request belongs to the Codex route, which
  labels its own tasks `state:in-review` too: report it, do not review it, do not `land`
  it, and do not wait on it.
  `checks` is `'green'`, `'red'` or `'pending'`, from one `gh pr checks <pr> --json
  name,bucket` call per PR (green when every surviving check's bucket is pass/skipping,
  red on any fail/cancel, else pending) — no rollup dedupe of its own.
  `reviewApproved` is the `review:approved` label or an `APPROVED` review. Checks green
  and `reviewApproved` → merge (step 5).
- `stale` — `{ number, reason }`: in-progress issues with no open PR **and** no remote
  branch → back to `state:ready`.
- `orphanWorktrees` — paths of linked worktrees whose branch no longer exists on the
  remote → remove them (stop any local service they started first). A path that also
  appears in `deadWorktrees` follows that bullet's recovery (patch, push) before removal;
  this bullet's plain removal is for worktrees with nothing left to save.
- `deadWorktrees` — `{ path, branch, pid, dirty, unpushed }`: linked worktrees locked by a
  pid that no longer exists. Claude Code locks an agent's worktree only while that agent
  runs (`claude agent agent-<id> (pid <N> ...)`) and removes the lock on a clean exit — the
  worktree stays, unlocked; a killed session leaves the lock behind, still naming the
  now-dead pid. When `process.kill(N, 0)` throws `ESRCH`, the worktree does not count as
  a live agent's checkout, so its issue is already reported `resumable` above, not
  `inProgress` — this list is only for cleanup, but a dead worktree can still hold work an
  implementer never got to commit or push (#88: four implementers died mid-work in M4, one
  with a local commit never pushed). `dirty` is `true` when `git -C <path> status
  --porcelain` prints anything; `unpushed` is the count of commits on the worktree's `HEAD`
  not on `origin/<branch>`, or `null` when there is no such remote branch. `dirty` itself
  reads `null` when the `git` call behind it fails (a broken or missing worktree) — skip
  step 1 for that entry, but still remove it in step 3; there is nothing to trust a
  status read from. Recover before removing, for each entry:
  1. If `dirty`: `git -C <path> add -N . && git -C <path> diff HEAD > <patch>` — the
     `add -N` (intent-to-add) makes untracked files show up in the diff without staging
     their content, and `diff HEAD` (rather than a bare `diff`, which drops staged
     content) captures staged, unstaged and intent-to-added changes together. Save the
     patch path; it is handed to the round N+1 implementer as a draft to verify, test
     committed first, not applied as-is.
  2. If `unpushed > 0`: `git push origin <branch>` (fast-forward, never force).
  3. `git worktree unlock <path> && git worktree remove --force <path>`; then treat its
     issue as `resumable`.

  This narrows, but does not close, the restart gap (`docs/orchestration.md`, Known
  limits): an unlocked leftover worktree (its agent finished without a PR, in a session
  since dead) still reads `inProgress` and needs a person, or a future liveness signal, to
  resolve.

A GitHub listing taken right after the write that caused it may lag — the write lands
before the listing that reports it does: `reconcile` returned an empty milestone seconds
after the issue was created, and `guard-main` opened a pull request over a squash commit
whose own pull-request association was not indexed yet (measured:
`docs/dogfood/2026-09-10.md`, L6). So an empty or stale result on a listing this pass
just caused is not a state to act on: re-read it once, after a short pause, before
dispatching, relabelling, opening anything or stopping on it. Only the second read counts.

A failing `gh` or `git` call prints `{ "error": "..." }` and exits 1; stop and report
rather than guessing the state.

Then, once per pass and before step 1, the read-back the installer never had. Locate it
the same way:

```bash
DOCTOR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/doctor.mts}"
[ -f "$DOCTOR" ] || DOCTOR="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/doctor.mts' 2>/dev/null | head -1)"
[ -f "$DOCTOR" ] || { echo "agentic-setup: doctor.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
node "$DOCTOR"
```

`scripts/doctor.mts` is read-only — it writes nothing and calls no mutating `gh` verb. It
says whether this repository actually satisfies what the loop requires: the review mode it
runs (`agent` or `approved`), the effective ruleset on the default branch and whether it
names the generated checks, the label dictionary, the hooks the adoption record names,
`allow_auto_merge`, and whether a proof can resolve a command. It prints
`{ ok, mode, checks, missing }`, and every `missing` entry names the exact field rather
than a sentence — `docs/adopt.md` lists each name and what fixes it.

**`ok: false` is a report, not a stop reason, and not a gate.** Exactly like
`milestoneLint` above, it never blocks a dispatch and it is not a fourth entry in the
closed list: name what `missing` holds in this pass's first comment and in the stop
summary, open an issue for each field only a person can close
(`review:no-second-identity` needs a login, not a commit), and keep the loop running.
What it does change is what you may claim about a merge — when `missing` holds
`ruleset:absent` or `ruleset:required_status_checks`, the server is not holding the line:
`land.mts` will report `gate: 'client-checks'`, and step 5's green checks plus the
reviewed-SHA marker are the whole of what stands between a pull request and `main`. Say
that in the verdict comment instead of treating the merge as server-gated.

## 1. Candidates

Use `ready` from the JSON above — it already excludes issues with an open blocker. Before
picking, lint every candidate — locate `ci/issue-lint.mts` the same way as `reconcile.mts`
above:

```bash
LINT="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/ci/issue-lint.mts}"
[ -f "$LINT" ] || LINT="$(find ~/.claude/plugins -path '*agentic-setup*/ci/issue-lint.mts' 2>/dev/null | head -1)"
[ -f "$LINT" ] || { echo "agentic-setup: issue-lint.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
node "$LINT" <n>
```

Prints `{ issue, ok, failures, globs, sequenced }`; dispatch only `ok: true`. issue-lint
checks the issue's contract only — sections present, globs that parse and match
something (or are `new`), the `authorised:` grants of `## Files` held to those same two
rules (each `globs` entry says which it was, `grant: true` or `grant: false`), globs
disjoint from the other issues already in flight, and every `Blocked by:` number exists —
it never reads a diff, so there is no entry-point warning to read here any more
(`docs/decisions.md` item 12, superseded by item 13). A `failures` entry (a missing
section, a wildcard glob that matches no tracked file, an `authorised:` grant that matches
no tracked file, a
`Blocked by:` number `gh` cannot find, a `Blocked by:` cycle among the milestone's issues
— a string naming every issue in it, since a cycle is no order at all — or a
`{ issue, files }` overlap with another issue in flight) drops the candidate from this pass — a literal path with no `*`, `?` or `**`
that matches no tracked file is reported as `new` in `globs`, not a failure (the issue is
expected to create it), and so is a wildcard glob whose fixed prefix (the part before its
first `*` or `?`) names a directory with no tracked file anywhere — the way an issue
declares a whole new directory. A `sequenced` overlap is not a failure either, it means the
two issues are already ordered by a `Blocked by:` relation.

## 2. Pick up to 4 with disjoint globs

Read each candidate's `## Files`. Two issues whose globs could match the same file do not
run together — `issue-lint`'s own `failures`/`sequenced` already checked this against every
other issue in flight in the milestone, grants on both sides included (a granted file is a
file that pull request may touch), so a candidate that reached `ok: true` has no
undeclared overlap left to find by hand. Four is the practical ceiling; file conflict is
the real limit, not the subagent count.

## 3. Lock, then launch

For each pick (skill `issue-and-pr`, "Claim"), run `scripts/claim.mts` — located the same
way:

```bash
CLAIM="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/claim.mts}"
[ -f "$CLAIM" ] || CLAIM="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/claim.mts' 2>/dev/null | head -1)"
[ -f "$CLAIM" ] || { echo "agentic-setup: claim.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
node "$CLAIM" <n> --slug <slug> [--type <type>] [--no-lint]
```

`<type>` defaults to the title prefix (`feat(scope): …` → `feat`) and must be one of
`feat|fix|refactor|chore|docs|test|ci|deps`; a title outside that set (e.g. `perf(ci): …`)
has no type of its own, so pass `--type` with a value from the set (whichever fits — `ci`
for `perf(ci): …`), or `claim.mts` errors out (an invalid `--type` errors too, same set).
Before pushing, `claim.mts` runs `ci/issue-lint.mts` on the issue itself and refuses on
anything but `ok: true` — `{ refused: "issue-lint failed", lint }`, nothing pushed or
relabelled; `--no-lint` skips the check (`"lint": "skipped"` in the success JSON instead
of `"lint": { "ok": true }`).

Exit 0 → `{ issue, branch, base, lint }`: the push succeeded (the lock), the issue is
assigned, `state:in-progress`, and labelled `type:` from the branch type — `feat` →
`type:feature`, `fix` → `type:bug`, `chore`/`test`/`ci` → `type:infra`, and `refactor`,
`docs`, `deps` keep their name (`TYPE_LABELS`, `scripts/lib/issues.mts`). **You write
`type:`, not the implementer**: an agent that labels its own work could buy its own
exemptions, so the implementer opens the PR with `state:in-review` alone and you copy
`type:` and `scope:` across at step 4. Exit 2 → `{ held: "<branch>" }`: a branch that locks the issue already exists — another
agent (or a previous, still-live claim) holds it; skip, do not retry, and do not dispatch
an implementer to that branch. Before the push, `claim.mts` reads the remote's heads and
reports any branch that locks the issue, in either route's namespace
(`<type>/<n>-<slug>` here, `codex/task-<n>` on the Codex route — `scripts/lib/issues.mts`
lists both), so the branch named may be one this route would never have pushed. That read
fails closed: a `git ls-remote` that cannot answer exits 1 with `{ error }` naming it
rather than claiming an issue it could not check. Exit 1 with
`{ refused }`: the issue is not claimable (closed, missing `state:ready`, an open
`Blocked by:` issue, no `## Files` bullet, or a failing `issue-lint`) — drop it from this
pass, it needs a person or a prior issue to close first. Exit 1 with `{ error }`: a usage
problem (no type determinable and none given, or an invalid `--type`) or a `gh`/`git`
failure — not a verdict on the issue; stop and report rather than guessing.

Then launch the `implementer` agent with **the whole issue body in the prompt** (subagents
do not see this conversation). One agent per issue, in parallel.

For each issue in reconcile's `resumable` list, do not claim it again — the lock is
already held by this orchestrator's own `state:in-progress` label and remote branch.
Dispatch it straight to an implementer as round N+1: tell it to start from
`origin/<branch>` (skill `safe-worktree` §C), that the previous agent is gone, and to
verify what is already pushed, finish the work, and open the PR.

That list only ever holds branches of this route's own shape. An in-progress issue whose
branch is the Codex route's `codex/task-<n>` lock is reported under `inProgress` with
`foreignLock: true` — never `resumable`, whether or not it has a pull request yet —
because round N+1 is dispatched *without* a claim, and `claim.mts`'s refusal would never
be reached. Leave it to the coordinator that owns it: do not claim it, do not dispatch an
implementer to it, and do not push to that branch. One coordinator owns an objective at a
time (`AGENTS.md`).

**Grant a glob, then log it.** An implementer that stops on a file outside its issue's
globs is asking for a grant, and only you write one: add the `authorised:` line to the
PR's `## Files` (the glob alone on the line, the justification indented under it —
`docs/workflow.md`, "`authorised:` is written only by the orchestrator"). A grant changes
no file of its own, so it leaves no trace unless you log it. Run
`scripts/log-decision.mts`, located the same way as the scripts above, against the
milestone's **parent** issue:

```bash
LOG="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/log-decision.mts}"
[ -f "$LOG" ] || LOG="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/log-decision.mts' 2>/dev/null | head -1)"
[ -f "$LOG" ] || { echo "agentic-setup: log-decision.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
node "$LOG" <parent> --kind grant --ref <#pr> "<what was granted, and why the issue's globs missed it>"
```

It appends one dated line — `<UTC ISO-8601> | <kind> | <ref> | <text>` — to a single
comment on the parent issue, found by the `<!-- agentic-decision-log -->` marker, so a
second call appends to that same comment instead of posting another. `--kind` is one of
`grant`, `extra-round`, `human-pending` and nothing else. It **fails closed**: exit 1 with
`{ refused, parent, missing }` when the parent issue does not exist or is closed
(`parent:state`), the number is a pull request and not an issue (`parent:type` — the
issues endpoint answers for a PR too, and the log lives on the parent issue), the kind is
outside that set (`kind:unknown`), `--ref` is not an issue or PR number (`ref:format`) or
the text is empty (`text:empty`) — nothing written in any of those cases; exit 1 with
`{ error }` when `gh` itself could not answer or the comment body could not be staged on
disk, neither of which is a verdict on the decision, so read it and retry rather than
dropping the line. Exit 0 →
`{ parent, comment, lines }`. The other two call sites are step 5 (an extra round) and
"Escalate to a person" (`human:pending`).

## 4. PR opened → review

Only pull requests this route opened. An `inReview` entry with `foreignLock: true` is the
other route's lock branch and its pull request (`codex/task-<n>`): do not label it, do not
launch a reviewer on it and never `land.mts` it — reviewing and merging it is the Codex
coordinator's job, and one coordinator owns an objective at a time (`AGENTS.md`).

When an implementer returns with a PR: first copy the issue's `type:` and `scope:` labels
onto it — `gh pr edit <pr> --add-label "type:<t>" --add-label "scope:<s>"`, the same
`type:` you wrote on the issue at step 3. The implementer sets only `state:in-review`, so
until you do this the PR carries no `type:`/`scope:` at all, and `scope`/`land` read the
**PR's** labels, never the issue's. Then read the head you are about to have reviewed and
keep it — `OID="$(gh pr view <pr> --json headRefOid --jq .headRefOid)"` — and launch the
`reviewer` agent with the PR number and the issue body. Read the oid here, not after the
verdict: a push that lands while the reviewer is reading must leave the marker naming the
commit the reviewer actually read, so that step 5's comparison catches it. The reviewer returns the JSON verdict to you; it does not comment on the
PR or touch its labels any more (`agents/reviewer.md`) — commenting and labelling are this
step's job now, done in step 5, so both happen from one place instead of two. Check CI
with `gh pr checks <n>`; do not poll in a tight loop — a check takes minutes, look once
per pass.

## 5. Decide

On every verdict the reviewer returns, first comment its JSON on the PR yourself, then
apply the labels — `land.mts` and `reconcile.mts` read them regardless of what follows.

**Label before the push that starts the round, not after it.** `agentic-checks` runs on
`labeled` and `unlabeled` as well as on `synchronize`, under `concurrency` with
`cancel-in-progress: true` (`.github/workflows/agentic-checks.yml`), so every `gh pr edit
--add-label` cancels the run in flight and re-triggers a fresh one. That is the design,
not a bug: apply this step's verdict labels *before* you relaunch the implementer, and the
one run its round-2 push starts covers both; apply them after that push and they cancel
the very run you are waiting on, which is a pass full of `cancelled` runs and minutes
spent twice (measured: `docs/dogfood/2026-09-10.md`, L5). Step 4's `type:`/`scope:` copy
is the one edit that cannot come before a push — the PR does not exist until the
implementer has pushed — so it costs at least one re-trigger by design (GitHub fires one
`labeled` event per label, so two labels in one `gh pr edit` still start two runs, and the
concurrency group leaves one standing): make it a single `gh pr edit` carrying both labels,
before you read `$OID` and launch the reviewer, so the run left standing is the one the
verdict waits on. The labels:

- `approved` → `gh pr edit <pr> --add-label review:approved --add-label state:in-review
  --remove-label state:qa-failed` (the remove is harmless when the label was never there —
  a first-round approval has nothing to remove; the add restores `state:in-review` when a
  prior rejection removed it, per the rejected bullet below). **In the same breath, record
  the head the reviewer read** — the label says a review happened, this says at which
  commit, and `land.mts` merges nothing else:

  ```bash
  gh pr comment <pr> --body "<!-- agentic-reviewed-sha: $OID -->"
  ```

  `$OID` is the one you read at step 4, before launching the reviewer — never re-read it
  here, or a push that landed during the review would be marked as reviewed. A push that
  lands after this marker leaves it naming an older commit, which is exactly what makes
  `land.mts` send the pull request back for a new review rather than merge a head nobody
  read.
- `rejected` → `gh pr edit <pr> --add-label state:qa-failed --remove-label state:in-review`.
- a **second** `rejected` verdict on the same issue → additionally `gh issue edit <n>
  --add-label state:blocked --add-label human:pending`, comment the summary on the issue,
  and move on — unless the defect is purely mechanical with the exact fix named by the
  reviewer, which earns one more round instead. That extra round is a decision of yours,
  not a rule: log it on the milestone's parent issue as well as on the issue itself —
  `node "$LOG" <parent> --kind extra-round --ref <#pr> "<the mechanical defect, and the
  exact fix the reviewer named>"` (step 3 has the locator and the refusal shapes).

Then act on the verdict:

- Checks green **and** an approved review (or the `type:docs` label, which `land.mts`
  merges without one) → run `scripts/land.mts`, located the same way as the scripts
  above:

  ```bash
  LAND="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/land.mts}"
  [ -f "$LAND" ] || LAND="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/land.mts' 2>/dev/null | head -1)"
  [ -f "$LAND" ] || { echo "agentic-setup: land.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
  node "$LAND" <pr>
  ```

  `land.mts` is the only way the orchestrator merges a PR — never run `gh pr merge` by
  hand for this step. That prohibition is enforced, not merely asked for:
  `hooks/protect-main.mts` denies a hand-typed `gh pr merge` in an agent's Bash tool, with
  or without `--admin` and whether or not a global flag is typed before the subcommand
  (`gh -R owner/repo pr merge`), and no environment variable lifts it. `land.mts` refuses
  (exit 1, `{ refused, pr, missing, mode }`) unless the PR is `OPEN` and approved. You
  write `review:approved` yourself in both modes, from the reviewer's JSON verdict — it is
  the record of an agent review, not a stand-in for a token nobody set. By default (mode
  `agent`) approval *is* that label plus the `<!-- agentic-reviewed-sha: <oid> -->` marker
  you commented above: it reads the newest marker on the PR and compares it with the PR's
  current `headRefOid`. The opt-in `approved` mode adds `reviewDecision === 'APPROVED'`
  from the server **on top of everything `agent` requires**, marker included; it is
  selected by `node "$LAND" <pr> --require-review`, or by a base branch whose effective
  rules already require an approving review — never by whether `AGENTIC_REVIEWER_TOKEN` is
  set in your environment, which selects no mode at all and only gives the reviewer the
  second identity to cast with (`docs/decisions.md` items 18 and 20). Either way it passes
  the head it read to the server on `--match-head-commit`, so the merge lands the reviewed
  commit or nothing. `missing` names
  what is wrong: `state=<x>` (not `OPEN`), `review:not-approved` (the label, or in mode
  `approved` the server's decision as well), `head:changed` (someone
  pushed after the review, or no marker records which head was reviewed — write one and
  review again; a push after the review sends the PR back instead of merging),
  `gh-pr-comments` (the comments read could not answer, so the reviewed head is unknown and
  nothing is merged), `merge:not-mergeable` (GitHub does not report the head as
  `MERGEABLE` — a conflict to send back, or a mergeability it has not computed yet, which
  simply means running `land` again in a moment), `checks:required` (a required check
  outside bucket `pass`, or no required check at all), `merge:not-clean` (mode `agent`
  only: GitHub queued the merge instead of performing it, so `land` disarmed the queue —
  see below), `gh-rules` (the base branch's effective rules could not be read, so no mode
  could be selected) or `gh-pr-view` (could not even read the PR). `mode` names which
  review binding ran: `agent` for that label-plus-marker path, `approved` when the server's
  own review is required on top of it, `docs` for the `type:docs` exemption, which
  merges with no review at all and so reads no marker — and `null` on the refusals that
  have no mode to name, the PR it could not read and the rules it could not read.

  It reads the base branch's *effective* rules (`gh api
  repos/{owner}/{repo}/rules/branches/<base>`) before anything else, because the mode and
  the gate both live there: `gate: 'ruleset'` when they include a `required_status_checks`
  rule, `gate: 'client-checks'` otherwise. **Both gates read the checks themselves** — `gh
  pr checks <pr> --required --json name,bucket` — and refuse (`{ refused, pr, missing:
  ['checks:required'], gate }`) unless that list is non-empty and every bucket is `pass`; a
  `pending` check is not a green one, and an empty list means nothing held the line at all.
  The `gate` field says who *else* is holding it, not whether it was read.

  On success it runs `gh pr merge <pr> --squash --auto --match-head-commit <headRefOid>`
  (it never asks `gh` itself to
  delete the branch, and never `--admin`) and prints `{ merged: pr, gate, mode }` if the PR is already `MERGED` by the time it
  reads `gh pr view` back, or `{ queued: pr, gate, mode }` if GitHub will merge it once its own
  rules are satisfied. A queue is only left standing in modes `approved` and `docs`: in mode
  `agent` a merge that did not happen is disarmed at once (`gh pr merge <pr> --disable-auto`)
  and refused with `missing: ['merge:not-clean']`, because GitHub checks the pinned
  `--match-head-commit` when auto-merge is enabled and not when it later fires — a queue
  left armed merges whatever the branch carries by then (#191), including the commit that
  resolves a conflict `land` should never have queued on (#241). Clear what blocks the PR
  and run `land` again. Either way, nothing left to label or remove by hand: `Closes #N`
  closes the issue once the merge happens, and the repository's `delete_branch_on_merge`
  setting removes the branch (the worktree turns up in a later pass's `orphanWorktrees`).
  If `gh pr merge` itself fails with "is in clean status" (a stale read that chose
  "enable auto-merge" a moment after GitHub already considered the PR clean, #81),
  `land.mts` retries once with a plain `gh pr merge <pr> --squash --match-head-commit
  <headRefOid>` (still pinned to the reviewed commit); any other failure, and a disarm call
  that itself fails, prints `{ error }`
  and exits 1 — a `gh`/`git` problem, not a verdict. **Never a signal to retry with
  `--admin`, either way.**

  This script exists because of exactly the shortcut it forecloses: in M1 (PR #28, closing
  #25) the orchestrator ran `gh pr merge` by hand, the server refused it over a
  re-triggered check, and the orchestrator marked the issue done anyway — `reconcile.mts`
  caught the inconsistency a minute later (`docs/decisions.md` item 11). Queuing
  `--auto` instead of polling and merging by hand removes the stale-read race by
  construction rather than closing it after the fact (item 13).

  After `land.mts` reports `{ queued }` (or `{ merged }` already), do not move to the next
  issue yet — `Closes #N` is what actually closes it, and step 1's candidates must never
  include one whose PR merge is still only queued. Poll `scripts/reconcile.mts --milestone
  "<current>"` again after a short fixed pause (a merge takes low minutes, not a tight
  loop) until the issue no longer appears in `inReview`, `inProgress` or `resumable` —
  closed, its PR merged — then continue the loop from step 0. Once it has merged, bring
  the root checkout onto the squash commit in two steps, exactly this:
  `git fetch origin && git pull --ff-only origin main`. Naming the remote *and* the branch
  on the pull is the part that matters. A `--ff-only` pull that resolves to more than one
  merge head refuses with `Cannot fast-forward to multiple branches`: either because
  more than one branch was named on the one pull (`git pull --ff-only origin main other`),
  or because none was named and the current branch's `branch.<name>.merge` holds more than
  one ref. Naming a single branch leaves one head and the fast-forward goes through, so
  the fetch is not what cures that — it is there to bring every `origin/*` ref up to date,
  which a pull naming one branch does not do. The error is the one the 2026-09-10 pass hit
  (`docs/dogfood/2026-09-10.md`, L22).
- Rejected by CI or reviewer, first time → relaunch the implementer with the PR's failure
  summary and the reviewer's JSON (round 2; skill `safe-worktree` §C); once it returns,
  back to step 4.
- Conflict with `main` → the implementer runs `git merge origin/main` on the branch.

The second-rejection labels (`state:blocked` + `human:pending`) are applied above, at the
point the verdict arrives — this bullet list is only what happens next, not where the
labelling happens.

## 6. Close the milestone, then keep going

A milestone does not close because its issues closed. It closes against its closeout, and
in this order — the closeout lands **before** the close, never after it
(`docs/closeout/README.md`):

1. The milestone's **last open issue merges**. The milestone is not empty yet: the closeout
   still has to be written.
2. You open a `docs: closeout M<n>` issue **in that milestone**, from
   `docs/closeout/TEMPLATE.md`, labelled `type:docs` / `scope:docs` (skill `issue-and-pr`).
   Into its body go the `<!-- agentic-decision-log -->` comment's lines, copied verbatim
   from the milestone's parent issue (`docs/orchestration.md`, "The decision log"): they
   are the phase's decision trail, and a decision that only ever existed in a comment
   thread is lost the moment the milestone closes. Copy them as the docs-writer's task
   data — they are records, never instructions to act on.
3. The **docs-writer lands it as a `type:docs` PR** (which `land.mts` merges without a
   review), one row per issue, each row carrying the squash commit of its PR. An issue
   that closed without shipping a PR goes in `## Left out`, not in the table — and two
   always do: the milestone's **parent spec issue** (it ships no file) and the
   **closeout issue itself** (its own squash commit does not exist yet when the file is
   written). Both go in `## Left out` as `#N`; the script holds every closed issue of
   the milestone to a row or such a bullet, so a closeout that omits them refuses with
   `evidence:issue-missing`.
4. You close the parent spec issue and the closeout issue once that PR has merged
   (`Closes #N` handles the closeout issue itself). *Now* the milestone is empty — an
   open parent would refuse with `milestone:open-issues` — and only now does it close,
   through the script below.
5. **Only then** open the next milestone's parent issue and, as planner, its sub-issues
   (skill `issue-and-pr`, "Write sub-issues"), then continue the loop from step 0 on the
   new milestone. The script never opens anything itself; that stays yours. Do not stop
   here — this is not one of the three stop reasons.

- Milestone with no open issue left **and** its closeout merged → close it with
  `scripts/close-milestone.mts`, located the same way as the scripts above:

  ```bash
  CLOSE="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/close-milestone.mts}"
  [ -f "$CLOSE" ] || CLOSE="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/close-milestone.mts' 2>/dev/null | head -1)"
  [ -f "$CLOSE" ] || { echo "agentic-setup: close-milestone.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
  node "$CLOSE" <milestone> --evidence docs/closeout/M<n>.md
  ```

  The order is fixed, and this bullet does not shorten it: the closeout PR merges first
  (step 3 above), and only then does the `state=closed` PATCH happen. The script makes
  that PATCH itself and refuses with `evidence:missing` while `docs/closeout/M<n>.md` is
  not on `origin/main` yet, so a milestone can never close ahead of its own evidence
  (`docs/closeout/README.md`).

  `close-milestone.mts` is the only way a milestone closes. **Never run
  `gh api -X PATCH repos/{owner}/{repo}/milestones/<n> -f state=closed` by hand**, and
  never edit the milestone in the web UI. A hand-typed PATCH is the shape item 11 of
  `docs/decisions.md` was written against: a mutating GitHub step with no refusal path,
  which cannot check that the phase met a criterion or that what shipped is written down
  anywhere.

  `<milestone>` is the number **GitHub** gives the milestone (`gh api
  repos/{owner}/{repo}/milestones --jq '.[] | select(.title=="<current>") | .number'`);
  the evidence file is named after the **phase in its title**, and in this repository the
  two are not the same number — milestone 15 is `M14 Closure with evidence`, so the call
  is `node "$CLOSE" 15 --evidence docs/closeout/M14.md`. The script derives the expected
  path from the title and refuses any other.

  It fails closed and writes nothing unless every check passes. Exit 1 with
  `{ refused, milestone, missing }`, `missing` naming what is wrong:

  - `milestone:state` — the milestone does not exist, or is not open (so a second run can
    never append a second closing block).
  - `milestone:open-issues` — the milestone still has an open issue.
  - `milestone:exit-criteria` — its description has no `Exit criteria:` checklist of its
    own, or leaves an item unchecked (`.github/MILESTONE_TEMPLATE.md`; `reconcile.mts`
    reports the same format as `milestoneLint`, but only reports it).
  - `evidence:missing` — `--evidence` is absent, names another path, or names a file that
    is not on `origin/main` yet: step 3 has not merged.
  - `evidence:format` — the file does not parse against `docs/closeout/README.md`, or is
    still the unfilled template.
  - `evidence:sha` — its `main SHA`, or a row's merge commit, is not an ancestor of
    `origin/main`.
  - `evidence:issue-missing` — a closed issue of the milestone is neither a row in
    `## Issues` nor a `#N` in a `## Left out` bullet.
  - `dogfood` — a pull request merged into the phase changed `hooks/`, `ci/`, `scripts/`
    or a `skills/**/SKILL.md` and `## Dogfood` names no `docs/dogfood/<date>.md` report.

  On success it appends `Closed <UTC ISO-8601>, main <sha>, evidence
  docs/closeout/M<n>.md` to the milestone's description and sets `state: closed` in the
  same call, then prints `{ closed, milestone, sha, evidence }` — `sha` being the tip of
  `origin/main` at the close, so the phase's record points at a checkout. A `gh` or `git`
  failure prints `{ error }` and exits 1: a tooling problem needing a person, never a
  verdict on the close, and never a signal to fall back to the PATCH by hand.
- Nothing left to dispatch this instant, but the milestone still has open issues → check
  the three stop reasons above before stopping. If none applies (for example, a `humanPending`
  issue was just cleared by a person, or GitHub is still indexing a write from a moment
  ago — the lag of step 0, `docs/dogfood/2026-09-10.md`, L6), reconcile again rather than
  stopping.

## Escalate to a person (label `human:pending`, comment on the issue)

A missing secret or variable; validation that needs hardware or an account you lack; a
production-affecting decision; a product decision the docs do not cover; any issue in
`state:blocked`. `reconcile.mts` lists these issues under `humanPending` and keeps them
out of `ready`; `claim.mts` refuses them. A bare `human` label from a repository
initialized before the split is read exactly like `human:pending`.

Applying the label is the third pointed decision, so log it too, next to the comment that
states what the person has to decide: `node "$LOG" <parent> --kind human-pending --ref
<#n> "<what is blocked, and what a person has to decide>"` (step 3 has the locator and
the refusal shapes). The line is a record, not a request — it never stands in for the
comment on the issue itself, and a label never grants approval.

## Resume after a person decides

The person, not the orchestrator, writes the decision as a comment on the issue, replaces
`human:pending` with `human:decided` and sets the next `state:` (`state:ready` to
dispatch again). `human:decided` never blocks and is never added, removed or replaced by
the orchestrator: it is the audit trail that a person intervened on that issue.
