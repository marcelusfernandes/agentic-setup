# State model

Everything `agentic-git` tracks lives under `.claude/agentic/` in your project. This document is the reference for every file's shape. Frontmatter fields are edited by the plugin's own scripts (`lib/state.sh`'s `fm_get`/`fm_set`); hand-editing is safe for `config.json` and the `overrides` block of `project-profile.json`, but not recommended anywhere else while a skill might be mid-run.

## The `.claude/agentic/` tree

```
.claude/agentic/
├── config.json                     # policy. Committed. init writes it once, never overwrites it again.
├── project-profile.json            # detected stack + your overrides. Committed.
├── hooks/                          # scripts adopt copied in. Committed.
│   ├── format-on-edit.sh
│   └── guard-secrets.sh
├── epics/
│   └── <epic-slug>/
│       ├── epic.md                 # the plan. Committed.
│       ├── tasks/
│       │   ├── 001.md              # pre-sync id
│       │   └── 123.md              # post-sync, renamed to the GitHub issue number
│       ├── analysis/
│       │   └── 123.md              # work's stream decomposition for issue 123
│       ├── mapping.json            # local id ↔ issue ↔ url ↔ branch ↔ worktree ↔ pr
│       └── ledger.md               # append-only rulings for this epic
├── archive/
│   └── <epic-slug>/                # completed epics, moved here by cleanup, same shape
└── runtime/                        # LOCAL ONLY — git-ignored, per machine
    ├── host-caps.json
    ├── last-scan.json
    ├── adopt-manifest.json
    ├── streams/<issue>/{<stream>.json, requests.jsonl, baseline.json}
    └── locks/<sha1-of-path>.lock
```

**Committed vs ignored**: everything is committed except `runtime/`. `init` adds `.worktrees/` and `.claude/agentic/runtime/` to `.gitignore`. Epics, tasks, the profile, config and the ledger are project history and belong in code review; stream state, locks and scan caches are per-machine and would conflict constantly if shared.

## `config.json` — policy

Written once by `init` with these defaults; existing values are never overwritten on re-run, only missing keys are merged in.

```json
{
  "schema_version": 1,
  "host": "github",
  "base_branch": "main",                                  // detected default branch at init time
  "protected_branches": ["main", "master", "develop", "release/*"],
  "protected_paths": ["**/migrations/**", ".github/workflows/**", "**/auth/**", "**/security/**"],
  "branch_template": "{type}/{issue}-{slug}",              // used by start for task branches
  "epic_branch_template": "epic/{slug}",                    // used by start for the shared epic branch
  "worktree_dir": ".worktrees",
  "worktree_link": [".env", ".env.local", ".envrc"],        // untracked files symlinked into new worktrees
  "commit_template": "{type}({scope}): {subject} (#{issue})",
  "labels": { "marker": "agentic", "epic": "epic", "task": "task", "status_prefix": "status:" },
  "merge_strategy": "squash",                               // squash | merge | rebase, passed to gh pr merge
  "delete_branch_on_merge": true,
  "require_review": true,                                   // merge STOPs unless reviewDecision == APPROVED
  "require_ci": true,                                       // merge STOPs unless every check is SUCCESS/NEUTRAL
  "default_reviewers": [],                                  // passed to gh pr create --reviewer
  "max_tasks_per_epic": 10,                                 // plan STOPs with a split proposal above this
  "max_parallel_streams": 4,                                // work's ceiling per wave
  "worktree_mode": "auto",                                  // auto | shared | per-task, see start's rule
  "conflict_autonomy": { "max_files": 10, "max_hunks": 20, "max_rebase_commits": 20 },
  "test_gate_hook": false                                   // written true only by adopt --enable-test-gate
}
```

## `project-profile.json` — detected facts + overrides

Written and refreshed by `scan`. Every field except `overrides` is derived evidence; edit only `overrides`.

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-05T14:02:11Z",
  "generated_by": "agentic-git@0.1.0",
  "confidence": "high",                     // high | medium | low
  "ambiguities": [],                        // unresolved ties (e.g. jest vs vitest) with the recommendation taken
  "repo": { "host": "github", "owner": "…", "name": "…", "default_branch": "main", "remote": "…" },
  "languages": [{ "name": "typescript", "share": 0.81, "evidence": ["tsconfig.json", "package.json"] }],
  "package_manager": { "name": "pnpm", "lockfile": "pnpm-lock.yaml", "runner_prefix": "pnpm exec", "version_file": ".nvmrc" },
  "monorepo": { "is_monorepo": true, "tool": "turborepo", "workspaces": ["apps/*", "packages/*"] },
  "tools": { "test_runner": "vitest", "linter": "eslint", "formatter": "prettier", "typechecker": "tsc", "build": "turbo" },
  "commands": {
    "install": "pnpm install --frozen-lockfile", "build": "pnpm build",
    "test": "pnpm test", "test_file": "pnpm vitest run {file}",
    "lint": "pnpm lint", "lint_fix": "pnpm eslint --fix {file}",
    "format": "pnpm prettier --write {file}", "format_all": "pnpm prettier --write .",
    "typecheck": "pnpm tsc --noEmit", "run": "pnpm dev"
  },
  "command_cwd": ".",
  "ci": { "provider": "github-actions", "workflows": [".github/workflows/ci.yml"], "required_checks": ["build", "test", "lint"] },
  "source_globs": ["apps/**", "packages/**", "src/**"],
  "test_globs": ["**/*.test.ts", "**/*.spec.ts", "tests/**"],
  "generated_globs": ["dist/**", "build/**", ".turbo/**", "pnpm-lock.yaml", "**/*.generated.*"],
  "shared_files": ["package.json", "pnpm-lock.yaml", "turbo.json", "packages/types/src/index.ts"],
  "secrets_globs": [".env", ".env.*", "!.env.example", "*.pem", "*.key", "**/id_rsa*", "secrets.*", "credentials.json"],
  "claude": {
    "claude_md_path": "CLAUDE.md", "claude_md_has_sentinel": false,
    "settings_path": ".claude/settings.json", "existing_hook_events": ["PostToolUse"],
    "existing_agents": ["db-migrator"], "existing_skills": []
  },
  "overrides": {}
}
```

**Any command slot can be `null`** — that means the gate is skipped and reported as skipped, never guessed and never treated as passed. `doctor` flags a `null` slot as `WARN` with the exact `overrides` JSON to paste in.

### `overrides` — the one hand-edited block

Deep-merged **over** every detected value at read time (`jq -s '.[0] * .[1]'`, defaults then overrides), and preserved byte-for-byte by `scan --refresh`. Every reader goes through `profile_get`, so nothing bypasses this merge.

```json
{
  "overrides": {
    "commands": { "test": "make test-fast", "test_file": "make test-one FILE={file}" },
    "shared_files": ["config/routes.rb"],
    "secrets_globs": ["config/master.key"]
  }
}
```

There is deliberately no second config file for stack facts — policy lives in `config.json`, facts and fact-overrides live here, nothing lives in a third place.

## `epic.md` frontmatter

```yaml
---
name: oauth-login                       # == the epics/<slug> directory name
title: Add OAuth login                  # human title; becomes the GitHub issue "Epic: <title>"
status: backlog | in-progress | completed
created: 2026-09-05T14:02:11Z
updated: 2026-09-05T14:02:11Z
progress: 0%                            # recomputed by scripts/state/epic-progress.sh
milestone: v1.2                         # optional; ensured on GitHub by sync
github: https://github.com/o/r/issues/100   # set by sync
issue: 100                              # set by sync
worktree_mode: shared | per-task        # decided by start, recorded here
epic_branch: epic/oauth-login           # only present when worktree_mode == shared
shared_files:
  - path: packages/types/src/index.ts
    owner: "001"                        # local id pre-sync, issue number post-sync
  - path: package.json
    owner: "001"
