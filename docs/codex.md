# Codex loop: migration and validation

The product is a continuing objective loop: plan, specify, implement, review, reconcile.
Human checkpoints protect consequential decisions and persist across restarts. The
maintained operating contract is the skill's
[reference](../.agents/skills/autonomous-loop/references/contract.md); do not duplicate it
in global/project instructions or agent role files.

For a guided introduction, open the [offline visual workflow](workflow-visual.html)
in a browser. It explains the Codex lifecycle, GitHub status labels and record hierarchy
alongside the separate legacy Claude installation route.

## Runtime boundaries

The [native Codex plugin](codex-plugin.md) distributes the same skill in an isolated
package. Its helpers resolve resources relative to the loaded skill in Codex's cache;
they still operate on the target repository's Git/GitHub state. The project-local
installer below remains an alternative, not a prerequisite for plugin use.

- `.agents/skills/autonomous-loop/SKILL.md` gives Codex the decision procedure. The main
  agent may implement; independent review uses another context. Parallel writers are
  deferred until sequential behavior and measured benefit justify them.
- `scripts/github.mts` inside the skill computes state and gates claim, merge and finish.
  Its authorized `labels` command projects that state onto GitHub issues/PRs without using
  labels as authority. It replaces the Claude scheduler, slug locks and PID-based recovery.
  It does not execute arbitrary validation commands supplied in issues.
- `scripts/run.mts` inside the skill provides optional bounded headless execution and
  usage logs. Codex owns planning/implementation; the runner owns process sequencing,
  result validation and external waits. It is not a scheduler or a second state store.
- `scripts/setup-codex.mts` copies the self-contained skill into a target repo. It makes
  no GitHub or global configuration changes and preserves existing project instructions.
- `plugins/agentic-setup/` is the native distribution snapshot, checked against the
  maintained source by `scripts/sync-codex-plugin.mts --check` and the test suite.

The unit of progress is an objective/task, not a fixed number of agent roles or commits.
Specification grows only as needed for the next task. Documentation belongs in the same
change. Native CI and review remain mandatory for autonomous merge **on this route**:
`land` requires an approved, non-draft PR into the objective's integration branch, a
base-branch ruleset carrying both required status checks and a required approving review
with stale approvals dismissed, every required check in bucket `pass`, and the merge pinned
to the reviewed head with `--match-head-commit`; any one of those missing is a refusal, not
a downgrade. That gate is this route's and not the repository's — the Claude route's
`scripts/land.mts` binds an isolated agent's verdict to the reviewed commit instead, and
asks for a server-side approving review only in its opt-in `approved` mode
([workflow.md](workflow.md)). Custom scope lint and negative control are optional project
policy, not universal prerequisites.

Keep titles descriptive; show workflow status with `state:*` labels and use checkboxes only
for acceptance criteria. The coordinator runs `labels <objective>` on resume and after
durable transitions, including completion. `status` and runner preflight remain read-only;
there is no background label polling. Classification labels are selected by the coordinator,
not inferred from titles. The contract defines managed states and human-label ownership.
Human requests have two exclusive states: `human:pending` (bare `human` is its legacy alias)
pauses the affected work; `human:decided` records that a person decided and never blocks.
On checkpoint issues the workflow moves between them from the recorded answer; on
objectives/tasks/PRs only a person does, and the decided label stays as the audit trail.
The runner stops for unresolved human requests without a model call. Starting a loop grants
routine publication/validated merge by default; record it once in the objective, preserving
explicit restrictions. Fix technical failures autonomously instead of asking for each merge.

The runner honors the chosen Codex configuration/profile, including its sandbox. The
operator must verify that authenticated GitHub/Git access and repository writes work
inside that environment; a successful host-side status call does not verify child
sandbox access. It neither enables network access nor loosens approval settings.

Repair-attempt budgets and session ownership checks remain agent procedures backed by
task evidence. The runner enforces invocation limits and state-based stopping gates,
not a hard token cap, distributed ownership or proof of correct model reasoning.

An objective can pin an existing `Integration branch` for a test-branch pilot. Claims,
PR completion and landing use that branch; its rules still govern automatic merge.
There is no fallback to the default branch when the named destination is unavailable.

## Migration boundary

