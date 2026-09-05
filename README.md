# agentic-git

![Claude Code 2.1+](https://img.shields.io/badge/Claude%20Code-2.1%2B-blue) ![MIT](https://img.shields.io/badge/license-MIT-green)

`agentic-git` turns a GitHub repository into a machine-operable delivery pipeline: a goal becomes an epic, the epic becomes a parent issue with sub-issues carrying real `blocked-by` dependencies, each unit of work becomes a branch in a git worktree, independent slices of that work run as parallel implementer subagents with disjoint file ownership, and everything lands through PRs that close their issues after a reviewed, conflict-checked merge. It is stack-agnostic — a one-time `scan` writes a machine-readable project profile, and every stack-specific action is read from that profile — and it onboards the project itself, adapting `.claude/agents/*.md`, `.claude/settings.json` hooks and a `CLAUDE.md` section without ever clobbering what is already there.

```
   goal / PRD
       │
       │ /agentic-git:plan
       ▼
   epic.md + tasks/*.md                          (local only, not yet on GitHub)
       │
       │ /agentic-git:sync
       ▼
   milestone ──▶ epic issue #100
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
      #101         #102         #103            (sub-issues, blocked-by links)
        │            │            │
        │ /agentic-git:start (branch + worktree, per task or shared per epic)
        ▼            ▼            ▼
   .worktrees/101   .worktrees/102   ...
        │
        │ /agentic-git:work
        ▼
   stream A ─┐
   stream B ─┼──▶ implementer agents (parallel, disjoint files) ──▶ commits
   stream C ─┘
        │
        │ /agentic-git:pr
        ▼
   PR ── Closes #101, Closes #102 ── Part of #100
        │
        │ /agentic-git:review [--fix]
        ▼
   reviewer agents (parallel) ──▶ findings ──▶ one batched fix pass
        │
        │ /agentic-git:merge
        ▼
   merge-tree dry run ──▶ merge ──▶ close issues ──▶ remove worktree
        │
        ▼
   epic 100% ──▶ /agentic-git:cleanup ──▶ archived
```

## Why

1. **Work doesn't map to issues.** Goals live in chat, PRDs live in docs — GitHub never sees the plan, so dependencies and progress live nowhere machine-readable.
2. **Parallel agents collide.** Running several agents against one codebase without disjoint file ownership means overwritten work and unreviewable diffs.
3. **Every project needs its `.claude/` set up by hand.** Agents, hooks and `CLAUDE.md` conventions get rewritten from scratch for every repo instead of generated from what the repo already is.

`agentic-git` is one plugin covering all three: a state model on disk, a GitHub layer that turns the state model into real issues and links, and a parallel-execution layer with mechanical safety nets (disjoint scopes, locks, merge-tree dry runs) instead of prompt-only promises.

## Install

```
/plugin marketplace add marcelusfernandes/agentic-setup
/plugin install agentic-git@agentic-setup
```

| Prerequisite | Requirement |
|---|---|
| `git` | ≥ 2.38 (needed for `git merge-tree --write-tree`) |
| `gh` | installed and authenticated (`gh auth login`) |
| `jq` | installed — all state is JSON |
| OS | macOS or Linux only in 0.1.0 (Windows is out of scope — see Troubleshooting) |

## Quickstart

```bash
# 0. Install (once per machine)
/plugin marketplace add marcelusfernandes/agentic-setup
/plugin install agentic-git@agentic-setup

# 1. Set up this repository (once per repo)
/agentic-git:init            # prereqs, state dir, rerere+zdiff3, labels, .gitignore
/agentic-git:scan            # detect the stack → .claude/agentic/project-profile.json
/agentic-git:adopt           # generate/adapt .claude/agents, hooks, CLAUDE.md (shows a diff first)
/agentic-git:doctor          # everything green?

# 2. Plan and publish a body of work
/agentic-git:plan "Add OAuth login with Google and GitHub" --milestone v1.2
/agentic-git:sync oauth-login          # → milestone, epic issue #100, sub-issues #101-#106

# 3. Execute
/agentic-git:status next               # which issues are unblocked
/agentic-git:start epic oauth-login    # worktree + branch + install + baseline tests
/agentic-git:work 101                  # decompose into streams, run implementers in parallel

# 4. Land it
/agentic-git:pr 101                    # gates, push, PR with "Closes #101"
/agentic-git:review 45 --fix           # parallel reviewers, one batched fix pass
/agentic-git:merge 45                  # preflight → merge → close issues → remove worktree

# 5. When the epic is done
/agentic-git:merge epic oauth-login    # ordered merge train over the remaining PRs
/agentic-git:cleanup --archive
```

See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for the same sequence with the expected output at every step.

## Português (Brasil)

`agentic-git` transforma um repositório GitHub em um pipeline de entrega operável por máquina: um objetivo vira um épico, o épico vira uma issue-pai com sub-issues com dependências reais (`blocked-by`), cada unidade de trabalho vira um branch em um git worktree, fatias independentes desse trabalho rodam como subagentes implementadores em paralelo com posse exclusiva de arquivos, e tudo chega ao repositório por PRs que fecham suas issues após um merge revisado e checado contra conflitos.

É agnóstico de stack — um `scan` único detecta o projeto e grava um perfil em JSON, e toda ação específica de stack é lida desse perfil — e também configura o projeto: adapta `.claude/agents/*.md`, hooks em `.claude/settings.json` e uma seção em `CLAUDE.md`, sem nunca sobrescrever o que já existe. Instalações e adições são sempre reversíveis via git, e nada é destrutivo sem confirmação explícita.

Pré-requisitos: `git` ≥ 2.38, `gh` autenticado, `jq`. Somente macOS/Linux na versão 0.1.0.

Sequência de início rápido (comandos e caminhos ficam em inglês):

```bash
/plugin marketplace add marcelusfernandes/agentic-setup
/plugin install agentic-git@agentic-setup

/agentic-git:init
/agentic-git:scan
/agentic-git:adopt
/agentic-git:doctor

/agentic-git:plan "Add OAuth login with Google and GitHub" --milestone v1.2
/agentic-git:sync oauth-login

/agentic-git:status next
/agentic-git:start epic oauth-login
/agentic-git:work 101

/agentic-git:pr 101
/agentic-git:review 45 --fix
/agentic-git:merge 45

/agentic-git:merge epic oauth-login
/agentic-git:cleanup --archive
```

Tradução completa deste README: [`docs/README.pt-BR.md`](docs/README.pt-BR.md).

## Commands

| Skill | What it does | When | Writes to GitHub? |
|---|---|---|---|
| `init` | Prereqs, state tree, rerere+zdiff3, `.gitignore`, workflow labels | Once per repo | Yes (labels only) |
| `scan` | Detects stack → `project-profile.json` | After `init`, or when the stack changes (`--refresh`) | No |
| `adopt` | Generates/adapts `.claude/agents`, hooks, `CLAUDE.md` | After `scan` | No |
| `doctor` | Diagnoses install, state, host caps; prints exact fixes | Anytime | No (`--fix` is local only) |
| `plan` | Goal/PRD → local epic + ≤10 tasks with dependency graph | Before `sync` | No |
| `sync` | Pushes epic to GitHub: milestone, epic issue, sub-issues, links | After `plan` | Yes |
| `start` | Branch + worktree + deps + baseline tests for an issue or epic | Before `work` | Yes (label + comment) |
| `work` | Decomposes an issue into file-scoped streams, runs implementers in parallel | After `start` | Yes (progress comment) |
| `status` | Read-only dashboard — epics, `next`, `blocked`, `streams`, `prs` | Anytime | No |
| `pr` | Runs gates, pushes, opens the PR with `Closes #N` | After `work` | Yes |
| `review` | Dispatches reviewer agents, posts one aggregated review, optional fix pass | After `pr` | Yes (review comment) |
| `merge` | Preflight (merge-tree, CI, review) → merge → cleanup → close issues | After `review` | Yes |
| `resolve-conflicts` | Rebases, classifies conflicts, auto-resolves trivial ones, stops on semantic ones | When `pr`/`merge` reports conflicts | Yes (push + PR comment) |
| `cleanup` | Removes gone worktrees/branches, prunes, archives finished epics, closes milestones | After a `merge` or an epic completes | Yes (branch delete, milestone close) |

There is no standalone `milestone` skill — milestones are declared in `epic.md`, ensured by `sync`, reported by `status`, and closed by `cleanup`. Call the underlying script directly any time:

```bash
bash "$CLAUDE_PLUGIN_ROOT"/scripts/host.sh milestone list|ensure|close
```

There is also no standalone `next` skill — it is a mode of `status` (`/agentic-git:status next`).

## What it puts in your project

| Location | Contents | Committed? |
|---|---|---|
| `.claude/agentic/config.json` | Policy defaults (branch templates, merge strategy, autonomy limits) | Yes |
| `.claude/agentic/project-profile.json` | Detected stack + your `overrides` | Yes |
| `.claude/agentic/epics/<slug>/` | `epic.md`, `tasks/*.md`, `mapping.json`, `ledger.md` | Yes |
| `.claude/agentic/hooks/*.sh` | Stack-independent format/secret-guard scripts `adopt` copies in | Yes |
| `.claude/agentic/runtime/` | Host-cap cache, stream state, locks — per-machine | No (git-ignored) |
| `.claude/agents/*.md` | `test-runner`, `code-reviewer`, `refactorer` — generated or adapted | Yes |
| `.claude/settings.json` | Two hook entries merged in (`PostToolUse` format-on-edit, `PreToolUse` secret guard) | Yes |
| `CLAUDE.md` | A sentinel-delimited `<!-- BEGIN agentic-git -->…<!-- END agentic-git -->` block | Yes |
| `.worktrees/` | Git worktrees for in-progress branches | No (git-ignored) |

Existing files are never overwritten: `adopt` merges hook entries by a `agentic/hooks/` marker, appends to agent files inside sentinels, and only ever adds keys `adopt` didn't already see in an agent's frontmatter. `adopt` always shows a diff and asks before writing, unless `--dry-run`.

**To remove everything agentic-git added:**

```bash
git rm -r .claude/agentic .claude/agents/test-runner.md .claude/agents/code-reviewer.md .claude/agents/refactorer.md
# then hand-edit CLAUDE.md and .claude/settings.json to delete the agentic-git sentinel block / hook entries
rm -rf .worktrees
git worktree prune
/plugin uninstall agentic-git
```

Everything it wrote is plain git history — `git revert` the `adopt` commit is equivalent for the config side.

## How parallel work stays safe

- **File-scoped streams.** `work` decomposes an issue into 1–4 streams with disjoint `files[]` globs, verified mechanically by expanding against `git ls-files` and intersecting every pair. Overlap is either merged into one stream or lifted into a `shared` path with exactly one owner.
- **Single-writer shared files.** A non-owner stream never edits a shared path — it appends a request to `runtime/streams/<issue>/requests.jsonl` instead and keeps working its own scope.
- **Post-wave audit.** After every wave, `git status --porcelain` in the worktree is checked against the union of declared scopes. Anything written outside its lane stops the run.
- **`merge-tree` dry runs, always.** Every PR and every step of an epic merge train is checked with `git merge-tree --write-tree` before anything touches history — in-memory, no working tree or index side effects.
- **Conflicts stop for a human.** `resolve-conflicts` only auto-resolves identical-sides, additive-list, formatting-only, regenerable-artifact and rerere-replayed conflicts, under strict file/hunk ceilings. Anything else — the same function changed on both sides, a migration, a protected path — is a hard `STOP:` with the exact recovery commands.
- **The ruling ledger.** Every autonomous judgment call (a stream split, a trivial-conflict resolution, a fallback to checklist linking) is appended as one row to `epics/<slug>/ledger.md` and surfaced in the skill's summary and in the merge PR comment, so a reviewer sees exactly what was decided.

## Configuration

### `config.json` — policy (written once by `init`, never auto-overwritten)

```json
{
  "base_branch": "main",                 // resolved from the default branch at init time
  "protected_branches": ["main", "master", "develop", "release/*"],
  "protected_paths": ["**/migrations/**", ".github/workflows/**", "**/auth/**", "**/security/**"],
  "branch_template": "{type}/{issue}-{slug}",
  "epic_branch_template": "epic/{slug}",
  "worktree_dir": ".worktrees",
  "worktree_link": [".env", ".env.local", ".envrc"],   // untracked files symlinked into each worktree
  "commit_template": "{type}({scope}): {subject} (#{issue})",
  "merge_strategy": "squash",            // squash | merge | rebase
  "delete_branch_on_merge": true,
  "require_review": true,                // merge STOPs unless reviewDecision == APPROVED
  "require_ci": true,                    // merge STOPs unless every check is SUCCESS/NEUTRAL
  "default_reviewers": [],
  "max_tasks_per_epic": 10,              // plan STOPs with a split proposal above this
  "max_parallel_streams": 4,
  "worktree_mode": "auto",               // auto | shared | per-task
  "conflict_autonomy": { "max_files": 10, "max_hunks": 20, "max_rebase_commits": 20 },
  "test_gate_hook": false                // opt in via adopt --enable-test-gate
}
```

Edit it directly — it is committed, plain JSON, and every skill reads it fresh each run.

### `project-profile.json` — detected facts, overridable

Written by `scan`; never hand-edit anything but the `overrides` block, which is deep-merged over every detected value at read time and preserved verbatim by `scan --refresh`:

```json
{
  "overrides": {
    "commands": { "test": "make test-fast", "test_file": "make test-one FILE={file}" },
    "shared_files": ["config/routes.rb"],
    "secrets_globs": ["config/master.key"]
  }
}
```

Full schemas, annotated: [`docs/STATE-MODEL.md`](docs/STATE-MODEL.md).

## Stack support

`scan` detects the stack from manifests, config files and scripts already in the repo — nothing is hardcoded per project. Condensed formatter/linter/typechecker table (full table in `docs/ARCHITECTURE.md`):

| Detected | Format | Lint | Typecheck |
|---|---|---|---|
| Prettier / Biome / ESLint | `prettier --write` / `biome format --write` | `eslint .` / `biome lint .` | `tsc --noEmit` |
| Python (Ruff, Black+isort, mypy/pyright) | `ruff format` / `black && isort` | `ruff check` / `flake8` | `mypy .` / `pyright` |
| Go | `gofmt -w` | `golangci-lint run` / `go vet ./...` | `go build ./...` |
| Rust | `cargo fmt` | `cargo clippy -- -D warnings` | `cargo check` |
| Ruby | `rubocop -a` | `rubocop` | — |
| PHP | `php-cs-fixer fix` | `phpstan analyse` | — |
| Elixir | `mix format` | `mix credo` | `mix dialyzer` |
| Dart/Flutter | `dart format` | `dart analyze` | — |
| Swift | `swiftformat` | `swiftlint` | — |
| Java/Kotlin (Gradle) | `./gradlew spotlessApply` (whole-project only — too slow per-file) | `./gradlew check` | `./gradlew compileJava` |
| C/C++ | `clang-format -i` | `clang-tidy` | — |
| Terraform | `terraform fmt` | `tflint` | `terraform validate` |
| Nothing detected | `null` — gate skipped, never guessed | `null` | `null` |

Not listed, or detected wrong? Set `overrides.commands` in `project-profile.json` — every skill reads through that override, no plugin code change needed.

## Safety

The plugin ships exactly one guard hook (`PreToolUse` on `Bash`), active for **any** agent in the session, not just this plugin's:

| Pattern | Decision |
|---|---|
| `git push --force` / `-f` (not `--force-with-lease`) | **deny** — use `resolve-conflicts`, which uses `--force-with-lease` safely |
| Force push targeting a protected branch, or `git push origin HEAD:main` | **deny** |
| `git worktree remove --force`/`-f` | **ask** |
| `git branch -D` / `--delete --force` | **ask** |
| `rm -rf` targeting `.worktrees/`, `.claude/agentic/`, or `.git/` | **deny** — use `/agentic-git:cleanup` |
| `git reset --hard` in a worktree with uncommitted changes | **ask** |
| Writing into the main checkout's `.git/` from a worktree | **deny** |
| `git clean -xf` | **ask** |
| `gh repo delete`/`archive`, deleting a protected remote branch | **deny** |

Everything else passes silently. The guard fails **open** — a broken hook never blocks your terminal.

**What the plugin will never do, under any circumstance:** `git push --force` (only `--force-with-lease`, only on a branch it created itself); `git branch -D`; `git reset --hard`; `git clean -fdx`; `git rebase --skip`; auto-resolve a semantic merge conflict; `git checkout --ours/--theirs` on anything but a mechanically-verified trivial conflict; `gh pr merge --admin`; auto-approve or auto-request-changes a PR; create issues in its own repository (`marcelusfernandes/agentic-setup`) if you forgot to change `origin`.

## Troubleshooting

Always start with:

```
/agentic-git:doctor
```

It runs every check as one script and prints `OK|WARN|FAIL` plus the exact fix command per line.

| Symptom | Cause | Fix |
|---|---|---|
| `doctor` reports `git_too_old` | `git` < 2.38 — `merge-tree --write-tree` is unavailable | Upgrade git, then re-run `doctor` |
| `init`/`sync`/`pr` STOP on `gh auth` | `gh` not authenticated, or missing the `repo` scope | `gh auth login` / `gh auth refresh -s repo` |
| A gate prints "test: skipped (no command configured)" | `scan` couldn't detect a test command and correctly wrote `null` instead of guessing | Add `overrides.commands.test` in `project-profile.json`, then `doctor` |
| `start` STOPs with a red baseline | Tests already fail on the base branch, before any work started | Fix the baseline first, or type the literal confirmation to proceed anyway (recorded as a ledger ruling) |
| `pr`/`merge` reports the branch conflicts with base | `merge-tree --write-tree` found real conflicts | `/agentic-git:resolve-conflicts <pr-or-branch>` |
| `resolve-conflicts` prints `STOP: N semantic conflicts` | The same logic changed on both sides, or a protected path is involved | This is the designed outcome — resolve by hand at the path shown, then `git add <files> && git rebase --continue` |
| `adopt` refuses to touch an agent file or hook | A sha mismatch against `adopt-manifest.json` — a human edited inside the sentinel block | Answer the per-file prompt; default is "keep yours" |

## Contributing

```bash
bash tests/lint.sh              # shellcheck + bash-3.2 bashism denylist over scripts/ and assets/
bash tests/smoke.sh             # hook + state scripts against fixtures in a throwaway repo
claude plugin validate --strict .
```

All three must pass with zero errors before a PR is opened. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and build order.

## License

MIT — see [`LICENSE`](LICENSE).
