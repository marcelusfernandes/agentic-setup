# Native Codex plugin distribution

The native plugin packages the same `autonomous-loop` skill as the local installer.
It does not include the Claude plugin, hooks, CI or project settings. Requires Node.js
22.18+, Git, authenticated `gh`, and Codex plugin support; CLI commands below were
checked with Codex 0.153.4. No MCP server, API key or runtime dependency is added.

## Install and start

After this distribution is available on `main`:

```sh
codex plugin marketplace add marcelusfernandes/agentic-setup --ref main
codex plugin add agentic-setup@agentic-setup
```

For a checked-out development branch, use its absolute directory instead of GitHub:

```sh
codex plugin marketplace add /path/to/agentic-setup
codex plugin add agentic-setup@agentic-setup
```

Both sources declare the same marketplace name. Select one source per environment;
inspect `codex plugin marketplace list` before replacing an existing registration.
The explicit repository marketplace is not the implicitly discovered personal one.
Installing intentionally registers a marketplace and writes Codex's plugin cache and
installation settings, but does not modify the target project's files or grant it
publication, merge, production, model or spending authority.

Open the target project and start a new Codex thread. Invoke
`$agentic-setup:autonomous-loop` and provide the outcome, success criteria, boundaries,
GitHub decision maker and separate publication/merge permissions described in the
[README](../README.md), substituting this namespaced invocation for the local
`$autonomous-loop` name. Installation alone starts no objective. Do not load the plugin
and a project-local copy for the same objective; reconcile existing project instructions
deliberately. Claude remains a separate opt-in controller.

## Locate helpers and update

Plugin resources live in Codex's cache, not the target project's `.agents` directory.
Ask Codex to use the helper relative to the loaded skill, as `SKILL.md` instructs.
For manual headless use, obtain `installedPath` from the JSON installation result and
use `<installedPath>/skills/autonomous-loop/scripts/run.mts` from the target repo.
Never hardcode a cache version. The README's `.agents/...` runner command applies only
to project-local installation; that alternative remains available unchanged.

```sh
codex plugin marketplace upgrade agentic-setup
codex plugin add agentic-setup@agentic-setup --json
```

Upgrade refreshes a configured Git source, then installation picks up the published
plugin version. For a local development source, refresh its files and reinstall instead.
Start a new thread after updating. Review the changes before updating; a plugin update
does not authorize new work or change an existing objective's boundaries.

## Maintain the package

`.agents/skills/autonomous-loop/` remains the maintained source. The regular files under
`plugins/agentic-setup/skills/autonomous-loop/` are its distributable snapshot, not a
second implementation. The isolated root avoids default discovery of Claude's `skills/`
and hooks. It also includes the repository license; no symlinks or source-root imports.

```sh
npm run sync:codex-plugin
npm run check:codex-plugin
npm test
npm run check
```

The check and default tests reject snapshot drift, missing files and unexpected payloads.
Sync refuses unsafe symlinks and unexpected files rather than deleting them. Edit the
maintained source, synchronize the snapshot, and include both in the same PR. For a
published update, choose a new semantic version in the plugin manifest so consumers do
not retain an old cache. Local-development cachebusting/reinstallation should use the
Plugin Creator update helpers, not edits to users' marketplace registrations.

Automated tests validate packaging and relocated real scripts without requiring Codex
on CI. Native CLI installation and skill discovery are a separate smoke test; they do
not prove live model planning, GitHub approvals or end-to-end objective completion.

This repository-backed marketplace is not a listing in OpenAI's universal directory.
Public-directory submission and workspace-admin import are separate authorized actions.
See the official [plugin overview](https://learn.chatgpt.com/docs/build-plugins) and
[GitHub marketplace distribution](https://learn.chatgpt.com/docs/enterprise/plugin-management).
