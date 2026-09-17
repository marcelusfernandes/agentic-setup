# 0015. One generated adoption record, and `adopt` calls `init`

Status: accepted
Date: 2026-09-17

The two questions M13 could not start without (#161, `human:decided`). The owner
delegated the open questions of M11–M16 to the orchestrator on 2026-09-17 — "you know
where we want to get to; the reference projects are the options to choose from when in
doubt" — keeping the veto by reopening the issue. Both answers are recorded verbatim in
that issue's decision comment, and that comment is the explicit written OK this item's
`accepted` status rests on ([`decisions/README.md`](README.md), "Silence never
accepts").

**1. An adoption record may exist, generated only.** One file, `agentic.config.json`, at
the adopted repository's root, written and rewritten only by `adopt`, never by hand.
Detection still runs on every read: the record pins what detection got wrong and nothing
else, and `adopt --inventory` reports every field where the record and `ci/lib/detect.mts`
now disagree, so the file cannot quietly outlive the repository it describes.

Invariant 4 (`AGENTS.md:44-45`, `CLAUDE.md:42-43`) gains exactly one sentence, which #163
copies verbatim into both contract files in the same pull request as the code:

> Detection remains the default, and the record is its output, not its replacement.

It arrives beside a clause that stops being true the day `adopt` writes a file, so
invariant 4 reads, in full, after #163:

> 4. **Detection is a default, never a contract.** New stacks go in `ci/lib/detect.mts`
>    with an env override path; the only file is `agentic.config.json`, written by
>    `adopt` and never by hand. Detection remains the default, and the record is its
>    output, not its replacement.

*Why:* the generated workflows (#165), the hooks (#166), the proof runner (#164) and
`doctor` (#168) all need the same answers, and each of them detecting them again is how
two readers of one fact drift apart. The alternative on the table — those values written
as environment variables into every generated workflow and nothing on disk — leaves no
single place to read from and no place to check against, and duplication kept in step by
hand is what this repository has already paid for twice: `scripts/init.mts:31` and the
Codex route's `.agents/skills/autonomous-loop/scripts/github.mts:152` still hold two label
dictionaries that a comment, not a check, keeps identical (#145 is the fix). The reference
implementations the owner pointed at all keep the proof harness's configuration in the
repository that runs it, for the same reason.

*Cost accepted:* one more file to keep in step with `ci/lib/detect.mts`, and someone will
eventually hand-edit it. The tooling therefore expects that rather than trusting the file:
`adopt` refuses to overwrite a record whose `generatedBy` is not this tool, `--record
--force` rewrites it and reports every field that changed, and `doctor` says a record was
hand-edited instead of reading it as gospel.

**2. `adopt` calls `init`.** One installer. `scripts/init.mts` keeps doing what it already
does (`:142-222`) and `adopt` wraps the inventory, the record, the generated checks and the
adoption pull request around it — including the "next, by hand" list at
`scripts/init.mts:324-337`, which is exactly the part `adopt` exists to automate.

*Why:* both alternatives cost more. Retiring `init` needs a migration for everyone already
installed and a milestone larger than this one; letting the two coexist means two
installers kept in step by hand, the same shape as the two label dictionaries above.

*Cost accepted, and the scope consequence:* `scripts/init.mts` and its tests are in scope
for M13. The milestone's draft kept that path out of every sub-issue's `## Files` until
this answer existed; from #163 onwards an issue may list it, sequenced after #143 and #145,
which also touch it. #163 itself still does not — its own acceptance criteria say so, and
the `adopt` → `init` call is a separate issue in this milestone.
