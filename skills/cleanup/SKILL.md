---
name: cleanup
description: Tidy up after merged work — remove worktrees whose branches are gone, delete merged local branches, prune stale worktree metadata, archive completed epics, and close finished milestones. Every deletion is listed and confirmed first.
argument-hint: "[--epic <slug>] [--worktrees] [--branches] [--archive] [--yes]"
disable-model-invocation: true
user-invocable: true
model: sonnet
---

# cleanup

List every candidate deletion, confirm, then execute — safe operations only.

Arguments: `$ARGUMENTS`.

Ground rules:

- Every script accepts `--help`; adapt from its help if an invocation is rejected. Never call `gh` — use `scripts/host.sh <verb>`.
- **Never `--force`, never `git branch -D`, never `git reset --hard`, never `git clean -fdx`.** Anything that would lose uncommitted work requires the human to type the literal token `discard <name>` in the same turn — and even then this skill only *prints* the forcing command for them to run.
- Nothing outside `config.worktree_dir` is ever touched, no matter how stale it looks.

## Procedure

1. **Refresh.**
   ```bash
   git fetch origin --prune
   ```

2. **Build the candidate list — act on nothing yet.**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/git/clean-gone.sh"
   ```
   It reports, each with a reason:
   - branches whose upstream is gone (`[gone]`)
   - branches fully merged into `origin/<config.base_branch>`, excluding `config.protected_branches` and the current branch
   - worktrees **under `config.worktree_dir` only** whose branch is in one of those sets
   - prunable worktrees (their directory no longer exists)
   Add from state:
   - epics whose tasks are all `closed` and whose PRs are all merged (`scripts/state/epic-progress.sh <slug>` to confirm 100%)
   - milestones with `open_issues == 0` and `state == open` (`host.sh milestone list`)
   `--epic <slug>` narrows everything to one epic; `--worktrees` / `--branches` / `--archive` narrow by action.

3. **Print the plan** grouped by action, one line per item with its reason, and **require confirmation**. `--yes` skips confirmation only for the non-destructive parts: `git worktree prune`, state archiving, milestone closing. Branch and worktree deletion always need an explicit yes.

4. **Execute in this order.**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/git/worktree-remove.sh" "<config.worktree_dir>/<name>"   # plain remove
   git worktree prune -v
   git branch -d "<branch>"                        # -d only; -D never
   git push origin --delete "<branch>"             # only if the remote branch still exists and its PR merged
   mv .claude/agentic/epics/<slug> .claude/agentic/archive/<slug>
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" milestone close "<title>"
   ```
   - A worktree that refuses removal (modified or untracked files) is **reported verbatim and skipped**. Offer, but never run: `git worktree remove --force <path>` — and print it only after the human typed `discard <name>`.
   - `git branch -d` refusing (unmerged) is the same story: report, skip, never `-D`.
   - Close a milestone only when all of its issues are closed; a milestone with open issues is left alone.
   - Archive target already exists ⇒ suffix with `-<YYYYMMDDHHMMSS>`.
   - A rejected remote branch delete (branch protection) is a warning, not a stop: continue with the rest.

5. **`--archive` specifics.** Move the epic directory to `.claude/agentic/archive/<slug>` **only** when every task is `closed` and every PR merged; the archived tree keeps its shape (`epic.md`, `tasks/`, `analysis/`, `mapping.json`, `ledger.md`) so history stays reviewable. Then close the epic issue if still open (`host.sh issue-close <epic-issue> --reason completed --comment "Epic complete"`) and its milestone.

6. **State updates.** `mapping.json`: `worktree: null`, `branch_deleted: true` per cleaned task. One ledger row per archived epic (`--who cleanup --scope "<slug>"`).

7. **Report** what was removed, what was skipped and the verbatim reason, what was archived, and what is left to do by hand.

## Outputs

Removed worktrees and local branches, pruned metadata, archived epics under `.claude/agentic/archive/`, closed milestones, updated `mapping.json`, ledger rows.

## Stop conditions

| Condition | Action |
|---|---|
| Nothing to clean | Say so and exit 0 |
| Worktree or branch removal refused | Report verbatim, skip, never force |
| A candidate lies outside `config.worktree_dir` | Never a candidate — list it as "ignored (outside worktree_dir)" |
| Anything that would lose work | Require the literal token `discard <name>`; then only print the command |
| Remote branch delete rejected | Warn and continue |
