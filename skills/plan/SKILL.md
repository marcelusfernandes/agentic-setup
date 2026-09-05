---
name: plan
description: Turn a goal, a PRD file, or a rough description into a local epic — a technical plan plus at most 10 tasks, each with explicit depends_on, conflicts_with, file scope and parallel metadata — stored under .claude/agentic/epics/ and not yet pushed to GitHub.
argument-hint: "<goal text> | --from <path/to/prd.md> [--milestone <title>] [--max-tasks N]"
disable-model-invocation: true
user-invocable: true
model: opus
---

# agentic-git: plan

Produces a local epic only. Nothing reaches GitHub here — that is `/agentic-git:sync`.

Arguments: `$ARGUMENTS`. The goal is the free text; `--from <path>` reads a PRD file instead; `--milestone <title>` sets `milestone:` in the epic frontmatter; `--max-tasks N` overrides `config.max_tasks_per_epic`.

Local facts:
- profile: !`test -f .claude/agentic/project-profile.json && echo yes || true`
- existing epics: !`ls .claude/agentic/epics 2>/dev/null || true`

## Procedure

1. **Preconditions.** `.claude/agentic/project-profile.json` must exist and parse; missing ⇒
   ```
   STOP: no project profile
   What happened: the planner needs the resolved command table and file globs.
   Done so far: nothing was written.
   Next: /agentic-git:scan
   ```
   Working-tree cleanliness is irrelevant — planning writes only under `.claude/agentic/`. Read `max_tasks_per_epic` (default 10) and `protected_paths` from `.claude/agentic/config.json`. With `--from`, STOP if the path does not exist.

2. **Derive the epic slug.** Lowercase the goal, drop the stop-words `a an the to for of and or with in on`, keep the first 3–4 meaningful words, join with `-`, keep only `[a-z0-9-]`, collapse repeated `-`, strip leading/trailing `-`, truncate to 40 chars. If `.claude/agentic/epics/<slug>/` already exists, append `-2`, `-3`, … The eventual `epic/<slug>` branch must stay well under 200 bytes.

3. **Clarify — at most 5 questions, in one message**: scope boundaries, non-goals, acceptance criteria, existing code to reuse, deployment/migration constraints. If the user says "just go" (or does not answer), proceed and record every assumption under `## Assumptions` in `epic.md`.

4. **Dispatch the `workflow-planner` agent — exactly one call.** Pass it, in the prompt:
   - the goal text or the full PRD contents, plus the answers from step 3 (or the assumptions taken);
   - the merged profile: `jq -s '.[0] * .[1]' <(jq "del(.overrides)" .claude/agentic/project-profile.json) <(jq ".overrides" .claude/agentic/project-profile.json)`, specifically `source_globs`, `test_globs`, `shared_files`, `generated_globs` and the command table;
   - the repository census: `git ls-files | head -300` and `git ls-files | sed 's|/[^/]*$||' | sort -u | head -80`;
   - `config.max_tasks_per_epic` (or `--max-tasks`), `config.max_parallel_streams`, `config.protected_paths`;
   - the path `${CLAUDE_PLUGIN_ROOT}/references/parallelism.md` to read;
   - the required output: the JSON plan object described in its own output contract — `{approach, tasks[], shared_files[], waves[]}`, nothing else.

   Do not dispatch it twice. If its output is not valid JSON, ask it once to re-emit the JSON only; a second failure is a STOP.

5. **Validate the graph before writing anything.** In this order, and stop at the first failure:
   - **Task cap.** `len(tasks) > max_tasks_per_epic` ⇒ do **not** truncate:
     ```
     STOP: <n> tasks exceeds the cap of <max>
     What happened: this goal is more than one epic.
     Done so far: nothing was written.
     Next: split it — <proposed epic A: tasks …> / <proposed epic B: tasks …>
           then /agentic-git:plan "<epic A goal>"
     ```
     Take the split proposal from the planner's wave structure; the boundary is the first wave with no cross-edges.
   - **Cycles.** Kahn's algorithm over `depends_on`. A cycle ⇒ STOP naming the exact ring (`001 → 004 → 002 → 001`).
   - **Symmetric conflicts.** Every `conflicts_with` edge must exist in both directions. Fix silently by adding the reverse edge; do not stop.
   - **Non-empty `files[]`.** A task with an empty `files[]` ⇒ STOP: a task whose file scope cannot be named cannot be safely parallelised. Offer the two ways out — refine the scope, or mark it `parallel: false` — and re-dispatch only after the user picks.
   - **Scope sanity.** Every `files[]` entry is a path or glob under a `source_globs` or `test_globs` root; anything matching `config.protected_paths` is reported as a warning on that task, not a stop.

