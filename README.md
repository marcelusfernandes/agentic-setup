# agentic-setup

Autonomous planning, specification and implementation on top of GitHub, with durable
human checkpoints for the decisions that deserve a person.

Two routes ship from this repository and are peers: a **Claude Code plugin** and a
**Codex** loop. They share one GitHub vocabulary (`state:`, `type:`, `human:pending` /
`human:decided`), the rule that the plan and the evidence live in GitHub so a restart
loses nothing, and the rule that status is a label — never a `[ ]` or a status prefix in
an issue or PR title. Acceptance criteria may still use checkboxes. The coordinator
reconciles labels after durable transitions; evidence and explicit human permissions
remain authoritative.

The two routes do not share a runtime. Neither installer runs the other, they coexist in
one repository, and one coordinator owns a given task at a time — a rule the two routes now
enforce on each other instead of asking for it. Each publishes a branch as that task's lock,
`<type>/<n>-<slug>` on the Claude route and `codex/task-<n>` on the Codex route, and each
reads **both** shapes on the remote before it claims: `scripts/claim.mts` and the Codex
helper's `claim` report `{ held }` and push nothing when the other's branch is already there.
The refusal outlives the claim — `scripts/reconcile.mts` marks such an issue `foreignLock` so
the Claude loop neither resumes, reviews nor lands it, and the Codex helper's `land` refuses a
task the Claude shape holds. Keeping both available does not imply feature parity; a new
behaviour on one route does not change the other unless its own contract, implementation
and tests do so.

