<!-- BEGIN agentic-git -->
## Agentic Git Workflow

This project uses the [agentic-git](https://github.com/marcelusfernandes/agentic-setup) plugin:
goals become epics, epics become GitHub issues with real `blocked-by` dependencies, units of
work happen in git worktrees, independent slices run as parallel implementer agents with
disjoint file ownership, and everything lands through reviewed, conflict-checked PRs.

### Stack commands

Detected by `/agentic-git:scan` and stored in `.claude/agentic/project-profile.json`. A command
shown as `null` means that gate is **intentionally skipped** for this project (see the
`overrides` block in the profile to set it) — never guessed.

| Slot | Command |
|---|---|
| install | `{{commands.install}}` |
| build | `{{commands.build}}` |
| test | `{{commands.test}}` |
| test (single file) | `{{commands.test_file}}` |
| lint | `{{commands.lint}}` |
| lint (fix) | `{{commands.lint_fix}}` |
| format | `{{commands.format}}` |
| format (all) | `{{commands.format_all}}` |
| typecheck | `{{commands.typecheck}}` |

### Conventions

- **Base branch**: `{{base_branch}}`.
- **Branches**: `{{branch_template}}` for a task, `{{epic_branch_template}}` for a shared epic.
- **Commits**: `{{commit_template}}`.
- **Worktrees**: all work happens under `{{worktree_dir}}/` — never edit the main checkout
  directly while a task is in progress.

### Skills

| Skill | What it does |
|---|---|
| `/agentic-git:init` | One-time setup: prereqs, state tree, git config, labels. |
| `/agentic-git:scan` | Detect the stack and write `project-profile.json`. |
| `/agentic-git:adopt` | Generate/adapt `.claude/agents`, hooks, and this CLAUDE.md section. |
| `/agentic-git:doctor` | Diagnose the install and print exact fixes. |
| `/agentic-git:plan` | Turn a goal into a local epic with tasks and dependencies. |
| `/agentic-git:sync` | Push the epic to GitHub as issues with real parent/blocked-by links. |
| `/agentic-git:start` | Create the branch + worktree for an issue or epic. |
| `/agentic-git:work` | Decompose an issue into streams and dispatch parallel implementers. |
| `/agentic-git:status` | Read-only dashboard: epic, next, blocked, streams. |
| `/agentic-git:pr` | Run gates, push, and open the PR with `Closes #N`. |
| `/agentic-git:review` | Dispatch reviewer agents over a PR diff. |
| `/agentic-git:merge` | Preflight (merge-tree, CI, review) then merge and clean up. |
| `/agentic-git:resolve-conflicts` | Rebase, classify, auto-resolve trivial conflicts; stop on semantic ones. |
| `/agentic-git:cleanup` | Prune gone branches/worktrees, archive completed epics. |

### Rules

- All work happens inside `{{worktree_dir}}/`, never in the main checkout.
- `git push --force`, `git branch -D`, `git reset --hard`, and `git clean -fdx` are never run
  automatically — only `--force-with-lease` on a branch the workflow itself created, and only
  after explicit confirmation.
- Merge conflicts always **stop for human review** — nothing beyond trivial, mechanical hunks
  is auto-resolved.
- A `null` command in `project-profile.json` means that gate is intentionally skipped, not
  broken — re-run `/agentic-git:scan --refresh` or edit `overrides` to fix it.
<!-- END agentic-git -->
