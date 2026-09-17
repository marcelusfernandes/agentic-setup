# Dogfood <YYYY-MM-DD> — <what this pass exercised, in one line>

- Repository: <owner/name the pass ran against>
- Commit: <40-character sha of this repository at the moment the pass ran>
- Turns: <turns the pass took, whole number>
- Minutes: <wall-clock minutes, whole number>
- Cost (USD): <what the pass cost, e.g. 12.40>
- Transcripts: <where they are kept, outside this repository>

## Scoreboard

| case | exit | error class | tool calls | decision | reason |
| --- | --- | --- | --- | --- | --- |
<!-- One row per case the pass ran. Copy the shape below; the commented row does
     not count as a row, so this file stays the empty case. Its numbers are
     illustrative, not a record of anything this repository ran.
     `error class` is `none` for a case that ended clean; `decision` is `keep`
     (the cost is accepted as it is) or `fix` (it is a defect), never blank.
| claim a ready issue | 0 | none | 7 | keep | the two refusal paths cost one call each |
| land a queued PR | 1 | checks-queued | 12 | fix | the wait loop cannot tell a conflict from a queue |
-->

## Findings

| finding | origin | outcome |
| --- | --- | --- |
<!-- One row per finding. `origin` is copied verbatim into the `Origin:` line of
     the issue the finding becomes; `outcome` is that issue's `#N`, the merged
     PR or closed issue that already covered it, or a one-line reason it is not
     work. A finding is never left as a candidate.
| the wait loop spins on a conflicting PR | case "land a queued PR", run 42 | #901 |
| a label edit re-triggers the checks | case "land a queued PR", run 42 | already covered by PR #905 |
| claim asks GitHub twice for the same issue | case "claim a ready issue" | accepted: one extra call per claim, cheaper than a cache |
-->
