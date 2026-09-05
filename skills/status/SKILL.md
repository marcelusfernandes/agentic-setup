---
name: status
description: Show the state of agentic-git work in this repo — epics and their progress, which tasks are ready to start, which are blocked and by what, running streams, live worktrees and open PRs. Read-only.
argument-hint: "[<epic-slug>] | next | blocked | streams | prs"
user-invocable: true
allowed-tools: Read, Glob, Bash(bash:*), Bash(git:*), Bash(gh:*), Bash(jq:*)
model: sonnet
---

# agentic-git: status

A thin router. All output comes from scripts; add nothing but a one-line reading of it. Never edit state here — `status` is read-only and must be safe to call anywhere, at any time.

Mode: `$0` (empty, an epic slug, or one of `next`, `blocked`, `streams`, `prs`). Remaining arguments: `$ARGUMENTS`.

Local facts:
- state dir: !`test -d .claude/agentic && echo yes || true`
- epics: !`ls .claude/agentic/epics 2>/dev/null || true`

## Router

| `$0` | Run | Shows |
|---|---|---|
| *(empty)* | `bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/status.sh"` | every epic — slug, milestone, issue, x/y tasks closed, %; then live worktrees; then open agentic PRs |
| `<epic-slug>` | `bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/status.sh" "$0"` | that epic's task table: issue, title, status, deps, parallel, branch, worktree, PR |
| `next` | `bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/next.sh" [<slug>]` | tasks whose `status` is `open` and **all** `depends_on` are closed, topological then estimate order, each with its exact `/agentic-git:start <n>` line |
| `blocked` | `bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/blocked.sh" [<slug>]` | each blocked task and the open issues blocking it |
| `streams` | `bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/streams.sh"` | running / blocked / done streams from `runtime/streams/**`, with age |
| `prs` | `bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/status.sh" prs` | one line per open agentic PR with a merge-readiness verdict |

Resolve `$0` in this order: exact mode keyword → an existing directory under `.claude/agentic/epics/` → empty. If `$0` is neither a keyword nor an existing epic, print the valid modes and the list of epic slugs, and exit normally.

## Procedure

1. If `.claude/agentic/` does not exist, print
   `agentic-git is not initialized here — run /agentic-git:init`
   and exit **successfully**. This is never an error.
2. Run exactly the one script for the resolved mode. Do not call `gh` yourself; `prs` mode's one read-only query lives inside `status.sh`.
3. Print the script's output as-is, inside a fenced block if it is a table.
4. Add at most three lines of reading on top: what is ready now, what is the single biggest blocker, and the one command to run next. Nothing else — no speculation about work not represented in state.

## Network use

Default mode and `next`, `blocked`, `streams` are fully offline and instant, which is why `work` and `merge` can call them freely. Only `prs` and the single-epic detail mode touch the network, and the detail mode does so with one issue-state query per **epic**, never per task.

If a network call fails (offline, rate limited, unauthenticated), print the offline part of the report and add
`GitHub unreachable — issue states below are from local state, last updated <mapping.updated>`.
Do not retry in a loop and do not turn it into a stop condition.

## Final summary format

Default mode:
```
epics
  oauth-login    #100  v1.2   3/5 closed  60%   in-progress
  audit-log      #140  —      0/4 closed   0%   backlog

worktrees
  .worktrees/epic-oauth-login   epic/oauth-login   2 commits ahead, clean
  .worktrees/126-audit-writer   feat/126-…         dirty

open PRs
  #45  feat(db): oauth providers (#123)   approved · checks green  → ready to merge
  #46  feat(api): token exchange (#124)   review pending           → wait

ready now: 125, 127     blocked: 128 (by #124)
Next: /agentic-git:start 125
```

`next` mode ends with the exact per-task start lines the script printed; `blocked` ends with the single issue that unblocks the most tasks; `streams` ends with any stream older than an hour flagged as stale.