tasks: ["001", "002", "003"]            # rewritten to issue numbers by sync
---

## Goal
## Technical approach
## Out of scope
## Assumptions
## Acceptance criteria
```

## `tasks/<id>.md` frontmatter

```yaml
---
name: Add OAuth provider config table
type: feat | fix | docs | refactor | perf | test | chore
status: open | in-progress | in-review | closed
created: 2026-09-05T14:02:11Z
updated: 2026-09-05T14:02:11Z
epic: oauth-login
local_id: "001"                         # never changes, survives the sync rename
issue: 123                              # null until sync
github: https://github.com/o/r/issues/123
parent: 100                             # the epic's issue number
depends_on: ["001"]                     # local ids pre-sync → issue numbers post-sync
conflicts_with: ["002"]                 # symmetric; plan fills in the reverse edge automatically
parallel: true                          # false when file scope could not be safely isolated
files:
  - src/db/migrations/**
  - src/db/oauth.ts
estimate: S | M | L
branch: feat/123-oauth-provider-config  # set by start
worktree: .worktrees/123-oauth-provider-config
pr: 45                                  # set by pr
---

## Description
## Acceptance criteria
- [ ] …
## Notes
```

Both files are edited by the portable single-field pattern `sed -i.bak "/^<field>:/c\\<field>: <value>" file && rm file.bak` (wrapped as `fm_set` in `lib/state.sh`). Array fields are rewritten wholesale as a flow-style list (`depends_on: ["123", "124"]`) — no YAML parser dependency anywhere in the plugin.

## `mapping.json`

The epic's single source of truth linking local plan ids to GitHub reality:

```json
{
  "epic_slug": "oauth-login",
  "epic_issue": 100,
  "epic_url": "https://github.com/o/r/issues/100",
  "milestone": { "title": "v1.2", "number": 4 },
  "link_mode": "native | rest | checklist",
  "worktree_mode": "shared",
  "epic_branch": "epic/oauth-login",
  "tasks": {
    "001": { "issue": 123, "url": "…", "branch": "feat/123-…", "worktree": ".worktrees/123-…", "pr": 45, "state": "open" }
  },
  "updated": "2026-09-05T14:02:11Z"
}
```

`link_mode: "checklist"` means GitHub does not enforce the dependency (your `gh` lacked `--blocked-by`/`sub_issues`) — `status`/`work` still honor `depends_on` from frontmatter, but GitHub's UI won't show it as blocked.

## Runtime files (git-ignored)

**`runtime/streams/<issue>/<stream>.json`** — written by the `implementer` agent, read by `work` after each wave:

```json
{
  "issue": 123, "stream": "A", "name": "data-layer",
  "status": "running | done | blocked | failed",
  "started_at": "2026-09-05T14:10:00Z", "ended_at": null,
  "files_owned": ["src/db/oauth.ts", "src/db/migrations/**"],
  "files_touched": ["src/db/oauth.ts", "src/db/migrations/003_oauth.sql"],
  "commits": ["a1b2c3d"],
  "tests": { "command": "pnpm vitest run src/db", "result": "pass" },
  "summary": "Added oauth_providers table and the accessor module.",
  "blocked_on": null
}
```

**`runtime/streams/<issue>/requests.jsonl`** — one line per cross-stream request for a shared file:

```json
{"ts":"…","from":"B","to":"A","path":"packages/types/src/index.ts","change":"add OAuthProvider interface","reason":"api layer needs the type"}
```

**`runtime/locks/<sha1(path)>.lock`** — `{"path":"…","issue":123,"stream":"A","acquired_at":"…","pid":12345}`. A lock whose `pid` is dead **and** older than 2 hours is treated as stale and reclaimed, with a ledger line recording the reclaim.

**`runtime/host-caps.json`** — the feature-probe result from `scripts/host/github/caps.sh`: `{"native_parent":bool,"native_blocked_by":bool,"native_sub_issue_edit":bool,"sub_issues_api":bool}`, refreshed weekly.

**`runtime/adopt-manifest.json`** — per generated file: action (created/adapted/kept) and a sha256 of the generated block, so a later `adopt` run can tell a human edited inside the sentinels and ask before replacing.

## `ledger.md` — the ruling ledger

Append-only, one Markdown table row per autonomous judgment call, written by `scripts/state/ledger.sh`:

```markdown
# Ruling ledger — oauth-login

| when | who | scope | ruling | why | cost if wrong | reversible |
|---|---|---|---|---|---|---|
| 2026-09-05T14:31:02Z | work | #123 stream B | Split api layer into its own stream | src/api/** disjoint from src/db/** | wasted parallelism if wrong | yes |
| 2026-09-05T15:02:44Z | resolve-conflicts | feat/125 | Resolved src/routes.ts as additive-list | both sides only appended routes, base unchanged | a route registered twice | yes (revert commit) |
| 2026-09-05T15:40:10Z | sync | epic | Fell back to checklist linking | gh lacks --add-sub-issue and sub_issues API returned 404 | dependencies not enforced by GitHub | yes (re-run sync) |
```

## Naming conventions

| Thing | Template | Example |
|---|---|---|
| Epic slug | 3-4 meaningful words, kebab-case, ≤40 chars | `oauth-login` |
| Task branch | `{type}/{issue}-{slug}` | `feat/123-oauth-provider-config` |
| Epic branch | `epic/{slug}` | `epic/oauth-login` |
| Task worktree | `.worktrees/{issue}-{slug}` | `.worktrees/123-oauth-provider-config` |
| Epic worktree | `.worktrees/epic-{slug}` | `.worktrees/epic-oauth-login` |
| Commit | `{type}({scope}): {subject} (#{issue})` | `feat(db): add oauth_providers table (#123)` |
| Epic issue title | `Epic: {title}` | `Epic: Add OAuth login` |
| PR title | same as the commit convention | `feat(db): add oauth_providers table (#123)` |
| Issue body marker | `<!-- agentic-git:epic=<slug> id=<local-id> -->` | dedup key used by `sync` |
| PR body marker | `<!-- agentic-git:pr epic=<slug> -->` | identifies this plugin's PRs |
| Stream id | single uppercase letter | `A`, `B`, `C` |

Slug rules: lowercase, `[a-z0-9-]` only, collapsed `-` runs, no leading/trailing `-`, truncated so the full ref stays well under GitHub's 244-byte branch limit.

## Labels

| Label | Meaning |
|---|---|
| `agentic` | Marker on everything the plugin creates — makes `gh issue list --label agentic` a bounded query |
| `epic` | The parent issue of an epic |
| `task` | A sub-issue |
| `status:ready` | No open blockers, not started |
| `status:in-progress` | `start`/`work` has touched it |
| `status:in-review` | PR open |
| `status:blocked` | An open issue blocks it |

Status labels are advisory mirrors of task frontmatter `status`; frontmatter is the source of truth for everything except open/closed, where GitHub's own issue state always wins (someone may have closed it from the UI).

## What is committed vs git-ignored

| Path | Committed |
|---|---|
| `.claude/agentic/config.json` | yes |
| `.claude/agentic/project-profile.json` | yes |
| `.claude/agentic/hooks/*.sh` | yes |
| `.claude/agentic/epics/**` | yes |
| `.claude/agentic/archive/**` | yes |
| `.claude/agentic/runtime/**` | **no** — git-ignored by `init` |
| `.worktrees/**` | **no** — git-ignored by `init` |
| `.claude/agents/*.md` (written by `adopt`) | yes |
| `.claude/settings.json` (merged by `adopt`) | yes |
| `CLAUDE.md` sentinel block | yes |
