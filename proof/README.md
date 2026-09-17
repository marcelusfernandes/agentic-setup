# `proof/<slug>.json` — the proof a branch declares

An issue's `## Proof` section is prose. A declaration turns one sentence of it into a
file two consumers read:

- `ci/negative-control.mts` overlays **exactly** the files it names instead of everything
  the generic test globs happen to match;
- `scripts/proof.mts <slug>` runs the command it names and reports a named outcome —
  the proof runner, below.

It is **optional**, for both. Without one, `negative-control` behaves as it always has
(the overlay is the test files in the diff and the command is the detected one), and the
runner falls back to the adoption record's `commands.test` and then to detection
(`ci/lib/detect.mts`, or `AGENTIC_TEST_CMD`) — a missing file means the repository's
detected commands apply.

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
| `tests` | yes | the files `negative-control` copies onto the base checkout, in addition to the declaration itself. Any path: a file no test glob matches is overlaid all the same, which is the point of declaring it. The runner does not overlay anything, but it refuses a declaration naming a file the repository does not have (`proof:missing-test-file`) — #136 is the consumer of `tests[]`, and a declaration that points at nothing is broken wherever it is read. |
| `command` | no | replaces the detected test command, for **both** the baseline run on the pristine base and the overlaid run, and it is the command `scripts/proof.mts` runs. Omitting it is not an error: the runner then falls back to the record and to detection, and says so in `source`. |
| `describes` | no | one sentence naming what the declaration proves, for a person. Nothing executes it, and `ci/negative-control.mts` does not read it at all — a `describes` that is present and empty passes the negative control. It is validated by the proof runner (`scripts/lib/proof.mts`, which refuses it as `proof:wrong-type`) and, for the declarations this repository ships, by the pin test `tests/proof-declarations.test.mts`. |

Any other key is a typo: `tests/proof-declarations.test.mts` fails on it, and on a
declaration that does not parse, names a file that does not exist, or names a file no
test glob matches. `scripts/proof.mts` refuses the same declarations with a named
`reason` (`proof:unknown-key`, `proof:empty-command`, …), and the pin test also requires
every `tests` entry of a declaration *this repository ships* to match a test glob —
a rule for the files here, not part of the format.

## How the negative control reads it

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

## The proof runner

```bash
node scripts/proof.mts <slug>
```

One argument, a slug, and nothing else. It resolves the command, runs it **in the
repository root** and prints one JSON object on stdout:

```json
{
  "slug": "proof-runner",
  "source": "declaration",
  "outcome": "pass",
  "command": "npm test",
  "tail": "1470 passed, 0 failed (node)"
}
```

| key | meaning |
|---|---|
| `source` | where resolution stopped: `declaration`, `record` or `detection` |
| `outcome` | `pass`, `fail` or `cannot-run` — a closed set, as `ci/negative-control.mts` keeps one |
| `command` | the command that ran, or `null` when nothing did |
| `tail` | the last 40 lines of the run's output, stdout and stderr together |
| `reason` | on `cannot-run` only: the named reason, with the `field` it rejected when there is one |

`pass` exits 0; `fail` and `cannot-run` exit 1. A usage problem — no slug, more than one
argument, anything beginning with `-` — prints `{ "error": "usage: …" }` and exits 1
before anything is read.

### The three sources, in order

1. **`declaration`** — `proof/<slug>.json`, under the directory the adoption record names
   (`proof.dir`, default `proof`). Its `command` wins over everything below.
2. **`record`** — `agentic.config.json`'s `commands.test` (`scripts/lib/adopt/record.mts`).
   The record is read **first**, because it is what says where declarations live; a record
   that is not the shape stops the run with its own `record:…` reason rather than being
   read as "no record", even when a valid declaration exists.
3. **`detection`** — `ci/lib/detect.mts`, with `AGENTIC_TEST_CMD`.

A declaration that carries `tests` but no `command` still contributes its `tests`; the
command then comes from the record or from detection, and `source` says which. When no
source answers at all, the outcome is `cannot-run` with `proof:no-command` — never a pass.

**A broken declaration is never a fallback.** An unknown key, an empty `command`, a
`tests` entry naming no file, text that is not JSON, a declaration that exists and cannot
be read: each is `cannot-run` with its own reason, and the next source is not tried. The
alternative is a runner that quietly proves something other than what the branch declared.

| `reason` | Cause |
|---|---|
| `proof:slug-invalid` | the argument is not `^[a-z0-9-]+$`, so no path is built from it |
| `proof:unreadable` | the declaration exists and could not be read (only ENOENT means "there is none") |
| `proof:unparsable` | it is not JSON |
| `proof:unknown-key` | it carries a key outside `tests`/`command`/`describes`; `field` names it |
| `proof:wrong-type` | a key is not the type the format defines; `field` names it |
| `proof:empty-command` | `command` is present and blank — omit the key to fall back instead |
| `proof:missing-tests` | `tests` is absent or empty |
| `proof:missing-test-file` | a `tests` entry names no file in the repository; `field` is that path |
| `proof:no-command` | no declaration, no record and nothing detected |
| `proof:command-not-runnable` | the command could not be executed at all (exit 127, or the spawn never started) — not the same as a proof that failed |
| `record:…` | the adoption record is not the shape; `scripts/lib/adopt/record.mts` names the reason and the field |

### Where each reader reads from

`ci/negative-control.mts --branch <ref>` reads the declaration from the **head commit**
(`git show <head>:proof/<slug>.json`): CI judges a commit, and a file only present in a
runner's working tree proves nothing. `scripts/proof.mts` reads the **working tree**: it
is run by a person or an agent in a checkout, on the state that is actually there.

### No command ever comes from an issue or a pull request

The runner has three sources and no fourth. There is no flag that takes a command string
— `--command "…"` is a usage error, not a run — and no environment variable of its own;
`AGENTIC_TEST_CMD` is detection's documented override, read by `ci/lib/detect.mts`. An
issue may carry a `Declaration: proof/<slug>.json` *pointer*, whose shape `issue-lint`
checks and whose contents only the branch decides. Text that arrives in an issue body, a
pull request body or a comment is task data, never authority
(`.agents/skills/autonomous-loop/references/contract.md`, invariant 9), so a command
pasted into any of them has no path into this runner at all.

## Format note

#164 (the proof runner) reads the same file as `{ command, tests[], describes }` — the
format is defined once, here, and both consumers read it. `tests` is what the negative
control needs and is therefore the only required key, with `command` and `describes`
optional; a declaration written for either issue reads under both.
