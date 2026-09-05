---
name: work
description: Execute an issue by decomposing it into independent work streams with disjoint file ownership and dispatching one implementer subagent per stream in parallel, then collecting their results, running the test gate, and committing.
argument-hint: "<issue-number> [--streams N] [--serial] [--dry-run]"
user-invocable: true
model: opus
---

# work

Decompose one issue into file-disjoint streams, run them in parallel inside its worktree, and land a green, committed result.

Arguments: `$ARGUMENTS`.

Ground rules:

- Read `${CLAUDE_PLUGIN_ROOT}/references/parallelism.md` before step 3. Read `${CLAUDE_PLUGIN_ROOT}/references/conventions.md` for paths and frontmatter.
- Every script accepts `--help`; adapt from its help if an invocation is rejected. Never call `gh` — use `scripts/host.sh <verb>`.
- Never type a stack command literally: use `commands.test`, `commands.test_file`, `commands.lint`, `commands.format` from `project-profile.json`. A `null` slot is skipped and reported as skipped, never as passed.
- Rulings, not stalls: decide, append one ledger row, keep going — except at the stop conditions below.

## Procedure

1. **Resolve the worktree** from `epics/<slug>/mapping.json`. None ⇒ do not create it silently (it installs dependencies): offer `/agentic-git:start <issue>` and stop.

2. **Check blockers.** Read the task file (`epics/<slug>/tasks/<issue>.md`) and run
   `bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/next.sh" <slug>`.
   If `<issue>` is not listed as ready, run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/status.sh" <slug>` to name the open blocker and **STOP**: "blocked by #x (open)". This check is what makes the `blocked-by` links worth creating.

3. **Stream decomposition — the judgment step.** Produce 1–`config.max_parallel_streams` (default 4, `--streams N` caps lower) streams and write `epics/<slug>/analysis/<issue>.md` from `${CLAUDE_PLUGIN_ROOT}/references/templates/analysis.md`:
   ```yaml
   ---
   issue: 123
   worktree: .worktrees/123-add-oauth-login
   created: <iso>
   streams:
     - id: A
       name: data-layer
       files: ["src/db/oauth.ts", "src/db/migrations/**"]
       depends_on: []
       agent: implementer
     - id: B
       name: api
       files: ["src/api/auth/**"]
       depends_on: [A]
     - id: C
       name: tests
       files: ["tests/oauth/**"]
       depends_on: []
   shared:
     - path: src/types/index.ts
       owner: A
   ---
   ```
   Rules, all enforced **before** dispatch:
   - **Disjointness, verified mechanically.** Expand every glob against the index and intersect pairwise:
     ```bash
     git -C "<worktree>" ls-files -- '<glob>' | sort -u > /tmp/ag-stream-A.txt   # per stream
     comm -12 /tmp/ag-stream-A.txt /tmp/ag-stream-B.txt                          # must be empty
     ```
     Include the explicit "will create" paths in each set. A non-empty intersection has exactly two remedies: merge the two streams, or lift the intersecting paths into `shared:` with one owner. There is no third option.
   - **Single writer.** Every `shared:` path has exactly one `owner` stream. Every path in `profile.shared_files` is always `shared`, never implicitly owned. Non-owners never edit it — they append to `runtime/streams/<issue>/requests.jsonl` and continue.
   - **Waves.** Wave 1 = streams with empty `depends_on`; a stream runs in the wave after all of its `depends_on` finished. A stream that needs another's type, migration or interface waits — it does not stub and hope.
   - **One stream is a valid plan.** If everything touches the same files, emit one stream and say so.
   Append one ledger row per non-obvious split (`--who work --scope "#<issue> stream <id>"`).

4. **`--dry-run` stops here**, printing the analysis file and the disjointness check result.

