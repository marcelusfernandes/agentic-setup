# Orchestrating agents in worktrees

## The orchestrator

One Claude Code session at the repository root (not in a worktree), running
`/agentic-setup:orchestrate` one pass at a time. Two roles:

- **planner:** decomposes the milestone's parent issue into self-sufficient sub-issues
  (context with `file:line` references, acceptance criteria, proof, globs,
  dependencies). Schema or contract changes become their own issues, opened first;
  feature issues that depend on them are born blocked.
- **dispatcher:** the loop below. The only role that touches the root `package.json`
  (or equivalent), the lockfile, `.claude/**`, `.github/**`, `main` and the labels.
  It never implements.

```
0. `scripts/reconcile.mts` prints the loop's state as one JSON document (`milestone`,
   `ready`, `inProgress`, `resumable`, `inReview`, `stale`, `orphanWorktrees`,
   `deadWorktrees` — see `skills/orchestrate/SKILL.md` step 0 for the invocation and what
   each field means), instead of reconciling from memory. It fetches `origin` with prune
   itself first (`--no-fetch` reads the local refs left by the last fetch, for an offline
   check):
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
4. PR opened → launch a `reviewer` (read-only) and wait for CI
5. green checks + an approved review (or the `type:docs` label) → `scripts/land.mts <pr>`
   refuses unless the PR is OPEN and approved, then gates on the base branch's ruleset
   when it has a `required_status_checks` rule, else on `gh pr checks <pr> --required`,
   then queues `gh pr merge <pr> --squash --auto` — the server merges once its own rules
   are satisfied. `Closes #N` closes the issue on merge (closed is done, nothing to
   relabel); the repository's `delete_branch_on_merge` setting removes the branch, and
   the now-orphaned worktree is picked up by `orphanWorktrees` on a later pass → back to 1
   `land.mts` refused (`missing`: `state=<x>`, `review:not-approved`, `checks:required`,
   or `gh-pr-view`) → read it and decide between waiting and sending the PR back; never a
   retry with `--admin`
   rejected (CI or reviewer) → back to the implementer with the summary (round 2)
   main moved and conflicts → implementer runs `git merge origin/main` (never rebase
   a published branch)
   second rejection → state:blocked + human, comment with the summary, move on
     (exception: a mechanical defect with the exact fix named by the reviewer earns
      one short extra round; a rejection with judgment pending blocks)
6. pass with nothing to do → summary of what is blocked on the parent issue;
   milestone with no open issue → open the next milestone's parent issue
```

Why "reconcile from GitHub": the orchestrator's context is summarised, restarted and
lost. Labels, branches and PRs are not. Every pass starts by reading them.

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
8. Stop. Do not merge. If CI or the reviewer sends it back, fix in the same worktree
   and update the PR.

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

and sets `review:approved`, or `state:qa-failed` with the reasons. When
`AGENTIC_REVIEWER_TOKEN` is set in its environment, it also casts a real GitHub review
(`gh pr review --approve` or `--request-changes`) as that separate identity — the label
stays a convenience, but `land.mts` then requires the review itself, not the label
(`agents/reviewer.md`, `docs/decisions.md` item 13). Never edits, never merges, never
offers to fix.

## Hooks (deterministic, instead of prose)

| event | hook | what it does |
|---|---|---|
| PreToolUse Bash | `protect-main.mts` | the third layer, for a session in a repo with no server-side ruleset yet: denies a force-push, a push or delete of `main`/`master`, and `gh pr merge --admin`. `AGENTIC_ALLOW_PUSH_MAIN=1` lifts the push form only, never deletion. Force-push, `reset --hard`, `clean` and `stash` are also denied declaratively by the permission deny list `/agentic-setup:init` writes |
| PreToolUse Edit/Write | `protect-worktree.mts` | denies a subagent's write that resolves inside the main checkout but outside its own worktree. A real failure mode: under load the model writes with an absolute path rooted at the main repository, and a prose rule does not stop it |

There is no Stop or SubagentStop hook: nothing runs the check or test commands before an
agent stops. CI (`test`, `scope`, `negative-control`) is the only gate before a merge is
queued — see item 13 of `docs/decisions.md` for why the earlier Stop-hook layer was cut.

Hooks run with Claude Code's environment (`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin,
the payload's `cwd` to the agent's worktree). A change to a hook takes effect after the
plugin updates, for every agent at once. Hooks fail **open** when Node is missing — the
git `pre-push` hook, the ruleset (when the plan allows one) and the `guard-main` action
are the other layers.

## Escalation to a person

Five reasons, always with the `human` label and a comment on the issue: a missing
secret or variable; validation that needs hardware or an account the agent lacks; a
production-affecting decision; a product decision the docs do not cover; **an issue in
`state:blocked`** after two rounds.

## Known limits

- **Every subagent is born pinned to a fresh worktree** (`.claude/worktrees/agent-<id>`)
  and the sandbox refuses git in another worktree. Round N+1 of an issue starts from
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
  checks and the orchestrator reconciles.
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