| | Claude Code | Codex |
|---|---|---|
| the loop | milestones → issues → worktrees → PRs: an orchestrator dispatches implementers and a reviewer and merges through `land.mts` | one authorized objective, continued until its success criteria are met or a decision or blocker needs the user |
| install | `/plugin install` ([below](#quick-start--claude-code)) | `codex plugin add` ([below](#quick-start--codex)) |
| what it puts in your repository | GitHub templates, CI checks, a permission deny list, a pre-push hook, labels, optionally a branch ruleset | a self-contained skill directory (project-local install), or nothing at all (plugin) |
| detail | [Claude Code plugin](docs/legacy-claude.md), [orchestration](docs/orchestration.md), [git, issues and PRs](docs/workflow.md) | [migration and validation](docs/codex.md), [plugin distribution](docs/codex-plugin.md), the [operating contract](.agents/skills/autonomous-loop/references/contract.md) |

Open the [self-contained visual guide](docs/workflow-visual.html) in a browser for
the lifecycle, milestone/issue/PR relationships, route-specific labels and human
checkpoints. It works offline and includes installation and starter prompts.

## Prerequisites

Node.js 22.18+, Git and an authenticated `gh`, for either route. There is no build step
and no runtime dependency: the hooks, CI scripts and installers use `node:` built-ins
only. Then the CLI of the route you pick — Claude Code with plugin support, or a Codex
CLI with plugin support.

## Quick start — Claude Code

```text
/plugin marketplace add marcelusfernandes/agentic-setup
/plugin install agentic-setup@agentic-setup
/agentic-setup:init --dry-run --milestone "M1 foundation"
/agentic-setup:init --milestone "M1 foundation" --rules
/agentic-setup:orchestrate
```

1. **Preview first.** `--dry-run` prints the exact report a real run would print and
   changes nothing on disk or on GitHub — no file written, the pre-push hook untouched,
   labels, milestone and ruleset only reported. Read it before dropping the flag.
2. **Apply it.** `--milestone "<title>"` creates the milestone; `--rules` updates the
   branch ruleset that already governs your default branch — whatever it is called — or
   creates one when nothing does, so a pull request is required, squash is the only merge
   method, `scope`, `negative-control` and your own test workflow's check are required,
   and force-push and deletion are blocked. `--rules` on its own never turns a review gate
   on, and is safe to run at any time; `--require-review` is the separate opt-in, and it
   needs a second reviewing identity to exist first or every merge freezes on a repository
   where one identity both merges and would have to approve. Other flags: `--no-gh`
   (offline: skips labels, milestone and ruleset), `--force`, `--ruleset-name <name>`.
   [`skills/init/SKILL.md`](skills/init/SKILL.md) holds the full list and the steps the
   script cannot do for you.
3. **Give the loop something to run.** `init` creates the milestone's title; you write its
   **description** in the one format of `.github/MILESTONE_TEMPLATE.md` (objective, `Out of
   this phase:`, `Exit criteria:` checkboxes, `Depends on:`) — those exit criteria are what
   says the phase is finished. Then open the milestone's **parent issue**, listing its
   sub-issues, and the task issues themselves from `.github/ISSUE_TEMPLATE/task.md`
   (Context, Goal, Acceptance criteria, Proof, Files, Dependencies). The `issue-lint`
   workflow `init` installs checks that contract before an issue is dispatched, and an
   issue's `Files` globs are what the `scope` check enforces on its PR.
4. **Run it.** `/agentic-setup:orchestrate` runs the orchestrator's loop across every open
   milestone — reconcile, dispatch ready issues to implementers in worktrees, review,
   merge, continue — to completion, not one pass, stopping only for the closed list of
   reasons [below](#human-decisions-and-stop-rules).

For an unattended run with nobody watching the session, start Claude Code in print mode
from a local checkout of this plugin:

```bash
claude --plugin-dir <path-to-the-agentic-setup-plugin-checkout> \
  -p "/agentic-setup:orchestrate" \
  --permission-mode acceptEdits \
  --allowedTools Bash Read Edit Write Glob Grep Agent
```

`--plugin-dir` points at a checkout rather than the marketplace install on purpose: it is
what makes `CLAUDE_PLUGIN_ROOT` resolve for every script and hook invocation, and what
loads `hooks/hooks.json` — whose `WorktreeCreate` entry puts each agent's worktree outside
`.claude/`, a path whose protected-path rules denied a headless session's writes outright.
`--permission-mode acceptEdits` accepts file edits without a prompt; what actually keeps
the session from pushing to `main` or writing outside its worktree are the two `PreToolUse`
hooks, not that flag. A turn or time budget is an ordinary flag around the same command
(`--max-turns <n>`, or an external `timeout <seconds>`), never invented by the orchestrator.
[orchestration.md#headless](docs/orchestration.md#headless) explains each flag and the
fallback for a loaded plugin that predates the worktree hook.

## Quick start — Codex

```sh
codex plugin marketplace add marcelusfernandes/agentic-setup --ref main
codex plugin add agentic-setup@agentic-setup
```

Start a new Codex thread in the target project and invoke `$agentic-setup:autonomous-loop`.
It loads from Codex's cache without copying instructions or
settings into the project. Authorize an objective explicitly using the prompt below.
See [plugin distribution](docs/codex-plugin.md) for local preview, updates, helper paths
and coexistence with existing installations. The native plugin does not load Claude.

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
`$autonomous-loop` with the same objective issue number. Installing alone starts no
objective. Starting the loop grants routine publication and validated merge within its
boundaries unless you restrict them; `human` pauses affected work for decisions, not
every PR.

On this route the default is one coordinator and one implementation at a time, with no
local task database, PID-based cleanup, mandatory milestones, scope globs or fixed cast of
agent roles.

### Alternative: project-local installation

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

### Optional headless loop

With project-local installation, from the target repository:

```sh
node .agents/skills/autonomous-loop/scripts/run.mts 123 --max-turns 12
```

The objective's issue number is positional; the only options are `--max-turns <1..100>`
and `--profile <name>`. With plugin installation, use the loaded skill's `scripts/run.mts`
instead — take `installedPath` from the JSON installation result and run
`<installedPath>/skills/autonomous-loop/scripts/run.mts` from the target repository, never
a hardcoded cache version; see
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

## What `init` writes into your repository

Only the Claude route's `init` changes a repository; the Codex plugin writes nothing into
it, and the project-local Codex installer writes only the skill directory named above plus
an `AGENTS.md` when there is none.
`init` is idempotent, and `--dry-run` shows the whole report before anything happens. It:

- copies the GitHub templates into `.github/` — the issue and PR templates,
  `MILESTONE_TEMPLATE.md`, and the `guard-main`, `agentic-checks` and `issue-lint`
  workflows — plus `.worktreeinclude` at the root; a file that already exists is left
  alone unless you pass `--force`;
- copies the plugin's `ci/` into `.github/scripts/agentic/` (`scope-check.mts`,
  `negative-control.mts`, `issue-lint.mts` and their `lib/`). These are plugin-owned and
  always overwritten, so an update reaches CI;
- merges the permission deny list into `.claude/settings.json` as a union — your own
  entries stay;
- installs `hooks/git-pre-push` as `.git/hooks/pre-push`; a pre-push hook it did not write
  is reported, never replaced;
- turns on the repository's `allow_auto_merge` and `delete_branch_on_merge` settings,
  which `land.mts` depends on;
- seeds the `state:`, `type:`, `review:approved`, `human:pending` and `human:decided`
  labels, and the milestone passed to `--milestone` (its title; you write the description).
  An existing bare `human` label is left as found;
- with `--rules` only, updates the branch ruleset that governs the default branch, or
  creates one. Everything that ruleset carried and the installer does not manage — its
  name, conditions, bypass actors, rules of other types — is kept.

What it never touches: your source, your tests and your own workflows; the `scope:` labels
are yours to add. Without `--rules` no rulesets call is made at all, and `--no-gh` skips
labels, milestone and ruleset entirely for an offline run. `AGENTIC_REVIEWER_TOKEN` is
never written anywhere by the installer. Installing this route preserves an existing
Codex installation's skills, project instructions and `.codex` settings, and the Codex
installer likewise preserves this route's instructions, settings, hooks and CI.

## Human decisions and stop rules

`human:pending` on a record means a person must decide before that work continues;
`human:decided` records that a decision was made and is kept as the audit trail — it never
blocks. The two are exclusive and matched by exact name, and neither is an approval in
itself: a label never grants permission. On the Claude route, `reconcile.mts` keeps
`human:pending` issues out of the ready list and `claim.mts` refuses them, and agents never
add, remove or replace `human:decided` — a person does. On the Codex route,
`human:pending` on the objective pauses all work; on a task or its PR it pauses that task
and its dependents, while independent tasks continue.

The Claude orchestrator's loop runs to completion, not one pass, and stops only for three
reasons: no open milestone; every open issue in the milestone is `state:blocked`,
`human:pending` or otherwise waiting on a person — including a `reconcile`/`gh`/`git` call
itself failing, which needs a person rather than a retry; or an explicit turn or time
budget given on the command line is spent. It then comments a summary on the milestone's
parent issue. [orchestration.md#stop-reasons](docs/orchestration.md#stop-reasons) is the
contract.

The Codex runner reports the equivalent in the JSON it prints for each invocation:
`complete`, `waiting_human`, `waiting_ci`, `blocked`, or `limit` when the turn budget is
spent (`blocked` and `limit` exit 2). Resume the same command once the external state has
changed. The [operating contract](.agents/skills/autonomous-loop/references/contract.md)
holds the issue formats, checkpoint answers and ownership rules.

## Human checkpoints and merge safety

Important product/scope choices, irreversible architecture, production/data operations
and additional cost/access require a checkpoint. Routine implementation stays autonomous.
An explicit human answer is attached to the decision revision and returned with its full
conditions and source. Silence, closing an issue and the agent's recommendation are not
approval. Accepted decisions survive restarts while their question and authority remain
unchanged.

Record publication and merge authority once when starting the objective; do not ask again
for each routine PR. A `human:pending` label on the objective pauses all work; on a task or
its PR, it pauses that task and dependents. Convert the request into a durable checkpoint and
apply the real answer; a person then flips the originating label to `human:decided`, which
keeps the intervention traceable without blocking. Explicit user restrictions still apply.

Automatic merge needs that standing permission on both routes, and then the gate of the
route doing the merging. The two gates are not the same, and neither is "the repository's":

**Claude route.** `scripts/land.mts` is the only merge path, and every line it prints — a
refusal, the merge, a queue — names the review mode it ran under. The default mode is
`agent`, and it requires all three of: the `review:approved` label, which the orchestrator
applies from the isolated reviewer's JSON verdict; an `<!-- agentic-reviewed-sha: <oid> -->`
marker comment equal to the head being merged; and every required check in bucket `pass`.
The merge is then pinned to that same head (`--match-head-commit`). A push after the review,
or no marker at all — a label records no commit, so it binds nothing — refuses instead of
merging. A separate GitHub review is the opt-in `approved` mode, never a fallback: it is
selected by `--require-review`, or by a base branch whose rules already require an approving
review, and it adds the server's own `APPROVED` decision *on top of* everything `agent`
requires. That mode costs a second identity, so a repository whose only login is the one
merging freezes at its first merge — which is why it is not the default. `type:docs` is an
exemption from the review, never from the checks. Inside a session a hand-typed `gh pr merge`
is denied outright, with or without `--admin`, by `hooks/protect-main.mts` and by the
permission deny list, while `node scripts/land.mts <pr>` in that same session still merges.
[docs/workflow.md](docs/workflow.md) holds the modes, the gates and every refusal reason.

**Codex route.** The autonomous-loop skill's `github.mts` helper gates on the server
instead: an approved, non-draft pull request into the objective's integration branch, a
base-branch ruleset carrying both required status checks and a required approving review
with stale approvals dismissed, every required check in bucket `pass`, and the merge pinned
to the reviewed head. Without that ruleset it refuses rather than merging — see
[docs/codex.md](docs/codex.md).

Either way, a read that cannot answer is a refusal, not a bypass. The setup does not provide
an identity security boundary when agent and human share credentials. Use separate
execution/reviewer identities for stronger isolation.

To pilot on an existing test branch, record its exact name under the objective's
`Integration branch` section. Claims and PRs then target that branch, not main. The same
review and required-check protections still apply. A milestone can group the pilot's issues.

## What each phase shipped

[`docs/closeout/`](docs/closeout/) holds one file per milestone: the UTC date the
phase closed, the `main` SHA it was true at, and every issue with its pull request
and its merge commit. What is still in flight is the
[open milestones](https://github.com/marcelusfernandes/agentic-setup/milestones?state=open).
This file makes no dated claim about the repository's own state — the closeouts and
the milestone list carry the date, and a paragraph here would not.

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

## Where the detail lives

| doc | what it covers |
|---|---|
| [docs/legacy-claude.md](docs/legacy-claude.md) | the Claude Code route's own page: installation, contracts, coexistence |
| [docs/orchestration.md](docs/orchestration.md) | the orchestrator, roles, stop reasons, decision log, milestone closing, headless, hooks |
| [docs/workflow.md](docs/workflow.md) | branches, milestones, labels, the issue and PR templates, required checks, merge |
| [docs/decisions.md](docs/decisions.md) | the numbered decisions behind the mechanisms, and why each one stands |
| [docs/closeout/](docs/closeout/) | what each phase shipped: one file per milestone, dated, with the merge commit of every issue |
| [docs/adopt.md](docs/adopt.md) | adopting an existing repository: the read-only inventory and the plan issue it can open |
| [docs/codex.md](docs/codex.md) | the Codex route's runtime boundaries, migration boundary and validation limits |
| [docs/codex-plugin.md](docs/codex-plugin.md) | native Codex plugin distribution: install, updates, helper paths, packaging |
| [contract.md](.agents/skills/autonomous-loop/references/contract.md) | the Codex loop's operating contract: issue formats, checkpoint answers, ownership |

## License

MIT.