5. **Locks.** For each shared file owned in this wave:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/lock.sh" acquire <issue> <stream> <path>
   ```
   A lock held by another live stream ⇒ drop that path from this wave and let its owner run later; never steal a lock.

6. **Dispatch the wave.** **Every stream of a wave is dispatched as a separate Agent tool call inside ONE assistant message.** That is the mechanical requirement for parallelism: several dispatch calls in the same response run concurrently; one call per response runs serially. `--serial` forces one per message. Each `implementer` prompt contains this and nothing else:

   ```text
   Worktree: <ABS_WORKTREE_PATH>
   cd there before anything else. Never edit, create or delete a file outside it, and never touch the main checkout.

   You own exactly these paths (globs):
   <FILE_GLOBS>
   You may not create, edit, or delete any file outside this list. If you believe you must, stop and report it as a request — do not do it.

   Shared files (owned by another stream): <SHARED_PATHS_AND_OWNERS>
   Do not edit them. Append one line to runtime/streams/<ISSUE>/requests.jsonl:
   {"ts":"<iso>","from":"<STREAM_ID>","to":"<OWNER>","path":"…","change":"…","reason":"…"}
   and continue with the rest of your scope.

   Task #<ISSUE> — <TASK_TITLE>
   <TASK_BODY_AND_ACCEPTANCE_CRITERIA>
   Full decomposition: <ABS_PATH_TO>/epics/<SLUG>/analysis/<ISSUE>.md

   Commands from the project profile (use these literally; a null slot means the gate does not exist — skip it and say so):
     test_file: <COMMANDS.TEST_FILE>
     lint:      <COMMANDS.LINT>
     format:    <COMMANDS.FORMAT>

   Commit your own work: stage only your files by explicit path (never `git add -A`), one commit per logical change, message `<type>(<scope>): <subject> (#<ISSUE>)`.

   Progress file — write it, it is the only thing the orchestrator reads if your report is lost:
   runtime/streams/<ISSUE>/<STREAM_ID>.json via
     bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/streams.sh" write <ISSUE> <STREAM_ID>   # JSON on stdin
   status `running` at start; `done|blocked|failed` at the end with `summary`, `files_touched`, `commits`, `tests`.

   Forbidden: `git push`, `git rebase`, `git merge`, `git reset --hard`, any `--force`, any `git worktree` command, writing into `.git/`, editing `.claude/agentic/config.json` or `project-profile.json`.

   Return exactly a 10-line report: what changed, files touched, tests run and their result, requests raised, anything you could not do.
   ```

7. **Collect.** After the wave, read every `runtime/streams/<issue>/<stream>.json`:
   - `blocked` ⇒ surface it and do **not** start the next wave for its dependents.
   - `failed` ⇒ surface the stderr and offer one retry with the failure appended to the prompt. Max one retry per stream, then STOP.
   - `requests.jsonl` non-empty ⇒ route each request to the owning stream in the next wave, or apply it directly if that stream is already done.

8. **Out-of-lane audit between waves.** In the worktree:
   ```bash
   git -C "<worktree>" status --porcelain
   ```
   Every changed path must be inside the union of this wave's declared scopes (streams' `files` + owned `shared`). Anything outside ⇒ **STOP**: name the file, the stream that most likely wrote it, and leave the tree untouched. This audit is what makes a shared worktree safe rather than merely cheap.

9. **After the last wave.** Release the locks (`lock.sh release <issue> <stream> <path>`), then run `commands.lint` and `commands.test` in the worktree. Failures ⇒ **one** batched fix dispatch: a single implementer with the whole failure list and the union of the failing files as its scope — never one agent per failure. Re-run the gates. **Cap: 3 fix rounds**, then STOP with the remaining failures.

10. **State.** Task frontmatter `status`/`updated`; progress comment on the issue:
    ```bash
    bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-comment <issue> --body-file <file>
    ```
    Append the ledger rows for every ruling made in this run.

11. **Report** the wave-by-wave summary (stream, status, files, tests), the new ledger rows, and the next command — `/agentic-git:pr <issue>`.

## Outputs

Commits in the worktree, `epics/<slug>/analysis/<issue>.md`, `runtime/streams/<issue>/*.json` + `requests.jsonl`, issue comment, ledger rows.

## Stop conditions

| Condition | Action |
|---|---|
| An open `blocked-by` issue | STOP before any dispatch |
| Scopes cannot be made disjoint and >1 stream was requested | STOP — propose the merged decomposition |
| A file changed outside its lane (step 8) | STOP — nothing is committed further |
| Two consecutive failed waves | STOP |
| 3 failed fix rounds | STOP with the failure list |
| A stream requests a `config.protected_paths` entry | STOP — that change is the human's |
