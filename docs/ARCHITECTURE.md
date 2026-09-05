# Architecture

Contributor-facing summary of the design. The normative, decision-complete spec lives in the project's build history; this document is trimmed to what a contributor needs to navigate and extend the plugin safely. When in doubt, the code and `references/*.md` are the source of truth.

## 1. Shape of the plugin

`agentic-git` is a single Claude Code plugin living at the repo root (`.claude-plugin/plugin.json` + `marketplace.json`, `"source": "./"`). One plugin, one repo — no `plugins/agentic-git/` nesting until a second plugin actually needs it. `skills/`, `agents/`, `hooks/hooks.json` are auto-discovered at the plugin root; the manifest carries metadata only, no component path lists.

It turns a GitHub repo into a pipeline: **goal → epic → GitHub issues with real dependencies → git worktrees → parallel implementer agents with disjoint file scopes → reviewed, conflict-checked PRs → merge**. It is stack-agnostic: one `scan` pass writes `project-profile.json`, and every stack-specific command is read from that profile, never hardcoded outside `references/stack-matrix.md`, `scripts/detect/*`, `assets/project-hooks/*`, and `tests/`.

## 2. Repo layout

```
agentic-setup/                    # repo root == plugin root
├── .claude-plugin/{plugin.json, marketplace.json}
├── README.md, LICENSE, CHANGELOG.md, .gitignore, .editorconfig
├── .github/workflows/ci.yml
├── docs/                          # this file, QUICKSTART, STATE-MODEL, README.pt-BR
├── skills/<name>/SKILL.md         # 14 skills, namespaced /agentic-git:<name>
├── agents/<name>.md               # 6 agents, no hooks/mcpServers/permissionMode
├── hooks/hooks.json                # SessionStart + PreToolUse(Bash) only
├── references/                     # loaded on demand by skills
│   ├── conventions.md, github.md, stack-matrix.md, parallelism.md, conflicts.md
│   └── templates/{epic,task,analysis,pr-body,claude-md-section}.md + templates/agents/*.md.tmpl
├── scripts/
│   ├── lib/{common.sh, state.sh, json.sh}       # portability shims, state I/O, jq wrappers
│   ├── hooks/{session-start.sh, guard-bash.sh}   # the two shipped hooks
│   ├── host.sh + host/github/*.sh                 # the only place `gh` may be called
│   ├── detect/*.sh                                 # evidence collection for scan
│   ├── state/*.sh                                  # init, next, blocked, status, streams, lock, ledger, epic-progress
│   ├── git/*.sh                                    # preflight, worktree add/remove, mergecheck, conflict-classify, clean-gone
│   └── validate/{doctor.sh, state-lint.sh}
├── assets/project-hooks/          # copied INTO target projects by `adopt`; no ${CLAUDE_PLUGIN_ROOT} references
└── tests/{lint.sh, smoke.sh, fixtures/, projects/}
```

Migration path if a second plugin ever appears: move everything but `marketplace.json` into `plugins/agentic-git/`, flip `source` to `"./plugins/agentic-git"`. Cheap, deliberately deferred.

## 3. Skill roster and dispatch

| # | Skill | Model-invocable | Group | Dispatches |
|---|---|---|---|---|
| 1 | `init` | no | setup | — |
| 2 | `scan` | yes | setup | `project-scanner` (fork context) |
| 3 | `adopt` | no | setup | — |
| 4 | `doctor` | yes | setup | — |
| 5 | `plan` | no | planning | `workflow-planner` |
| 6 | `sync` | no | planning | — |
| 7 | `start` | yes | execution | — |
| 8 | `work` | yes | execution | `implementer` × N, parallel, per wave |
| 9 | `status` | yes | execution | — |
| 10 | `pr` | no | integration | — |
| 11 | `review` | yes | integration | `reviewer` × 2-4, parallel; `implementer` × 1 on `--fix` |
| 12 | `merge` | no | integration | `integration-manager` (epic mode only) |
| 13 | `resolve-conflicts` | no | integration | `conflict-resolver` |
| 14 | `cleanup` | no | integration | — |

Rule for `disable-model-invocation`: a skill that writes to GitHub, rewrites project config, or changes git history is human-initiated. Read-only and worktree-local skills stay model-invocable so an orchestrating session can chain them.

No standalone `milestone` skill (a thin wrapper over `scripts/host/github/milestone.sh list|ensure|close`, called directly or through `sync`/`status`/`cleanup`). No standalone `next` skill (`status next`, backed by `scripts/state/next.sh`).

