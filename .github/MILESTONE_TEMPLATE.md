# Milestone description

One format for every milestone description in this repository — not a set of typed
moulds, one format. Paste the block below into the milestone's **description** field
(GitHub has no milestone chooser, so this file is the contract, not a UI feature) and
replace the placeholders. It lives beside `ISSUE_TEMPLATE/`, not inside it, so GitHub
never offers it as an issue template.

A milestone description says when the phase is finished. Without it, "the phase is done"
is decided by the last issue closing, which is an accident, not a criterion.
`scripts/reconcile.mts` reads the reconciled milestone's description and reports
`milestoneLint: { ok, missing }`, naming the parts that are absent (`objective`,
`out-of-phase`, `exit-criteria`, `depends-on`). It reports only: a milestone that has not
been migrated yet still reconciles and still dispatches.

## The format

```text
<Objective: one to three sentences. What this phase changes, and for whom. Not a list
of issues — the parent issue already lists those.>

Out of this phase:
- <what a reader could reasonably expect here and will not get, and where it goes instead>

Exit criteria:
- [ ] <a criterion someone else can check without asking you>
- [ ] <one per line, each one true or false on its own>

Depends on: <milestone or issue that must land first, or "none">
```

## Rules

- **Objective** — prose, one to three sentences, first. A bullet list or a heading is not
  an objective.
- **Out of this phase** — the scope boundary. Write `- none` rather than dropping the
  section; the format is the same for every milestone.
- **Exit criteria** — `- [ ]` checkboxes, one criterion per line, each one checkable by
  someone who did not write it. This is the part that says when the phase is finished, so
  a section with no checkbox of its own counts as missing — a checkbox under another
  section does not stand in for it.
- **Depends on** — one line, the milestone or issue that must land first, or `none`.
- A section label may be written `Out of this phase:` or `**Out of this phase:**` or
  `## Exit criteria`; the lint matches the label at the start of a line,
  case-insensitively, and the colon is required unless the label is a markdown heading —
  so a sentence that merely opens with a label's words ("Depends on the day the upstream
  API lands.") stays prose.

## Example

```text
Closure with evidence: every phase states its exit criteria in its own description, and
the loop reports which part of that format a milestone is missing.

Out of this phase:
- migrating the descriptions of already-closed milestones

Exit criteria:
- [ ] every open milestone's description holds the four parts of this format
- [ ] `reconcile.mts` prints `milestoneLint` and `docs/workflow.md` states the format
- [ ] no issue in this milestone is left in `state:blocked`

Depends on: none
```
