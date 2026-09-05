---
name: scan
description: Detect this project's stack — language, package manager, test runner, linter, formatter, typechecker, CI, monorepo layout, and existing Claude Code config — and write a machine-readable profile to .claude/agentic/project-profile.json that every other agentic-git skill reads.
argument-hint: "[--refresh] [--quiet]"
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash(ls:*), Bash(cat:*), Bash(bash:*), Bash(git:*), Bash(jq:*), Write
model: sonnet
context: fork
agent: project-scanner
---

# agentic-git: scan

Runs in a forked context with the `project-scanner` agent so the file census never lands in the main conversation — only the profile summary returns.

Arguments: `$ARGUMENTS` — `--refresh` (re-detect even if a profile exists), `--quiet` (summary only, no command table).

Local facts:
- profile present: !`test -f .claude/agentic/project-profile.json && echo yes || true`
- profile generated_at: !`jq -r ".generated_at // empty" .claude/agentic/project-profile.json 2>/dev/null || true`

## Procedure

1. **Freshness gate.** If `.claude/agentic/project-profile.json` exists, parses, and was generated less than 30 days ago (`generated_at`), and `--refresh` was not passed: print the existing profile summary (step 6) with a `re-run with --refresh to re-detect` note, and stop. Do not re-scan.

2. **State tree check.** If `.claude/agentic/` does not exist, run
   `bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/init-state.sh"` first so there is somewhere to write; if that fails, STOP with `Next: /agentic-git:init`.

3. **Collect evidence — facts only, no inference:**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/detect/scan.sh" > .claude/agentic/runtime/last-scan.json
   ```
   The script emits manifest presence, config-file presence, an extension census from `git ls-files`, manifest script/target names, CI workflows, monorepo markers, the `claude-config.sh` inventory of existing `CLAUDE.md` / `.claude/settings.json` / `.claude/agents`, and repo facts. If it exits non-zero, print its stderr and STOP — never guess a stack from memory.

4. **Preserve the user's block.** If a profile already exists, extract it before anything is rewritten:
   ```bash
   jq '.overrides // {}' .claude/agentic/project-profile.json > .claude/agentic/runtime/overrides.bak.json
   ```
   That block is the user's and must survive verbatim.

5. **Resolve.** Read `.claude/agentic/runtime/last-scan.json` and `${CLAUDE_PLUGIN_ROOT}/references/stack-matrix.md`, then fill every command slot with the first hit of:
   1. an explicit script/target in the manifest (`package.json` `scripts.*`, `pyproject` tasks, a `Makefile` target, a `justfile` recipe);
   2. the canonical invocation for the detected tool, from `stack-matrix.md`;
   3. `null`.

   `null` is a decision, not a gap: a null slot means the gate is **skipped and reported as skipped** downstream. A guessed command is a bug that silently breaks every gate. Never run an install/test/build command to "check" it.

   Ambiguities (two plausible test runners, two formatters, …) are collected and asked as **one** message with a recommendation per item. If the session cannot answer, take each recommendation, set `"confidence": "medium"` and list every item in `ambiguities[]`.

6. **Write** `.claude/agentic/project-profile.json` per the §6.2 schema (`schema_version`, `generated_at` from `date -u +"%Y-%m-%dT%H:%M:%SZ"`, `generated_by`, `confidence`, `ambiguities`, `repo`, `languages`, `package_manager`, `monorepo`, `tools`, `commands`, `command_cwd`, `ci`, `source_globs`, `test_globs`, `generated_globs`, `shared_files`, `secrets_globs`, `claude`, `overrides`), with `overrides` restored byte-for-byte from step 4. Then prove it parses:
   ```bash
   jq -e . .claude/agentic/project-profile.json > /dev/null
   ```
   Non-zero ⇒ STOP, keep the previous profile, show the parse error.

7. **Report** — at most 15 lines:
   ```
   Profile written · confidence: high

   languages     <lang> 81%, <lang> 6%
   package mgr   <manager> (<lockfile>)
   monorepo      <tool> — <workspace globs>
   ci            github-actions — build, test, lint

   install    <resolved commands.install>
   test       <resolved commands.test>
   test_file  <resolved commands.test_file, contains {file}>
   lint       <resolved commands.lint>
   format     <resolved commands.format>
   typecheck  <resolved commands.typecheck>
   build      (none — gate will be skipped)

   already in .claude/: settings.json (PostToolUse), agents: db-migrator
   ```
   Suppress the command table with `--quiet`.

## Stop / degradation conditions

| Condition | Behaviour |
|---|---|
| `scan.sh` exits non-zero | STOP, print stderr, change nothing |
| Profile JSON does not parse after writing | STOP, restore the previous profile |
| No recognisable manifest | Not a stop. Write a profile with every command `null`, `"confidence":"low"`, `"needs_manual_commands": true`, and print the exact `overrides` JSON block to paste |
| Ambiguity, non-interactive session | Take the recommendation, `confidence: medium`, fill `ambiguities[]` |

Whenever a slot ends up `null`, print the override snippet so the fix is one paste away:
```json
{ "overrides": { "commands": { "test": "<the command you run>", "test_file": "<same, with {file}>" } } }
```
`overrides` is deep-merged over detected values on every read, and `scan --refresh` copies it through untouched. It is the only hand-edited block in the file.

## Outputs

- `.claude/agentic/project-profile.json` (committed)
- `.claude/agentic/runtime/last-scan.json` (raw evidence, git-ignored)

Never write outside `.claude/agentic/`. `scan` does not touch GitHub, git config, `CLAUDE.md` or `.claude/settings.json` — that is `/agentic-git:adopt`.

Finish with: `Next: /agentic-git:adopt` (or, if a profile was already current, the reason nothing was re-detected).
