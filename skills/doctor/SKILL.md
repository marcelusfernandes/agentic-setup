---
name: doctor
description: Diagnose an agentic-git installation — prerequisites, GitHub auth and capabilities, state-tree integrity, profile validity, hook wiring, worktree and branch drift — and print exactly what to run to fix each problem.
argument-hint: "[--fix] [--json]"
user-invocable: true
allowed-tools: Read, Glob, Bash(bash:*), Bash(git:*), Bash(gh:*), Bash(jq:*)
model: sonnet
---

# agentic-git: doctor

Script-first: one call does every check. Your only job is to explain the failures and offer the fix — never to improvise a repair.

Arguments: `$ARGUMENTS` — `--fix` (apply the safe fixes), `--json` (machine output).

## Procedure

1. Run exactly one command, passing the flags through:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/validate/doctor.sh" $ARGUMENTS
   ```
   It emits one `OK|WARN|FAIL` line per check with a `fix:` line, or, with `--json`,
   `{"checks":[{"id","group","status","message","fix"}],"summary":{...}}`.

2. If `--json` was passed, print the script's stdout **verbatim and nothing else** (it is consumed by CI). Stop there.

3. Otherwise group the human report by check group in this order: `prereq`, `repo`, `host`, `state`, `git`, `config`, `profile`. Within each group print `FAIL` first, then `WARN`, then a single collapsed `n OK` line.

4. For every `FAIL` and `WARN`, print the script's `fix` line verbatim. Do not invent a different fix, and do not run it — except under `--fix`, which the script itself handles.

5. If any check failed, end with the shortest ordered list of commands that clears all of them, deduplicated (e.g. `/agentic-git:init` then `/agentic-git:scan --refresh`).

## What the script checks

| Group | Check | Fix it prints |
|---|---|---|
| prereq | git ≥ 2.38, `gh` present, `gh` authed, `jq` present | the install / `gh auth login` command |
| prereq | local `rerere.enabled`, `rerere.autoupdate`, `merge.conflictStyle=zdiff3` | `/agentic-git:init` |
| repo | inside a work tree, not inside a linked worktree, origin is GitHub, origin ≠ the plugin's own repo | — |
| host | `gh auth status` scopes include `repo`; host-caps probe fresher than 7 days | `gh auth refresh -s repo` |
| state | `.claude/agentic/` exists; `config.json` and `project-profile.json` parse; `schema_version` known | `/agentic-git:init`, `/agentic-git:scan` |
| state | every `epics/*/epic.md` and task file carries the required frontmatter keys (`state-lint.sh`) | names the file and the missing key |
| state | every `depends_on` target exists; no cycles (Kahn) | names the cycle |
| state | `mapping.json` issue numbers still exist, open/closed as recorded | `/agentic-git:sync` |
| git | every worktree under `config.worktree_dir` has a live branch, and every recorded worktree exists on disk | `/agentic-git:cleanup` |
| git | `.worktrees/` and `.claude/agentic/runtime/` are git-ignored | `/agentic-git:init` |
| config | `.claude/settings.json` parses; the agentic hook scripts exist and are executable | `/agentic-git:adopt --only hooks` |
| config | sentinel blocks in `CLAUDE.md` and project agents match the `adopt-manifest.json` hashes | `/agentic-git:adopt` |
| config | no project agent shadows a plugin agent name | WARN + the override order |
| profile | `commands.test` is either set or an explicit `null` decision | `/agentic-git:scan --refresh` |

## `--fix` boundary

`--fix` performs only safe, idempotent repairs, all inside the script: local git config, the two ignore lines, `chmod +x` on the hook scripts, re-probing host caps, recomputing epic progress, pruning stale worktree admin files.

It never creates issues, never deletes a branch or worktree, never rewrites the profile, and never edits `CLAUDE.md` or `.claude/settings.json`. If a check's fix is outside that boundary, `doctor` prints the command and stops there — say so plainly rather than offering to do it anyway.

## Reading a null command slot

A `null` entry in `profile.commands` is a WARN, not a FAIL: it means the gate is deliberately skipped. Print the exact override block to paste into `project-profile.json` when the user wants it filled:
```json
{ "overrides": { "commands": { "test": "<the command>" } } }
```

## Final summary format

```
agentic-git doctor — <owner>/<name>

prereq   ✓ 4 OK
repo     ✓ 4 OK
host     ⚠ host-caps probe is 12 days old        fix: /agentic-git:init
state    ✗ epics/oauth-login/tasks/124.md: missing frontmatter key `files`
         ✓ 5 OK
git      ✓ 3 OK
config   ⚠ CLAUDE.md sentinel block was edited by hand (hash mismatch)
profile  ✓ 1 OK

1 failure, 2 warnings.
To clear them:  edit tasks/124.md · /agentic-git:init · /agentic-git:adopt
```

`doctor` is read-only without `--fix` and must be safe to run anywhere. If `.claude/agentic/` does not exist, report `state: not initialized` with `Next: /agentic-git:init` and exit normally — that is a finding, not an error.
