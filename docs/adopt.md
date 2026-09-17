# Adopting a repository

`scripts/init.mts` writes first and reports afterwards. That is the right order for a
repository you own and the wrong one for a repository you do not: the first thing
adoption owes an existing project is a description of what is already there.
`scripts/adopt.mts` is that step.

```bash
node scripts/adopt.mts --inventory     # describes the repository, writes nothing
node scripts/adopt.mts --plan-issue    # turns that description into one plan issue
```

Run it from inside the repository being adopted (it resolves the root with
`git rev-parse --show-toplevel`). Exactly one of the two flags is required; anything
else prints `{ "error": "usage: …" }` and exits 1 before a single call is made.

## `--inventory` writes nothing

`--inventory` prints one JSON object on stdout and **makes no write of any kind**: no
file is created, moved or touched, and every `gh` and `git` call it makes is a read. Four
reads, in this order:

| Read | What it answers |
| --- | --- |
| `gh api repos/{owner}/{repo}` | `defaultBranch`, `autoMerge`, `deleteBranchOnMerge` |
| `gh api repos/{owner}/{repo}/rules/branches/<defaultBranch>` | `ruleset` (the branch's *effective* rules, flattened and enforcement-aware — the same endpoint `scripts/land.mts` gates on, not the ruleset list) |
| `gh label list --json name --limit 200` | `labels` |
| `git rev-parse --git-path hooks` | where `hooks` are looked for — git's answer, not a guess |

Everything else comes off the filesystem under the root: `hooks` and `workflows` by
looking, and `stack`, `test`, `check` and `source` from `ci/lib/detect.mts` unchanged —
`adopt` adds no detector and knows nothing about stacks, so `AGENTIC_TEST_CMD` and
`AGENTIC_CHECK_CMD` override the commands here exactly as they do everywhere else
(`source` then reads `override`).

### The JSON shape

```json
{
  "stack": "node",
  "test": "npm test",
  "check": "npm run check",
  "source": "detected",
  "defaultBranch": "main",
  "ruleset": {
    "rules": ["deletion", "pull_request", "required_status_checks"],
    "requiresPullRequest": true,
    "requiredApprovingReviewCount": 1,
    "requiredStatusChecks": ["scope", "negative-control"]
  },
  "labels": ["human:decided", "human:pending", "state:ready"],
  "hooks": ["pre-push"],
  "workflows": ["agentic-checks.yml", "guard-main.yml", "issue-lint.yml"],
  "autoMerge": true,
  "deleteBranchOnMerge": false,
  "gaps": []
}
```

- `stack`, `test`, `check`, `source` — `ci/lib/detect.mts`'s answer, verbatim. `test` and
  `check` are `null` when nothing was detected; `source` is `override`, `detected` or `none`.
- `defaultBranch` — the repository's default branch, and the branch whose rules are read.
- `ruleset` — `null` when no rule is in force on that branch, otherwise the flattened
  view above. `null` means *there is none*, never *it could not be read* (see below).
- `labels` — every label that exists on the repository, sorted.
- `hooks` — the hooks this setup installs (`pre-push`) that are present **and** carry its
  marker. Someone else's `pre-push` is not ours and is not listed. Where to look is asked
  of git (`git rev-parse --git-path hooks`), the same question `scripts/init.mts` asks
  before it installs the hook, so the hooks reported are the ones git would actually run:
  `core.hooksPath` (husky, lefthook, a shared team directory) is honoured, and so is a
  worktree, whose `.git` is a file and whose hooks live in the common directory. A hook
  sitting in `.git/hooks` that `core.hooksPath` has redirected away from is *not* reported
  as installed — it never runs.
- `workflows` — every `*.yml`/`*.yaml` in `.github/workflows`, sorted; not only ours. A
  missing directory is none; a directory that exists and cannot be listed fails closed.
- `autoMerge`, `deleteBranchOnMerge` — the repository settings `scripts/init.mts` turns
  on and `scripts/land.mts` depends on.
- `gaps` — the named list below.

### The gap names

A gap is a fact, not a judgement: `--inventory` names it and stops there.

| Gap | Means |
| --- | --- |
| `ruleset:absent` | no rule at all is in force on the default branch |
| `ruleset:review-not-required` | a ruleset exists, but `required_approving_review_count` is 0 — the review gate `scripts/land.mts` reads can never be satisfied |
| `labels:missing` | at least one label of the loop's vocabulary (the `state:`, `type:`, `review:` and `human:` set `scripts/init.mts` seeds) does not exist |
| `hooks:not-installed` | the `pre-push` hook is absent or is not ours |
| `workflows:missing` | at least one of `agentic-checks.yml`, `guard-main.yml`, `issue-lint.yml` is absent |
| `test-command:none` | no test command was detected and none was overridden — `negative-control` cannot prove anything without one |

## `--plan-issue` asks

`--plan-issue` takes the same inventory and opens **one** issue labelled `human:pending`
(creating that label first if the repository does not have it yet), titled
`Adoption plan: what this repository is missing`. The body renders the inventory, lists
exactly the gaps found as checkboxes — one per gap, each saying what adoption would do
about it — and ends with the raw JSON. Nothing else is written: no adoption record, no
file, no setting.

That is the repository's own pattern. `.github/workflows/guard-main.yml` opens exactly
such an issue and deduplicates it by title, and the three readers that honour the label
already exist: `scripts/reconcile.mts` reports it under `humanPending`,
`scripts/claim.mts` refuses to claim it, and the Codex route's `github.mts` pauses on it.
A person reads the issue, ticks what should happen and flips the label to
`human:decided`, which stays as the audit trail.

On success it prints `{ "issue": 7, "url": "…", "gaps": [ … ] }`.

A second run never opens a second issue. When an open issue with that exact title
already exists it refuses — `{ "refused": "…", "reason": "plan-issue:already-open",
"issue": 7 }`, exit 1 — and makes no `gh issue create` call at all. Close the issue to
get a new one.

## Crash policy: fail closed

Every `git` or `gh` read this script depends on either answers or stops the run:
`{ "error": "<named reason>" }` on stdout, exit 1, nothing written. A field is never
reported as absent because the read for it failed — "there is no ruleset" and "the
ruleset could not be read" are different answers, and a caller acting on the first when
the second is true would remove a protection it never saw. The same rule governs the
filesystem: only `ENOENT` (the file or directory genuinely is not there) reads as
absent, and every other errno — `EACCES` above all — fails closed.

| `error` | Cause |
| --- | --- |
| `usage: node scripts/adopt.mts --inventory \| --plan-issue` | neither flag, or both |
| `root:not-a-git-repository` | `git rev-parse --show-toplevel` could not answer |
| `repository:unreadable` | the repository read failed, or answered without a default branch or without the two merge settings |
| `ruleset:unreadable` | the branch rules read failed or was not a list |
| `labels:unreadable` | the label list read failed or was not a list |
| `hooks:unreadable` | `git rev-parse --git-path hooks` could not answer, or a hook file exists and could not be read |
| `workflows:unreadable` | `.github/workflows` exists and could not be listed |
| `plan-issue:unreadable` | the open-issue search failed, or the created issue's number could not be read back from what `gh` printed |
| `plan-issue:not-created` | `gh issue create` failed and said nothing of its own |
| `label:human:pending:not-created` | the label does not exist and could not be created |
| *(gh's own first line)* | `gh issue create` failed with a message of its own |

## What this is not

`adopt` reads and writes no adoption record: what an adopting repository decided has no
home yet, because invariant 4 (`AGENTS.md`) says detection is a default and there is no
config file, and changing that is the owner's decision, not this script's. `adopt` also
performs none of the remedies it lists — the plan issue is a question, and the answer is
a person's.
