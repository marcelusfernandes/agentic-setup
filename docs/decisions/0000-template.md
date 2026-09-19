# NNNN. One line: the decision, not the topic

Status: proposed
Date: YYYY-MM-DD

<!--
Copy this file to `<nnnn>-<slug>.md`, four-digit number, continuing the register's
numbering (see README.md). Delete every comment before opening the PR.
Status is one of `proposed`, `accepted`, `superseded by item <n>`. It starts
`proposed` and only an explicit written OK from the person running the loop moves it
to `accepted` — merging this file does not (README.md, "Silence never accepts").
-->

## Decision

What is in force once this is accepted, in verifiable sentences. Name the hook, flag,
label, check or identity it changes, by path and symbol.

## Reason

Why this and not what was there before. Cite the code or the incident it comes from by
`file:line`, the way items 11 and 13 of `../decisions.md` do — a decision with no
verifiable cause is a preference.

## Cost accepted

What this makes worse, and who pays it. Every item in `../decisions.md` that had a cost
says so; an item claiming none says why none exists.

## Supersedes

`item <n>` or the file it replaces, or `nothing`. The same PR sets that item's
`Status:` to `superseded by item <nnnn>` — supersession is written on both sides or it
is not written at all.

## Updates

Dated lines, newest last, in the shape item 8 of `../decisions.md` already uses:

*YYYY-MM-DD (#issue, #PR):* what changed and what still holds. The decision above
keeps its original wording; an update never rewrites it.

That freeze is for a statement the ground moved under — a line that drifted, a mechanism
that changed after this item landed. A statement that was **false when it was written**
is corrected in the body instead, in place, because an appended line cannot make the body
stop asserting it and a reader who stops at the section carrying it never reaches the
update. A correction in the body never touches the decision itself, its `Status:` or its
number. `README.md`, "Correcting an item that is already written", states the split in
full and gives the argument for it.
