---
name: init
description: One-time setup of agentic-git in this repository — checks gh/git prerequisites, creates the .claude/agentic state tree, enables rerere and zdiff3, ignores .worktrees/, and creates the workflow labels on GitHub.
argument-hint: "[--no-labels] [--no-git-config] [--base <branch>]"
disable-model-invocation: true
user-invocable: true
model: sonnet
---

# agentic-git: init

Idempotent, non-destructive one-time setup. Never asks for confirmation. Running it twice must change nothing and report "already configured" per line.

Arguments: `$ARGUMENTS` — recognised flags `--no-labels`, `--no-git-config`, `--base <branch>`. Anything else: ignore it and say so in the summary.

Local facts (advisory only, the scripts are authoritative):
- toplevel: !`git rev-parse --show-toplevel 2>/dev/null || true`
- git: !`git --version 2>/dev/null || true`
- state dir present: !`test -d .claude/agentic && echo yes || true`

## Procedure

1. **Announce the plan** in 5 lines: prerequisites → state tree → ignores → git config → labels. Do not ask for confirmation.

2. **Prerequisites.** Run:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/validate/doctor.sh" --prereqs-only --json
   ```
   Read the `checks[]` array. Any check with `"status":"FAIL"` is a stop condition — print its `fix` verbatim.

3. **STOP on any prereq failure.** One `STOP:` block, listing every failed check at once (do not fix them one at a time, and never auto-install anything):
   ```
   STOP: prerequisites not met
   What happened: <check id> — <message>
   Done so far: nothing was written.
   Next: <the check's fix line>, then re-run /agentic-git:init
   ```
   The mandatory failures are: git < 2.38 (`merge-tree --write-tree` is the whole safety story), `gh` missing, `gh` unauthenticated, `jq` missing, not inside a git work tree, already inside a linked worktree (run init from the main checkout).

4. **Repo safety gate.**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" repo-info
   ```
   Emits `{host,owner,name,default_branch,remote}` and exits non-zero if `origin` is not a GitHub remote or is the plugin's own repo (`marcelusfernandes/agentic-setup`). Non-zero ⇒ STOP with "point `origin` at your own repository first". Print the resolved `owner/name` so the user sees which repo is being configured.

5. **State tree.** `--base` wins over the detected `default_branch`; otherwise pass the value from step 4:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/init-state.sh" --base "<base-branch>"
   ```
   Creates only what is absent: `.claude/agentic/{epics,archive,runtime/{streams,locks}}`, `config.json` with the §6.3 defaults, `.gitkeep`. An existing `config.json` is never overwritten — missing keys are merged in with existing values winning. Report `created` / `already present` per path from the script's output.

6. **Host capabilities**, written straight to the runtime file:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" caps > .claude/agentic/runtime/host-caps.json
   ```
   Read it back and report the four booleans (`native_parent`, `native_blocked_by`, `native_sub_issue_edit`, `sub_issues_api`). If `native_parent` and `native_blocked_by` are both false, warn once: `sync` will use the REST or checklist fallback and dependencies will be advisory.

7. **Ignores.** For each of `.worktrees/` and `.claude/agentic/runtime/`, skip the line when `git check-ignore -q <path>` already succeeds; otherwise append it to the repo's `.gitignore` (create the file if absent). If `.gitignore` is not writable, append to `.git/info/exclude` instead and say so explicitly — the team-wide `.gitignore` is the intended home.

8. **Git config**, local scope only — never `--global`. Skipped entirely with `--no-git-config`. Before each, read the current value with `git config --local --get <key>`; report `set` or `already set`:
   ```bash
   git config --local rerere.enabled true
   git config --local rerere.autoupdate true
   git config --local merge.conflictStyle zdiff3
   ```

9. **Labels** (skipped with `--no-labels`). Idempotent; never call `gh` yourself:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-label ensure
   ```
   This creates/updates the workflow label set: `agentic`, `epic`, `task`, `status:ready`, `status:in-progress`, `status:in-review`, `status:blocked`. A 403 is **not** a stop condition — warn that labels need write access on this repo, note that labels are advisory (frontmatter is the source of truth), and continue.

10. **Verify.** Re-run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/validate/doctor.sh" --json` and report any remaining `FAIL`/`WARN` as a short list, each with its `fix` line.

## State touched

| Path | Action |
|---|---|
| `.claude/agentic/config.json` | created with defaults; existing keys preserved |
| `.claude/agentic/{epics,archive,runtime/{streams,locks}}` | created if absent |
| `.claude/agentic/runtime/host-caps.json` | written from `host.sh caps` |
| `.gitignore` (or `.git/info/exclude`) | two ignore lines appended if not already ignored |
| `.git/config` | `rerere.enabled`, `rerere.autoupdate`, `merge.conflictStyle` (local scope) |
| GitHub | 7 workflow labels |

Nothing else. `init` never creates issues, branches or worktrees, and never writes a ruling to a ledger (no epic exists yet).

## Final summary format

```
agentic-git initialized in <owner>/<name> (base: <branch>)

  ✓ prerequisites      git 2.4x.x · host CLI authed · jq 1.7
  ✓ state tree         .claude/agentic (created | already present)
  ✓ host caps          parent=<bool> blocked_by=<bool> sub_issue_edit=<bool>
  ✓ ignores            .worktrees/ (added | already ignored), runtime/ (…)
  ✓ git config         rerere.enabled (set | already set) …
  ⚠ labels             6 created, 1 failed (403 — needs write access)

Next:
  /agentic-git:scan            detect the stack, write project-profile.json
  /agentic-git:adopt           generate this project's Claude Code config
  /agentic-git:plan "<goal>"   turn a goal into an epic
```

Use `✓` for done, `=` for already configured, `⚠` for a non-fatal degradation. Never print `✓` for something a script reported as failed.
