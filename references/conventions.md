# Conventions

Normative reference for paths, schemas, and naming used by every skill and script. Read this
before touching `.claude/agentic/` state by hand or from a skill.

## 1. Directory layout

```
.claude/agentic/
├── config.json                     # policy. Committed. Never auto-overwritten (missing keys merge in).
├── project-profile.json            # detected facts + user overrides. Committed.
├── hooks/                          # scripts `adopt` copied in. Committed.
├── epics/<slug>/
│   ├── epic.md                     # the plan. Committed.
│   ├── tasks/{001.md .. | <issue>.md}
│   ├── analysis/<issue>.md         # stream decomposition, written by `work`
│   ├── mapping.json                # local id ↔ issue ↔ url ↔ branch ↔ worktree ↔ pr
│   └── ledger.md                   # append-only rulings for this epic
├── archive/<slug>/                 # completed epics, same shape
└── runtime/                        # LOCAL ONLY — git-ignored
    ├── host-caps.json
    ├── last-scan.json
    ├── adopt-manifest.json
    ├── streams/<issue>/{<stream>.json, requests.jsonl, baseline.json}
    └── locks/<sha1-of-path>.lock
```

Everything except `runtime/` is committed: epics, tasks and the ledger are project history and
belong in review. `runtime/` is per-machine (stream state, locks, scan caches) and would conflict
constantly if shared — `init` adds it to `.gitignore`.

## 2. `config.json` (defaults; see `scripts/state/init-state.sh`)

Key fields: `base_branch`, `protected_branches`, `protected_paths`, `branch_template`
(`{type}/{issue}-{slug}`), `epic_branch_template` (`epic/{slug}`), `worktree_dir` (`.worktrees`),
`worktree_link`, `commit_template`, `labels`, `merge_strategy`, `require_review`, `require_ci`,
`max_tasks_per_epic`, `max_parallel_streams`, `worktree_mode` (`auto|shared|per-task`),
`conflict_autonomy.{max_files,max_hunks,max_rebase_commits}`. Never edited by scripts except to
fill in missing keys — a hand edit always wins.

## 3. `project-profile.json`

Detected stack facts (`repo`, `languages`, `package_manager`, `commands.*`, `source_globs`,
`generated_globs`, `shared_files`, `secrets_globs`, …) plus a single hand-edited `overrides`
block, deep-merged **over** everything else at read time. Always read through
`lib/state.sh:profile_get`/`profile_json`/`profile_cmd` — never `jq` the file directly — so the
merge is never forgotten. `scan --refresh` re-derives everything except `overrides`.

## 4. Frontmatter schemas

**`epic.md`** — required keys: `name` (== directory slug), `title`, `status`
(`backlog|in-progress|completed`), `created`, `updated`, `progress` (`NN%`, recomputed by
`epic-progress.sh`), `tasks` (flow list of local ids or issue numbers). Set once synced:
`milestone`, `github`, `issue`, `worktree_mode`, `epic_branch`, `shared_files` (list of
`{path, owner}`).

**`tasks/<id>.md`** — required keys: `name`, `type` (`feat|fix|docs|refactor|perf|test|chore`),
`status` (`open|in-progress|in-review|closed`), `created`, `updated`, `epic` (must equal the
parent directory slug), `local_id` (never changes, survives the sync rename), `depends_on` (flow
list — local ids pre-sync, issue numbers post-sync), `conflicts_with`, `parallel` (bool),
`files` (block-style YAML list of paths/globs), `estimate` (`S|M|L`). Set once synced/started:
`issue`, `github`, `parent`, `branch`, `worktree`, `pr`.

Arrays are edited wholesale, never parsed as real YAML — `lib/state.sh:fm_set` rewrites the whole
`key: value` line with `sed`. Flow-style lists (`["a","b"]`) round-trip through `fm_set`/`fm_list`;
block-style lists (`files:` — one `  - item` per line) need a dedicated reader (see
`scripts/state/_lib.sh:read_block_list`), since `fm_list` only understands flow style.

## 5. `mapping.json` (per epic)

```json
{
  "epic_slug": "oauth-login", "epic_issue": 100, "epic_url": "…",
  "milestone": {"title": "v1.2", "number": 4}, "link_mode": "native|rest|checklist",
  "worktree_mode": "shared", "epic_branch": "epic/oauth-login",
  "tasks": {"001": {"issue": 123, "url": "…", "branch": "…", "worktree": "…", "pr": 45, "state": "open"}},
  "updated": "…"
}
```

## 6. Runtime files

