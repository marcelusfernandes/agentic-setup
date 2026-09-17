# Adopting a repository

`scripts/init.mts` writes first and reports afterwards. That is the right order for a
repository you own and the wrong one for a repository you do not: the first thing
adoption owes an existing project is a description of what is already there.
`scripts/adopt.mts` is that step.

```bash
node scripts/adopt.mts --inventory       # describes the repository, writes nothing
node scripts/adopt.mts --plan-issue      # turns that description into one plan issue
node scripts/adopt.mts --record [--force] # writes the adoption record, and nothing else
node scripts/adopt.mts --workflows       # generates the workflows, and the checks they produce
node scripts/adopt.mts --hooks           # installs the hooks the record names, and reports the rest
node scripts/adopt.mts --pr              # opens the adoption pull request, which proves itself
node scripts/proof.mts <slug>            # runs the proof that slug declares, and reports it
```

Run it from inside the repository being adopted (it resolves the root with
`git rev-parse --show-toplevel`). Exactly one of the `adopt` flags is required; anything
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
| `hooks[]` | the hooks of this setup that are installed and carry its marker, as the inventory found them. `--hooks` reads it back as the set to install |
| `proof.dir` | where a branch slug declares its proof (`proof/<slug>.json`); `scripts/proof.mts` looks there rather than assuming the default |
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

## `--workflows` generates the workflows and the checks they produce

`scripts/init.mts` copies `templates/.github/workflows/**` verbatim, and the adopting
repository is then told to edit `AGENTIC_TEST_CMD` by hand. Meanwhile the check names
`init --rules` puts in the ruleset are computed somewhere else entirely
(`detectTestCheckName`, which reads the repository's *other* workflow files). Two answers
to one question is one answer too many: the workflow and the ruleset can name different
checks and nothing notices.

`--workflows` makes them one answer. It renders the three workflow files from the
adoption record and writes them under the adopted repository's `.github/workflows/`, and
the list of check names it prints is the job list of the file it just rendered — not a
second computation over it.

```bash
node scripts/adopt.mts --workflows
```

```json
{
  "workflows": [
    { "file": ".github/workflows/agentic-checks.yml", "outcome": "created", "reason": "absent",
      "jobs": ["scope", "negative-control", "test", "check"] },
    { "file": ".github/workflows/guard-main.yml", "outcome": "created", "reason": "absent",
      "jobs": ["direct-push"] },
    { "file": ".github/workflows/issue-lint.yml", "outcome": "skipped", "reason": "not-generated",
      "jobs": ["lint"] }
  ],
  "checks": ["scope", "negative-control", "test", "check"],
  "missingFromRuleset": ["test", "check"],
  "gaps": []
}
```

- `checks` — the status checks these files produce on a pull request: the job ids of the
  rendered `agentic-checks.yml`, in file order. This is the list the default branch's
  ruleset must require. The other two workflows run on `push` and on `issues`, so they
  contribute nothing here: requiring a check that never runs on a pull request blocks
  every merge.
- `missingFromRuleset` — the entries of `checks` that the record's `checks[]` (what the
  ruleset requires today, as `--inventory` read it) does not hold. Empty means the
  generated workflows and the live ruleset agree.
- `gaps` — `test-command:none` when the record's `commands.test` is `null`; see below.

### The record is the input, and it is required

The workflows are generated **from** `agentic.config.json`, not from a second detection
run. A repository without a record is refused —
`{ "refused": "…", "reason": "workflows:no-record" }`, exit 1, nothing written — because
detecting again here is how the workflow and the ruleset drifted apart in the first
place. Run `--record` first. A record that is not the shape stops the run with the same
`record:…` error `--inventory` would report.

| Record field | Where it lands |
| --- | --- |
| `commands.test` | the `AGENTIC_TEST_CMD` the `negative-control` job exports, and the `run:` of a generated `test` job |
| `commands.check` | the `run:` of a generated `check` job |
| `checks[]` | read, never written: it is what `missingFromRuleset` is measured against |

