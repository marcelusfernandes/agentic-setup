# Orchestrating agents in worktrees

## The orchestrator

One Claude Code session at the repository root (not in a worktree), running
`/agentic-setup:orchestrate` as a continuous loop over every open milestone — see
"Headless" below for the unattended command and the loop's closed list of stop reasons.
Two roles:

- **planner:** decomposes the milestone's parent issue into self-sufficient sub-issues
  (context with `file:line` references, acceptance criteria, proof, globs,
  dependencies). Schema or contract changes become their own issues, opened first;
  feature issues that depend on them are born blocked.
- **dispatcher:** the loop below. The only role that touches the root `package.json`
  (or equivalent), the lockfile, `.claude/**`, `.github/**`, `main` and the labels.
  It never implements.

```
0. `scripts/reconcile.mts` prints the loop's state as one JSON document (`milestone`,
   `ready`, `humanPending`, `inProgress`, `resumable`, `inReview`, `stale`,
   `orphanWorktrees`, `deadWorktrees` — see `skills/orchestrate/SKILL.md` step 0 for the invocation and what
   each field means), instead of reconciling from memory. It fetches `origin` with prune
   itself first (`--no-fetch` reads the local refs left by the last fetch, for an offline
   check):
   carrying `human:pending` or a legacy bare `human`, whatever its state → not
   dispatched; a person decides and flips it to `human:decided` (`humanPending`)
   in-progress with no PR and no remote branch → ready (`stale`)
   in-progress with a remote branch, no PR and no local worktree on it → dispatch as
   round N+1 from origin/<branch>, no re-claim (`resumable`)
   in-review, checks read per PR via `gh pr checks <pr> --json name,bucket` (green when
   every bucket is pass/skipping, red on any fail/cancel, else pending), and an approved
   review → merge (`inReview`)
   local worktree with no remote branch → delete (`orphanWorktrees`)
   local worktree locked by a pid that no longer exists → save uncommitted/unpushed work
   first (see the card), then unlock, remove --force, then treat its issue as `resumable`
   before step 3 (`deadWorktrees`)
1. `ci/issue-lint.mts <n>` on every state:ready candidate with no open dependency;
   dispatch only `ok: true`. issue-lint checks the contract only — sections present,
   globs that parse and match something (or are `new`), globs disjoint from the other
   issues already in flight in the milestone, and every `Blocked by: #N` number exists —
   it never reads a diff, so it has no entry-point warning to fold in; a `failures` entry
   drops the candidate (a wildcard glob whose fixed prefix has no tracked file is `new`,
   like a literal new path, not a failure), a `sequenced` overlap does not
