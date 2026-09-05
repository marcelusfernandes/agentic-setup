---
name: sync
description: Push a local epic to GitHub — ensure the milestone, create the parent epic issue and one sub-issue per task with real parent and blocked-by links, apply labels, and rewrite local files to be keyed by issue number. Idempotent: re-running reconciles instead of duplicating.
argument-hint: "<epic-slug> [--dry-run] [--no-milestone]"
disable-model-invocation: true
user-invocable: true
model: sonnet
---

# agentic-git: sync

Epic slug: `$0`. Flags in `$ARGUMENTS`: `--dry-run`, `--no-milestone`.

Every GitHub call goes through the host dispatcher. Never invoke `gh` yourself:
`bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" <verb> …`

Local facts:
- epic dir: !`test -d ".claude/agentic/epics/$0" && echo yes || true`
- already mapped: !`jq -r '.epic_issue // "none"' ".claude/agentic/epics/$0/mapping.json" 2>/dev/null || true`

Inputs: `epics/<slug>/{epic.md,tasks/*.md,mapping.json}`, `runtime/host-caps.json`, `config.json`. Missing epic directory ⇒ STOP listing the epics that do exist.

## Procedure

1. **Repo safety gate.**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" repo-info
   ```
   Non-zero (not a GitHub origin, or the plugin's own repo) ⇒ STOP. Otherwise print the caution banner naming the exact target before any write:
   `About to create issues in <owner>/<name>. Epic "<slug>", <n> tasks.`

2. **Refresh host caps** if `runtime/host-caps.json` is missing or older than 7 days:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" caps > .claude/agentic/runtime/host-caps.json
   ```

