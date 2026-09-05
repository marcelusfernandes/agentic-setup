---
name: resolve-conflicts
description: Resolve merge conflicts on a branch against its base — rebase, classify every conflicted file as trivial or semantic, let an agent resolve only the mechanically safe ones, and stop with a precise report for anything requiring human judgment.
argument-hint: "<pr-number> | <branch> [--strategy rebase|merge] [--dry-run]"
disable-model-invocation: true
user-invocable: true
model: opus
---

# resolve-conflicts

Rebase onto the base, resolve only what is mechanically determined, and stop precisely on everything else.

Arguments: `$ARGUMENTS`. Read `${CLAUDE_PLUGIN_ROOT}/references/conflicts.md` before step 4.

Ground rules:

- Every script accepts `--help`; adapt from its help if an invocation is rejected. Never call `gh` — use `scripts/host.sh <verb>`.
- Never type a stack command literally: use `commands.lint`, `commands.test`, `commands.format`, `commands.install`. A `null` slot is skipped and reported as skipped, never as passed.
- **Escalating is the successful outcome.** A wrongly "resolved" semantic conflict is the worst thing this plugin can produce.

## Procedure

1. **Preconditions.** `merge.conflictStyle=zdiff3` and `rerere.enabled=true` locally — set them if absent and say so; the zdiff3 base section is what makes classification reliable. Working tree clean. Resolve the branch (from `<pr>` via `host.sh pr-state <pr>` → `headRefName`, or use `<branch>` directly) and its worktree from `mapping.json`; if none exists, create a throwaway one under `<config.worktree_dir>/resolve-<branch-slug>` with `scripts/git/worktree-add.sh` and remove it at the end.

2. **Dry run first** — nothing is touched:
   ```bash
   git -C "<worktree>" fetch origin
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/git/mergecheck.sh" "origin/<base>" "<branch>"
   ```
   Exit 0 ⇒ nothing to do, report and exit. Exit ≥2 ⇒ STOP with the raw output. `--dry-run` stops here with the conflicted-path list.

3. **Start the integration.** Default `--strategy rebase` (linear history, which is what `squash` merges expect):
   ```bash
   git -C "<worktree>" rebase "origin/<base>"
   ```
   `--strategy merge` runs `git merge origin/<base>` in the branch instead — choose it when the branch is shared or already reviewed and rewriting it would invalidate review comments. Config may pin this (`config.conflict_strategy`, when present).

4. **Census at every stop.**
   ```bash
   git -C "<worktree>" diff --name-only --diff-filter=U
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/git/conflict-classify.sh" "<file>"    # per file
   ```
   The classifier prints one line per file — `<class>  hunks:<n>  <path>` (or `--json`) — with class `protected` (config.protected_paths / secrets_globs), `regenerable` (matches `profile.generated_globs`), `trivial` (both sides identical after whitespace normalization, or purely additive against the zdiff3 base) or `semantic`. The conflict-resolver refines `trivial` into the sub-classes of `references/conflicts.md` (identical, additive-list, formatting, rerere) from the conflict text itself; anything it cannot place is treated as **semantic**. Semantic triggers: the same function body, signature, condition, constant or test expectation changed on both sides; any `config.protected_paths` entry; any migration; anything under `**/auth/**`, `**/security/**` or matching `secrets_globs`.

5. **Autonomy ceilings** (`config.conflict_autonomy`). Exceeding **any** of them converts the whole run into a STOP, even if every file classified trivial:
   - more than `max_files` (default 10) conflicted files
   - more than `max_hunks` (default 20) conflict hunks in total
   - any file matching `config.protected_paths`
   - a rebase spanning more than `max_rebase_commits` (default 20) commits — offer squash-then-rebase instead

6. **Dispatch `conflict-resolver` once for the whole trivial set** (never one dispatch per file), with: the file list, each file's class and the rationale, the zdiff3 conflict text, the ceilings, and the rule *"if a file does not match its stated class when you actually read it, do not resolve it — return it as escalated"*. It stages what it resolved with `git add` and returns the escalated list. It never runs `git rebase --continue`, never pushes, never `--force`.
   Regenerable files are not hand-merged: delete both sides, run `commands.install`, stage the regenerated file.

7. **Continue and gate.** `git rebase --continue` after each resolved stop (this skill does it, not the agent). When the rebase finishes, run `commands.lint` and `commands.test` in the worktree. **A green test run is required** before the branch counts as resolved. Red ⇒ STOP without pushing, branch left committed mid-state, and print the recovery commands verbatim: `git rebase --abort`, `git reset --hard ORIG_HEAD` (for the human to run, not this skill).

8. **Push.**
   ```bash
   git -C "<worktree>" push --force-with-lease origin "<branch>"
   ```
   Permitted only because this workflow created the branch and `--force-with-lease` refuses if anyone else pushed. If the branch is **not** in `mapping.json` (not ours), require the human to type the literal token `force-push <branch>` in this same turn first. Plain `--force` is never emitted. Rejection ⇒ STOP: "someone pushed to this branch; fetch and re-run".

9. **Ledger** — one row per auto-resolved file:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/ledger.sh" <epic-slug> \
     --who resolve-conflicts --scope "<branch>" \
     --ruling "Resolved <file> as <class>" --why "<signals>" \
     --cost "<what breaks if wrong>" --reversible yes
   ```
   `rerere` note: a resolution recorded here is replayed automatically the next time the same conflict appears (e.g. later in a merge train). Say when a resolution came from rerere — it was decided earlier, not now.

10. **Comment on the PR** with what was auto-resolved (the ledger rows) and what was escalated:
    ```bash
    bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-comment <pr> --body-file <file>
    ```
    (There is no `pr-comment` verb; on GitHub a PR shares the issue number namespace.)

## STOP report format (semantic conflicts)

```
STOP: 2 semantic conflicts require your judgment.

src/api/auth/session.ts (3 hunks)
  ours   (feat/123): rotates the refresh token on every request
  theirs (main):     invalidates the session after 15 min idle
  why semantic: both sides rewrote validateSession()'s control flow
  the file is open at: .worktrees/123-oauth/src/api/auth/session.ts

Resolved automatically and staged: 4 files (see ledger).
To continue after you fix these: git add <files> && git rebase --continue
To abandon: git rebase --abort
```

## Never

`git push --force` (only `--force-with-lease`, only on a workflow-created branch), `git rebase --skip`, `git checkout --ours/--theirs` on a semantic conflict, resolving by deleting one side's code, continuing a rebase before the tests pass.

## Stop conditions

| Condition | Action |
|---|---|
| Dirty tree or detached HEAD | STOP — the rebase cannot start |
| Any semantic or `unknown` conflict | STOP with the report above (designed outcome, not a failure) |
| Any autonomy ceiling exceeded | STOP — escalate everything, including the trivial files |
| Tests red after resolution | STOP without pushing |
| `--force-with-lease` rejected | STOP — someone else pushed |