2. pick up to 4 whose globs do not intersect (`issue-lint`'s own failures/sequenced
   already checked this against the milestone's other in-flight issues)
3. for each: `scripts/claim.mts <n> --slug <slug>` runs `ci/issue-lint.mts` on the issue
   itself first and refuses (`{ refused: "issue-lint failed", lint }`) on anything but
   `ok: true` (`--no-lint` to skip), then pushes the remote branch <type>/<n>-<slug> as
   the lock (skip on `{ held }`, exit 2), assigns, labels in-progress, then launch an
   `implementer` in its own worktree with the whole issue in the prompt; a `resumable`
   issue skips `claim.mts` — the lock is already held — and launches straight to an
   implementer as round N+1 from origin/<branch>
4. PR opened → launch a `reviewer` (read-only), wait for it. The reviewer returns the JSON
   verdict; it no longer comments on the PR or touches its labels (that moved here, to the
   orchestrator, in step 5) — read `agents/reviewer.md`. Check CI with `gh pr checks <n>`
5. on the verdict: comment it on the PR and apply the labels yourself — `approved` →
   `review:approved` (+ remove `state:qa-failed`); `rejected` → `state:qa-failed`; a
   *second* `rejected` on the same issue → additionally `state:blocked` + `human:pending`
   on the issue, comment the summary, move on (exception: a mechanical defect with the
   exact fix named by the reviewer earns one short extra round instead)
   green checks + an approved review (or the `type:docs` label) → `scripts/land.mts <pr>`
   refuses unless the PR is OPEN and approved, then gates on the base branch's ruleset
   when it has a `required_status_checks` rule, else on `gh pr checks <pr> --required`,
   then queues `gh pr merge <pr> --squash --auto` — the server merges once its own rules
   are satisfied. `Closes #N` closes the issue on merge (closed is done, nothing to
   relabel); the repository's `delete_branch_on_merge` setting removes the branch, and
   the now-orphaned worktree is picked up by `orphanWorktrees` on a later pass. After
   `land.mts` reports `{ queued }`/`{ merged }`, poll `reconcile.mts` (a fixed pause
   between reads, not a tight loop) until the issue drops out of `inReview`/`inProgress`/
   `resumable` entirely, then loop back to 1
   `land.mts` refused (`missing`: `state=<x>`, `review:not-approved`, `checks:required`,
   or `gh-pr-view`) → read it and decide between waiting and sending the PR back; never a
   retry with `--admin`
   rejected (CI or reviewer), first time → back to the implementer with the summary
   (round 2), then back to 4
   main moved and conflicts → implementer runs `git merge origin/main` (never rebase
   a published branch)
6. milestone with no open issue left → open the next milestone's parent issue and its
   sub-issues, then keep looping on the new milestone — this is not a stop condition;
   nothing left to dispatch this instant, but the milestone still has open issues → check
   the closed list of stop reasons below before actually stopping
```

Why "reconcile from GitHub": the orchestrator's context is summarised, restarted and
lost. Labels, branches and PRs are not. Every pass starts by reading them.

## Stop reasons

The loop above runs to completion, not one pass; it stops only for one of these three
reasons, spelled out in full in `skills/orchestrate/SKILL.md`:

1. No open milestone.
2. Every open issue in the milestone is `state:blocked`, `human:pending`, or otherwise
   waiting on a person — including a `reconcile`/`gh`/`git` call itself failing with
   `{ error }`, which needs a person, not a retry.
3. An explicit turn or time budget given on the command line (`--max-turns`, or an
   external `timeout`) is spent.

On stop, the orchestrator comments a summary on the milestone's parent issue.

## Headless

Running the loop unattended, with no person watching the session, needs a Claude Code
session started with `-p` (print mode: run to completion, no interactive prompts), a
worktree hook so agent worktrees land outside `.claude/` (see the hooks table below), and
enough tool permission granted up front that neither the orchestrator nor an implementer
stalls on a permission prompt nobody is there to answer. The command that reached a closed
milestone unattended (#129 L13, PR #130):

```bash
claude --plugin-dir <path-to-the-agentic-setup-plugin-checkout> \
  -p "/agentic-setup:orchestrate" \
  --permission-mode acceptEdits \
  --allowedTools Bash Read Edit Write Glob Grep Agent \
  --settings '{"hooks":{"WorktreeCreate":[{"hooks":[{"type":"command","command":"node \"<path-to-the-plugin-checkout>/hooks/worktree-create.mts\""}]}]}}'
```

What each flag is for:

- `--plugin-dir <path>` — points the session at a local checkout of this plugin instead of
  the marketplace install, so `CLAUDE_PLUGIN_ROOT` resolves for every script and hook
  invocation the same way it does interactively.
- `-p "/agentic-setup:orchestrate"` — runs the skill once, to completion (the loop inside
  it, not one pass), and exits when the loop stops; there is no REPL to leave running.
- `--permission-mode acceptEdits` — accepts file edits without a prompt; `Bash` calls still
  go through the `allowedTools` list and the two `PreToolUse` hooks (`protect-main.mts`,
  `protect-worktree.mts`), which is what actually keeps a headless session from pushing to
  `main` or writing outside its worktree, not this flag.
- `--allowedTools Bash Read Edit Write Glob Grep Agent` — the minimum set the orchestrator
  and the implementers/reviewers it dispatches need; `Agent` is what lets the orchestrator
  launch them as foreground subagents (`docs/decisions.md`, #129 L11 — a backgrounded
  implementer's work dies with the top-level session that returned before it finished, so
  the prompt and this flag both matter, not the flag alone).
- `--settings '{"hooks":{"WorktreeCreate":[...]}}'` — registers `worktree-create.mts` (see
  the hooks table below) for this session only, so every agent's worktree lands under
  `${AGENTIC_WORKTREE_DIR:-<tmpdir>/agentic-worktrees}/<name>` instead of
  `.claude/worktrees/agent-<id>`, a path Claude Code's own protected-path rules deny
  writes into from a headless session (#129 L10). A project-wide install can instead add
  the same entry to `hooks/hooks.json` (already done in this plugin) so every session picks
  it up without the `--settings` flag; the flag is for a checkout that has not adopted it
  yet, or for overriding the destination per invocation.

Turn and time budgets, when wanted, are ordinary flags around the same command —
`--max-turns <n>` on `claude` itself for a turn budget, an external `timeout <seconds>
claude -p ...` for a time budget — never invented by the orchestrator itself; see "Stop
reasons" above.

The loop stops only for the three reasons above; it does not stop merely because a
person is not watching.

## The implementer, step by step

0. Prove the secrets arrived in the worktree (a worktree is born with tracked files
   only; `.worktreeinclude` or your equivalent copies the rest).
1. Prove the base is right: `git fetch`, and `grep` for a symbol the prerequisite issue
   delivered. A stale worktree does not see what another issue merged.
2. Prove you can write (a throwaway edit). The write guard complains now, not on the
   third edit.
3. Read the issue and everything it links.
4. Write the failing test. Commit it as `test(red): …` — the convention that keeps
   the red test visible in history. `negative-control` reads the PR's diff, not the
   commit: the changed test files are copied onto a checkout of the base and the
   suite must fail there, so the PR's diff must add or change a test file.
5. Implement until the test command is green. Commit at every green.
6. Run the project's check command (types, lint, fast scans). Green.
7. Open the PR with the template (a closing keyword — `Closes`/`Fixes`/`Resolves #N`,
   several may be linked, the diff must fit the union of their globs, never quote a
   keyword inside backticks or a fence — test summary, globs touched). Label
   `state:in-review`. Copy the issue's `type:`/`scope:` labels onto the PR.