**Cross-cutting rules, all 14 skills**: `allowed-tools` set only on the three read-only skills (`status`, `doctor`, `scan`) — everywhere else it is omitted because the subagent-dispatch tool name is version-sensitive and an incomplete allowlist silently disables dispatch; safety comes from the shipped `PreToolUse` guard instead. Inline `` !`cmd` `` shell is ≤5 cheap local facts, always `|| true`, never `gh`. Anything deterministic is a script the model reads, never re-derives. Every skill that writes to GitHub calls `repo-info.sh` first (hard-fails on a non-GitHub origin or the plugin's own repo). Stop conditions print a `STOP:` block naming the condition, what happened so far, and the exact recovery command — never "try something else". Autonomous judgment calls append one ledger line. `--force`/`-D`/`--hard`/`clean -fdx` are never emitted without the user typing a literal confirmation token in that turn; `--force-with-lease` is permitted only on a workflow-created branch.

## 4. Agents

| Agent | Model | Dispatched by | Why this model |
|---|---|---|---|
| `project-scanner` | sonnet | `scan` | Output is a fixed, mechanically-validated JSON schema |
| `workflow-planner` | opus | `plan` | A bad dependency graph or file-scope assignment costs a whole epic |
| `implementer` | sonnet | `work`, `review --fix` | Narrow explicit scope, gated by lint+tests+out-of-scope check |
| `reviewer` | opus | `review` | Last gate before merge; false negatives are silent and expensive |
| `conflict-resolver` | opus | `resolve-conflicts` | Misclassifying a semantic conflict as trivial silently corrupts logic |
| `integration-manager` | sonnet | `merge epic` | Ordering decisions independently verified by `merge-tree` per step |

Hard constraints on every agent: no `hooks`, `mcpServers`, or `permissionMode` (plugin agents may not carry them); no `isolation: worktree` (it creates a *second*, harness-owned worktree the plugin's state model knows nothing about — the plugin creates worktrees itself via `scripts/git/worktree-add.sh` and hands agents an absolute path); no `memory:` (anything that must survive is a file under `.claude/agentic/`, inspectable and diffable). Project `.claude/agents/` overrides plugin agents by name, so `adopt` never emits a project agent named after one of these six.

## 5. Hooks

### Shipped by the plugin — exactly two

| Event | Script | Job |
|---|---|---|
| `SessionStart` (`startup\|resume\|clear`) | `scripts/hooks/session-start.sh` | Local-only (no `gh`, no fetch), ≤1200 chars of `additionalContext`: epic + progress, in-progress issues with branch/worktree, ready-to-start issues, detected stack, the never-force rules. Exit 0 with **no output** if `.claude/agentic` doesn't exist. |
| `PreToolUse` (`Bash`) | `scripts/hooks/guard-bash.sh` | Deny/ask on a short table of observed-dangerous patterns (below). Protects every agent in the session, not just this plugin's. |

Both use `set -uo pipefail` (never `-e` — a hook that dies mid-script emits no JSON) and fail **open**: malformed stdin → exit 0, no output, never a block.

**guard-bash.sh rule table** (substring/regex on the normalized, segment-split command — never a full shell parser):

| Pattern | Decision |
|---|---|
| `git push --force`/`-f` (not `--force-with-lease`) | deny |
| Force push to a `protected_branches` entry, or `push origin HEAD:main` | deny |
| `git worktree remove --force`/`-f` | ask |
| `git branch -D` / `--delete --force` | ask |
| `rm -rf` resolving inside `.worktrees/`, `.claude/agentic/`, `.git/` | deny |
| `git reset --hard` in a worktree with a dirty `git status --porcelain` | ask |
| write/`rm`/`mv`/`cp` into the main checkout's `.git/` from a worktree | deny |
| `git clean -xf` | ask |
| `gh repo delete`/`archive`; deleting a protected remote branch | deny |

`protected_branches` is read from `.claude/agentic/config.json` when present, else the default list.

### Deliberately NOT used

| Event | Why not |
|---|---|
| `WorktreeCreate` | Replaces git's default worktree behavior; would hijack `claude --worktree` for the user's unrelated work. |
| `PostToolUse` (plugin-level) | Formatting is the *target project's* concern, written by `adopt` into that project's own `.claude/settings.json`, not run in every project the plugin is merely installed in. |
| `Stop` | Every-turn nagging is how plugins get uninstalled; status transitions already happen at the moment `work`/`pr`/`merge` change them. |
| `SubagentStop` | No reliable result payload; `runtime/streams/<issue>/<stream>.json`, written by the party that knows what happened, is a better ledger. |
| `UserPromptSubmit` | Nothing to inject per-prompt that `SessionStart` hasn't already. |
| `SessionEnd`, `PreCompact` | State is already on disk after every step. |

### Written INTO the target project by `adopt`

Two entries in the project's `.claude/settings.json` (three with `--enable-test-gate`), each pointing at a stack-**independent** script copied to `.claude/agentic/hooks/` that reads `project-profile.json` at runtime — so changing the stack changes hook behavior with zero `settings.json` edits:

- `format-on-edit.sh` (`PostToolUse`, `Edit|Write|MultiEdit`) — runs `commands.format` on the touched file; exits 0 silently if the command is `null` or the formatter binary is missing.
- `guard-secrets.sh` (`PreToolUse`, `Edit|Write|MultiEdit|NotebookEdit`) — denies writes matching `secrets_globs` (`.env`, `*.pem`, `*.key`, etc.), never blocks reads.
- `test-gate.sh` (`Stop`) — opt-in only (`--enable-test-gate`), default off: a full-suite Stop hook on every turn is the fastest way to get a plugin disabled. The real gate is `/agentic-git:pr`.

Merge into `.claude/settings.json` is `jq`-based, keyed on the `agentic/hooks/` substring in the command — that's how "our" entries are identified and replaced idempotently without touching anything the user wrote. An unparseable `settings.json` is a hard STOP, never a rewrite.

## 6. State model

### 6.1 Layout

```
.claude/agentic/
├── config.json              # policy, committed, never auto-overwritten
├── project-profile.json     # detected facts + overrides, committed
├── hooks/*.sh                # committed
├── epics/<slug>/{epic.md, tasks/*.md, analysis/*.md, mapping.json, ledger.md}   # committed
├── archive/<slug>/           # completed epics, same shape, committed
└── runtime/                  # git-ignored — per-machine
    ├── host-caps.json, last-scan.json, adopt-manifest.json
    ├── streams/<issue>/{<stream>.json, requests.jsonl, baseline.json}
    └── locks/<sha1-of-path>.lock
```

Everything except `runtime/` is committed: epics, tasks and the ledger are project history that belongs in code review; stream state, locks and scan caches are per-machine and would conflict constantly if shared.

### 6.2 Key files, briefly (full annotated schemas: `docs/STATE-MODEL.md`)

- **`project-profile.json`** — `commands.*` (install/test/test_file/lint/lint_fix/format/format_all/typecheck/build/run), `source_globs`/`test_globs`/`generated_globs`/`shared_files`/`secrets_globs`, and the single hand-edited `overrides` block, deep-merged over detected values on every read and preserved verbatim by `scan --refresh`.
- **`config.json`** — `base_branch`, `protected_branches`/`protected_paths`, branch/commit templates, `merge_strategy`, `require_review`/`require_ci`, `max_tasks_per_epic` (10), `max_parallel_streams` (4), `worktree_mode` (`auto|shared|per-task`), `conflict_autonomy` limits.
- **`epic.md` / `tasks/<id>.md`** frontmatter — see STATE-MODEL for the full schema; the load-bearing fields are `depends_on`/`conflicts_with`/`files[]` (local ids pre-`sync`, issue numbers post-`sync`) and `shared_files[]` with exactly one `owner` each.
- **`mapping.json`** — the epic's single source of truth for `local_id → {issue, url, branch, worktree, pr, state}`, plus `link_mode` (`native|rest|checklist`) and `worktree_mode`.
- **`ledger.md`** — append-only table, one row per autonomous ruling: when, who, scope, ruling, why, cost if wrong, reversible.

Frontmatter is edited with a portable single-field `sed` pattern (`fm_set` in `lib/state.sh`) — no YAML parser dependency.

## 7. Parallelism and conflict strategy

### 7.1 Stream computation

Task `files[]` → expand globs against `git ls-files` → group into 2-4 candidate streams along real seams (layer, module, test-vs-impl) → **intersect every pair**: non-empty intersection means merge the streams or lift the overlap into `shared` with one owner — there is no third option. A path in `profile.shared_files` is always shared, never implicitly owned. `depends_on` between streams creates waves; a stream needing another's output waits rather than stubbing. One stream is a valid, common outcome.

### 7.2 Worktree mode

**Default: one worktree per epic** (`.worktrees/epic-<slug>`), N implementers inside it on disjoint scopes — one install, one branch, one PR closing several issues. **Escalate to one worktree per task** when: scopes can't be made disjoint; tasks need different dependency states (lockfile changes, native modules); tasks must ship/review independently; CI must gate per task; or a task rewrites history. `config.worktree_mode` (`auto|shared|per-task`) overrides; `auto`'s decision is recorded as a ledger ruling naming the trigger. PR shape follows worktree shape.

### 7.3 Single-writer rule

Shared files (declared `shared_files` + `profile.shared_files`) have exactly one owning stream, enforced by a lock in `runtime/locks/`. Non-owners append to `requests.jsonl` and keep working their own scope; the orchestrator routes requests to the owner next wave, or applies directly if the owner is done. After every wave, `git status --porcelain` is diffed against the union of declared scopes — anything outside its lane stops the run. This check is what makes a shared worktree safe rather than merely cheap.

### 7.4-7.5 Merge order and dry runs

Topological by `depends_on`, then smallest-diff-first within a level (small PRs land clean, the big one absorbs the rebase cost once), ties by PR number. **Every merge invalidates prior dry runs** — re-run `git merge-tree --write-tree` for all remaining PRs after each merge; anything now conflicting moves to the end and is flagged. `rerere` (enabled locally by `init`) replays a resolution across the rest of a merge train automatically. Dry run exit codes: `0` clean, `1` conflicts (route to `resolve-conflicts`, never merge), `≥2` unspecified failure (STOP, show raw output). Runs entirely in memory — no working tree, index, or HEAD touched — which is why `merge` never trusts GitHub's `mergeable` field alone (`UNKNOWN` while GitHub recomputes is common).

### 7.6 The ruling ledger

One append-only table per epic, one row per autonomous judgment call (a stream split, a trivial-conflict resolution, a link-mode fallback). Every skill that wrote rows prints them in its summary; `merge` includes the epic's rows in the PR comment so a reviewer sees exactly what was decided without asking.

### 7.7 `conflict-resolver` autonomy

**May resolve** (within ≤10 files / ≤20 hunks / no protected path / ≤20 rebase commits): identical-sides, additive-list, formatting-only, regenerable-artifact, rerere-replayed. Each is verified by lint+test before anything pushes. **Must stop, always**: the same function/signature/condition/constant changed on both sides; conflicting test expectations; migrations; anything under `protected_paths`, `**/auth/**`, `**/security/**`, or `secrets_globs`; anything the resolver can't place or explain in one sentence. **Never, ever**: `--force` (only `--force-with-lease` on a workflow-created branch); `rebase --skip`; `checkout --ours/--theirs` on a semantic conflict; deleting one side's code to "resolve"; continuing a rebase before tests pass.

## 8. Stack-agnosticism and the host layer

### 8.1 The profile is the only source of stack knowledge

No skill, agent, hook, or script outside `references/stack-matrix.md`, `scripts/detect/*`, `assets/project-hooks/*`, and `tests/` may hardcode a stack-specific command. Everything reads `profile.commands.*` via `profile_get`/`profile_cmd` in `lib/state.sh`. `tests/lint.sh` enforces this with a grep denylist. A `null` command slot is a decision, not a gap — the gate is skipped and reported as skipped, never guessed or treated as passing.

### 8.2 User overrides

One mechanism: the `overrides` object in `project-profile.json`, deep-merged over detected values at every read, preserved verbatim by `scan --refresh`. There is deliberately no second config file — policy lives in `config.json`, facts and fact-overrides live in `project-profile.json`.

### 8.3 Host verb contract (GitHub now, GitLab-ready)

Every host interaction goes through one dispatcher: `bash scripts/host.sh <verb> [args]` → `scripts/host/<host>/<verb>.sh`, selected by `config.host` (default `github`). Skills never call `gh` directly — `tests/lint.sh` greps for bare `gh ` outside `scripts/host/github/` and fails the build (the one allowlisted exception is `status prs`, a read-only one-liner).

| Verb | Output |
|---|---|
| `caps` | `{native_parent, native_blocked_by, native_sub_issue_edit, sub_issues_api}` |
| `repo-info` | `{host, owner, name, default_branch, remote}` — non-zero on non-host or self-repo remote |
| `milestone` | `list\|ensure <title> [due]\|close <title>` → `{number,title,state,open_issues}` |
| `issue-create` | `{number,url}` |
| `issue-find` | `[{number,url,title,state}]` |
| `issue-link` | `{mode:"native\|rest\|checklist"}` |
| `issue-close` | `{number,state}` |
| `pr-create` | `{number,url}` |
| `pr-state` | one JSON blob with everything `merge` needs |
| `pr-merge` | `{merged:bool,sha}` |

Every implementation of a verb must produce the same shape. Adding GitLab means `references/gitlab.md` + `scripts/host/gitlab/*.sh` implementing the same ten verbs with `glab`, plus `"host":"gitlab"` — nothing in the skills changes. Everything GitHub-specific (closing keywords, `mergeStateStatus` values, sub-issue REST shapes, rate limits) is documented in `references/github.md`.

## 9. Key decisions a contributor should not "fix"

| Decision | Reasoning |
|---|---|
| `gh` capability is feature-probed (`gh issue create --help \| grep -q -- '--parent'`), never version-compared | `gh` ships flags ahead of documented version bumps; probing is cached in `runtime/host-caps.json` and refreshed weekly, with a native → REST → checklist fallback ladder |
| `allowed-tools` omitted on every dispatching skill | The subagent-dispatch tool's name in the restriction grammar is version-sensitive; an incomplete allowlist silently disables dispatch. Safety comes from `guard-bash.sh`, not a tool allowlist |
| The native `EnterWorktree`/`claude --worktree` mechanism is not used | It creates `.claude/worktrees/<name>` on branches with no issue number, invisible to this plugin's state. The plugin owns `.worktrees/` entirely; `cleanup` only ever touches `config.worktree_dir` |
| `.worktrees/` goes in the tracked `.gitignore`, not `.git/info/exclude` | It's a documented, team-wide convention — CI checkouts benefit too. Falls back to `.git/info/exclude` only if `.gitignore` is unwritable |
| Everything under `.claude/agentic/` except `runtime/` is committed | Epics, tasks, profile, config and the ledger are project history that belongs in code review; `runtime/` is per-machine and would conflict constantly if shared |
| The 10-task epic cap is enforced by STOPping with a split proposal, never by truncating | Two independent prior-art projects converged on this ceiling independently as the best guard against unreviewable issue dumps; overridable via `config.max_tasks_per_epic` |
| Windows is out of scope for 0.1.0 | Every script is bash+jq; a Windows port would need a polyshell wrapper and extensionless hook names — a contained, additive change if demand appears |
| `adopt`'s three generated project-agent names (`test-runner`, `code-reviewer`, `refactorer`) are deliberately distinct from the plugin's six agent names | Project `.claude/agents/` overrides plugin agents by name; a collision would silently shadow the plugin's own `implementer`/`reviewer`/etc. |
| A Stop hook running the full test suite ships **off** by default | The single fastest way to get a plugin uninstalled is an every-turn hook slower than a few hundred ms; the real gate is `/agentic-git:pr` |

## 10. Build order

1. `.claude-plugin/*`, `LICENSE`, `.gitignore`, stub `README.md` → `claude plugin validate --strict .` passes empty.
2. `scripts/lib/{common,state,json}.sh` + `tests/lint.sh`.
3. `hooks/hooks.json` + the two hook scripts + `tests/smoke.sh` items 1-6 — safety lands before anything that could do damage.
4. `references/conventions.md` + `scripts/state/init-state.sh` + `skills/init` + `scripts/validate/doctor.sh` + `skills/doctor`.
5. `scripts/detect/*` + `references/stack-matrix.md` + `agents/project-scanner.md` + `skills/scan`.
6. `assets/project-hooks/*` + `references/templates/{claude-md-section,agents/*}` + `skills/adopt` + smoke items 7-8.
7. `scripts/host/github/*` + `scripts/host.sh` + `references/github.md`.
8. `agents/workflow-planner.md` + `skills/plan` + `skills/sync` + `scripts/state/{next,blocked,status,epic-progress,ledger}.sh` + `skills/status`.
9. `scripts/git/*` + `skills/start` + `agents/implementer.md` + `scripts/state/{streams,lock}.sh` + `skills/work` + `references/parallelism.md`.
10. `skills/pr` + `agents/reviewer.md` + `skills/review`.
11. `scripts/git/{mergecheck,conflict-classify}.sh` + `agents/conflict-resolver.md` + `skills/resolve-conflicts` + `references/conflicts.md`.
12. `agents/integration-manager.md` + `skills/merge` + `skills/cleanup` + `scripts/git/clean-gone.sh`.
13. `README.md` (full) + `docs/*` + `.github/workflows/ci.yml` + the manual acceptance run → tag `v0.1.0`.

Each step is independently testable and leaves the plugin installable.