3. **Bounded dedup pass.** Every issue this workflow creates carries a hidden body marker:
   ```
   <!-- agentic-git:epic=<slug> id=<local-id> -->
   ```
   Build the set of ids still needing creation (`epic` plus every task's `local_id`), then:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-find --marker "agentic-git:epic=<slug>"
   ```
   It pages `--label agentic --state all` and stops as soon as every id is accounted for. Record each match into `mapping.json` and skip it below. Never create an issue whose marker already exists.

4. **Milestone.** If `epic.md` has `milestone:` and `--no-milestone` was not passed:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" milestone ensure "<title>" [<due_on>]
   ```
   Returns `{number,title,state,open_issues}`; store `{title,number}` in `mapping.json.milestone` and pass `--milestone <number>` to every creation below.

5. **Epic parent issue**, only when `mapping.json.epic_issue` is null. Body = `epic.md` with the frontmatter stripped (`sed '1,/^---$/d; 1,/^---$/d'`), plus the marker line, plus an empty task checklist placeholder; write it to a temp file first:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-create \
     --title "Epic: <title>" --body-file /tmp/agentic-epic-<slug>.md \
     --labels epic,agentic [--milestone <n>]
   ```
   Write `epic_issue` and `epic_url` into `mapping.json` **immediately**, and set `github:`/`issue:` in `epic.md` frontmatter via `fm_set`.

6. **Task sub-issues, in topological order** of `depends_on`, so every blocker already has a number. Per task, body = the task file minus frontmatter plus the marker; flags driven by `runtime/host-caps.json`:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-create \
     --title "<task name>" --body-file /tmp/agentic-task-<local-id>.md \
     --labels task,agentic [--milestone <n>] \
     [--parent <epic#>]        # only when native_parent
     [--blocked-by <n1,n2>]    # only when native_blocked_by; already-mapped numbers
   ```
   Write the new `{issue,url}` into `mapping.json.tasks["<local-id>"]` **after each single creation**, not at the end — an interrupted run must resume, not duplicate.

   Rate limiting is handled inside `issue-create.sh` (it checks remaining quota before each batch of 5 and waits when it is under 10). If it reports a wait, say so and let it wait.

7. **Linking ladder** (`issue-link`), for whatever step 6 could not do natively. Try tier by tier; the script returns `{mode:"native|rest|checklist"}`:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-link --parent <epic#> --children <t1,t2,…>
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-link --blocked-by <task#> --by <n1,n2>
   ```
   1. native `--add-sub-issue` / `--add-blocked-by` flags on the host CLI;
   2. REST `sub_issues` / `dependencies/blocked_by` using the numeric database id;
   3. degraded checklist — `- [ ] #<n>` lines in the epic body and a `Blocked by: #a, #b` line in each task body.

   Record the returned mode in `mapping.json.link_mode`. Any downgrade is a visible warning **and** a ledger ruling:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/ledger.sh" <slug> \
     --who sync --scope epic --ruling "Fell back to <mode> linking" \
     --why "<what the probe/API returned>" \
     --cost "dependencies not enforced by GitHub" --reversible "yes (re-run sync)"
   ```
   In checklist mode, tell the user plainly that `status blocked` is then advisory.

8. **Status labels.** For each task: `status:ready` when it has no open blockers, `status:blocked` otherwise.
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-label set <issue> --add "status:ready" --remove "status:blocked"
   ```
   A label failure is a warning, never a stop — labels mirror frontmatter, frontmatter is the source of truth.

9. **Rewrite local state**, per task, after its issue exists:
   - rename `tasks/<local-id>.md` → `tasks/<issue>.md` (plain `mv`; `local_id` in the frontmatter is what preserves identity);
   - `fm_set` on each renamed file: `issue`, `github`, `parent` (= epic issue), `updated` (`date -u +"%Y-%m-%dT%H:%M:%SZ"`);
   - rewrite `depends_on` and `conflicts_with` from local ids to issue numbers, whole-array, flow style: `depends_on: ["123", "124"]`;
   - in `epic.md`, rewrite `tasks:` to issue numbers and rewrite each `shared_files[].owner` from local id to issue number;
   - re-run step 7's parent link with the full child list so the epic body checklist carries the real numbers.

   Use `fm_set` from `scripts/lib/state.sh` for every frontmatter write — never a hand-rolled `sed -i`.

10. **Reconcile mode** (any re-run, for every already-mapped id): compare local `status`/`title` with GitHub.
    - open/closed **state**: GitHub wins (someone may have closed it in the UI) — update the task's `status` to `closed` and say so;
    - title and body: local wins;
    - report every divergence as a line in the summary rather than syncing it silently;
    - never re-create an issue whose marker exists, and never reopen an issue GitHub says is closed.

11. **`--dry-run`**: print every command that *would* run, in order, with the resolved numbers where they are already known and `<new>` where they are not, then exit. Nothing is created, nothing local is renamed, `mapping.json` is untouched.

## Final summary format

```
Synced epic "oauth-login" → <owner>/<name>

  milestone   v1.2 (#4, ensured)
  epic issue  #100  https://github.com/o/r/issues/100
  tasks       #123 001  created   ready
              #124 002  created   blocked by #123
              #125 003  existed   unchanged
  linking     native (parent + blocked-by)
  renamed     tasks/001.md → tasks/123.md  (+2 more)

  divergences 1 — #125 closed on GitHub, local status was open → updated
  rulings     0

Next: /agentic-git:status oauth-login   ·   /agentic-git:start 123
```

## Stop conditions

| Condition | Behaviour |
|---|---|
| Origin is not GitHub, or is the plugin's own repo | STOP before any write |
| Epic directory or `mapping.json` missing | STOP; list the epics that exist |
| `epic.md` frontmatter unparseable | STOP → `/agentic-git:doctor` |
| `issue-create` fails mid-run | Not a stop condition to fear: `mapping.json` already holds every issue created so far. Report where it stopped and say `re-run /agentic-git:sync <slug>` |
| Auth/permission error (403) on creation | STOP with the exact `gh auth refresh -s repo` line |
