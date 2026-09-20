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
generated workflows the decision accepted, the merged deny list, the proof declaration and
one deliberate red
test under the record's `proof.dir`; pushes it; comments the decision on the plan issue;
and opens a pull request against the
default branch. On success it prints the branch, the base and head commits, the plan issue
it closes, the decision it acted on, the pull request's URL, one entry per file with what
happened to it, the globs
the body declares, the checks the generated workflow produces, and the proof the branch
declares.

```json
{ "decision": { "accepted": ["ruleset:absent"], "declined": ["workflows:missing"], "decidedBy": "the-owner" } }
```

### The sequence, end to end

| Step | Command | What it does |
| --- | --- | --- |
| 1 | `node scripts/adopt.mts --inventory` | describes the repository; writes nothing |
| 2 | `node scripts/adopt.mts --plan-issue` | opens one `human:pending` issue with that plan |
| 3 | *a person* | reads the plan, ticks what should happen, moves the issue to `human:decided` |
| 4 | `node scripts/adopt.mts --pr` | reads the ticks, assembles the branch from them, pushes it, records the decision on the plan issue, opens the pull request |
| 5 | *the checks, then a review* | the generated `test` and `check` jobs run and are expected green; `scope` and `negative-control` are expected **red** on this one pull request (below) |
| 6 | `node scripts/land.mts <pr>` | queues the merge — **`adopt` never merges anything** |

Step 3 is not optional and is not a formality. `--pr` **refuses unless that plan issue
exists and carries `human:decided`**:

```json
{ "refused": "…", "reason": "pr:plan-not-decided", "missing": ["plan:not-decided"], "issue": 41 }
```

exit 1, nothing pushed and no pull request opened. A repository with no plan issue at all
is refused the same way, with `missing: ["plan:not-found"]`. Adoption is not something a
script decides for a repository; the issue is the question and the label is the answer.

### The ticks decide what the pull request carries

The label says a person answered. The **boxes** say what they answered, and `--pr` reads
them: the search asks GitHub for the issue's `body` alongside its `state` and `labels`,
and each checkbox line of the `## What adoption would do` section is one gap.

```
- [x] `workflows:missing` — copy the missing workflow(s) into `.github/workflows`
- [ ] `ruleset:absent` — create the `agentic-setup` branch ruleset on `main`
```

A ticked box is **accepted**; an empty one is **declined**. Both lists go into the pull
request's body under `## The decision this acts on`, and into a comment on the plan issue
before the pull request is opened, so the decision is legible from either end. Until this
existed the ticks were read by nothing: a person who ticked two gaps of five and one who
ticked all five got the same pull request, and the only trace of what was decided was the
issue body's edit history, which no script and no closeout reads.

**A gap is read by its name, never by its prose.** The name is the first backticked span
of the line, and everything after it is a remedy a person may rewrite while they answer —
and they do, because "no: we maintain these by hand" is how a person declines something.
Only the first span counts, so a remedy quoting a second path (``create `state:ready` ``)
does not turn that path into a second decision. `[X]` is a tick, `*` is as good a bullet
as `-`, and a line whose gap name is not backticked contributes nothing rather than a
guess. A name this version does not recognise is carried through to the record of the
decision rather than refused: a typo in a box is not a reason to stop an adoption.

**What declining actually changes depends on whether the gap's remedy is a file.**

| Declined gap | What the pull request does |
| --- | --- |
| `workflows:missing` | `.github/workflows/**` is **not in the diff** — the files are planned as `skipped (declined)` and appear in the body's "left exactly as they are" list |
| `ruleset:absent`, `ruleset:review-not-required` | named as declined; the remedy is a GitHub API call (`init.mts --rules`), never a file |
| `labels:missing` | named as declined; the remedy is `gh label create` |
| `hooks:not-installed` | named as declined; the remedy lives under the directory git runs hooks from, which no pull request can carry (above) |
| `test-command:none` | named as declined; the remedy is an environment variable |
| `record:stale` | named as declined; the remedy is `--record --force`, which `--pr` never runs — it uses the record it was handed as it stands |

`agentic.config.json`, `.claude/settings.json` and the proof files answer no gap, so no
tick governs them: the record is what every generated step reads, and the proof files are
this pull request's own deliberate red rather than a remedy.

