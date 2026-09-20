# The decision register

[`../decisions.md`](../decisions.md) holds items 1 to 13 — the reasoning behind the
loop, each item a decision, its reason and what it costs. This file is the rule the
register runs by: what earns a number, what the three statuses mean, who may move an
item between them, where a new decision lands, and how an item already written is
corrected. Which item lives in which file is a rule rather than a row — see **Where a
decision lives** — and **Reading the register** gives the one command that prints every
item, with its file and its status, over both files at once.

## What becomes a numbered decision

A numbered decision is a change to the contract the agents run under:

- a **hook** — what `protect-main.mts` or `protect-worktree.mts` denies, or a hook's
  stated crash policy;
- a **flag** — a flag added to or removed from `scripts/init.mts`, `scripts/claim.mts`,
  `scripts/land.mts`, `scripts/reconcile.mts` or a `ci/` check, and what it changes;
- a **label** — a new `state:`, `type:`, `scope:`, `review:` or `human:` value, or a
  change to what one of them gates;
- a **check** — a required CI job, or what makes one pass or fail (`scope`,
  `negative-control`, `issue-lint`);
- **who is allowed to write something** — which identity or role may merge, approve,
  relabel, push or claim.

That is the same list as invariant 8 of `AGENTS.md` ("a change to a hook, flag, label or
check updates `docs/` and the relevant `SKILL.md` in the same PR"). If a change obliges
that doc update, it is a decision, and the decision is part of the same PR.

## What stays a note

Anything that explains one change rather than binding the next one stays where it was
written — the PR body or a comment on the issue:

- why an implementation took shape A rather than B, inside one PR's diff;
- a measured fact about how the code already behaves, with no change of contract;
- a classification the orchestrator makes while dispatching an issue;
- a refusal, or why an issue is blocked — already traceable from `state:blocked` and
  `human:pending` / `human:decided`.

In doubt: if the next agent has to read it before touching a file this PR never
touched, it is a decision. If it only explains the diff in front of you, it is a note.

## The three statuses

Every item carries one `Status:` line directly under its heading.

| status | what it means | who may set it |
|---|---|---|
| `proposed` | written down, not in force. The loop still runs by whatever was in force before it. | anyone — an agent or a person may open the PR that adds a `proposed` item. |
| `accepted` | in force. Hooks, skills, checks and docs are expected to match it. | a person only, by an explicit written OK (item 8). An agent may make the edit, but only citing that OK by issue comment or review. |
| `superseded by <item>` | replaced. Kept with its reason, because the history is the point. | the PR that lands the replacing decision, in the same diff, naming the item that replaces it. |

A new decision starts `proposed`. `accepted` is not a state a PR can reach on its own;
see below.

## Silence never accepts

Item 8 of `../decisions.md` names approving these decisions as an explicit human
point — "explicit OK; silence does not approve". That clause is a rule of this register,
not a detail of item 8:

- A decision file merging into `main` is **not** acceptance. A PR labelled `type:docs`
  merges on CI alone, with no reviewer (item 6), so landing a `proposed` item proves
  only that it is written down.
- No amount of elapsed time, no unanswered comment and no green check moves an item to
  `accepted`. Only an explicit written OK from the person running the loop does, and the
  PR that flips the `Status:` line cites where that OK was written.
- An item whose acceptance is waiting on a person belongs to an issue labelled
  `human:pending`; the person flips it to `human:decided` when the decision is recorded.

## Where a decision lives

- **Items 1 to 13 keep their numbers in [`../decisions.md`](../decisions.md).** Ten
  tracked files name that path and several cite it by item number, so the file is not
  moved, renamed or renumbered. Only its `Status:` lines change from here on.
- **Every decision after them is one dated file** in this directory, named
  `<nnnn>-<slug>.md` — the number zero-padded to four digits and continuing the
  register's numbering, so "item 14" resolves to
  [`0014-hand-typed-gh-pr-merge-denied.md`](0014-hand-typed-gh-pr-merge-denied.md). The
  date lives inside the file, on its `Date:` line.
- **A number resolves to a file by name, not through a table.** Item *n* is the file in
  this directory whose name begins with its four digits, when one exists; otherwise it is
  the `## n.` heading in [`../decisions.md`](../decisions.md). `ls docs/decisions` answers
  the first half and the command under **Reading the register** answers both.
- **Some later items were written into `../decisions.md` and still live there**, each
  because its issue's `## Files` listed that path and no path in this directory, and an
  implementer never widens its own globs. The same is true of the dated note under item
  13, which holds no number of its own. This file does not list which items those are:
  such a list is one more line every exception has to come back and edit, and the command
  under **Reading the register** prints the file each item lives in anyway. Relocating
  them is its own issue.
- **The next free number is computed, never written down here.** It is one past the
  highest number *either* file carries, which is why the command under **Reading the
  register** reads both: items 1 to 13 and the exceptions above hold numbers no file in
  this directory carries, so a derivation that reads only this directory can hand out a
  number already taken. A sentence in this file naming the next number would be the same
  hazard by another route — every item that landed would leave it one behind, as the
  register's own history shows.
- [`0000-template.md`](0000-template.md) is the shape such a file takes. It is a
  template, not a decision, and holds no number of its own; its heading carries `NNNN`
  rather than digits, which is why neither command below counts it as an item.
- **A pull request that adds a numbered decision touches its own file and nothing else in
  this directory.** There is no index row to add and no next-number sentence to advance,
  so two such pull requests never need the same file and `ci/issue-lint.mts` has no
  overlap to refuse (item 35 of [`../decisions.md`](../decisions.md);
  `tests/register.test.mts` holds it against the lint itself). What is left is narrower:
  two pull requests that compute the number in the same window compute the same number.
  Nothing here orders them. The duplicate is caught by the case in
  `tests/register.test.mts` that fails when two items carry one number — but **only when
  that case runs after the sibling landed**. This repository does not guarantee that it
  does: `.github/workflows/test.yml` fires on `pull_request`, so a base-branch update
  re-triggers nothing, and the `main` ruleset sets
  `strict_required_status_checks_policy: false`, so a branch is never required to be
  current. A green recorded before the sibling merged still counts, and `scripts/land.mts`
  gates on mergeability and review with no notion of a head behind its base, so it merges
  the duplicate. The case then reds `main`, and every pull request after it, until an item
  is renumbered. Enabling the strict policy, or teaching `land.mts` to refuse a behind
  head, is what would move the catch ahead of the merge; it is its own issue.

## Correcting an item that is already written

Every item ends with `## Updates` ([`0000-template.md`](0000-template.md)), and the
template states one half of the rule: *the decision above keeps its original wording; an
update never rewrites it.* That freeze is right for one of the two ways a written item
goes wrong and wrong for the other, so the split is stated here rather than derived
again — two implementers derived it independently on 2026-09-19, on separate pull
requests and never in contact, and neither found it written.

- **Overtaken — true when it was written, and the ground moved under it.** A cited line
  that drifted when the file grew, a mechanism that changed after the item landed, a
  consequence the code no longer has. The body keeps the wording and the numbers it was
  written with, and a dated `## Updates` line says what moved, what still holds, and
  which sentence above no longer describes the code. The original sentence is the record
  of what was true on the item's `Date:`; rewriting it erases that record and buys
  nothing, because the sentence was right on its date and the world moved, not the
  sentence.
- **Wrong when it was written — false on its own date.** A claim about the code that was
  never true of it, a reason that does not hold, a citation that never pointed where it
  said it did. This is corrected **in the body**, in place, where the sentence is. The
  pull request that makes the correction is its record — an explanation of one change is
  a note (**What stays a note**), and the diff shows what the sentence used to say.

A sentence corrected in the body is rewritten whole, its citations with it, pointing at
the code as of the correction: a freshly written sentence carrying an old line number
asserts something nobody checked. The freeze keeps the numbers of the sentences that
stay.

**Why an appended line cannot serve the second case.** Read literally against a false
sentence, the freeze is an instruction to leave the falsehood standing, and the argument
against that does not depend on how widely the template's sentence is read. The
acceptance criteria decide it on their own: a criterion that requires an item to **stop
asserting** something cannot be satisfied by appending a line. Appending adds a
sentence; it removes none. The body goes on making the claim, in the present tense,
above the correction, and a reader stops at the section that answers the question they
came with — so the sentence they read and cite is the false one, and the update at the
foot of the file is never reached. A criterion phrased as a removal is met only by a
removal. Nothing in the template asks otherwise: its freeze is about wording that is
still true of its own date, which is exactly what a wrong-when-written sentence is not.

**What a correction in the body may not touch.** A correction fixes a statement, never
the item. Three things are not statements, and each has a route of its own:

- **the decision** — the rule in force under `## Decision`. A rule that should now be
  different is replaced by a new item that supersedes this one (**The three statuses**),
  never edited into a different rule, which would leave nothing to show that the loop
  ever ran by the old one.
- **its `Status:`** — `accepted` comes only from an explicit written OK (**Silence never
  accepts**), and `superseded by item <n>` is written by the pull request that lands the
  replacement, on both sides. Neither is a correction.
- **its number** — other files cite items by number and the number resolves to a file by
  name, so renumbering moves every citation without touching one of them.

So the freeze is narrowed here, not lifted: what may be corrected in place is a sentence
that was false when it was written, and what may not is the decision it sits under.

## Reading the register

Both commands below read the register's two files and nothing else, from the repository
root. They replace a table this file used to carry: every item is already in one of those
two files, headed `# <nnnn>.` or `## <n>.` with its `Status:` on the third line, so the
table was a copy of data that was never anywhere else.

**Every item, with the file it lives in and its status** — what the index gave a reader:

````sh
awk 'FNR==1{h="";c=0} substr($0,1,3)=="```"{c=!c; next} c{next} /^##? [0-9]+\. /{h=$0} /^Status:/ && h!=""{print FILENAME" | "h" | "$0}' docs/decisions.md docs/decisions/[0-9]*.md
````

**The next free number**, one past the highest either file carries:

````sh
awk 'FNR==1{c=0} substr($0,1,3)=="```"{c=!c; next} c{next} /^##? [0-9]+\. /{n=$0; sub(/^#+ +/,"",n); sub(/\..*/,"",n); if (n+0>m) m=n+0} END{printf "%04d\n", m+1}' docs/decisions.md docs/decisions/[0-9]*.md
````

An item is a `#` or `##` heading whose first word is its number, outside a fenced block,
with its `Status:` two lines under it — the two depths the register uses and no other, so
a numbered `###` sub-heading is not an item and neither is a heading quoted in a fence.

`tests/register.test.mts` runs both commands on every `npm test`, against a scan of the
same two files written out separately: the number they print is one past the highest, is
free, and the view reaches both files. It runs them again against a register written
inside the test, which is where the two shapes above are held. It holds no item number of
its own, so adding an item never edits it.

**What a reader loses.** The table rendered on github.com; these commands need a checkout
and a shell. A reader who wants the whole register at a glance from a browser now opens
the directory listing, which gives every item's number and title in its filename but not
its status, and `../decisions.md`, which gives the rest. That is the cost this change
accepts, and item 35 of [`../decisions.md`](../decisions.md) says why it is the smaller
one: a view reachable without a checkout cost, measured, five serialised landings in one
day, with nineteen open issues still owing an item behind it.
