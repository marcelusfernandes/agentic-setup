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
| `tests` | yes | the files `negative-control` copies onto the base checkout, in addition to the declaration itself. They **replace** the diff's test files; they do not widen them. No test glob is consulted at all once a declaration is read, which is both how a file no glob matches is overlaid — the point of declaring it — and how a file every glob matches is left out. Each entry is relative to the repository root and must be in the head commit: an absolute path, a path that escapes the root once normalised (`..`), or a path the head does not have is `cannot-run` naming that path, before any file is written or removed, and never a deletion replayed on the base. The runner does not overlay anything, but it refuses a declaration naming a file the repository does not have (`proof:missing-test-file`) — #136 is the consumer of `tests[]`, and a declaration that points at nothing is broken wherever it is read. |
| `command` | no | replaces the detected test command, for **both** the baseline run on the pristine base and the overlaid run, and it is the command `scripts/proof.mts` runs. Both of those runs happen in the base worktree: **`negative-control` never executes the declared command at head.** A `proof/*.json` diff therefore proves that the command is red on the base with the declared files overlaid, and nothing at all about what it does at head — that is the repository's own test workflow's job, and the `SubagentStop` gate's. Omitting it is not an error: the runner then falls back to the record and to detection, and says so in `source`. |
| `describes` | no | one sentence naming what the declaration proves, for a person. Nothing executes it, and neither reader acts on its content. Both **validate** it: since #297 the two readers share one parser (`ci/lib/proof.mts`), so a `describes` that is present and blank is `proof:wrong-type` for the runner and `cannot-run` for the negative control, where it used to pass. For the declarations this repository ships, the pin test `tests/proof-declarations.test.mts` checks it as well. |

Any other key is a typo: `tests/proof-declarations.test.mts` fails on it, and on a
declaration that does not parse, names a file that does not exist, or names a file no
test glob matches. `scripts/proof.mts` refuses the same declarations with a named
`reason` (`proof:unknown-key`, `proof:empty-command`, …), and so does
`ci/negative-control.mts` — the two read the file with the same parser, `ci/lib/proof.mts`
(#297). The pin test also requires
every `tests` entry of a declaration *this repository ships* to match a test glob —
a rule for the files here, not part of the format.

## One parser, two readers

The format is parsed in exactly one place, `ci/lib/proof.mts`, which
`scripts/lib/proof.mts` and `ci/negative-control.mts` both import. Until #297 there were
two parsers: the runner refused an unknown key and a blank `describes`, the negative
control accepted both. A branch could therefore declare a proof one reader honoured and
the other rejected — and the reader that accepts more is the one deciding what CI
overlays, so the looser half won by default.

It lives under `ci/` and not under `scripts/` because `scripts/init.mts` copies `ci/`
into an adopting repository as `.github/scripts/agentic` and does not copy `scripts/`: a
parser under `scripts/lib/` would not exist where `negative-control` runs. The import
direction is the one already in the tree — `scripts/lib/proof.mts` imports
`ci/lib/detect.mts`.

**What the two still do differently, on purpose: where the file is.** The runner reads
the working tree, under the directory the adoption record names (`proof.dir`, default
`proof`). The negative control reads the head *commit*, under a hardcoded `proof/`,
because the record's reader is `scripts/lib/adopt/record.mts` and `init` does not copy
it. Honouring `proof.dir` in the check means moving that reader under `ci/` first. The
two agree on what a declaration *means*; they do not yet agree on where it lives.

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
globs: a broken declaration must not silently narrow the control to nothing. A fallback
would report "we could not verify this" as "this passed", which is the one thing the
negative control exists to prevent. The causes, each naming the path it rejected:

| cause | what the check saw |
|---|---|
| unreadable | the declaration is in the head tree and `git show` could not read it — a corrupt or missing object, or a `git` that could not run |
| unparsable | the text is not JSON, or not a JSON object |
| no `tests` | `"tests"` is absent, empty, or not an array of non-empty strings |
| bad `command` | `"command"` is present and is not a non-empty string |
| unknown key | it carries a key outside `tests`/`command`/`describes`; the cause names it (#297) |
| bad `describes` | `"describes"` is present and is not a non-empty sentence (#297) |
| path outside the checkout | a `tests` entry is absolute, or escapes the repository root once normalised (`..`) |
| path absent at head | a `tests` entry names a file the head commit does not have |

Presence is decided from the head **tree** (`git ls-tree`), never from the exit status of
`git show`: only "absent from the head commit" means "this branch declares nothing".
`git show` fails the same way for an absent path, a corrupt object and a `git` that
cannot run, so its status alone cannot tell the four apart — and reading the other three
as the first is exactly the silent fallback above. The path checks run before the base
worktree is made, so a rejected declaration removes and writes nothing.

The path-class skip (`docs/**`, `.github/**`, `templates/**`, `.claude/**`, and Markdown
anywhere in the tree — minus `.github/scripts/agentic/**`, the gate's own code in an
adopting repository, which no class covers) is decided before the declaration is read, so
a diff that owes no negative control still owes none.

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

### The two limits on a run

Both readers run a command, and both bound it in two dimensions (#297). `spawnSync`
defaults to a 1 MiB buffer and to no timeout at all, so a suite that printed more than a
megabyte came back as a command that could not be executed, and a command that hung hung
whatever was waiting on it with no verdict ever.

| limit | default | override | what it is |
|---|---|---|---|
| buffer | 64 MiB | `AGENTIC_RUN_MAX_BUFFER` (bytes) | how much of the run's output is held in memory |
| timeout | 30 minutes | `AGENTIC_RUN_TIMEOUT_MS` (milliseconds) | how long the run may take before it is killed |

A run killed by either is reported as that and not as `proof:command-not-runnable`: the
command *did* run, and these two are the only causes an operator clears by raising a
number. The overrides are detection-style defaults, never a contract (invariant 4) — and
an override can raise a limit until it stops limiting, which is the operator's to decide.

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
| `proof:output-too-large` | the command ran and printed more than the buffer holds; raise `AGENTIC_RUN_MAX_BUFFER` |
| `proof:command-timed-out` | the command ran and was killed for outliving the timeout; raise `AGENTIC_RUN_TIMEOUT_MS` |
| `record:…` | the adoption record is not the shape; `scripts/lib/adopt/record.mts` names the reason and the field |

### Where each reader reads from

`ci/negative-control.mts --branch <ref>` reads the declaration from the **head commit**
(`git ls-tree` for presence, then `git show <head>:proof/<slug>.json` for the content):
CI judges a commit, and a file only present in a runner's working tree proves nothing.
`scripts/proof.mts` reads the **working tree**: it is run by a person or an agent in a
checkout, on the state that is actually there.

It reads the declaration from head and then *runs* only on the base: the baseline and the
overlaid run both happen in a worktree of the pull request's base, so the declared
`command` is never executed at head by this check. The runner is what executes it in a
head checkout.

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
