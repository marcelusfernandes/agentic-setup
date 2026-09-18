# The decision register

[`../decisions.md`](../decisions.md) holds items 1 to 13 — the reasoning behind the
loop, each item a decision, its reason and what it costs. This file is the rule the
register runs by: what earns a number, what the three statuses mean, who may move an
item between them, and where a new decision lands. The index below is the authority on
which item lives in which file, because some later material has not been relocated yet.

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
  [`0014-hand-typed-gh-pr-merge-denied.md`](0014-hand-typed-gh-pr-merge-denied.md) and
  the next free number is `0025-<slug>.md`. The date lives inside the file, on its
  `Date:` line. The number continues the register across both files: items 16, 18, 19 and
  20 hold their numbers inside [`../decisions.md`](../decisions.md), so the next free
  number is the one after the highest in the index below, not the one after the
  highest-numbered file in this directory.
- **Four exceptions exist today, recorded in the index rather than hidden.** Items 16,
  18, 19 and 20 — and the dated note under item 13, which holds no number of its own —
  were written into `../decisions.md` and still live there, each because its issue's
  `## Files` listed `../decisions.md` and no path in this directory, and an implementer
  never widens its own globs. Relocating them is its own issue.
- [`0000-template.md`](0000-template.md) is the shape such a file takes. It is a
  template, not a decision, and holds no number of its own.
- A PR that adds a decision file adds its line to the index below in the same diff.

## Index

| item | decision | status |
|---|---|---|
| 1 | [Unit of work: a GitHub sub-issue](../decisions.md#1-unit-of-work-a-github-sub-issue) | accepted |
| 2 | [Claiming: the remote branch is the lock](../decisions.md#2-claiming-the-remote-branch-is-the-lock) | accepted |
| 3 | [Isolation: one worktree per issue](../decisions.md#3-isolation-one-worktree-per-issue) | accepted |
| 4 | [Merge without a human](../decisions.md#4-merge-without-a-human) | accepted |
| 5 | [Parallelism](../decisions.md#5-parallelism) | accepted |
| 6 | [PR classes](../decisions.md#6-pr-classes) | accepted |
| 7 | [Restart](../decisions.md#7-restart) | accepted |
| 8 | [Explicit human points](../decisions.md#8-explicit-human-points) | accepted |
| 9 | [Single trunk, and how `main` is protected](../decisions.md#9-single-trunk-and-how-main-is-protected) | accepted |
| 10 | [Negative control is the load-bearing check](../decisions.md#10-negative-control-is-the-load-bearing-check) | accepted |
| 11 | [Every mutating orchestrator step is a script with a refusal path](../decisions.md#11-every-mutating-orchestrator-step-is-a-script-with-a-refusal-path) | accepted |
| 12 | [Issue-time entry-point warnings are advisory, not a gate](../decisions.md#12-issue-time-entry-point-warnings-are-advisory-not-a-gate-superseded--see-item-13) | superseded by item 13 |
| 13 | [The 2026-09-06 audit: trim to the core, and a separate reviewer identity](../decisions.md#13-the-2026-09-06-audit-trim-to-the-core-and-a-separate-reviewer-identity) | accepted |
| 14 | [A hand-typed `gh pr merge` is denied, not discouraged](0014-hand-typed-gh-pr-merge-denied.md) | accepted |
| 15 | [One generated adoption record, and `adopt` calls `init`](0015-generated-adoption-record-and-adopt-calls-init.md) | accepted |
| 16 | [One label dictionary, a union with a per-route marker](../decisions.md#16-2026-09-17-one-label-dictionary-a-union-with-a-per-route-marker) — still in `../decisions.md`, not yet relocated | accepted |
| 17 | [The decision nudge stays a warning, over five mechanism globs](0017-decision-nudge-strength.md) | accepted |
| 18 | [One review mode: an isolated agent, a label the orchestrator writes](../decisions.md#18-2026-09-17-one-review-mode--an-isolated-agent-a-label-the-orchestrator-writes) — still in `../decisions.md`, not yet relocated | accepted |
| 19 | [The M9 discipline agent catalogue is retired](../decisions.md#19-2026-09-17-the-m9-discipline-agent-catalogue-is-retired) — still in `../decisions.md`, not yet relocated | accepted |
| 20 | [`land` declares its review mode — `agent` by default, `approved` opt-in](../decisions.md#20-2026-09-17-land-declares-its-review-mode--agent-by-default-approved-opt-in) — still in `../decisions.md`, not yet relocated | accepted |
| 21 | [The negative control never exempts a change to its own installed code](0021-the-gate-does-not-exempt-its-own-code.md) | proposed |
| 22 | [A grant bullet is read once, as a grant, and never as a glob of the issue](0022-a-grant-bullet-is-never-also-a-glob.md) | proposed |
| 23 | [A `--ruleset-name` that matches nothing refuses, and no failed read reaches the create path](0023-a-ruleset-name-that-matches-nothing-refuses.md) | proposed |
| 24 | [An `authorised:` grant is never written from inside the worktree it would exempt](0024-a-grant-is-never-written-from-a-worktree.md) | accepted |
