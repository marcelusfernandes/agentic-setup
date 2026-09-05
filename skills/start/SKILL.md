---
name: start
description: Begin work on an issue or a whole epic — create the branch and its git worktree under .worktrees/, link untracked config, install dependencies with the profile's command, and run a baseline test to prove the starting point is green.
argument-hint: "<issue-number> | epic <epic-slug> [--mode shared|per-task] [--no-install] [--no-baseline]"
user-invocable: true
model: sonnet
---

# start

Create the isolated workspace for a unit of work and prove it starts green.

Arguments: `$ARGUMENTS`.

Ground rules for this skill:

- Read `${CLAUDE_PLUGIN_ROOT}/references/conventions.md` and, before step 4, `${CLAUDE_PLUGIN_ROOT}/references/parallelism.md`.
- Every script below accepts `--help`; if an invocation is rejected, read its `--help` and adapt. Never call `gh` — the host layer is `scripts/host.sh <verb>`.
- Never type a stack command literally. Read it from `project-profile.json` (`commands.install`, `commands.test`). **A `null` slot is skipped and reported as skipped, never as passed.**
- Stop conditions are hard: print a `STOP:` block naming the condition, what was done so far, and the exact command the human runs to continue. Do not try something else.

## Procedure

1. **Parse the request.** `<issue-number>` (single task) or `epic <epic-slug>` (whole epic). Flags: `--mode shared|per-task`, `--no-install`, `--no-baseline`.

2. **Detect existing isolation before creating anything.**
   ```bash
   GIT_DIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)
   GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
   git rev-parse --show-superproject-working-tree 2>/dev/null || true
   ```
   `GIT_DIR != GIT_COMMON` and no superproject path ⇒ you are already inside a linked worktree. STOP unless it is exactly the worktree this invocation would create (then skip to step 8). A superproject path means submodule, not worktree — treat as a normal checkout.

3. **Preflight.**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/git/preflight.sh"
   ```
   It checks a clean working tree, the git version, `rerere`/`zdiff3`, fetches `origin --prune` and resolves `origin/<config.base_branch>`. Non-zero exit ⇒ STOP with its stderr.

4. **Decide the worktree mode** (rule in `references/parallelism.md` §2). `epic <slug>` ⇒ shared epic worktree by default; a single `<issue>` ⇒ its own worktree. `config.worktree_mode` (`auto|shared|per-task`) and `--mode` override. Escalate `auto` to per-task when any of these holds: intersecting file scopes that cannot be lifted into `shared`, different dependency states, independent review/release, per-task CI, or a history-rewriting task. Record the decision in `mapping.json` (`worktree_mode`) and as a ledger ruling naming the triggering condition:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/ledger.sh" <epic-slug> \
     --who start --scope "#<issue>|epic" \
     --ruling "worktree_mode=<shared|per-task>" --why "<condition>" \
     --cost "<extra installs | scope collisions>" --reversible yes
   ```

5. **Compute names** (`references/conventions.md`):
   - task: `type` from the task frontmatter or the issue labels (`feat|fix|docs|refactor|perf|test|chore`) ⇒ branch `<type>/<issue>-<slug>`, worktree `<config.worktree_dir>/<issue>-<slug>`
   - epic: branch `epic/<slug>`, worktree `<config.worktree_dir>/epic-<slug>`

6. **Create the worktree.**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/git/worktree-add.sh" --branch "<branch>" --path "<worktree>" --base "origin/<base>"
   ```
   The script picks the right form (new branch from `origin/<base>`; existing local branch; remote-only branch checked out as a new local branch) and links the untracked config from `config.worktree_link` (default `.env`, `.env.local`, `.envrc`, plus `.worktreeinclude` entries) into the worktree. If the worktree path already exists ⇒ STOP and point at `/agentic-git:cleanup`.

7. **Dependencies.** Unless `--no-install` or `commands.install` is `null`, run that command **inside the worktree**. Never symlink `node_modules`/`.venv` — install per worktree (pnpm/uv make this cheap). A failing install is a STOP: report its stderr and leave the worktree in place for inspection; never auto-remove it.

8. **Baseline.** Unless `--no-baseline` or `commands.test` is `null`, run the test command in the worktree and record the result in `.claude/agentic/runtime/streams/<issue>/baseline.json` (`{"command","result":"pass|fail","at":"<iso>"}`).
   **A red baseline is a STOP** — do not start work on a red tree. Offer exactly three options and wait:
   1. fix the baseline first (recommended),
   2. proceed anyway — only if the human says so, and it is recorded as a ledger ruling with "cost if wrong: failures attributed to this work",
   3. abort and remove the worktree via `scripts/git/worktree-remove.sh`.

9. **State updates.**
   - `mapping.json`: `tasks.<local_id>.branch`, `.worktree`, `started_at` (and `epic_branch` in shared mode).
   - task frontmatter: `status: in-progress`, `branch`, `worktree`, `updated`.
   - labels and comment through the host layer, never `gh`:
     ```bash
     bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-label <issue> --add "status:in-progress" --remove "status:ready"
     bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-comment <issue> --body "Started — branch \`<branch>\`, worktree \`<worktree>\`"
     ```

10. **Report**: worktree path, branch, install result, baseline result (or "skipped: commands.test is null"), any ledger rulings written, and the next command — `/agentic-git:work <issue>`.

## Outputs

Worktree + branch, dependencies installed, `runtime/streams/<issue>/baseline.json`, updated `mapping.json` and task frontmatter, issue label + comment.

## Stop conditions

| Condition | Action |
|---|---|
| Dirty working tree | STOP (preflight) — commit or stash first |
| Already inside another worktree | STOP — `cd` to the main checkout, or work there |
| Worktree path already exists | STOP — `/agentic-git:cleanup` |
| `origin/<base>` unresolvable | STOP — fix the remote or `config.base_branch` |
| Install fails | STOP — worktree kept, stderr shown |
| Baseline red | STOP — the three options above |