6. **Compute `shared_files`.** Any path appearing in more than one task's `files[]`, plus every path in `profile.shared_files`. Give each exactly one `owner`: the task planning the most edits in it, ties broken by lowest local id. Write the list into `epic.md` frontmatter as `path`/`owner` pairs.

7. **Write the epic**, rendering `${CLAUDE_PLUGIN_ROOT}/references/templates/epic.md` and `${CLAUDE_PLUGIN_ROOT}/references/templates/task.md`:
   ```
   .claude/agentic/epics/<slug>/epic.md
   .claude/agentic/epics/<slug>/tasks/001.md … NNN.md
   .claude/agentic/epics/<slug>/mapping.json
   .claude/agentic/epics/<slug>/ledger.md
   ```
   - `epic.md` frontmatter: `name` (= slug), `title`, `status: backlog`, `created`/`updated` from `date -u +"%Y-%m-%dT%H:%M:%SZ"`, `progress: 0%`, `milestone` (only if given), `github: null`, `issue: null`, `worktree_mode` from `config.worktree_mode`, `shared_files`, `tasks` (local ids). Body sections: `## Goal`, `## Technical approach`, `## Out of scope`, `## Assumptions`, `## Acceptance criteria`.
   - `tasks/NNN.md` — zero-padded local ids in wave order — frontmatter: `name`, `type`, `status: open`, `created`, `updated`, `epic`, `local_id: "NNN"`, `issue: null`, `github: null`, `parent: null`, `depends_on` (**local ids**, e.g. `["001"]`), `conflicts_with`, `parallel`, `files`, `estimate`, `branch: null`, `worktree: null`, `pr: null`. Body: `## Description`, `## Acceptance criteria` (checkboxes), `## Notes`.
   - `mapping.json`: `{"epic_slug":"<slug>","epic_issue":null,"epic_url":null,"milestone":null,"link_mode":null,"worktree_mode":"<mode>","epic_branch":null,"tasks":{},"updated":"<utc>"}`.
   - `ledger.md`: the header only — `# Ruling ledger — <slug>` and the table header row.
   Local ids are rewritten to issue numbers by `sync`; `local_id` never changes.

8. **Ledger.** Append one row per autonomous judgment made here — a silently added reverse conflict edge, a shared-file owner chosen on a tie, an assumption taken because the user said "just go":
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/ledger.sh" <slug> \
     --who plan --scope "<epic|NNN>" --ruling "<one line>" --why "<one line>" \
     --cost "<what a wrong call costs>" --reversible yes
   ```
   Print the new rows in the summary.

## Final summary format

```
Epic planned: oauth-login  (.claude/agentic/epics/oauth-login/)

 id   title                             type   deps        par  files
 001  OAuth provider config table       feat   —           yes  3
 002  Provider client + token exchange  feat   001         yes  4
 003  Login route and callback          feat   001,002     no   2

 waves:  1 → 001        2 → 002        3 → 003
 shared: packages/types/src/index.ts → owned by 001
         package.json                → owned by 001

 rulings: 1 (see epics/oauth-login/ledger.md)

Nothing has been pushed to GitHub.
Next: review the files, then /agentic-git:sync oauth-login
```

## Stop conditions

More tasks than the cap → STOP with a split proposal. A dependency cycle → STOP naming the ring. A task with an empty `files[]` → STOP. Missing profile → STOP. A missing `--from` file → STOP. In every case nothing under `epics/<slug>/` is written — the epic directory is created only after step 5 passes completely.