A command is written as a single-quoted YAML scalar, so a command holding a `:` or a `#`
still means what it says. A command holding a newline or a control character cannot be
put on one line at all and is refused (`workflows:command-not-renderable`) rather than
truncated into a workflow that runs something else.

### What is rendered and what is copied verbatim

The templates carry no placeholders — they are working files this repository runs — so
rendering anchors on lines that are already there.

| Template | What happens to it |
| --- | --- |
| `agentic-checks.yml` | **rendered.** Its commented `# AGENTIC_TEST_CMD: …` line becomes the recorded test command, and a `test` job and a `check` job are appended for the two recorded commands. Everything else — the `scope` and `negative-control` jobs, the triggers, the permissions — is the template unchanged |
| `guard-main.yml` | **copied verbatim** under the marker. It names no command and runs on `push`, so the record has nothing to say about it. (It is also pinned byte-identical to this repository's own copy by `tests/guard-main.test.mts`) |
| `issue-lint.yml` | **copied verbatim** under the marker. It names no command and runs on `issues` |

The generated `test` and `check` jobs carry the same commented *toolchain setup* block the
template's `negative-control` job carries. That block stays a hand-filled one on purpose:
the record says what the command is, and the toolchain a repository needs before it can
run that command is the one thing the record cannot answer.

A record whose `commands.test` is `null` renders **no** `test` job, leaves the
`AGENTIC_TEST_CMD` line commented out and reports `test-command:none` among `gaps`. It
never exports an empty command: a `negative-control` job that runs nothing and reports as
if it had is worse than one that says it has no command. The same record still renders the
`check` job when `commands.check` is set.

### The marker, and the file it protects

Every generated file carries this on its first three lines:

```yaml
# generated by agentic-setup adopt — the commands come from `agentic.config.json`, not from this file.
# Regenerate it with `node scripts/adopt.mts --workflows`; edits made here are lost.
# A workflow without this marker on its first lines is never overwritten.
```

`generated by agentic-setup adopt` is the marker. A file that does not carry it on those
first lines was written by a person, and `--workflows` reports it as `skipped` with the
reason `not-generated` and leaves it byte-identical. There is no `--force` past that
refusal — `--force` is a modifier of `--record` alone, and on `--workflows` it is a usage
error. The remedy is to read the file and decide: move it aside, or keep it and require
its own job names instead. Losing a hand-written workflow to a flag is not a remedy.

| `outcome` | `reason` | Means |
| --- | --- | --- |
| `created` | `absent` | there was no such file; it was written |
| `updated` | `regenerated` | the file carried the marker and its contents moved; it was rewritten |
| `skipped` | `unchanged` | the file carried the marker and is already what would be written; nothing was written |
| `skipped` | `not-generated` | the file does not carry the marker; it was left exactly as it was |

Rendering itself is pure: `scripts/lib/adopt/workflows.mts` takes a record and the
template texts and returns strings. It writes nothing — `adopt.mts` is what writes — and
it reads nothing in the repository being adopted.

### What this does not close yet

`node scripts/init.mts --rules` still computes its own check names with
`detectTestCheckName` when it builds the ruleset payload. Until that path reads the
`checks` list above, `missingFromRuleset` is how the disagreement is made visible rather
than prevented: run `--workflows`, and require exactly the names it prints.

## `--hooks` installs the hooks the record names

`scripts/init.mts` installs the hooks unconditionally and reports afterwards: it merges
the deny list into `.claude/settings.json` and writes `hooks/git-pre-push` into the
repository's git hooks directory, on every run, for every repository, with no record of
what it installed and no way to read it back. A repository that already had a `pre-push`,
or a settings file with its own deny entries, got a merge and no report of what was kept.

`--hooks` makes the hook set data. The adoption record's `hooks[]` names what to install,
`scripts/lib/adopt/hooks.mts` resolves those names to files and returns a plan **without
writing**, and this flag executes it — naming every file it did not touch, and why.

```bash
node scripts/adopt.mts --hooks
```

```json
{
  "hooks": [
    { "hook": "pre-push", "file": ".git/hooks/pre-push", "outcome": "created", "reason": "absent" },
    { "hook": "protect-main", "file": "hooks/hooks.json", "outcome": "skipped", "reason": "not-recorded" },
    { "hook": "protect-worktree", "file": "hooks/hooks.json", "outcome": "skipped", "reason": "not-recorded" },
    { "hook": "stop-gate", "file": "hooks/hooks.json", "outcome": "skipped", "reason": "not-recorded" },
    { "hook": "worktree-create", "file": "hooks/hooks.json", "outcome": "skipped", "reason": "not-recorded" },
    { "hook": "deny-list", "file": ".claude/settings.json", "outcome": "updated", "reason": "merged",
      "deny": { "added": ["Bash(git push --force *)"], "preserved": ["Bash(terraform apply *)"],
                "replaced": [{ "from": "Bash(gh pr merge *--admin*)", "to": "Bash(gh pr merge *)" }] } }
  ],
  "recorded": ["pre-push"]
}
```

- `hooks` — one entry per hook this setup ships, plus the permission file. A hook that is
  not installed here is a line in this list with the reason, never a silence.
- `recorded` — the record's `hooks[]`, printed beside what happened to it. A hook named
  there and `skipped` here is the one line that says the repository does not have what its
  record claims.

### The hook set, and what `hooks[]` may name

| Name | What installing it means |
| --- | --- |
| `pre-push` | `hooks/git-pre-push` is written into the directory git says it runs hooks from (`git rev-parse --git-path hooks` — its answer, never an assumed `.git/hooks`: `core.hooksPath` moves it, and in a worktree `.git` is a file) and made executable |
| `protect-main`, `protect-worktree`, `stop-gate`, `worktree-create` | nothing is copied. They are the event hooks `hooks/hooks.json` registers, and they run from the plugin root (`${CLAUDE_PLUGIN_ROOT}/hooks/…`), so they are reported as `skipped` / `plugin-provided` |

That list is read from `hooks/hooks.json` rather than restated, so a hook added there is a
name a record may carry without a second edit. A name in `hooks[]` outside it is
`{ "error": "hooks:unknown-hook", "field": "<the name>" }`, exit 1, **nothing installed** —
not one file, not the deny list. A record naming a hook nobody installs is a repository
that believes it is protected and is not, and a plan that silently dropped the name would
install part of what was asked for and say nothing about the rest.

`deny-list` is not a name `hooks[]` may hold. The deny list of
`templates/claude-settings.json` is what makes the hooks enforceable rather than a thing to
install beside them, so `--hooks` always merges it into `.claude/settings.json`: every rule
already there that this installer did not seed is kept and reported as `preserved`, a rule
whose wording an older `init` seeded is `replaced` by the wording that superseded it
(`Bash(gh pr merge *--admin*)` → `Bash(gh pr merge *)`, #242) instead of being left beside
it, and every other key of the file — `allow`, `ask`, anything the adopter put there — is
carried through untouched.

### The marker, and the hook it protects

A `pre-push` whose text does not carry `agentic-setup` was written by a person. It is
reported as `skipped` with the reason `not-ours` and left byte-identical, and there is no
`--force` past that refusal — `--force` is a modifier of `--record` alone, and on `--hooks`
it is a usage error. The remedy is to read the file and decide: move it aside, or chain the
two. Losing a hand-written hook to a flag is not a remedy.

| `outcome` | `reason` | Means |
| --- | --- | --- |
| `created` | `absent` | there was no such file; it was written |
| `updated` | `reinstalled` | the file carried the marker and its contents moved; it was rewritten |
| `updated` | `merged` | the deny list gained rules, or a superseded one was replaced |
| `skipped` | `unchanged` | the file is already what would be written; nothing was written |
| `skipped` | `not-ours` | the hook does not carry the marker; it was left exactly as it was |
| `skipped` | `not-recorded` | the record's `hooks[]` does not name this hook, so nothing was installed for it |
| `skipped` | `plugin-provided` | the record names it, and it runs from the plugin root; nothing of it is copied into a repository |

### Running it twice changes nothing

`--hooks` is safe to re-run: a second run reports `skipped` for every entry and leaves the
tree exactly as the first one left it (`git status --porcelain` is empty). The hook file is
compared byte for byte with the one this repository ships, and the settings file is
rewritten only when the merge actually adds or replaces a rule — a file that already holds
every wanted rule keeps its own formatting and key order, because rewriting it to this
tool's formatting would be a change nobody asked for and would make the second run
something other than the no-op it promises to be.

### The record is the input, and it is required

Like `--workflows`, a repository without `agentic.config.json` is refused —
`{ "refused": "…", "reason": "hooks:no-record" }`, exit 1, nothing installed. Run `--record`
first.

One gap remains open, and it is worth naming: `--record` fills `hooks[]` from the hooks the
inventory found **installed**, so a repository that has adopted nothing yet writes
`hooks: []` and `--hooks` then installs no hook file for it — only the deny list. Until the
record can carry the hooks an adoption *intends*, name them in `hooks[]` before running
this flag, and re-run `--record` afterwards so the record and the repository agree again.

## `node scripts/proof.mts <slug>` runs the proof

An adoption pull request has to prove itself, and `doctor` has to be able to say whether
an adopted repository is proof-ready at all. Both need the same thing: one script that
turns a branch's declared proof into a run and a named outcome.

```bash
node scripts/proof.mts proof-runner
```

`<slug>` is the `<slug>` of the branch `<type>/<n>-<slug>` — what `scripts/claim.mts`
takes as `--slug`. It takes that one argument and nothing else, runs the resolved command
in the repository root, writes nothing, and prints one JSON object:

```json
{
  "slug": "proof-runner",
  "source": "declaration",
  "outcome": "pass",
  "command": "npm test",
  "tail": "1470 passed, 0 failed (node)"
}
```

`outcome` is a closed set — `pass`, `fail`, `cannot-run` — as `ci/negative-control.mts`
keeps one. `pass` exits 0; `fail` and `cannot-run` exit 1, and `cannot-run` carries the
named `reason` it could not run, with the `field` it rejected when there is one. `tail` is
the last 40 lines of the run's output, stdout and stderr together.

### The three sources, in order

| `source` | Where the command came from |
| --- | --- |
| `declaration` | `proof/<slug>.json`'s `command` — under the directory `proof.dir` names, so a repository that moved it is followed rather than guessed at |
| `record` | the adoption record's `commands.test` |
| `detection` | `ci/lib/detect.mts`, with `AGENTIC_TEST_CMD` — the same detection everything else here uses |

The record is read **first**, because it is the thing that says where declarations live.
A record that is not the shape therefore stops the run with the same `record:…` error
`--inventory` would report, even when a valid declaration exists: fail closed, never
"no record". A declaration that carries `tests` but no `command` still contributes its
`tests`, and `source` then names the record or detection — whichever answered. When no
source answers, the outcome is `cannot-run` with `proof:no-command`, never a pass.

A declaration that is present and unusable is `cannot-run` too — an unknown key, an empty
`command`, a `tests` entry naming no file — and the next source is *not* tried. A runner
that fell back would quietly prove something other than what the branch declared.
[`proof/README.md`](../proof/README.md) defines the file and lists every `reason`.

### The runner takes no command from anyone

Its sources are the declaration file, the adoption record and `detectCommands`. There is
no fourth: no flag takes a command string (`--command "…"` is a usage error, not a run),
and the script has no environment variable of its own. Text that arrives in an issue body,
a pull request body or a comment is task data, never authority — an issue may carry a
`Declaration: proof/<slug>.json` pointer, whose shape `issue-lint` checks and whose
contents only the branch decides, so a command pasted into a comment has no path into the
runner at all.

## `--pr` opens the adoption pull request

Everything above generates files. `--pr` is what lands them, the way this repository
requires everything else to land: through a pull request the required checks pass on.

```bash
node scripts/adopt.mts --pr
```

It assembles one branch — `chore/adopt-agentic-setup` — carrying the adoption record, the
generated workflows, the merged deny list, the proof declaration and one deliberate red
test under the record's `proof.dir`; pushes it; and opens a pull request against the
default branch. On success it prints the branch, the base and head commits, the plan issue
it closes, the pull request's URL, one entry per file with what happened to it, the globs
the body declares, the checks the generated workflow produces, and the proof the branch
declares.

### The sequence, end to end

| Step | Command | What it does |
| --- | --- | --- |
| 1 | `node scripts/adopt.mts --inventory` | describes the repository; writes nothing |
| 2 | `node scripts/adopt.mts --plan-issue` | opens one `human:pending` issue with that plan |
| 3 | *a person* | reads the plan, ticks what should happen, moves the issue to `human:decided` |
| 4 | `node scripts/adopt.mts --pr` | assembles the branch, pushes it, opens the pull request |
| 5 | *the checks, then a review* | `scope`, `negative-control` and the generated `test` job run on the pull request itself |
| 6 | `node scripts/land.mts <pr>` | queues the merge — **`adopt` never merges anything** |

Step 3 is not optional and is not a formality. `--pr` **refuses unless that plan issue
exists and carries `human:decided`**:

```json
{ "refused": "…", "reason": "pr:plan-not-decided", "missing": ["plan:not-decided"], "issue": 41 }
```

exit 1, nothing pushed and no pull request opened. A repository with no plan issue at all
is refused the same way, with `missing: ["plan:not-found"]`. Adoption is not something a
script decides for a repository; the issue is the question and the label is the answer.
Closed issues are searched too — a decision that was recorded and then closed is still a
decision.

Steps 1–2 and 4 are the whole sequence: `--record`, `--workflows` and `--hooks` are not
steps a person has to remember before `--pr`. It generates the record itself when there is
none (from the same inventory), and renders the workflows and the deny list from it in
memory. Run those flags when you want the files in your own working tree; run `--pr` when
you want them reviewed.

### It writes nothing into the working tree

The branch is assembled in the object database — `hash-object`, `update-index` against a
temporary index, `write-tree`, `commit-tree` — from the **base tree**, never from the
checkout. `git status --porcelain` is empty afterwards, `HEAD` is where it was, and no
file of the repository was created, moved or touched. Every "is this file already there?"
question is asked of the base tree for the same reason: a file edited but not committed
must not make a generated file look unchanged.

That is also why the `pre-push` hook is not in the diff, and the body says so. Git hooks
live under the directory git runs hooks from (`.git/hooks` by default), which is not
tracked and which no pull request can carry. `node scripts/adopt.mts --hooks` installs it
in each clone.

### What the deliberate red test is for

`ci/negative-control.mts` checks out the pull request's base, runs the test command there
unchanged (the baseline), then copies **only the test files of the diff** on top and
requires that second run to fail. A pull request whose tests pass on the base proves
nothing, and that is exactly the risk an adoption pull request carries: the whole point of
it is to install the checks, so nothing would notice if those checks could never go red.

So the branch carries `<proof.dir>/adopt-agentic-setup.test.mjs`, generated from the
record. It asserts what adoption generated — the record's `generatedBy` and `commands.test`,
and each job of the generated `agentic-checks.yml` — by reading the files, never by
importing them, so the red on the base is a failed assertion rather than a missing module
(which `negative-control` would report as `structural`). Absent on the base, present at
head: red there, green here. It is committed **on its own and first**, as
`test(red): …`, which is also the vouch `negative-control` reads when a red does look
structural (`docs/workflow.md`). The rest of the adoption follows in a second commit.

The declaration beside it, `<proof.dir>/adopt-agentic-setup.json`, names that file and no
command, so `node scripts/proof.mts adopt-agentic-setup` runs the command the record
holds — one answer rather than two. The pull request's `## Proof` section names it.

Two records are refused here rather than producing a test nobody would run:

- `pr:stack-not-supported` — the generated test is a `node:test` file, so a record whose
  `stack` is not `node` is refused by name. A runner that would never discover the file
  would make `negative-control` report `no-tests` or `vacuous`, which reads as a pull
  request that forgot its test rather than as an adoption that cannot be proved here.
- `pr:no-test-command` — a record with no `commands.test` gives the deliberate red nothing
  to be red in.

Even on `node`, discovery is the one thing the record cannot guarantee: a test command
that walks the repository (`npm test` running `node --test`, say) finds the file, and a
runner configured with an explicit list of test paths has to be told about it. The pull
request's `## Risks` section says so.

### The body is the one `ci/scope-check.mts` reads

The generated body follows `.github/pull_request_template.md` exactly: `Closes #<plan
issue>` in plain text on the first line, `## What changed`, `## Proof`, `## Files` listing
exactly the paths the branch carries, and `## Risks`. `scope` reads a pull request's scope
off the **linked issue**, never off the body its opener wrote (#155), which is why
`--plan-issue` declares the globs adoption may write under its own `## Files`:
`agentic.config.json`, `.github/workflows/**`, `.claude/settings.json` and `proof/**`.
The pull request names the exact files; the issue grants the globs they sit in.

No `type:` label is applied to the pull request. An agent that labels its own work buys its
own exemptions (`agents/implementer.md`), and the same rule holds for a script.

### The branch is created, never forced

The push is the create-only push `scripts/claim.mts` uses: `--force-with-lease=<ref>:`
with an empty expected value, which means the ref must not already exist, and the
`--porcelain` data line read as the signal. A branch that is already there is

```json
{ "held": "chore/adopt-agentic-setup", "branch": "chore/adopt-agentic-setup", "base": "…", "issue": 41 }
```

exit 2 — the remote ref is left exactly where it was and no second pull request is opened.
`--force` is not a modifier of this flag (it is a usage error), for the same reason the
generated workflows have none: the remedy is to read the branch, not to lose it. Delete
the branch if you want a new one.

### `adopt` never merges

Nothing in this script merges anything, and no flag of it ever will. `scripts/land.mts` is
the only thing in this repository that queues a merge — `gh pr merge --squash --auto`,
gated by the base branch's ruleset when it has one and by `gh pr checks --required`
otherwise (M12). The adoption pull request is reviewed and landed like any other.

## Crash policy: fail closed

This is `scripts/adopt.mts`'s policy; the runner states its own above, and holds to the
same rule. Every `git` or `gh` read this script depends on either answers or stops the run:
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
succeeding, on any flag — creates, moves or touches a file other than the ones its mode
names: `agentic.config.json` for `--record`, the files under `.github/workflows/` for
`--workflows`, and the `pre-push` hook plus `.claude/settings.json` for `--hooks`.
`--inventory`, `--plan-issue` and `--pr` write no file at all. It is **not** a claim that
the run had no effect on GitHub — `--pr` is the clearest case: it creates commits in the
object database, pushes a branch and opens a pull request, and every one of those is the
point of the flag. Two branches of `--plan-issue` show the same thing:

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
| `usage: node scripts/adopt.mts --inventory \| --plan-issue \| --record [--force] \| --workflows \| --hooks \| --pr` | no mode flag, more than one, or `--force` without `--record` |
| `root:not-a-git-repository` | `git rev-parse --show-toplevel` could not answer |
| `repository:unreadable` | the repository read failed, or answered without a default branch or without the two merge settings |
| `ruleset:unreadable` | the branch rules read failed or was not a list |
| `labels:unreadable` | the label list read failed or was not a list |
| `hooks:unreadable` | `git rev-parse --git-path hooks` could not answer, or a hook file or `.claude/settings.json` exists and could not be read |
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
| `workflows:template-missing` | a shipped template under `templates/.github/workflows/` is not there; `field` names it |
| `workflows:template-unreadable` | a shipped template exists and could not be read; `field` names it |
| `workflows:template-anchor-missing` | a template no longer carries the line the record is substituted into, so the file would be written with the placeholder still in it; `field` names it |
| `workflows:command-not-renderable` | a recorded command holds a newline or a control character and cannot be put on one line of YAML; `field` names it (`commands.test`, `commands.check`) |
| `workflows:unreadable` | a file under `.github/workflows` exists and could not be read, so whether it carries the marker is unknown |
| `workflows:not-written` | a generated workflow could not be written |
| `hooks:unknown-hook` | the record's `hooks[]` names a hook this setup does not ship; `field` names it, and nothing is installed |
| `hooks:source-missing` | a file this repository ships (`hooks/git-pre-push`, `hooks/hooks.json`, `templates/claude-settings.json`) is not there; `field` names it |
| `hooks:source-unreadable` | one of those exists and could not be read, or is not the shape the installer needs; `field` names it |
| `hooks:manifest-unparsable` | `hooks/hooks.json` is not JSON, or registers no hook command, so the hook set cannot be resolved |
| `hooks:settings-unparsable` | the adopted repository's `.claude/settings.json` was read and is not one JSON object; the deny list is never merged into a file this tool could not understand |
| `hooks:not-written` | a hook file or the settings file could not be written |
| `pr:plan-unreadable` | the plan-issue search failed or was not a list, so whether a decision exists is unknown |
| `pr:origin-unreadable` | `git fetch origin` could not answer, so the base the branch would be built on is unknown |
| `pr:base-unreadable` | `origin/<default branch>` does not resolve to a commit |
| `pr:stack-not-supported` | the record's `stack` is not `node`, so the generated `node:test` file would never be discovered; `field` names it |
| `pr:no-test-command` | the record holds no `commands.test`, so the deliberate red has nothing to be red in; `field` names it |
| `pr:nothing-to-commit` | the base already carries every file the adoption would write |
| `pr:git-failed` | a git plumbing command (`read-tree`, `hash-object`, `update-index`, `write-tree`, `commit-tree`) could not answer; `field` names it |
| `pr:not-pushed` | the push failed for a reason other than the branch already existing (which is `{ held }`, exit 2) |
| `pr:not-created` | `gh pr create` failed; its first line, when it had one, is in `detail` |

The `record:*` and `workflows:*` names carry a `field` alongside `error` whenever the
problem has one (`commands.test`, `proof.dir`, `agentic-checks.yml`, …), so a caller can
point at the line rather than the file.

`workflows:no-record` is a *refusal* rather than an error — it is printed as
`{ "refused": …, "reason": "workflows:no-record" }`, the shape `record:not-ours` and
`plan-issue:already-open` use, because nothing failed: the repository simply has no
record yet. `pr:no-plan-issue` and `pr:plan-not-decided` are refusals of the same shape,
with one more field: `missing`, the named list of what a person still owes
(`["plan:not-found"]`, `["plan:not-decided"]`).

## What this is not

The plan issue is a question, and the answer is a person's: `--plan-issue` performs none
of the remedies it lists, and no flag of this script performs a remedy a person has not
asked for by name. `--workflows` is the first remedy `adopt` can carry out — the
`workflows:missing` one — and it is a flag someone runs, on files it will not overwrite
unless it wrote them. `--pr` carries out several at once, and is the only flag that asks
the answer back: it refuses until the plan issue carries `human:decided`, and what it
produces is a pull request for review rather than a change to any branch anyone runs on.
Every other gap in the plan is still a person's to close.

And the record it writes is not a configuration file a person maintains: invariant 4
still holds, detection remains the default, and the record is its output, not its
replacement.
