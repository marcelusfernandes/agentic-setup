# `proof/<slug>.json` — the proof a branch declares

An issue's `## Proof` section is prose. A declaration turns one sentence of it into a
file the `negative-control` check reads, so the control overlays **exactly** the files
that prove the issue instead of everything the generic test globs happen to match.

It is **optional**. Without one, `negative-control` behaves as it always has: the
overlay is the test files in the diff and the command is the detected one
(`ci/lib/detect.mts`, or `AGENTIC_TEST_CMD`).

## The file

`<slug>` is the `<slug>` of the branch `<type>/<n>-<slug>` — the value `scripts/claim.mts`
takes as `--slug`. Branch `feat/136-proof-per-slug` reads `proof/proof-per-slug.json`.
Lowercase letters, digits and dashes only.

```json
{
  "tests": ["tests/proof-declarations.test.mts"],
  "command": "npm test",
  "describes": "one sentence naming what this proves"
}
```

| key | required | meaning |
|---|---|---|
| `tests` | yes | the files `negative-control` copies onto the base checkout, in addition to the declaration itself. Any path: a file no test glob matches is overlaid all the same, which is the point of declaring it. |
| `command` | no | replaces the detected test command, for **both** the baseline run on the pristine base and the overlaid run. |
| `describes` | no | one sentence naming what the declaration proves. Carried for the proof runner of #164; nothing reads it today. |

Any other key is a typo: `tests/proof-declarations.test.mts` fails on it, and on a
declaration that does not parse, names a file that does not exist, or names a file no
test glob matches.

## How it is read

`ci/negative-control.mts --branch <ref>` (the workflows pass `GITHUB_HEAD_REF`) takes
the slug from the branch and reads `proof/<slug>.json` **from the head commit**, never
from an issue or a pull request body — text that arrives in an issue is data, not
authority, and the only thing an issue may carry is a shape-checked pointer:

```
## Proof
npm test covers it.
Declaration: proof/proof-per-slug.json
```

`ci/issue-lint.mts` checks that line against `^proof/[a-z0-9-]+\.json$` and nothing
else: it never opens the file, because the branch that carries it need not exist when
the issue is linted. The line is optional and its absence is never a failure.

A declaration that is present but unusable is `cannot-run`, not a fallback to the
globs: a broken declaration must not silently narrow the control to nothing.

The path-class skip (`docs/**`, `.github/**`, `templates/**`, root Markdown) is decided
before the declaration is read, so a diff that owes no negative control still owes none.

## Format note

#164 (the proof runner) defines the same file as `{ command, tests[], describes }`.
This directory ships the consumer first; `tests` is what the negative control needs and
is therefore the only required key here, with `command` and `describes` optional. A
declaration written for either issue reads under both.