- `runtime/streams/<issue>/<stream>.json` — `{issue, stream, name, status:running|done|blocked|failed,
  started_at, ended_at, files_owned[], files_touched[], commits[], tests:{command,result},
  summary, blocked_on}`. Written by the implementer, read by `work`/`status streams`.
- `runtime/streams/<issue>/requests.jsonl` — one JSON object per line, appended by a non-owner
  stream that needs a shared file changed: `{ts, from, to, path, change, reason}`.
- `runtime/locks/<sha1(path)>.lock` — `{path, issue, stream, acquired_at, pid}`. A lock whose
  `pid` is dead (`kill -0` fails) **and** older than 2 hours is stale and may be reclaimed —
  reclaiming always appends a ledger row (`scripts/state/lock.sh` calls `ledger.sh`).

## 7. Naming conventions

| Thing | Template | Example |
|---|---|---|
| Epic slug | 3–4 meaningful words, kebab, ≤40 chars | `oauth-login` |
| Task branch | `{type}/{issue}-{slug}` | `feat/123-oauth-provider-config` |
| Epic branch | `epic/{slug}` | `epic/oauth-login` |
| Task worktree | `.worktrees/{issue}-{slug}` | `.worktrees/123-oauth-provider-config` |
| Epic worktree | `.worktrees/epic-{slug}` | `.worktrees/epic-oauth-login` |
| Commit | `{type}({scope}): {subject} (#{issue})` | `feat(db): add oauth_providers table (#123)` |
| Epic issue title | `Epic: {title}` | `Epic: Add OAuth login` |
| PR title | same as the commit convention | |
| Issue body marker | `<!-- agentic-git:epic=<slug> id=<local-id> -->` | dedup key for `sync` |
| PR body marker | `<!-- agentic-git:pr epic=<slug> -->` | identifies our PRs |
| Stream id | single uppercase letter | `A`, `B`, `C` |

Slug rules (`lib/common.sh:slugify`): lowercase, `[a-z0-9-]` only, collapse runs of `-`, strip
leading/trailing `-`. Keep full branch refs well under GitHub's 244-byte limit.

Labels: `agentic` (marker on everything the plugin creates — the basis of a bounded
`gh issue list --label agentic`), `epic`, `task`, `status:ready|in-progress|in-review|blocked`.
Status labels are advisory mirrors of frontmatter; frontmatter is the source of truth, GitHub
state wins only for open/closed.

## 8. Datetime

Always `date_utc` (`date -u +"%Y-%m-%dT%H:%M:%SZ"`) from `lib/common.sh`. Never a placeholder,
never `date -d`/`date -j` (not portable — see `scripts/state/_lib.sh:epoch_of` for the pure-
arithmetic alternative when a timestamp must be turned back into an epoch, e.g. for staleness or
age checks).

## 9. `fm_set` usage

`fm_set <file> <key> <value>` replaces the `key: ...` line inside frontmatter (or appends it just
before the closing `---`). The caller is responsible for quoting: `fm_set f status '"closed"'` is
wrong (that's for `json_set`) — frontmatter values are written verbatim, so
`fm_set f status closed` and `fm_set f depends_on '["101", "102"]'` are both correct as-is.

## 10. Script-first rule

Anything deterministic — status, next, blocked, progress recomputation, validation, conflict
census, merge-tree checks, label creation — is a `scripts/*.sh` call whose stdout a skill reads.
Skills only add judgment: decomposition, conflict semantics, review findings, commit messages.

## 11. STOP block format

When a stop condition fires, print (to stderr, or in the skill's final message):
```
STOP: <what fired>
<what was done so far, if anything>
<the exact command the human can run to continue / recover>
```
`lib/common.sh:stop "<condition>" "<next command>"` emits this and exits 3.
`scripts/git/*` scripts that refuse a destructive action (dirty worktree removal, an
already-existing worktree path) follow the same shape on stderr and exit 3.

## 12. Ruling ledger row format

`epics/<slug>/ledger.md`, append-only, one row per autonomous judgment call:

```markdown
| when | who | scope | ruling | why | cost if wrong | reversible |
|---|---|---|---|---|---|---|
| 2026-09-05T14:31:02Z | work | #123 stream B | Split api layer into its own stream | src/api/** disjoint from src/db/** | wasted parallelism if wrong | yes |
```

Written by `scripts/state/ledger.sh <slug> <who> <scope> <ruling> <why> <cost-if-wrong>
<reversible>`, which escapes `|` and collapses newlines so one call always yields exactly one row.