8. Stop. Do not wait on CI, do not poll the PR, do not merge — the orchestrator watches
   the checks and launches the reviewer; polling here would only burn the implementer's
   own turns. If CI or the reviewer sends it back, fix in the same worktree and update
   the PR.

Forbidden: `git stash`, `git reset --hard`, `git checkout <file>`, `git clean`,
force-push, editing outside the globs, touching the root manifest or lockfile. Need a
new dependency? Comment on the issue and stop: that is a `type:deps` issue for the
orchestrator. Conflict with `main`: `git rebase` only before the first push; a published
branch uses `git merge origin/main` (the final squash flattens it).

## The reviewer

Read-only. Checks each acceptance criterion against the diff and the test summary; the
scope; the negative control; the project's invariants (whatever `CLAUDE.md` names as
such). Returns JSON:

```json
{"verdict": "approved" | "rejected", "reasons": [{"ac": "AC2", "file": "path:line", "missing": "..."}]}
```

and returns it to the orchestrator that launched it — it is the orchestrator, not the
reviewer, that comments the verdict on the PR and sets `review:approved` or
`state:qa-failed` (`skills/orchestrate/SKILL.md` step 5). When `AGENTIC_REVIEWER_TOKEN` is
set in its environment, the reviewer also casts a real GitHub review (`gh pr review
--approve` or `--request-changes`) as that separate identity — `land.mts` then requires
the review itself, not the label (`agents/reviewer.md`, `docs/decisions.md` item 13).
Never edits, never merges, never offers to fix.

## Hooks (deterministic, instead of prose)

| event | hook | what it does |
|---|---|---|
| WorktreeCreate | `worktree-create.mts` | creates every agent's worktree itself, outside the main checkout — `${AGENTIC_WORKTREE_DIR:-<tmpdir>/agentic-worktrees}/<name>`, detached HEAD, `node_modules` symlinked in when the checkout has one, path printed on stdout. Ships because Claude Code's own default (`.claude/worktrees/agent-<id>`) sits under a protected path and a headless implementer's writes there were denied (#129 L10/L11); this hook replaces that default once registered. Fails **closed**: any error exits 1 with nothing on stdout, since there is no later layer to catch a bogus or missing worktree the way the ruleset catches a missed push |
| PreToolUse Bash | `protect-main.mts` | the third layer, for a session in a repo with no server-side ruleset yet: denies a force-push, a push or delete of `main`/`master`, and `gh pr merge --admin`. `AGENTIC_ALLOW_PUSH_MAIN=1` lifts the push form only, never deletion. Force-push, `reset --hard`, `clean` and `stash` are also denied declaratively by the permission deny list `/agentic-setup:init` writes |
| PreToolUse Edit/Write | `protect-worktree.mts` | denies a subagent's write that resolves inside the main checkout but outside its own worktree. A real failure mode: under load the model writes with an absolute path rooted at the main repository, and a prose rule does not stop it |

There is no Stop or SubagentStop hook: nothing runs the check or test commands before an
agent stops. CI (`test`, `scope`, `negative-control`) is the only gate before a merge is
queued — see item 13 of `docs/decisions.md` for why the earlier Stop-hook layer was cut.

Hooks run with Claude Code's environment (`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin,
the payload's `cwd` to the agent's worktree). A change to a hook takes effect after the
plugin updates, for every agent at once. The two `PreToolUse` hooks fail **open** when
Node is missing or they crash — the git `pre-push` hook, the ruleset (when the plan
allows one) and the `guard-main` action are the other layers behind them.
`worktree-create.mts` is the exception: it fails **closed**, because there is nothing
behind it to create the worktree if it does not (see the table above).

## Escalation to a person

Five reasons, always with the `human:pending` label and a comment on the issue: a missing
secret or variable; validation that needs hardware or an account the agent lacks; a
production-affecting decision; a product decision the docs do not cover; **an issue in
`state:blocked`** after two rounds. The person records the decision in a comment,
replaces `human:pending` with `human:decided` and sets the next `state:`; the decided
label stays as the audit trail and never blocks. A bare `human` label from before the
split is read as pending.

## Known limits

