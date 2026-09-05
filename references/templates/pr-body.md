{{title}}

## Summary
{{summary_bullets}}
<!-- 2-4 bullets, generated from the commits and the task acceptance criteria -->

## Changes
{{changes_by_area}}
<!-- file-group level summary, from `git diff --stat` -->

## Testing
{{testing_bullets}}
<!-- one bullet per gate: - `<command>` — <result>  (a null/unconfigured command still gets a
     bullet: - `lint` — skipped (no command configured)) -->

## Rulings
{{ledger_rows}}
<!-- omit this section entirely when the epic's ledger.md gained no new rows while this was worked;
     otherwise one line per new row: "<scope>: <ruling> — <why>" -->

## Issues
{{closes_lines}}
<!-- one "Closes #N" line per issue this PR fully completes -->
{{part_of_line}}
<!-- "Part of #<epic>" for the epic parent — never a closing keyword, or merging one task's PR
     would close the whole epic -->

<!-- agentic-git:pr epic={{epic_slug}} -->
