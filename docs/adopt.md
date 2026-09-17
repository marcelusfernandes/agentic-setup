# Adopting a repository

`scripts/init.mts` writes first and reports afterwards. That is the right order for a
repository you own and the wrong one for a repository you do not: the first thing
adoption owes an existing project is a description of what is already there.
`scripts/adopt.mts` is that step.

```bash
node scripts/adopt.mts --inventory       # describes the repository, writes nothing
node scripts/adopt.mts --plan-issue      # turns that description into one plan issue
node scripts/adopt.mts --record [--force] # writes the adoption record, and nothing else
```

Run it from inside the repository being adopted (it resolves the root with
`git rev-parse --show-toplevel`). Exactly one of the three flags is required; anything
else prints `{ "error": "usage: …" }` and exits 1 before a single call is made. `--force`
is a modifier of `--record` and never a mode of its own — on its own it is a usage error,
not a silent write.

## `--inventory` writes nothing

`--inventory` prints one JSON object on stdout and **makes no write of any kind**: no
file is created, moved or touched, and every `gh` and `git` call it makes is a read. Four
reads, in this order:

| Read | What it answers |
| --- | --- |
| `gh api repos/{owner}/{repo}` | `defaultBranch`, `autoMerge`, `deleteBranchOnMerge` |
| `gh api repos/{owner}/{repo}/rules/branches/<defaultBranch>` | `ruleset` (the branch's *effective* rules, flattened and enforcement-aware — the same endpoint `scripts/land.mts` gates on, not the ruleset list) |
| `gh label list --json name --limit 200` | `labels`, `labelsTruncated` — one page, asked for explicitly rather than left at `gh`'s default of 30 |
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
  "labelsTruncated": false,
  "hooks": ["pre-push"],
  "workflows": ["agentic-checks.yml", "guard-main.yml", "issue-lint.yml"],
  "autoMerge": true,
  "deleteBranchOnMerge": false,
  "gaps": [],
  "record": null
}
```

- `stack`, `test`, `check`, `source` — `ci/lib/detect.mts`'s answer, verbatim. `test` and
  `check` are `null` when nothing was detected; `source` is `override`, `detected` or `none`.
- `defaultBranch` — the repository's default branch, and the branch whose rules are read.
- `ruleset` — `null` when no rule is in force on that branch, otherwise the flattened
  view above. `null` means *there is none*, never *it could not be read* (see below).
- `labels` — the labels that exist on the repository, sorted: one page of at most 200,
  the limit the read asks for.
- `labelsTruncated` — `true` when that page came back **full**, so the repository may have
  labels this read never saw. `gh` reports neither a total nor a cursor, so a full page is
  the only signal there is, and the field is always present rather than left for a reader
  to infer from `labels.length`. While it is `true`, `labels:missing` is a guess drawn from
  a page: a label reported missing may simply be one beyond it.
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
- `record` — `null` when the repository has no adoption record, otherwise
  `{ "generatedBy": …, "generatedAt": …, "stale": [ … ] }`: who generated the record, when,
  and every field where it and detection now disagree. The record's *values* are
  deliberately not echoed here — the fields above are detection's answer, and detection is
  what the loop follows. A record that exists and is not the shape stops the run
  (`record:…` below); it is never read as "no record".
- `gaps` — the named list below.

### The gap names

A gap is a fact, not a judgement: `--inventory` names it and stops there.

| Gap | Means |
| --- | --- |
| `ruleset:absent` | no rule at all is in force on the default branch |
| `ruleset:review-not-required` | a ruleset exists, but `required_approving_review_count` is 0 — the review gate `scripts/land.mts` reads can never be satisfied |
| `labels:missing` | at least one label of the loop's vocabulary (the `state:`, `type:`, `review:` and `human:` set `scripts/init.mts` seeds) is not on the page the label read returned; read together with `labelsTruncated` |
| `hooks:not-installed` | the `pre-push` hook is absent or is not ours |
| `workflows:missing` | at least one of `agentic-checks.yml`, `guard-main.yml`, `issue-lint.yml` is absent |
| `test-command:none` | no test command was detected and none was overridden — `negative-control` cannot prove anything without one |
| `record:stale` | an adoption record exists and detection no longer agrees with it on at least one field; `record.stale` names them |

## `--plan-issue` asks

`--plan-issue` takes the same inventory and opens **one** issue labelled `human:pending`
(creating that label first if the repository does not have it yet), titled
`Adoption plan: what this repository is missing`. The body renders the inventory, lists
exactly the gaps found as checkboxes — one per gap, each saying what adoption would do
about it — and ends with the raw JSON. Nothing is written to disk: no adoption record, no
file, no setting. What it does change is on GitHub, and there are two things there: the
issue itself, and the `human:pending` label when the repository did not already have it.
Both are named below.

The body carries one warning the JSON carries as a field: when `labelsTruncated` is
`true`, the `Labels:` line says so and names the limit the read asked for, because the
checklist right below it lists the labels adoption would create and that list is drawn
from a page. A person should not tick a box without knowing the list behind it was
complete.

That is the repository's own pattern. `.github/workflows/guard-main.yml` opens exactly
such an issue and deduplicates it by title, and the three readers that honour the label
already exist: `scripts/reconcile.mts` reports it under `humanPending`,
`scripts/claim.mts` refuses to claim it, and the Codex route's `github.mts` pauses on it.
A person reads the issue, ticks what should happen and flips the label to
`human:decided`, which stays as the audit trail.

On success it prints `{ "issue": 7, "url": "…", "gaps": [ … ] }`. `gaps` is the same list
the body's checkboxes were rendered from, `record:stale` included — the JSON a caller
reads and the issue a person reads never disagree.

A second run never opens a second issue. When an open issue with that exact title
already exists it refuses — `{ "refused": "…", "reason": "plan-issue:already-open",
"issue": 7 }`, exit 1 — and makes no `gh issue create` call at all. Close the issue to
get a new one.

A repository with nothing to plan is refused too. When the report names no gap there is
no question to ask — the issue would carry an empty checklist, and a person would have to
open it to find that out — so it prints
`{ "refused": "…", "reason": "plan-issue:nothing-to-plan", "gaps": [] }` and exits 1. That
refusal comes *before* the open-issue search and before the label, so such a run makes no
`gh` call beyond the reads the inventory already did. The list read is `gaps` of the
report, not of the inventory: a `record:stale` repository is whole and still has something
to plan.

## `--record` writes the adoption record

`--record` writes exactly one file, `agentic.config.json`, at the adopted repository's
root. It is the adoption record of [`decisions.md`](decisions.md) item 15: the one place
that says what an adopting repository decided, so the generated workflows, the hooks, the
proof runner and `doctor` read one answer instead of detecting the same facts four times
and drifting apart.

**No person edits this file.** It is generated, and `scripts/lib/adopt/record.mts` is the
only thing that produces it — one writer, one reader, one validator.

```json
{
  "version": 1,
  "stack": "node",
  "commands": { "test": "npm test", "check": "npm run check" },
  "checks": ["negative-control", "scope"],
  "hooks": ["pre-push"],
  "proof": { "dir": "proof" },
  "labels": { "source": "scripts/init.mts" },
  "generatedAt": "2026-09-17T10:04:00.000Z",
  "generatedBy": "agentic-setup/adopt"
}
```

| Field | What it holds |
| --- | --- |
| `version` | the shape's version; `1` today. A reader that does not know a version refuses the file rather than guessing |
| `stack` | `ci/lib/detect.mts`'s stack at the moment of writing |
| `commands.test`, `commands.check` | the commands the loop runs; `null` when nothing was detected and nothing was overridden |
| `checks[]` | the status checks the merge gate requires on the default branch, as the inventory read them from the branch's effective ruleset. Empty when no ruleset is in force |
| `hooks[]` | the hooks of this setup that are installed and carry its marker, as the inventory found them |
| `proof.dir` | where a branch slug declares its proof (`proof/<slug>.json`) |
| `labels.source` | *where* the label vocabulary is defined — a pointer, never a copy. `scripts/init.mts` today; it becomes `labels.json` when that file is the one dictionary |
| `generatedAt` | when the file was generated, ISO 8601 |
| `generatedBy` | what generated it. Anything other than `agentic-setup/adopt` means a person touched it |

Nothing in the record restates a list that already has an owner: `checks[]` and `hooks[]`
are what the inventory read, and `labels.source` names the file the vocabulary lives in
rather than repeating its 15 entries.

### Detection stays the default

The record pins; it does not replace. `ci/lib/detect.mts` still runs on **every** read,
and `--inventory` compares `stack`, `commands.test` and `commands.check` with what
detection says now. Any field where they disagree is reported as the gap `record:stale`
and named in `record.stale`, so the file cannot quietly outlive the repository it
describes. The report's own `stack`, `test` and `check` are always detection's answer,
never the record's.

### Writing, refusing and rewriting

```bash
node scripts/adopt.mts --record           # { "record": "agentic.config.json", "written": true, "changed": [] }
node scripts/adopt.mts --record --force   # rewrites, and reports every field that changed
```

- **No record yet** — it is written, and `changed` is empty. Nothing else on disk is
  touched.
- **A record this tool generated** — it is rewritten, and `changed` lists one
  `{ "field": "commands.test", "from": null, "to": "npm test" }` per field that moved.
  `generatedAt` is never reported as a change: it moves on every write by definition.
- **A record whose `generatedBy` is not this tool** — it is *not* overwritten:
  `{ "refused": "…", "reason": "record:not-ours", "generatedBy": "…" }`, exit 1, the file
  left byte-identical. Someone hand-edited it, and silently discarding that edit would
  hide the very thing worth knowing. `--record --force` is the way past the refusal; it
  regenerates the file and reports `generatedBy` among the changed fields.
- **A record that is not the shape** — an unknown key, a missing required field, a wrong
  type or text that is not JSON — stops the run with a named error and the offending
  field, on `--inventory` as much as on `--record`. It is never repaired in place and
  never defaulted. Delete the file to start again.

## Crash policy: fail closed

Every `git` or `gh` read this script depends on either answers or stops the run:
`{ "error": "<named reason>" }` on stdout, exit 1, nothing written. A field is never
reported as absent because the read for it failed — "there is no ruleset" and "the
ruleset could not be read" are different answers, and a caller acting on the first when
the second is true would remove a protection it never saw. The same rule governs the
filesystem: only `ENOENT` (the file or directory genuinely is not there) reads as
absent, and every other errno — `EACCES` above all — fails closed.

`error` is always one of the names below, never a tool's wording: `gh`'s own first line
is reported alongside it in `detail`, so a caller can branch on the name and still show
the cause.

### What "nothing written" does and does not cover

"Nothing written" above is exact for the filesystem: no run of this script — failing or
succeeding, on any flag — creates, moves or touches a file other than the one
`--record` writes. It is **not** a claim that the run had no effect on GitHub, and two
branches of `--plan-issue` show why:

- **The plan issue itself.** `--plan-issue` is a mutation by design: on success the issue
  exists, and so does the `human:pending` label when the repository did not already have
  it. That is the point of the flag, not an exception to the policy.
- **A `gh issue create` that fails after the label was created.** The label is created
  first, because the issue cannot carry a label that does not exist. When `gh issue
  create` then fails, the run stops with `plan-issue:not-created` and the label is left
  behind — created, and carried by nothing. Nothing on disk changed and no issue was
  opened, but the repository is not byte-for-byte as the run found it. The same holds for
  `plan-issue:unreadable` when the issue was created and its number could not be read back
  from what `gh` printed: there, the issue exists and the script cannot name it. Run
  `--plan-issue` again — the already-open refusal will point at it.

Every other named error below is either reached before any write is attempted, or is that
write itself failing — and no second write follows it. `label:human:pending:not-created`
is the label create that failed, so no issue was opened and no label exists;
`record:not-written` is `agentic.config.json` failing to be written, and the write is a
single `writeFileSync`, not a rename, so a file left half-written by the filesystem is
possible. `--inventory` reports it as `record:unparsable` on the next run rather than
reading it as "no record"; delete the file and run `--record` again.

| `error` | Cause |
| --- | --- |
| `usage: node scripts/adopt.mts --inventory \| --plan-issue \| --record [--force]` | no mode flag, more than one, or `--force` without `--record` |
| `root:not-a-git-repository` | `git rev-parse --show-toplevel` could not answer |
| `repository:unreadable` | the repository read failed, or answered without a default branch or without the two merge settings |
| `ruleset:unreadable` | the branch rules read failed or was not a list |
| `labels:unreadable` | the label list read failed or was not a list |
| `hooks:unreadable` | `git rev-parse --git-path hooks` could not answer, or a hook file exists and could not be read |
| `workflows:unreadable` | `.github/workflows` exists and could not be listed |
| `plan-issue:unreadable` | the open-issue search failed, or the created issue's number could not be read back from what `gh` printed |
| `plan-issue:not-created` | `gh issue create` failed; its first line, when it had one, is in `detail` |
| `label:human:pending:not-created` | the label does not exist and could not be created |
| `record:unreadable` | `agentic.config.json` exists and could not be read |
| `record:unparsable` | it exists and is not JSON |
| `record:unknown-key` | it holds a key the shape does not define; `field` names it |
| `record:missing-field` | a required field is absent; `field` names it |
| `record:wrong-type` | a field is not the type the shape defines, or the file does not hold one JSON object; `field` names it when there is one |
| `record:unknown-version` | its `version` is not the one this reader knows; a future shape is refused, never read with today's rules |
| `record:not-written` | the record could not be written to the repository root |

The `record:*` names carry a `field` alongside `error` whenever the problem has one
(`commands.test`, `proof.dir`, …), so a caller can point at the line rather than the file.

## What this is not

`adopt` performs none of the remedies it lists — the plan issue is a question, and the
answer is a person's. And the record it writes is not a configuration file a person
maintains: invariant 4 still holds, detection remains the default, and the record is its
output, not its replacement.
