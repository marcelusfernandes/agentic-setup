---
name: adopt
description: Generate or adapt this project's Claude Code configuration from the detected profile — project-level .claude/agents, .claude/settings.json hooks for format-on-edit and secret protection, and a CLAUDE.md section describing the agentic-git workflow. Existing files are merged, never overwritten.
argument-hint: "[--only agents|hooks|claude-md] [--dry-run] [--enable-test-gate]"
disable-model-invocation: true
user-invocable: true
model: sonnet
---

# agentic-git: adopt

Writes three things that all derive from one profile in one pass: project agents, project hooks, and a `CLAUDE.md` section. Everything is additive and sentinel-delimited; nothing the user wrote is ever overwritten.

Arguments: `$ARGUMENTS` — `--only agents|hooks|claude-md` (default: all three), `--dry-run`, `--enable-test-gate`.

Local facts:
- profile: !`test -f .claude/agentic/project-profile.json && echo yes || true`
- settings: !`test -f .claude/settings.json && echo yes || true`
- CLAUDE.md: !`ls CLAUDE.md .claude/CLAUDE.md 2>/dev/null || true`

## 0. Preconditions and the dry-run rule

1. `.claude/agentic/project-profile.json` must exist and parse (`jq -e . …`). Missing ⇒
   ```
   STOP: no project profile
   What happened: adopt renders everything from the detected profile; there is none.
   Done so far: nothing was written.
   Next: /agentic-git:scan
   ```
2. `.claude/` (and the repo root) must be writable. Not writable ⇒ STOP naming the path.
3. Read the profile through the merge so `overrides` wins — use `profile_get`/`profile_cmd` semantics, i.e. read values via
   `bash -c '. "${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.sh"; profile_cmd test'` rather than raw `jq .commands.test`.
   Never hardcode a stack command anywhere in the rendered output; every command in a template comes from a profile slot, and a `null` slot renders as "not configured — this gate is skipped".
4. **Dry-run first, always.** Compute every planned change, print a unified diff per file (`diff -u <current> <planned>`; for new files show the full body), then ask for a plain `yes` before writing. With `--dry-run`, stop after printing. No literal confirmation token is required — every change here is additive and revertible with git.

## 1. Agents (`--only agents`)

Target: `.claude/agents/*.md` in the **project**, rendered from `${CLAUDE_PLUGIN_ROOT}/references/templates/agents/*.md.tmpl`.

| Template | Emitted when | Substituted from the profile |
|---|---|---|
| `test-runner.md.tmpl` | `commands.test != null` | `commands.test`, `commands.test_file`, `commands.install`, `test_globs` |
| `code-reviewer.md.tmpl` | always | `commands.lint`, `commands.typecheck`, `source_globs`, conventions found in `CLAUDE.md` |
| `refactorer.md.tmpl` | `commands.format != null && commands.test != null` | `commands.format`, `commands.test` |

**Denylist — never generate a project agent named** `project-scanner`, `workflow-planner`, `implementer`, `reviewer`, `conflict-resolver`, `integration-manager`. Project agents override plugin agents of the same name (managed > `--agents` > project > user > plugin), so any of those names would silently shadow the plugin's own agent. The three template names are deliberately distinct. If the project *already* has an agent with one of the six names, do not touch it — report it as a warning explaining the override order.

**Adaptation rule for an existing file with the same name — never overwrite:**
- Split it into (frontmatter, body).
- Frontmatter: add only keys that are **absent**. Never change an existing value; if `tools:` exists leave it, if `model:` exists leave it.
- Body: append (or, on re-run, replace **only** the content between) the sentinels:
  ```
  <!-- BEGIN agentic-git -->
  … generated section …
  <!-- END agentic-git -->
  ```
  Content outside the sentinels is untouched, forever. Never reorder or reformat it.
- If a same-named agent exists, has **no** sentinel block, and its body already covers the same ground (you read it and judge so), skip it entirely and report `kept existing <name> — already covers this`.

New files are written whole **including** the sentinel block, so a later run can update them in place.

## 2. Hooks (`--only hooks`)

Target: `.claude/settings.json` in the project. Never `settings.local.json` — that file is the user's.

1. Copy the standalone runtime scripts into the project. They must not reference `${CLAUDE_PLUGIN_ROOT}`, which is undefined for project-settings hooks:
   ```bash
   mkdir -p .claude/agentic/hooks
   cp "${CLAUDE_PLUGIN_ROOT}/assets/project-hooks/format-on-edit.sh" .claude/agentic/hooks/
   cp "${CLAUDE_PLUGIN_ROOT}/assets/project-hooks/guard-secrets.sh"  .claude/agentic/hooks/
   # test-gate.sh only with --enable-test-gate
   chmod +x .claude/agentic/hooks/*.sh
   ```
   They read `.claude/agentic/project-profile.json` at runtime, so changing the profile changes hook behaviour with no settings edit: **one hook entry per event, regardless of stack**. These scripts are committed (project config), unlike `runtime/`.

