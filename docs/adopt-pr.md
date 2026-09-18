# The adoption pull request

`node scripts/adopt.mts --pr` is the last step of `docs/adopt.md`, and the only one that
touches the remote. It lives in its own file because the document it came out of reached
the 800-line cap this repository holds every file to (#302); everything before it — the
report, the plan issue, the record, the generated workflows and hooks — is
[`docs/adopt.md`](./adopt.md), and the refusal names this flag can print are in that
file's crash-policy table, with the rest.

Every flag before this one generates files. `--pr` is what lands them, the way this
repository requires everything else to land: through a pull request the required checks
pass on.

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

### Which plan issue authorises, when two share the title

Two can. `--plan-issue` deduplicates against **open** issues only, so closing a plan issue
and running the documented sequence again leaves a closed one beside an open one — an
ordinary state, not an anomaly. `--pr` is the only mode that writes to a remote
repository, and a gate that read whichever match the search returned first would not be a
gate: a closed `human:decided` issue could authorise the push and put `Closes #<a closed
issue>` in the body — a keyword GitHub will not act on — and a closed undecided one could
produce a refusal the live question does not deserve.

So the search asks GitHub for each issue's `state`, and **the open issue is what
authorises**:

| The repository holds | `--pr` reads |
| --- | --- |
| one open plan issue | that one; `human:decided` on it is the gate |
| a closed one and an open one | the **open** one, whichever of the two the search returned first |
| only closed ones | nothing — `pr:no-plan-issue`, `missing: ["plan:not-found"]`, naming them |
| more than one **open** | nothing — `pr:plan-ambiguous`, `missing: ["plan:ambiguous"]`, naming them in `issues` |

The open issue is the live question, and it is the one `--plan-issue` maintains as unique.
A closed one is history — a decision that was made, acted on and filed — and history is
not a standing authorisation; a pull request cannot close a closed issue anyway. Preferring
the open match resolves the ordinary case. Where preference cannot decide — several open
matches, which only a person opening one by hand produces — the run refuses by name rather
than picking one, because each may carry a different decision and search order is not an
answer. Close all but the one that holds the decision and run it again.

A `state` this reader cannot recognise as open is treated as closed. That is the
fail-closed direction: a state it cannot name never authorises a push.

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

### Two of the generated checks are expected red on this one pull request

The generated `agentic-checks.yml` runs `scope` and `negative-control` out of
`.github/scripts/agentic/`, which `node scripts/init.mts` copies into a repository and this
branch does not carry: the two checks it installs cannot run on the pull request that
installs them. The body says so, the way `skills/init/SKILL.md` says it for the bootstrap
pull request — **both reds are correct there**, the generated `test` and `check` jobs are
the ones expected green, and they stop at the first pull request opened after this one is
merged. Do not make them
required checks on the default branch until then, or the adoption pull request cannot land.
The jobs are not made conditional on the copy existing: a required check that skips itself
is a gate that reports green without having run, which is the one thing a merge gate must
never do.

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