Declining the workflows has one consequence worth stating, because it looks like a bug
otherwise: the deliberate red then asserts the adoption record **and nothing about the
workflow**. A generated test that asserted a file no commit carries would be red at the
head as well as on the base, which proves nothing. The body says so in its `## Proof`
section, and says that no generated check is expected red or green on that pull request
because none of them is installed by it.

**What accepting one changes depends on the same thing, and the report now says
which.** Five of the seven remedies are a GitHub API call, an environment variable or
a file no pull request can carry, so accepting them records an answer and performs
nothing.

| Accepted gap | What the pull request does |
| --- | --- |
| `workflows:missing` | **carried** — `.github/workflows/**` is in this diff; the body's file list says which files were written and which the base already carried identically |
| `ruleset:absent`, `ruleset:review-not-required` | **recorded, not performed** — run `node scripts/init.mts --rules` |
| `labels:missing` | **recorded, not performed** — run `node scripts/init.mts`, which is what calls `gh label create` for every label of the dictionary |
| `hooks:not-installed` | **recorded, not performed** — run `node scripts/adopt.mts --hooks`, once in each clone |
| `test-command:none` | **recorded, not performed** — set `AGENTIC_TEST_CMD`, or add a test command detection can find |
| `record:stale` | **recorded, not performed** — run `node scripts/adopt.mts --record --force`; `--pr` uses the record it was handed as it stands |

The plan-issue comment and the pull-request body name the command beside each recorded
gap. Before this they rendered a bare list of names, so a gap the branch carried and a
gap the run had written down read alike, and "accepted" read as "done".

**Accepting `labels:missing` and running nothing is what stops the pull request
landing.** It is the one case where the missing distinction costs an hour rather than a
sentence, and the chain is:

1. The box is ticked, so the decision records `labels:missing` as accepted — and **no
   mode of the six performs that gap's remedy**. (`--plan-issue` does create the two
   `human:` labels its own question needs; that is the only label write any mode of
   `adopt` makes, and it is not this remedy.)
2. `review:approved` is one of the labels `node scripts/init.mts` seeds, so it is still
   absent from the repository.
3. `node scripts/land.mts <pr>` — step 6 of the sequence — refuses:

```json
{ "refused": "PR #2 is not ready to merge: review:not-approved.", "pr": 2, "missing": ["review:not-approved"], "mode": "agent" }
```

exit 1, nothing queued. Run `node scripts/init.mts` in a clone of the adopted
repository, which seeds the whole label dictionary, then have the pull request reviewed
and run `land.mts` again. **Do not create `review:approved` by hand to get past the
refusal**: the label is the record of a review, and writing it without one fabricates a
review nobody cast — the same reason `adopt` never merges.

**The sequence stays six steps, and the label creation is not one of them.** Both
answers were defensible: the sequence is documented as complete, so a gap it leaves
unperformed is a gap in the document; but a flag that created labels because a box was
ticked would be `adopt` acting on a decision instead of recording one, which is the line
every mode of it holds. `land.mts`'s refusal is the right place to catch it — it names
the exact missing label, it is the step that needs it, and it refuses before anything
merges rather than after. So the answer is: the report names the remedy, this document
names the chain, and the refusal stays where it is. No script gains a write it did not
have, so this earns no numbered decision item beside item 33; the one correction it does
owe that item is a dated line under its `## Updates`.

### A tick nobody can act on is named, not refused

A ticked name that is not one of the seven gaps
`scripts/lib/adopt/inventory.mts` defines is **unrecognised**: it is carried into the
decision exactly as written — a typo in a box is not a reason to stop an adoption — and
the comment and the body both say that nothing acted on it.

That matters because of what silence costs. A person who ticks `workflow:missing`
accepts a name no version defines, while `workflows:missing` is left empty and counted
as declined, so `.github/workflows/**` is left out of the branch and every artefact
records the decision correctly, in the person's own vocabulary, naming a gap they did
not mean and declining one they did not decline. The report now prints the two facts
side by side: the unrecognised tick names the gap it was nearest, and that gap's own
declined bullet names the tick that missed it. It is a word in the report and never a
refusal — the run cannot know which of the two a person meant, and only they can.

**Where the vocabulary comes from.** The seven names are written out in
`scripts/lib/adopt/decision.mts` as the keys of `GAP_REMEDIES`, typed `Record<Gap,
string>` against the `Gap` type of `scripts/lib/adopt/inventory.mts`. The import is
`import type`, erased by `verbatimModuleSyntax`, so nothing is imported at runtime and
an unknown tick still cannot become a refusal — the coupling item 33 declined to take
is taken only at compile time, where `npm run check` refuses a gap renamed in one file
and not the other. Item 33's cost list named the reverse direction of this same drift
(`GAP_PATHS` silently ceasing to map a renamed gap to its files) and is updated to say
so.

