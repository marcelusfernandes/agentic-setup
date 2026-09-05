# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to the version in `.claude-plugin/plugin.json`
(kept in lockstep with `.claude-plugin/marketplace.json`).

## [0.1.0] — Unreleased

Initial build of the `agentic-git` plugin.

### Added

- Plugin manifest and single-entry marketplace (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`).
- 14 skills covering setup, planning, execution and integration (`skills/*/SKILL.md`).
- 6 agents: project-scanner, workflow-planner, implementer, reviewer, conflict-resolver, integration-manager (`agents/*.md`).
- Two plugin hooks: `SessionStart` (in-flight-work summary) and `PreToolUse(Bash)` (destructive-command guard), plus their scripts under `scripts/hooks/`.
- Shared shell libraries (`scripts/lib/common.sh`, `json.sh`, `state.sh`) providing bash-3.2/BSD-portable primitives.
- GitHub host layer under `scripts/host/github/`, dispatched via `scripts/host.sh`.
- Stack detection under `scripts/detect/`, state management under `scripts/state/`, git/worktree mechanics under `scripts/git/`, and install/health checks under `scripts/validate/`.
- Project-hook assets copied into adopting projects (`assets/project-hooks/`).
- Reference docs (`references/*`, `references/templates/*`) and user docs (`docs/*`, `README.md`).
- Test suite: `tests/lint.sh` (shellcheck + portability + repo-policy checks), `tests/smoke.sh` and `tests/smoke.d/*.sh`, fixtures under `tests/fixtures/`.
- CI (`.github/workflows/ci.yml`): lint + smoke on `ubuntu-latest`/`macos-latest`, plus `claude plugin validate --strict .`.