The README presents the two routes as peers; the local installation entrypoint described
here is the Codex one. The Claude package is retained as an opt-in compatibility surface:
`agents/`, `skills/`, `hooks/`, the
original `scripts/{init,claim,reconcile,land}.mts`, and their templates/tests. Do not mix
the two orchestration procedures within one objective. The Codex installer does not
copy or invoke the old runtime. The two routes may be installed in the same repository, and
neither takes a task the other holds: each publishes a branch as that task's lock —
`codex/task-<n>` here, `<type>/<n>-<slug>` on the Claude route — and each reads both shapes
on the remote before claiming, reporting `{ held }` instead of pushing. `land` here also
refuses a task the Claude shape holds, and `scripts/reconcile.mts` there marks such an issue
`foreignLock` so the Claude loop neither resumes, reviews nor lands it. Preservation is an
explicit compatibility commitment, not a requirement to add every new feature to both
runtimes.

Existing GitHub required-check settings cannot be changed safely by only deleting their
workflow files. This repository therefore retains its current workflows. Before using
the new task format here, migrate those requirements with the repository owner, or keep
the old issue contract for the transition. Retiring any Claude components requires a
separate maintainer decision; successful Codex adoption alone is not permission to remove them.

For existing adopters, the helper also accepts a single legacy `Blocked by:` dependency
line, and reads a `## Proof` section as the task's `## Validation`, so one heading is
enough on both routes. This permits retaining the existing issue CI and its Context/Proof/Files sections
without importing the old scheduler or changing server requirements during a pilot.

An existing untracked `AGENTS.md` or `.codex` directory belongs to the user. The installer
reports existing instructions so they can be reconciled rather than overwriting them.
It does not install model names, expand permissions or enable unrelated MCP servers.

The installer refuses symbolic links anywhere in its planned destination paths,
including during `--dry-run` and `--force`, so a repository-local setup cannot write
through `.agents` or another destination into an external path.

## What automated validation establishes

`tests/codex-loop.test.mts` executes the real GitHub helper and headless runner. It uses
a real local remote, creates the canonical task branch, implements a small change, runs
its acceptance test and pushes it. Controlled `gh` responses then exercise review,
server protection, merge and objective closure. Separate process invocations exercise
restart recovery. Controlled `codex` events exercise continuation, token accounting,
waiting without model calls, execution limits and unverified completion rejection.

The tests cover pending/closed checkpoints, full multiline decision conditions, wrong
decision authors, revision invalidation, PRs merged into the wrong base branch,
independent work while another task waits, downstream blocking, duplicate claims, default
branch advancement, retry branches, incomplete specifications and cancelled work.
Label tests exercise authorized/idempotent writes, current PR failures, checkpoint revisions,
scoped human-request gates and runner waits, the `human:pending`/`human:decided`
transitions on checkpoints and their inert decided state elsewhere, preservation of unrelated labels/titles and
recovery from partial API failure. Fake status or
approval labels do not satisfy the original execution and merge gates.
Installer tests verify previews, self-contained installation, repeated installation and
preservation of user instructions/settings. `tests/coexistence.test.mts` runs both real
installers in both orders and verifies the other route's instructions, skill files,
settings, hooks and CI remain byte-identical, including dry-run/repeat/force cases.
Existing legacy tests remain part of `npm test`.

These fixtures prove mechanics, not LLM planning quality or live GitHub policy behavior.
Before broad rollout, run a small authorized objective in a disposable GitHub repository:
request one material decision, answer it, interrupt/resume a task, review and merge, then
verify the objective evidence. Compare token usage, latency and repair rounds with a
single-task baseline. Do not claim a percentage cost improvement from text length alone.

## Platform references

- [Codex skills](https://learn.chatgpt.com/docs/build-skills): progressive disclosure and
  reusable workflow instructions.
- [Non-interactive Codex](https://learn.chatgpt.com/docs/non-interactive-mode): JSONL events,
  structured final results and native authentication.
- [Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing): environment permissions
  must allow the intended operations; the runner does not override them.
- [Managed worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees): app-managed
  isolation; CLI-created worktrees still need explicit lifecycle ownership.
- [GitHub merge command](https://cli.github.com/manual/gh_pr_merge): pinning a merge to
  the expected head commit.