A near-miss is a name within two edits of a gap name; no two of the seven are that close
to each other, so a correct tick is never reported as a miss of another. A name further
away than that is reported as unrecognised with no guess attached.

**`workflows:missing` is the only gap whose remedy is a file today**, so the measurable
harm — files silently left out of the branch — is confined to it; a second entry in
`GAP_PATHS` widens it without changing anything else. The same single mistyped character
would then drop two unrelated sets of files for one reason, and the person would read
two correct-looking declines instead of one. The report is what scales here, not the
map — every entry added to `GAP_PATHS` is covered by the same carried/recorded split and
the same near-miss note the moment it exists.

**The `--pr` JSON is not part of this yet.** Its `decision` object still carries
`accepted` and `declined` exactly as the boxes were ticked, with no carried/recorded
split and no unrecognised list: that object is assembled in
`scripts/lib/adopt/pr-run.mts`, which is outside the files #423 declared. The two places
a person reads a decision — the comment on the plan issue and the pull-request body —
carry the whole of it.

### A decision that accepts nothing is refused

```json
{ "refused": "…", "reason": "pr:plan-nothing-ticked", "missing": ["plan:nothing-ticked"], "issue": 41 }
```

exit 1, nothing pushed, no comment and no pull request. A plan carrying `human:decided`
with no box ticked — or with the checklist deleted outright — asks for no gap to be
closed, so the pull request would carry the record, the deny list and its own deliberate
red and close an issue that requested none of it.

It is **not** `pr:plan-not-decided`. The two are opposite mistakes: there the label is
missing, here the label is the one thing that is right. A refusal telling a person to
apply `human:decided` when they already have would send them to fix what they did
correctly, so this one names the boxes.

### The decision is recorded on the issue that asked

Before it opens the pull request, `--pr` comments on the plan issue: the accepted gaps —
each one marked as carried in the diff or recorded and performed by nothing, with the
command that performs a gap nothing here performed — the declined ones (with the paths a
declined gap left out, where it has any, and the tick that was aimed at it where one
was), any tick this version cannot act on, and the login that applied `human:decided`. That login is read from the issue's **timeline** —
the last `labeled` event naming the label, because a label removed and applied again is
an ordinary thing and the decision in force is the standing one.

The order is deliberate. **After the push**, because a second run over a branch someone
already holds answers `{ held }` and never reaches the comment, so re-running the flag
never leaves a second identical record. **Before `gh pr create`**, because a comment
naming a pull request that then fails to open is a record of something that did not
happen.

Two things can go wrong there, and both fail closed:

- `pr:timeline-unreadable` — the timeline read failed or was not JSON. It runs before
  anything is built, so nothing is pushed and no comment is left. It is an error and not
  a `decidedBy` quietly reported as absent, because that field would then mean two
  different things: "nobody is recorded" and "the read failed".
- `pr:decision-not-recorded` — `gh issue comment` failed. The branch is pushed by then
  and stays pushed; no pull request is opened. Running `--pr` again answers `{ held }`
  rather than duplicating anything, so the remedy is to comment by hand, or to delete the
  branch and run again.

A timeline that *answers* is a different thing from one that cannot be read, and it has
two shapes that both mean `decidedBy: null`. Either **there is no such event** — no
`labeled` event for the label at all — or the standing one **carries no actor**, which is
what GitHub renders for an event attributed to a deleted user or to an integration. The
comment and the body say a sentence true of both, because the timeline itself does not
reach the phrase: the run names no person, and the reason is one of those two. Both are
facts about the issue rather than a failed read, and reporting only the first sent a
reader looking for a missing event that was sitting in the timeline.

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

A file the planner cannot read is left exactly as the base has it and reported with the
reason why, never rewritten: `not-generated` for a workflow without the marker,
`not-parsable` for a `.claude/settings.json` that is not JSON, and `deny-not-strings` for
one whose `permissions.deny` holds an entry that is not a string. That last one is the
same answer `--hooks` gives as `hooks:settings-unparsable` (`docs/adopt.md`): a rule this
tool cannot read is not a rule it may quietly drop out of a permission file, least of all
in a pull request whose subject is a protection.

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
