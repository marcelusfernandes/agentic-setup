# Legacy Claude Code plugin

The original Claude workflow remains available during and after the Codex migration. It
is a separate, opt-in installation route, with its own strict issue contract, labels
(sharing the `human:pending`/`human:decided` vocabulary with the Codex route),
hooks and worktree lifecycle. The Codex installer preserves but does not install or
manage these components; the legacy installer likewise preserves local Codex skills,
project instructions and `.codex` settings.

```text
/plugin marketplace add marcelusfernandes/agentic-setup
/plugin install agentic-setup@agentic-setup
/agentic-setup:init --dry-run --milestone "M1 foundation"
/agentic-setup:init --milestone "M1 foundation"
/agentic-setup:orchestrate
```

This workflow runs the orchestrator's loop across every open milestone, stopping only for
the closed list of reasons in [orchestration.md](orchestration.md#stop-reasons); for an
unattended run with no person watching the session, see
[orchestration.md](orchestration.md#headless). Its contracts are
[workflow](workflow.md), [orchestration](orchestration.md) and [decisions](decisions.md).
It requires Node 22.18+, Git and authenticated `gh`. The old installer copies its CI
and templates, installs its git hook and configures labels and repository settings.

For the new continuing Codex loop with human decision checkpoints, follow the root
[README](../README.md). Both routes can coexist in one repository, but only one
coordinator may own a given objective. Do not infer feature parity: a new Codex behavior
does not change the Claude route unless its own contract, implementation and tests do so.