2. Write the entries to add into `/tmp/agentic-hooks.json`:
   ```json
   {
     "PostToolUse": [
       { "matcher": "Edit|Write|MultiEdit",
         "hooks": [{ "type": "command",
           "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/agentic/hooks/format-on-edit.sh",
           "timeout": 30 }] }
     ],
     "PreToolUse": [
       { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
         "hooks": [{ "type": "command",
           "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/agentic/hooks/guard-secrets.sh",
           "timeout": 10 }] }
     ]
   }
   ```
   With `--enable-test-gate`, additionally:
   ```json
   { "Stop": [ { "hooks": [{ "type": "command",
       "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/agentic/hooks/test-gate.sh",
       "timeout": 600 }] } ] }
   ```
   The Stop gate is **off by default**: a hook that runs the whole suite on every turn is the fastest way to get the plugin disabled. The real test gate is `/agentic-git:pr`.

3. If `.claude/settings.json` is absent, create it as `{"hooks":{}}`. If it exists but does not parse ⇒ **STOP**, print the `jq` parse error, change nothing.

4. Merge — never a rewrite. The merge key is the `agentic/hooks/` substring in the command, so any entry the user wrote survives and ours is replaced idempotently:
   ```bash
   tmp=$(mktemp)
   jq --slurpfile add /tmp/agentic-hooks.json '
     .hooks //= {} |
     reduce ($add[0] | to_entries[]) as $e (.;
       .hooks[$e.key] //= [] |
       .hooks[$e.key] = (
         # drop any prior agentic-git entry for this event, then append
         [ .hooks[$e.key][] | select((.hooks // [] | map(.command // "") | join(" ")) | test("agentic/hooks/") | not) ]
         + $e.value
       ))
     ' .claude/settings.json > "$tmp" && mv "$tmp" .claude/settings.json
   ```
   Verify with `jq -e . .claude/settings.json` afterwards.

## 3. CLAUDE.md (`--only claude-md`)

1. Render `${CLAUDE_PLUGIN_ROOT}/references/templates/claude-md-section.md` with: the profile's command table, the branch/commit conventions from `config.json` (`branch_template`, `commit_template`), the worktree location (`worktree_dir`), and the skill list.
2. Which file: root `CLAUDE.md` if it exists; else `.claude/CLAUDE.md` if that exists; if **both** exist use the root one and mention the other in the summary.
3. If the file exists: find `<!-- BEGIN agentic-git -->` … `<!-- END agentic-git -->`. Present ⇒ replace only between the sentinels. Absent ⇒ append the block at the end, preceded by one blank line. Nothing else in the file is touched, reordered or reformatted.
4. If no such file exists: create root `CLAUDE.md` with a minimal header (`# <repo name>` plus the one-line repo description from `bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" repo-info`) and the sentinel block. Do **not** attempt a full `/init`-style codebase document — say in the summary that `/init` is the tool for that.

## 4. Manifest

Write `.claude/agentic/runtime/adopt-manifest.json`: every file, whether it was `created` / `adapted` / `kept`, and a `sha256` of each generated block. On a later run, a hash mismatch means a human edited **inside** the sentinels — then ask per file, defaulting to **keep yours**. `doctor` reads the same file.

## 5. Summary

```
file                                   action    why
.claude/agents/test-runner.md          created   commands.test is set
.claude/agents/code-reviewer.md        adapted   existed; replaced sentinel block only
.claude/agents/refactorer.md           skipped   commands.format is null
.claude/agentic/hooks/*.sh             created   2 scripts, chmod +x
.claude/settings.json                  adapted   merged PostToolUse + PreToolUse (3 user entries kept)
CLAUDE.md                              adapted   appended sentinel block

Next: /agentic-git:plan "<goal>"
```

## Stop conditions

| Condition | Behaviour |
|---|---|
| Profile missing or unparseable | STOP → `/agentic-git:scan` |
| `.claude/settings.json` unparseable | STOP, print the jq error, change nothing |
| `.claude/` not writable | STOP naming the path |
| sha mismatch inside sentinels | Ask per file; default "keep yours" |
| User answers anything but `yes` to the diff | Change nothing; print the same diffs and exit |