- **Every subagent is born pinned to a fresh worktree.** Claude Code's own default is
  `.claude/worktrees/agent-<id>`, a protected path whose writes a headless session denied
  outright (#129 L10/L11); the plugin ships a `WorktreeCreate` hook (`worktree-create.mts`,
  see the table above) that creates it outside the main checkout instead —
  `${AGENTIC_WORKTREE_DIR:-<tmpdir>/agentic-worktrees}/<name>` — once registered in the
  session's settings. Either way the sandbox refuses git in another worktree. Round N+1
  of an issue starts from
  `origin/<branch>` on a local branch `<branch>-rN` and pushes fast-forward to `<branch>`;
  the state that matters is always on the remote (commit at every green). The
  orchestrator removes the old worktree **after** the merge, never before: pruning a
  worktree still in use is what decides whether round N+1 resumes the same agent
  (`SendMessage`, context kept) or starts from zero — delete early and the decision was
  made by accident.
- **Shared local services are the hidden coupling.** If two worktrees point at the same
  local database, cache or dev server, one agent's reset lands under another's test run.
  Derive ports and instance names from the worktree path, and stop the instance before
  removing the worktree — an orphaned stack is how a machine runs out of memory.
- Subagents do not see the orchestrator's conversation: the issue must be
  self-sufficient.
- What limits parallelism is file conflict, not the subagent ceiling. Four issues with
  disjoint globs is the practical number.
- The implementer does not wait on CI. Polling CI burns tokens; the reviewer follows the
  checks and comments its verdict back, and the orchestrator does the rest of the
  waiting — it watches the checks (step 4), then, after queuing the merge, polls
  `reconcile.mts` at a fixed interval until the PR is actually `MERGED` (step 5) before
  moving to the next issue. Neither wait is a tight loop.
- **The check re-run window no longer needs a client-side read.** A label change (or a
  push) re-triggers `agentic-checks`, so a PR the orchestrator saw as green a moment
  earlier can have a required check back to `IN_PROGRESS` by the time it acts. Where
  `land.mts` gates on the ruleset, `gh pr merge --auto` sidesteps this by construction: it
  merges the instant GitHub's own rules are satisfied, so there is no client-side snapshot
  that can go stale between being read and the merge happening — closing by design the M1
  gap where the orchestrator relabelled an issue done on read state the server no longer
  agreed with (`docs/decisions.md` items 11 and 13). Where it gates on `gh pr checks
  --required` instead (no ruleset on the base branch), that read is still a snapshot taken
  moments before `--auto` is queued.
- **No Stop or SubagentStop hook runs the test or check commands before an agent stops.**
  CI is the only gate; an implementer that stops with a red suite finds out from the
  `test` check on its PR, not before.
- **The reviewer and the merging identity can be the same token.** Without
  `AGENTIC_REVIEWER_TOKEN` configured, `review:approved` is a label the same identity that
  runs `land.mts` can write itself — `land.mts` then falls back to trusting the label. With
  the token set (and the base branch ruleset's `required_approving_review_count` raised to
  1, in that order — see `docs/decisions.md` item 13), only a real `APPROVED` review from
  the separate reviewer identity counts.
- Agent Teams do not isolate in worktrees; the loop does not use them.
- **A restarted orchestrator session cannot tell a live implementer from an abandoned
  one by label state alone.** If the orchestrator process dies (an OS kill, low memory)
  mid-pass, every issue it had claimed stays `state:in-progress` with a pushed lock
  branch and no PR — indistinguishable, from labels alone, from an implementer still
  working. A local worktree checked out on that branch is not proof either, but it is
  evidence with a known shape: Claude Code locks an agent's worktree only while that
  agent runs, with a reason of the form `claude agent agent-<id> (pid <N> start
  <date>)`; it removes the lock on a clean exit (the worktree stays, unlocked), but a
  killed session leaves the lock behind, still naming the now-dead pid — exactly the
  incident above. `reconcile.mts`'s `resumable` list narrows this gap: it reads that
  lock and signals the pid it names (`process.kill(N, 0)`); when it is gone (`ESRCH`)
  the worktree does not count as a live checkout — its issue is `resumable` and the
  worktree itself is listed in `deadWorktrees` for the orchestrator to remove. A
  worktree with no lock, no pid in its lock reason (or `pid <= 0`, which proves
  nothing), or a pid that is still alive (or cannot be signalled for permission reasons
  — fail safe) is treated as a live checkout, so its issue stays `inProgress`. The gap
  the lock cannot narrow: an agent that finished *without* opening a PR, in a session
  that has since died, leaves its worktree unlocked — indistinguishable, by this rule,
  from a live session's paused agent. That residual still reads `inProgress` and needs
  a person, or a future liveness signal, to resolve. Either way, a `resumable` issue is
  resumed as round N+1 from `origin/<branch>`, not reclaimed.
