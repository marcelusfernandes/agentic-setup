# Quickstart

The 8-command happy path, copy-pasteable, with what you should see after each step. Run these from the root of a real GitHub repository (not this plugin's own repo — `sync` and `pr` refuse to create issues in `marcelusfernandes/agentic-setup`).

## 0. Install (once per machine)

```
/plugin marketplace add marcelusfernandes/agentic-setup
/plugin install agentic-git@agentic-setup
```

**Expect:** the plugin appears in `/plugin list` as `agentic-git@agentic-setup`. Nothing is written to your project yet.

## 1. `/agentic-git:init`

**Expect on disk:**
```
.claude/agentic/
├── epics/
├── archive/
├── runtime/{streams,locks}/
├── config.json
└── .gitkeep
```
`.gitignore` gains two lines: `.worktrees/` and `.claude/agentic/runtime/`. Local git config gets `rerere.enabled true`, `rerere.autoupdate true`, `merge.conflictStyle zdiff3` (`git config --local --list` shows all three).

**Expect on GitHub:** seven labels created on the repo — `agentic`, `epic`, `task`, `status:ready`, `status:in-progress`, `status:in-review`, `status:blocked`.

**Expect in chat:** a checklist with a ✓ or ⚠ per prerequisite (git version, gh auth, jq), and a "next steps" line pointing at `/agentic-git:scan`.

## 2. `/agentic-git:scan`

**Expect on disk:** `.claude/agentic/project-profile.json` (committed) and `.claude/agentic/runtime/last-scan.json` (git-ignored, raw evidence).

**Expect in chat:** a ≤15-line summary — detected language(s), package manager, the resolved command table (`install`, `test`, `lint`, `format`, `typecheck`, `build`), monorepo yes/no, CI provider, and what already exists under `.claude/` (existing agents, hooks, `CLAUDE.md`). Any command it could not resolve shows as `null`, never a guess.

## 3. `/agentic-git:adopt`

**Expect in chat first:** a unified diff per file it intends to write or change, and a plain-text confirmation prompt.

**Expect on disk after confirming:**
```
.claude/agents/{test-runner.md, code-reviewer.md, refactorer.md}   # created or adapted
.claude/agentic/hooks/{format-on-edit.sh, guard-secrets.sh}        # copied in, executable
.claude/settings.json                                               # merged, not overwritten
CLAUDE.md                                                            # sentinel block added or updated
.claude/agentic/runtime/adopt-manifest.json                         # created vs adapted vs kept, per file
```
An agent file that already exists and already covers the same ground is reported as "kept existing `<name>` — already covers this" and left untouched.

## 4. `/agentic-git:doctor`

**Expect in chat:** a grouped report (prereq / repo / host / state / git / config / profile), each line `OK`, `WARN`, or `FAIL` with a `fix:` command. A fresh install right after steps 1–3 should show all `OK`.

## 5. `/agentic-git:plan "<goal>"` then `/agentic-git:sync <slug>`

```bash
/agentic-git:plan "Add OAuth login with Google and GitHub" --milestone v1.2
```
**Expect on disk (nothing on GitHub yet):**
```
.claude/agentic/epics/oauth-login/
├── epic.md              # frontmatter + Goal/Technical approach/Out of scope/Assumptions/Acceptance criteria
├── tasks/001.md … 00N.md
├── mapping.json          # {"epic":null,"tasks":{},"milestone":null}
└── ledger.md             # header only
```
**Expect in chat:** the task table (id, title, deps, parallel, files count) and a parallelism preview (wave 1, wave 2, …). More than `max_tasks_per_epic` (default 10) tasks → a `STOP:` with a proposed split, not a truncated plan.

```bash
/agentic-git:sync oauth-login
```
**Expect on GitHub:** a milestone `v1.2` (created if absent), an epic issue titled `Epic: Add OAuth login` labeled `epic, agentic`, and one sub-issue per task labeled `task, agentic`, each carrying real `--parent`/`--blocked-by` links (or the REST or checklist fallback if your `gh` lacks the flags — `mapping.json.link_mode` records which).

**Expect on disk:** `tasks/001.md` renamed to `tasks/<issue-number>.md`; `depends_on`/`conflicts_with` rewritten from local ids to issue numbers; `mapping.json` filled in with `{issue, url, branch: null, worktree: null}` per task.

## 6. `/agentic-git:status next`, `/agentic-git:start epic oauth-login`, `/agentic-git:work <issue>`

**Expect from `status next`:** the list of issues with no open blockers, each with the exact `/agentic-git:start <n>` line to run.

**Expect from `start epic oauth-login`:**
```
.worktrees/epic-oauth-login/          # new worktree, branch epic/oauth-login
```
Dependencies installed inside it, a baseline test run reported pass/fail, `mapping.json` gains `branch`/`worktree`/`started_at`, and on GitHub the first task's issue gets `status:in-progress` (replacing `status:ready`) plus a "Started" comment.

**Expect from `work <issue>`:**
```
.claude/agentic/epics/oauth-login/analysis/<issue>.md    # stream decomposition
.claude/agentic/runtime/streams/<issue>/<stream>.json     # one per stream, status running→done
```
Commits appear in the worktree, one per stream, message `type(scope): subject (#<issue>)`. Chat shows a wave-by-wave summary and any ledger rulings, ending with the suggested next command `/agentic-git:pr <issue>`.

## 7. `/agentic-git:pr <issue>`, `/agentic-git:review <pr> --fix`, `/agentic-git:merge <pr>`

**Expect from `pr`:** format/lint/typecheck/test gates run and reported (or shown as skipped when the profile has `null`); the branch pushed; a GitHub PR created with a body containing `Closes #<issue>` per completed sub-issue and `Part of #<epic>`. `mapping.json` gains `pr`/`pr_url`; the issue label moves to `status:in-review`.

**Expect from `review --fix`:** correctness/conventions/tests reviewer agents run in parallel; one aggregated review posted with `gh pr review --comment` (never auto-approve); with `--fix`, one implementer applies the whole findings list, lint+test re-run, a fix commit pushed.

**Expect from `merge`:** the gate table (state, conflicts, CI, review, branch protection, issue links) printed; a `git merge-tree` dry run; on success, `gh pr merge --match-head-commit`; then the worktree removed, the local branch deleted (`-d`, never `-D`), linked issues closed, and the epic's `progress:` recomputed in `epic.md`.

## 8. `/agentic-git:merge epic oauth-login` and `/agentic-git:cleanup --archive`

**Expect from the merge train:** remaining open PRs for the epic merged in dependency order, smallest diff first, with a fresh `merge-tree` re-check after every merge.

**Expect from `cleanup --archive`:** a printed plan (gone branches, merged branches, stale worktree entries, epics whose tasks are all closed) requiring confirmation, then:
```
.claude/agentic/epics/oauth-login/   →   .claude/agentic/archive/oauth-login/
```
plus the `v1.2` milestone closed if its open-issue count is zero, and a final ledger line recorded for the archive.

At this point `.worktrees/` is empty, `git branch -vv` shows no leftover feature branches, and `/agentic-git:status` reports the epic at 100% under Archive.
