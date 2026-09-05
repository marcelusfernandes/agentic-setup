---
name: pr
description: Open a pull request for the current unit of work — run the lint, typecheck and test gates from the profile, push the branch, and create a PR whose body closes every issue it implements, with labels, milestone and reviewers applied.
argument-hint: "[<issue-number>] [--draft] [--base <branch>] [--skip-gates]"
disable-model-invocation: true
user-invocable: true
model: sonnet
---

# pr

Gate the work, push the branch, and open a PR that closes its issues.

Arguments: `$ARGUMENTS`.

Ground rules:

- Every script accepts `--help`; adapt from its help if an invocation is rejected. Never call `gh` — use `scripts/host.sh <verb>`.
- Never type a stack command literally: read `commands.format_all`, `commands.format`, `commands.lint`, `commands.typecheck`, `commands.test` from `project-profile.json`. **A `null` command is skipped and reported as skipped — never as passed.**
- Never `git push --force`. `--force-with-lease` only after a rebase this workflow performed and the human confirmed.

## Procedure

1. **Resolve context.** Inside a worktree ⇒ use it. Otherwise resolve `<issue>` ⇒ worktree/branch from `epics/<slug>/mapping.json`. Neither ⇒ STOP ("no worktree for #<issue>; run /agentic-git:start <issue>"). Base branch = `--base` or `config.base_branch`. Confirm the target `owner/repo` from
   `bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" repo-info` and print it in the confirmation line.

2. **Gates**, all run inside the worktree, in this order, unless the human typed `--skip-gates` (never offer it):
   | Gate | Command | On failure |
   |---|---|---|
   | format | `commands.format_all` (or `commands.format` per changed file when `format_all` is null) | auto-fix, then re-stage the reformatted files |
   | lint | `commands.lint` | STOP with the output |
   | typecheck | `commands.typecheck` | STOP with the output |
   | test | `commands.test` | STOP with the output |
   Record each result as `pass`, `fail` or `skipped (commands.X is null)`; the same strings go into the PR body.

3. **Commit hygiene.** Uncommitted changes ⇒ show the proposed message for approval, then commit with the convention `<type>(<scope>): <subject> (#<issue>)` staging changed files by explicit path (never `git add -A`). Fixups and `wip` commits are squashed into the change they belong to before pushing. Nothing is committed outside the worktree.

4. **Conflict pre-check** — cheap, and it saves a red PR:
   ```bash
   git -C "<worktree>" fetch origin
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/git/mergecheck.sh" "origin/<base>" HEAD
   ```
   Exit 1 ⇒ STOP: the branch conflicts with the base, route to `/agentic-git:resolve-conflicts <branch>` **before** opening the PR. Exit ≥2 ⇒ STOP and show the output raw.

5. **Push.**
   ```bash
   git -C "<worktree>" push -u origin "<branch>"
   ```
   Plain push, always. If it is rejected as non-fast-forward, STOP and route to `/agentic-git:resolve-conflicts`.

6. **Build the body** from `${CLAUDE_PLUGIN_ROOT}/references/templates/pr-body.md`, written to a file under `.claude/agentic/runtime/`:
   ```markdown
   ## Summary
   <2–4 bullets from the commits and the task acceptance criteria>

   ## Changes
   <file-group summary from `git diff --stat origin/<base>...HEAD`>

   ## Testing
   - `<test command>` — pass | fail | skipped (commands.test is null)
   - `<lint command>` — …
   - `<typecheck command>` — …

   ## Rulings
   <the epic ledger rows written since this branch started, verbatim from epics/<slug>/ledger.md; "none" if empty>

   ## Issues
   Closes #123
   Closes #124
   Part of #100

   <!-- agentic-git:pr epic=<slug> -->
   ```
   Rules: one `Closes #N` line per issue **fully** satisfied by this PR — an epic-worktree PR lists every completed sub-issue. The epic parent gets `Part of #N`, never a closing keyword, or merging one task's PR closes the whole epic. The `Rulings` section is what lets a reviewer see every autonomous decision without asking.

7. **Create the PR.**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" pr-create \
     --base "<base>" --head "<branch>" \
     --title "<type>(<scope>): <subject> (#<issue>)" \
     --body-file "<body-file>" --labels "agentic" \
     [--draft] [--milestone "<epic milestone>"] [--reviewers "<config.default_reviewers>"]
   ```
   The milestone comes from `epic.md:milestone` / `mapping.json.milestone`; omit the flag when there is none. Reviewers come from `config.default_reviewers` (default: none).
   A PR already existing for this branch is not an error: the verb reports it (or `pr-state` finds it) — update the body instead and say so.

8. **Labels and state.**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-label <pr> --add "agentic,status:in-review"
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-label <issue> --add "status:in-review" --remove "status:in-progress"
   ```
   Then: `mapping.json` gains `tasks.<local_id>.pr` and `.pr_url`; task frontmatter `pr: <n>`, `status: in-review`, `updated`. Do this for every issue the PR closes.

9. **Report** the PR URL, the gate table (including every skipped gate and why), the rulings included in the body, and the next command — `/agentic-git:review <pr>`.

## Outputs

Pushed branch, PR with `Closes`/`Part of` links, `agentic` + `status:in-review` labels, milestone, updated `mapping.json` and task frontmatter.

## Stop conditions

| Condition | Action |
|---|---|
| No worktree/branch for the issue | STOP — `/agentic-git:start <issue>` |
| lint / typecheck / test red | STOP with the command output |
| `mergecheck.sh` exit 1 | STOP — `/agentic-git:resolve-conflicts <branch>` |
| `mergecheck.sh` exit ≥2 | STOP — show the raw output; the merge could not be attempted |
| Push rejected | STOP — never `--force`; resolve first |
| `repo-info` rejects the remote | STOP — wrong repo; fix `origin` |
