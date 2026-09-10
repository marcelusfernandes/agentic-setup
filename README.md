# agentic-setup

A Codex setup for autonomous planning, specification and implementation, with durable
human checkpoints for consequential decisions.

Keep one authorized objective moving: plan the next useful task, specify it, implement,
review, validate and reconcile. Continue until its success criteria are met or a real
decision or blocker needs the user. GitHub holds the plan and evidence across restarts.
Status appears in GitHub labels, not `[ ]` or status prefixes in issue/PR titles.
The coordinator reconciles labels after durable transitions; evidence and explicit human
permissions remain authoritative. Starting the loop grants routine publication and validated
merge within its boundaries unless you restrict them. `human` pauses affected work for
decisions, not every PR. Acceptance criteria may still use checkboxes.

The default is one coordinator and one implementation at a time. No local task database,
PID-based cleanup, mandatory milestones, scope globs or fixed cast of agent roles.

## Choose a workflow

Codex is the primary route below. The [Claude Code plugin](docs/legacy-claude.md)
remains a supported installation option with its existing runtime, hooks, labels and
contracts. These routes coexist in the repository; neither installer runs the other.
Choose one coordinator per objective and never run both against the same work.
Keeping Claude available does not require feature parity with Codex. Removing it would
require a separate maintainer decision, not an automatic migration cleanup.

Open the [self-contained visual guide](docs/workflow-visual.html) in a browser for
the lifecycle, milestone/issue/PR relationships, route-specific labels and human
checkpoints. It works offline and includes installation and starter prompts.

## Install as a Codex plugin

With Node.js 22.18+, Git, authenticated `gh` and a Codex CLI with plugin support:

```sh
codex plugin marketplace add marcelusfernandes/agentic-setup --ref main
codex plugin add agentic-setup@agentic-setup
```

Start a new Codex thread in the target project and invoke `$agentic-setup:autonomous-loop`.
It loads from Codex's cache without copying instructions or
settings into the project. Authorize an objective explicitly using the prompt below.
See [plugin distribution](docs/codex-plugin.md) for local preview, updates, helper paths
and coexistence with existing installations. The native plugin does not load Claude.

## Alternative: project-local installation

Requires Node.js 22.18+, Git, authenticated `gh` and Codex with project skills.
The optional headless runner uses `codex exec` with JSON events and an output schema;
its flags were checked against Codex CLI 0.153.2.

From this checkout:

```sh
node scripts/setup-codex.mts --target /path/to/repo --dry-run
node scripts/setup-codex.mts --target /path/to/repo
```

This installs the self-contained `.agents/skills/autonomous-loop/` and adds a small
`AGENTS.md` only if absent. Existing instructions, `.codex`, hooks, CI and GitHub settings
are preserved. Review any existing workflow instructions before mixing them with this
loop. Conflicting skill files stop installation; `--force` replaces only those distributed
skill files, never an existing `AGENTS.md`.
Symbolic links in planned destination paths are refused before any installation writes,
including with `--force`.

Fill in the project's actual validation commands. With project-local installation,
ask the following; for the plugin, replace `$autonomous-loop` with
`$agentic-setup:autonomous-loop`:

```text
Use $autonomous-loop to achieve <observable outcome>.
Success criteria: <evidence>.
Boundaries: <scope, constraints, non-goals>.
Publishing issues/branches/PRs and merging after validation and review are authorized.
Pause affected work for human decisions; continue independent tasks.
Human decision maker: @my-github-login.
```

The skill creates the authorized GitHub objective and works from it. To resume, use
`$autonomous-loop` with the same objective issue number.

## Optional headless loop

With project-local installation, from the target repository:

```sh
node .agents/skills/autonomous-loop/scripts/run.mts 123 --max-turns 12
```

With plugin installation, use the loaded skill's `scripts/run.mts` instead; see
[cache-relative execution](docs/codex-plugin.md#locate-helpers-and-update).

Each invocation advances bounded Codex transitions, reconciles GitHub and stops on a
human/CI wait, blocker, completion or execution limit. Resume the same command after
external state changes, manually or through your existing scheduler. Waiting does not
repeatedly call the model. This runner is not a daemon or scheduler.

Use `--profile name` for an existing Codex profile. The runner does not override sandbox,
approval or model settings. Configure the chosen environment for the required repository
writes and authenticated GitHub/Git access; sandboxed execution does not automatically
inherit the host's network access. Test a read-only GitHub operation from Codex in that
environment before unattended use. A host-side reconciliation succeeds only for the host,
not necessarily for the child sandbox. Do not disable protections just to make it run.

Run logs live under Git's metadata directory in `agentic-runs/`, outside tracked files.
The summary records CLI invocations, duration and available input/cached/output token
counts. Cached input is part of input, not an extra charge to add again. The turn limit
is not a hard token/spending cap. Logs may contain sensitive task/tool content.

## Human checkpoints and merge safety

Important product/scope choices, irreversible architecture, production/data operations
and additional cost/access require a checkpoint. Routine implementation stays autonomous.
An explicit human answer is attached to the decision revision and returned with its full
conditions and source. Silence, closing an issue and the agent's recommendation are not
approval. Accepted decisions survive restarts while their question and authority remain
unchanged.

Record publication and merge authority once when starting the objective; do not ask again
for each routine PR. A `human` label on the objective pauses all work; on a task or its PR,
it pauses that task and dependents. Convert the request into a durable checkpoint and apply
the real answer before removing the originating label. Explicit user restrictions still apply.

Automatic merge requires that standing permission, a separate GitHub review,
required passing server checks and stale-approval dismissal. The merge is pinned to the
reviewed commit. If that policy is unavailable, automatic merge stops; no fallback bypass.
The setup does not provide an identity security boundary when agent and human share
credentials. Use separate execution/reviewer identities for stronger isolation.

Read the [operating contract](.agents/skills/autonomous-loop/references/contract.md) for
issue formats, checkpoint answers and ownership rules.

To pilot on an existing test branch, record its exact name under the objective's
`Integration branch` section. Claims and PRs then target that branch, not main. The same
review and required-check protections still apply. A milestone can group the pilot's issues.

## Development and migration

```sh
npm test
npm run check
```

Tests execute the real helper and runner against local Git repositories and controlled
GitHub/Codex CLI fixtures. They validate mechanics, not live LLM planning or GitHub policy.
See [migration and validation](docs/codex.md) for the limits of those tests and the
live end-to-end validation required before broad adoption.

The installer coexistence tests exercise both installation orders with actual scripts
and verify the other route's instructions/settings/hooks/CI survive unchanged. Existing
required CI workflows remain intact until their server-side requirements are migrated
deliberately; installing Codex does not perform that migration.

## License

MIT.
