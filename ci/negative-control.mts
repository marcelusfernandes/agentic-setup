#!/usr/bin/env node
// negative-control — the tests a PR adds must fail without the PR's change.
//
// Checks out the PR's base in a temporary worktree, first runs the project's
// test command there UNCHANGED (the baseline), then copies ONLY the test
// files from the PR's diff on top of it and runs the command again,
// requiring that second run to fail. Outcomes:
//   skipped      every file the PR changes sits in a skipped path class
//                (SKIP_PATH_GLOBS below, extended by AGENTIC_SKIP_GLOBS) —
//                docs, workflows, templates, Markdown anywhere in the tree
//                and session configuration owe no negative
//                control. One path is carved out of every class,
//                AGENTIC_SKIP_GLOBS included: NEVER_SKIP_GLOBS, the gate's
//                own code in an adopting repository
//   pass         the baseline was green, the overlaid run failed, and at
//                least one failure in that run names a file the overlay
//                placed — the tests bite. When the same run also carries a
//                failure naming nothing overlaid, the outcome stays `pass`
//                and a `warning:` line names that unrelated red
//   unattributed the baseline was green and the overlaid run failed, but no
//                failure in it names any overlaid file. Something else was
//                already broken — a flake, a regression on the base's own
//                suite, a rate limit — and crediting it to the overlay is a
//                `pass` on a change nothing depends on (#354). Its detail
//                names the failures the run did report, so the reader can act
//                on the unrelated red instead of re-running and hoping. It is
//                deliberately not `vacuous`: "nothing depended on the change"
//                and "something else was already broken" are different facts
//   structural   the overlaid run failed only structurally (a missing module,
//                a missing export, a syntax error) and no `test(red):` commit
//                in base..head touches any of the overlaid test files
//   vacuous      the baseline was green and the overlaid run also passed — the
//                tests prove nothing. Its detail names the usual cause, an
//                entry point that enumerates its test directories: a
//                brand-new test tree is invisible to it on the base, so the
//                verdict is about the entry point, not the tests. The entry
//                point is overlaid only when a test glob matches its path or
//                a declaration's `tests` names it — the same two routes that
//                let the fix prove itself in the PR that makes it
//   test-only    the baseline was green, the overlaid run also passed, and the
//                overlay withheld nothing the diff changed: every changed file
//                is a test file by TEST_FILE_GLOBS *as written below* and every
//                one of them was overlaid, so the second run is the pull
//                request's own suite with no part of its change absent for a
//                test to bite on. No red was available, and none ever will
//                be. Deliberately not
//                `vacuous`: that says nothing *depended* on the change and is
//                cleared by writing a test that bites, while this says nothing
//                *could have* depended on it and no test clears it. It passes
//                the check (#355); see the note below for what carries the
//                weight instead
//   no-tests     the diff adds or changes no test files
//   cannot-run   the test command could not be found or detected, it ran and
//                outran one of the two limits below, or the branch's
//                `proof/<slug>.json` could not be read as written.
//                When nothing was detected, the detail names the escape a
//                repository has whatever its stack: a `Makefile` with a
//                `test:` target, which ci/lib/detect.mts reads first. The
//                declaration's causes, each naming the path it rejected:
//                it does not parse, it is not a JSON object, it has no
//                `"tests"` array, its `"command"` is not a non-empty string,
//                it carries a key the format does not define, its
//                `"describes"` is not a non-empty sentence,
//                a declared path is absolute or escapes the repository root
//                once normalised, a declared path is absent from the head
//                commit, or the declaration exists at head and its blob
//                cannot be read. A run that printed more than
//                AGENTIC_RUN_MAX_BUFFER holds, or that outlived
//                AGENTIC_RUN_TIMEOUT_MS, is named as that rather than as a
//                command that could not be executed: only those two are
//                cleared by raising a limit (#297)
//   inconclusive the baseline itself failed, before the overlay — a base that
//                cannot run its own tests makes the negative control unable
//                to discriminate anything
//
// A structural red says the test file could not run at all on the base, not
// that an assertion caught the change, and an opaque test command cannot tell
// one crashing file apart from several real failures. It is accepted only
// when the PR shows the red was written on purpose: a commit in base..head
// whose subject starts `test(red):` and which touches at least one of the
// overlaid test files. Then the outcome stays `pass` and the `warning:` line
// nudging toward a throwing stub is still printed and summarised; without
// such a commit the outcome is `structural` and the check fails.
//
// The signature is read per *diagnostic block* — a maximal run of
// consecutive non-blank lines — and counts only when that same block also
// names an overlaid test file or a file the diff touches, which is what a
// stack frame or a Node error header does. Matching the overlaid run's whole
// output instead let one unrelated structural-looking line (a dependency
// logging `Cannot find module` and carrying on, printed in a block of its
// own) flip an honest assertion red to `structural` (#214).
//
// Deciding a `pass` asks the same question of the failures: at least one of
// them must name a file the overlay placed. It reuses the naming predicate
// the structural read uses (`namesOverlay`, extended to the file's basename
// because runners print one), but reads it per *failure line* rather than per
// block, with the block kept for the one shape where a failure and the file
// it happened in are on different lines: a stack trace, where the overlaid
// file appears as a source location (`<path>:<line>` or a `file://` URL).
// A second granularity is needed because a block cannot discriminate here:
// this repository's own runner prints one `<file>: N passed, M failed` line
// per test file and, since #415, a `<file>: note …` line for every line a
// *passing* file marked for an operator, continuation lines included and
// marked too (#432) — all of them consecutively and with no blank line
// between them, so the whole listing is a single block in which every
// overlaid name sits beside every unrelated red, which is exactly the run
// that produced the false pass this rule exists for (#354, run
// `35405433899`). The `note` half of that description is the reason for the
// paragraph below (invariant 8, #428).
//
// **A line a passing file wrote is not evidence** (#428). Those `note` lines
// are free text a *green* file chose to print — a rate limit it skipped a row
// over, a `gh` or `git` error it carried on from — and each of the three
// readings above took them for a failure. A note matching FAILURE_SIGNATURE
// on its `Error:` made `mentioned` true through its own `<file>: ` prefix,
// turning `unattributed` into `pass`. A note carrying `Cannot find module`
// put a structural token into the one block that already names every overlaid
// file, turning an honest red into `structural` — or, when a `test(red):`
// commit vouches for the red, into a `pass` with the structural warning and
// no attribution test at all. And a note *continuation* carrying a source
// location reached `locatesOverlay`, which owns every other failure in its
// block and empties `elsewhere`: `unattributed` became a `pass` that had also
// lost the warning naming the unrelated red, which is the strongest of the
// three. All four were measured by running this check over one captured
// listing with and without the line; `tests/negative-control.test.mts` holds
// that listing and the four pairs.
//
// So every such line is dropped from what the two predicates read
// (`NOTE_LINE` below), and from nothing else: a verdict's detail still prints
// the run's output whole, notes and all, because an operator reading why a
// run was refused wants the line the file meant them to see.
//
// Why the marker and not the block. Attributing only within a failing file's
// block cannot discriminate here, for the reason the paragraph above gives —
// the listing is one block, so every overlaid name is already in it, note or
// no note. The marker is the only thing in the line that says a *passing*
// file wrote it, which is why #432 put it on continuation lines too: the
// whole exposure then sits inside one discriminator. Nothing here reads
// blocks, so a blank line appearing in that listing changes none of it, and
// dropping a line never merges two blocks either, because the blank lines
// around it stay where they were. Blanking the line instead of dropping it
// would split its block and change how every other line in it is read.
//
// What keying on the marker costs, since a line can carry it by accident. A
// failing file's output is printed verbatim, so a file whose own output
// contains `<name>.<ext>: note ` at the start of a line — in practice only
// `tests/run.test.mts`, which quotes this runner's log in its failure detail
// — has that line ignored as evidence too. Dropping evidence usually moves a
// verdict *toward* refusal: a mention or an owner lost is `unattributed`, a
// structural diagnostic lost is a red that has to attribute itself. It can
// move one toward `pass`, when the dropped line was the only `elsewhere`
// entry contradicting a mention. That direction is the rule working rather
// than failing — a note is inert in both directions or it is not inert — and
// it costs a failing file printing a runner-shaped note line that carries
// another file's non-zero failure count.
//
// The note is the only free text a *passing* file gets into this log, checked
// by reading the two places `tests/run.mts` prints for a green child: its
// `<file>: N passed, M failed` summary and `printNotes`. A failing file's
// output is printed whole and is deliberately not covered — that file failed,
// and its output is what this check is for. Nor is an adopting repository
// covered: `scripts/init.mts` copies this file into repositories whose runner
// is not `tests/run.mts`, and free text *their* runner prints for a passing
// file carries no marker this rule can see.
//
// The skip is by path class, not by the PR's own labels: the implementer
// applies its own PR's labels, so a `type:` label could buy its own
// exemption. `type:docs`/`deps`/`infra`/`refactor`/`spec` are still read —
// for one release — but only to print a `note:` line saying they no longer
// skip on their own, and to name the label in a skip the path class already
// decided. AGENTIC_SKIP_GLOBS (comma-separated, env only, no config file)
// adds path classes; `*` never crosses a `/` (ci/lib/globs.mts), so Markdown
// anywhere in the tree needs `**/*.md`, not `*.md` alone — a card under
// `skills/` or `agents/` is Markdown just as much as a root `README.md`.
// NEVER_SKIP_GLOBS is the one carve-out no
// class may override: `scripts/init.mts` copies this repository's `ci/` into
// an adopting repository's `.github/scripts/agentic/`, so the `.github/**`
// class would otherwise let a PR rewrite the gate's own code under the gate's
// own exemption.
//
// `--base`/`--head` are a supported interface, not an implementation detail:
// being able to re-run this check by hand, against CI's own base, is what let
// an implementer compare a local `vacuous` with a CI `pass`, eliminate the
// stale-base and merge-ref explanations by measurement, and find the false
// pass #354 is about. A stricter verdict nobody can reproduce by hand would
// be worth less than the defect it removes, so the verdict that change added,
// `unattributed`, prints the two-argument invocation that reproduces it —
// base and head filled in, and `--branch` when one was passed.
//
// Inputs: --base <sha> --head <sha> (or the pull_request event), labels from
// the event or --labels a,b, and --branch <ref> (or the event's head ref)
// naming the head branch. Test files: TEST_FILE_GLOBS below, extended
// with AGENTIC_TEST_GLOBS (comma-separated). Test command: ci/lib/detect.mts
// or AGENTIC_TEST_CMD. For Node projects the head checkout's node_modules is
// linked into the base worktree so nothing is reinstalled.
//
// A branch may declare its own proof (#136). When --branch names a
// `<type>/<n>-<slug>` branch and `proof/<slug>.json` exists at head, that
// file — `{ "tests": [...] }`, optionally `"command"` — decides the run:
// the overlay is exactly the files it names plus the declaration itself (no
// test glob is consulted, so a proof that lives outside the usual test
// paths is still overlaid), and `command` replaces the detected test
// command for both runs. It is read from the head *commit*, never from an
// issue or PR body (invariant 9): the slug comes from the branch, and the
// only thing an issue carries is a `Declaration:` line that `issue-lint`
// checks the shape of. The declaration is read and validated by
// `ci/lib/proof.mts`, the module `scripts/lib/proof.mts` reads it with too,
// so the runner and this check cannot accept one file and reject it: two
// parsers meant a branch could declare a proof one honoured and the other
// refused, and the looser of the two is the one that decides what is
// overlaid (#297).
//
// The declaration fails closed, and why each refusal is the shape it is
// belongs with the reader: `ci/lib/proof.mts` states it, including why
// presence comes from the head *tree* and never from the exit status of
// `git show`. What this file owes the reader is the consequence. Every
// refusal is `cannot-run`, named path and all, before any worktree is made,
// because a fall back to the detected globs would report "we could not
// verify this" as "this passed" — the one thing this check exists to
// prevent. Without a declaration nothing changes, including the path-class
// skip, which is decided before the declaration is read.
//
// `test-only` is the one verdict that passes without any red at all, so what
// it rests on is written out here (#355). The overlay is a comparison: head's
// test files on a base that lacks the rest of the change. What makes a red
// available is the part of the diff it *withholds*. When it withholds
// nothing, the second run is the pull request's own suite on the pull
// request's own tree — green exactly when the `test` check is green — and
// requiring it to fail is requiring the pull request's own tests to fail. No
// test-only pull request could ever land, and none has: 150 commits of this
// repository's `main` were read and not one is confined to the test globs.
// The class is two facts, both read off `git diff` and neither claimable by a
// pull request: the overlay carried every changed file, and every changed
// file is a test file by TEST_FILE_GLOBS as written in this file.
// AGENTIC_TEST_GLOBS and a declaration's `tests` decide what is *overlaid*
// and deliberately do not decide the *class*: letting either in would let a
// repository variable, or the implementer's own declaration, call a
// production file a test and buy the verdict for it. What carries the weight
// instead: nothing outside the test globs changed, so there is no unproved
// production change to carry; the overlaid run is the pull request's own
// suite, which is the `test` check's business; `scope` holds those test paths
// to the linked issue's globs; and whether a test-only change strengthens or
// weakens the suite is the reviewer's, because the overlay carries the change
// either way and so could never have told the two apart.
//
// Both runs — the baseline and the overlaid one — happen in the base
// worktree, so a declared `command` is only ever executed against the base;
// that the same command passes at head is the repository's own test check's
// job, not this one's (`proof/README.md`).
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { parseArgs } from './lib/args.mts';
import { attributeFailures, structuralInOverlay } from './lib/attribution.mts';
import { detectCommands } from './lib/detect.mts';
import { SKIP_PATH_GLOBS } from './lib/skip-paths.mts';
import { branchSlug, headDeclarationPath, KNOWN_KEYS, ProofError, readDeclarationAtHead, validateDeclaredPaths } from './lib/proof.mts';
import type { Declaration } from './lib/proof.mts';
import { matchesAny } from './lib/globs.mts';
import { appendSummary } from './lib/summary.mts';

// Read for one release only, to print a `note:` and to name the label in a
// skip the path class already decided. They never skip on their own: the
// implementer applies its own PR's labels.
const LEGACY_SKIP_LABELS = ['type:docs', 'type:deps', 'type:infra', 'type:refactor', 'type:spec'];
// The primary skip is `SKIP_PATH_GLOBS`, imported above from
// `ci/lib/skip-paths.mts` because `scripts/land.mts` asks the same question of
// the same classes and used to hold a second copy of them (#412, from #370).
// The carve-out below is *not* shared: land.mts narrows its own by two more
// globs, and that difference is a decision rather than drift — see that file.
//
// The carve-out from every skipped class, AGENTIC_SKIP_GLOBS included.
// `scripts/init.mts` copies this repository's `ci/` — this file among them —
// into an adopting repository's `.github/scripts/agentic/`, which `.github/**`
// would otherwise swallow whole: a pull request rewriting the gate would be
// skipped by the gate. A mechanism that can exempt a change to itself is not
// a gate, so this one is not an operator's to switch off (#214).
const NEVER_SKIP_GLOBS = ['.github/scripts/agentic/**'];
const TEST_FILE_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/*_test.go', '**/test_*.py', '**/*_test.py',
  '**/tests/**', '**/test/**', '**/__tests__/**', 'e2e/**', 'spec/**',
];
const TAIL = 40;
// How much of the overlaid run's own failure report a verdict repeats back.
const FAILURES_SHOWN = 10;
const FAILURE_WIDTH = 200;

/** A positive integer from `value`, or `fallback` when it is absent or is not one. */
const limit = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * How much of each run's output this check holds in memory. `spawnSync`
 * defaults to 1 MiB, and a command that prints more is killed with ENOBUFS,
 * which arrives here as "the command could not be executed" — so a suite that
 * was merely noisy was reported as a broken one, on a check whose whole job is
 * to read that output. 64 MiB is past anything this repository's own suite has
 * printed and still far below a runner's memory. AGENTIC_RUN_MAX_BUFFER
 * (bytes) raises or lowers it; an override can raise it until it stops
 * limiting, which is the operator's to decide (invariant 4).
 */
const RUN_MAX_BUFFER = limit(process.env.AGENTIC_RUN_MAX_BUFFER, 64 * 1024 * 1024);

/**
 * How long either run may take. `spawnSync` has no timeout by default, so a
 * test command that hangs on the base hangs the job until the workflow's own
 * limit — hours later, with no verdict and nothing to read. 30 minutes is well
 * past this repository's own suite and well short of a job timeout.
 * AGENTIC_RUN_TIMEOUT_MS raises or lowers it.
 */
const RUN_TIMEOUT_MS = limit(process.env.AGENTIC_RUN_TIMEOUT_MS, 30 * 60 * 1000);

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();

type Outcome = 'skipped' | 'pass' | 'test-only' | 'unattributed' | 'structural' | 'vacuous' | 'no-tests' | 'cannot-run' | 'inconclusive';

/** A comma-separated env list, trimmed, empty entries dropped. */
const csv = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// What a `pass` says when the overlaid run's red was structural after all: a
// structural failure reads as red for the wrong reason — the file could not
// run at all, not that an assertion caught the change. `structuralInOverlay`
// (`ci/lib/attribution.mts`) decides when that is the case.
const STRUCTURAL_WARNING =
  'the red on the base looks structural (missing module or export), not an assertion — prefer a throwing stub so the red is a runtime red (safe-worktree §B7)';

/**
 * A line this repository's runner printed on behalf of a *passing* test file:
 * `<file>: note ` and then whatever that file marked, continuation lines
 * included (`tests/run.mts`, #415 and #432). The shape is mirrored here by
 * hand rather than imported — that file runs a suite at import, and invariant
 * 10 asks a pin to write out the shape it pins anyway. The token before the
 * colon is file-shaped, the same thing `FILE_VERDICT` looks for, which keeps
 * a prose `something: note ` out of it. `tests/run.test.mts` pins the
 * printing side and `tests/negative-control.test.mts` pins this one; a change
 * to either owes a visit to the other.
 */
const NOTE_LINE = /^[^\s:]+\.[A-Za-z0-9]{1,6}: note\s/;

/**
 * `output` with every one of those lines dropped — what the two predicates
 * read, and the whole of the fix for #428. Dropped, never blanked: a blank
 * line splits the diagnostic block it sits in, which would change how every
 * other line in that block is attributed.
 */
const withoutNotes = (output: string): string =>
  output.split('\n').filter((line) => !NOTE_LINE.test(line)).join('\n');

/** At most `FAILURES_SHOWN` reported failures, one per line, for a detail. */
const listFailures = (failures: string[]): string => {
  const shown = failures.slice(0, FAILURES_SHOWN).map((line) => `  - ${line.slice(0, FAILURE_WIDTH)}`);
  const rest = failures.length - shown.length;
  return [...shown, ...(rest > 0 ? [`  - … and ${rest} more`] : [])].join('\n');
};

function finish(outcome: Outcome, detail: string, warning?: string): never {
  // `test-only` passes: the control could not put a question to this diff at
  // all, and a gate that refuses what it cannot judge refuses forever (#355).
  const ok = outcome === 'skipped' || outcome === 'pass' || outcome === 'test-only';
  const summaryWarning = warning ? `\n\n> warning: ${warning}` : '';
  appendSummary(`## negative-control\n\n${ok ? '' : '**FAILED** — '}\`${outcome}\` — ${detail}${summaryWarning}`);
  console.log(`negative-control: ${outcome} — ${detail}`);
  if (warning) console.log(`warning: ${warning}`);
  process.exit(ok ? 0 : 1);
}

function readEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function git(gitArgs: string[], cwd: string = root): string {
  const r = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

const event = readEvent();
const base = String(args.base ?? event?.pull_request?.base?.sha ?? '');
const head = String(args.head ?? event?.pull_request?.head?.sha ?? '');
if (!base || !head) finish('cannot-run', 'no base/head (pass --base/--head or run on a pull_request event).');

const labels = typeof args.labels === 'string'
  ? args.labels.split(',').map((l) => l.trim())
  : (event?.pull_request?.labels ?? []).map((l: { name: string }) => l.name);
const legacyLabel = LEGACY_SKIP_LABELS.find((l) => labels.includes(l)) ?? null;

const changed = git(['diff', '--no-renames', '--name-only', `${base}...${head}`]).split('\n').map((l) => l.trim()).filter(Boolean);

// The primary skip: every changed file sits in a skipped path class. An
// empty diff is not a skip — it falls through to `no-tests`.
const skipGlobs = [...SKIP_PATH_GLOBS, ...csv(process.env.AGENTIC_SKIP_GLOBS)];
/** In a skipped class, unless it is the gate's own code, which never is. */
const inSkippedClass = (file: string): boolean =>
  matchesAny(file, skipGlobs) && !matchesAny(file, NEVER_SKIP_GLOBS);
const gateCode = changed.filter((f) => matchesAny(f, NEVER_SKIP_GLOBS));
if (gateCode.length > 0) {
  console.log(`note: ${gateCode.length} changed file(s) under ${NEVER_SKIP_GLOBS.map((g) => `\`${g}\``).join(', ')} — this repository's gate code, copied there by \`scripts/init.mts\` — are never in a skipped path class, so the negative control runs whatever the rest of the diff is: ${gateCode.map((f) => `\`${f}\``).join(', ')}.`);
}
if (changed.length > 0 && changed.every(inSkippedClass)) {
  const alsoLabelled = legacyLabel ? ` The PR also carries \`${legacyLabel}\`, which no longer skips on its own.` : '';
  finish(
    'skipped',
    `every changed file sits in a skipped path class (${skipGlobs.map((g) => `\`${g}\``).join(', ')}); no negative control expected.${alsoLabelled}`,
  );
}
if (legacyLabel) {
  console.log(`note: \`${legacyLabel}\` no longer skips the negative control by itself — the skip is by path class (set AGENTIC_SKIP_GLOBS to add one). The label is read for backward compatibility for one release.`);
}

// --- the proof a branch declares, when it declares one (#136) -------------

/**
 * The check's own sentence for a declaration `ci/lib/proof.mts` refused. The
 * reason is the contract and the phrasing is this file's: an operator reads
 * these in a job summary, where "has no `"tests"` array of file paths" says
 * more than a reason name does. `detail` is the underlying cause — what
 * `JSON.parse` or `git` said — which the reason alone cannot carry.
 */
function declarationWhy(error: ProofError): string {
  const because = error.detail ? ` (${error.detail})` : '';
  switch (error.reason) {
    case 'proof:unparsable':
      return `does not parse as JSON${because}`;
    case 'proof:unknown-key':
      return `carries \`"${error.field}"\`, which is not part of a proof declaration (${KNOWN_KEYS.join(', ')})`;
    case 'proof:missing-tests':
      return 'has no `"tests"` array of file paths';
    case 'proof:empty-command':
      return 'has a `"command"` that is not a non-empty string';
    case 'proof:wrong-type':
      if (error.field === 'tests') return 'has no `"tests"` array of file paths';
      if (error.field === 'command') return 'has a `"command"` that is not a non-empty string';
      if (error.field === 'describes') return 'has a `"describes"` that is not a non-empty sentence';
      return 'is not a JSON object';
    default:
      return `${error.message}${because}`;
  }
}

const branchRef = typeof args.branch === 'string' ? args.branch.trim() : String(event?.pull_request?.head?.ref ?? '').trim();
const slug = branchRef ? branchSlug(branchRef) : null;
if (branchRef && !slug) {
  console.log(`note: \`${branchRef}\` is not a \`<type>/<n>-<slug>\` branch, so no proof declaration is looked up for it.`);
}
let declaration: Declaration | null = null;
if (slug) {
  try {
    const declared = readDeclarationAtHead(root, head, slug);
    declaration = declared ? validateDeclaredPaths(root, head, declared) : null;
  } catch (error) {
    if (!(error instanceof ProofError)) throw error;
    finish(
      'cannot-run',
      `\`${headDeclarationPath(slug)}\` ${declarationWhy(error)}. A proof declaration decides what is overlaid; a broken one must not narrow the control silently.`,
    );
  }
}
if (declaration) {
  console.log(`note: \`${declaration.path}\` declares this branch's proof; the overlay is the ${declaration.tests.length} file(s) it names${declaration.command ? ` and its command \`${declaration.command}\`` : ''}.`);
}

const extraGlobs = csv(process.env.AGENTIC_TEST_GLOBS);
const testFiles = declaration
  ? [...new Set([...declaration.tests, declaration.path])]
  : changed.filter((f) => matchesAny(f, [...TEST_FILE_GLOBS, ...extraGlobs]));
// Which of the overlaid files the declaration vouched for. A path from the
// diff that is gone at head was deleted by the pull request; a declared path
// was proved to be at head above, so the same failure there means the content
// could not be read — two different facts that must not share a branch.
const declaredPaths = new Set(declaration ? [...declaration.tests, declaration.path] : []);
// The two facts that make the overlay incapable of a red, read off `git diff`
// alone (#355). `withheld` is the part of the change the second run did not
// see — the only thing a test there could bite on. `notATestFile` is what
// keeps the class from being claimable: TEST_FILE_GLOBS without the env
// extension and without the declaration's `tests`, plus the declaration's own
// path, since a branch that declares its proof has still changed nothing but
// tests. Both empty is `test-only`; either non-empty and the diff is judged
// as it always was. `changed` is three-dot, so a base that moved on since the
// branch is a tree the overlay does not reconstruct — and a red there is a
// real red, decided by the branches above. This verdict is only ever reached
// after the overlaid run came back green, so it reports what was measured.
const overlaidPaths = new Set(testFiles);
const withheld = changed.filter((f) => !overlaidPaths.has(f));
const notATestFile = changed.filter((f) => !matchesAny(f, TEST_FILE_GLOBS) && f !== declaration?.path);
/** The files that keep this diff inside the control, for a `vacuous` to name. */
const keptInTheControl = [...new Set([...withheld, ...notATestFile])].map((f) => `\`${f}\``).join(', ');
/**
 * How a `vacuous` verdict tells the reader to get the entry point into the
 * overlay — and only by a route that is open to this diff (#297, AC5).
 *
 * A declaration replaces the diff's test files outright: no test glob is
 * consulted once one is read, so half of the sentence this used to print —
 * the globs, and the variable that extends them — was advice a branch with a
 * declaration could act on and see nothing change. Naming both routes when
 * only one is live is the same defect in prose that the check spends its
 * verdicts on in code.
 */
const overlayRoute = declaration
  ? `The entry point is overlaid only when \`${declaration.path}\` names it in its \`tests\`, which here is ${declaration.tests.map((f) => `\`${f}\``).join(', ')}: this branch declares its proof, so no test glob is consulted at all and extending one would change nothing here. So make the entry point discover its tests rather than list them, and either add it to that \`tests\` list, which proves the fix in this same PR, or name the discovering command as the \`command\` of \`${declaration.path}\`, which replaces the detected command for both runs.`
  : 'The entry point is overlaid only when it is one of the overlaid files — a path a test glob matches (TEST_FILE_GLOBS, extended by AGENTIC_TEST_GLOBS) or a path `proof/<slug>.json` names in its `tests`. So make the entry point discover its tests rather than list them, and either keep it in the overlay by one of those two routes, which proves the fix in this same PR, or name the discovering command as the `command` of `proof/<slug>.json`, which replaces the detected command for both runs.';
if (testFiles.length === 0) finish('no-tests', 'the diff changes no test files, and it is not confined to a skipped path class; add the test that fails first (`test(red):`), declare the proof in `proof/<slug>.json`, or add the path class to AGENTIC_SKIP_GLOBS.');

const commands = detectCommands(root);
const testCommand = declaration?.command ?? commands.test;
if (!testCommand) finish('cannot-run', 'no test command detected; set AGENTIC_TEST_CMD in the workflow, name the command in `proof/<slug>.json`, or give the repository a `Makefile` with a `test:` target — `ci/lib/detect.mts` reads a Makefile before every other stack marker, so that target is the written escape for a stack it cannot detect.');

/** `buffer` and `timeout` are runs that started and were killed; `null` covers the rest. */
type Overrun = 'buffer' | 'timeout' | null;
type RunResult = { status: number | null; crashed: boolean; overran: Overrun; output: string };

/**
 * Runs the detected test command in `cwd`; never throws. The two streams are
 * joined by a blank line, not concatenated: `structuralInOverlay` reads
 * diagnostic blocks, and without the separation the last line a test logs on
 * stdout shares a block with the first line a runtime writes on stderr — a
 * `Cannot find module` the test merely printed would then borrow the file
 * name out of the stack header that follows it.
 */
function runTests(cwd: string): RunResult {
  const r = spawnSync(String(testCommand), [], {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    maxBuffer: RUN_MAX_BUFFER,
    timeout: RUN_TIMEOUT_MS,
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const overran: Overrun = code === 'ENOBUFS' ? 'buffer' : code === 'ETIMEDOUT' ? 'timeout' : null;
  return {
    status: r.status,
    crashed: r.status === 127 || Boolean(r.error),
    overran,
    output: `${r.stdout ?? ''}\n\n${r.stderr ?? ''}`.trim(),
  };
}

/**
 * The `cannot-run` detail for a run that produced no usable verdict. Three
 * different facts, kept apart because only two of them are cleared by raising
 * a limit: the command never started, it printed more than this check can
 * hold, or it was still running when the clock ran out. Reporting all three as
 * "could not be executed" sent an operator looking for a missing binary that
 * was never missing.
 */
const unrunnable = (run: RunResult, which: string): string => {
  if (run.overran === 'buffer') {
    return `\`${testCommand}\` printed more than the ${RUN_MAX_BUFFER}-byte buffer this check holds, while running ${which}, so its output could not be read and no verdict can rest on it. Raise AGENTIC_RUN_MAX_BUFFER, or make the command print less.`;
  }
  if (run.overran === 'timeout') {
    return `\`${testCommand}\` was still running after the ${RUN_TIMEOUT_MS} ms this check allows it and timed out, while running ${which}. Raise AGENTIC_RUN_TIMEOUT_MS, or find what the command is waiting on.`;
  }
  return `\`${testCommand}\` could not be executed on the base checkout (${which}).`;
};

const tail = (output: string): string => output.split('\n').slice(-TAIL).join('\n');

/**
 * Whether a commit in `base..head` (the PR's own commits, not the merge
 * base's other side) has a subject starting `test(red):` and touches at
 * least one of the test files overlaid onto the base. That is the PR's
 * evidence that a structural red on the base was written first, on purpose.
 */
function redCommitTouchesTests(): boolean {
  let log: string;
  try {
    log = git(['log', '--format=%H%x09%s', `${base}..${head}`]);
  } catch {
    return false; // an unreadable range cannot vouch for anything
  }
  const overlaid = new Set(testFiles);
  const shas = log
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([sha, subject]) => sha && /^test\(red\):/.test((subject ?? '').trim()))
    .map(([sha]) => String(sha));
  return shas.some((sha) => {
    const r = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', sha], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) return false;
    return (r.stdout ?? '').split('\n').map((f) => f.trim()).some((f) => overlaid.has(f));
  });
}

/**
 * Copies every overlaid file from head onto the base worktree. Returns a
 * `cannot-run` detail instead of overlaying when a *declared* path cannot be
 * read — `validateDeclaredPaths` proved that path is in the head tree, so a
 * failure here is an unreadable blob, not a deletion. Only a path that came
 * from the diff may be replayed as a deletion.
 */
function overlayTestFiles(tmp: string): string | null {
  for (const file of testFiles) {
    const show = spawnSync('git', ['show', `${head}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const target = join(tmp, file);
    if (show.status !== 0) {
      if (declaredPaths.has(file)) {
        const why = (show.stderr ?? '').trim() || show.error?.message || `git show exited ${show.status}`;
        return `\`${declaration?.path}\` names \`${file}\`, which is in the head commit and whose content could not be read (${why}). A declared path is never replayed as a deletion on the base.`;
      }
      rmSync(target, { force: true }); // in the diff and gone at head: deleted in the PR, delete on the base too
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, show.stdout);
  }
  return null;
}

/**
 * Runs the test command on a pristine base worktree (the baseline), then
 * again with the head's test files overlaid on top. Returns the outcome
 * instead of exiting, so the worktree is always removed (`process.exit`
 * inside a `try` skips `finally`).
 */
function runOnBase(): { outcome: Outcome; detail: string; warning?: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'negative-control-'));
  try {
    git(['worktree', 'add', '--detach', tmp, base]);
    if (commands.stack === 'node' && existsSync(join(root, 'node_modules')) && !existsSync(join(tmp, 'node_modules'))) {
      symlinkSync(join(root, 'node_modules'), join(tmp, 'node_modules'), 'dir');
    }

    const baseline = runTests(tmp);
    console.log(`--- \`${testCommand}\` on pristine base ${base.slice(0, 7)} ---\n${tail(baseline.output)}\n---`);
    if (baseline.crashed) return { outcome: 'cannot-run', detail: unrunnable(baseline, 'the baseline') };
    if (baseline.status !== 0) {
      return {
        outcome: 'inconclusive',
        detail: `\`${testCommand}\` already fails on the pristine base (exit ${baseline.status}); the base does not pass its own tests; the negative control cannot discriminate.\n${tail(baseline.output)}`,
      };
    }

    const overlayError = overlayTestFiles(tmp);
    if (overlayError) return { outcome: 'cannot-run', detail: overlayError };
    const overlaid = runTests(tmp);
    console.log(`--- \`${testCommand}\` on base ${base.slice(0, 7)} with ${testFiles.length} test file(s) from head ---\n${tail(overlaid.output)}\n---`);

    if (overlaid.crashed) return { outcome: 'cannot-run', detail: unrunnable(overlaid, 'the overlaid run') };
    if (overlaid.status === 0 && withheld.length === 0 && notATestFile.length === 0) {
      return {
        outcome: 'test-only',
        detail: `\`${testCommand}\` passed on the base with the ${testFiles.length} test file(s) from head overlaid — and it could not have done anything else. The overlay withheld nothing this diff changes: every changed file is a test file by TEST_FILE_GLOBS and every one of them was overlaid, so the run that had to fail is this pull request's own suite with no part of its change absent for a test to bite on. That is not \`vacuous\`, which says nothing *depended* on the change and is cleared by writing a test that bites; here nothing could have depended on it and no test clears it. **This verdict passes the check**: the control could put no question to this diff, and a gate that refuses what it cannot judge refuses forever (#355). It would go back to being judged the moment the diff touched one file outside the test globs — that file is the difference the overlay withholds, and this diff has none. What carries the weight instead: nothing outside the test globs changed, so there is no unproved production change; this very run is the pull request's own suite, which is the \`test\` check's business; \`scope\` holds these test paths to the linked issue's globs; and whether the change strengthens or weakens the suite is the reviewer's, because the overlay carries it either way and so could never have told the two apart. The class is not claimable: AGENTIC_TEST_GLOBS and a \`proof/<slug>.json\` \`tests\` list decide what is overlaid and deliberately do not decide this.`,
      };
    }
    if (overlaid.status === 0) {
      return {
        outcome: 'vacuous',
        detail: `\`${testCommand}\` passed on the base with the PR's test files applied — the tests do not depend on the change. When the PR adds a whole new test tree, suspect the entry point instead of the tests: a command that enumerates its test directories cannot see a tree the base does not have, so the base keeps running its own list and stays green. ${overlayRoute} This diff is not \`test-only\` (#355), and here is why, because that is what a reader asks next: ${keptInTheControl} — the overlay withheld it, or it is outside TEST_FILE_GLOBS as written in this file — so a test could have bitten here and did not.`,
      };
    }
    const named = testFiles.map((f) => `\`${f}\``).join(', ');
    // What the two predicates read: the run's output with the lines a
    // *passing* file wrote taken out of it (#428). `tail` still prints it
    // whole, notes included, in every detail below.
    const evidence = withoutNotes(overlaid.output);
    const structural = structuralInOverlay(evidence, [...testFiles, ...changed]);
    if (structural && !redCommitTouchesTests()) {
      return {
        outcome: 'structural',
        detail: `\`${testCommand}\` failed on the base only structurally (missing module or export, or a syntax error) with ${testFiles.length} test file(s): ${named} — the file could not run there at all, which is not an assertion catching the change. Either write a throwing stub so the red is a runtime red (safe-worktree §B7), or commit the failing test first with a subject starting \`test(red):\` that touches one of those files.\n${tail(overlaid.output)}`,
      };
    }
    // A structural red already proved its point: `structuralInOverlay` only
    // says `true` when the diagnostic named an overlaid path, so the overlay
    // is what could not run. Every other red has to show its own evidence.
    const { owned, mentioned, failures, elsewhere } = attributeFailures(evidence, testFiles);
    // A mention is evidence until something better contradicts it. `FAIL  the
    // overlaid file is listed in the pin table` is a *case name* quoting a
    // path, not that file failing, and this repository writes nineteen of
    // them; on its own it still has to be believed, because a runner that
    // prints `FAIL <path>` and nothing else says no more than that. What it
    // may not do is outvote a failure that states its own owner. When the
    // only overlaid evidence is a mention and some other file is reported as
    // owning a red, the run has said `pass` and `this red is not yours` in
    // the same breath, and the honest reading of that is neither.
    const contradicted = mentioned && !owned && elsewhere.length > 0;
    if (!structural && (contradicted || (!owned && !mentioned))) {
      const saw = contradicted
        ? `The only lines naming an overlaid file mention it in passing — a case name quoting a path does that too. The failures that say which file they belong to name another one:\n${listFailures(elsewhere)}\nFix or quarantine those and run it again`
        : failures.length > 0
          ? `The failures that run did report, none of them in an overlaid file:\n${listFailures(failures)}\nFix or quarantine those and run it again`
          : 'That run reported no failure of its own — it failed without saying what failed, so there is nothing to attribute. Make the command report its failures (a thrown error names the file in its stack; safe-worktree §B7) and run it again';
      return {
        outcome: 'unattributed',
        detail: `\`${testCommand}\` failed on the base with the ${testFiles.length} test file(s) from head overlaid (exit ${overlaid.status}), but no failure in that run is attributable to any of them: ${named}. A red the overlay did not cause is not this control's red — reading any red as "the tests bite" reports \`pass\` on a change nothing depends on, which is the one thing this check exists to prevent (#354). This is not \`vacuous\`: the tests may well bite, but something else was already broken and the run could not tell. ${saw}. By hand: \`node ci/negative-control.mts --base ${base} --head ${head}${branchRef ? ` --branch ${branchRef}` : ''}\`.\n${tail(overlaid.output)}`,
      };
    }
    // The overlay's red is there and so is someone else's. The verdict stands,
    // but the unrelated red is real and the operator is told rather than left
    // to find it in the log.
    const collateral = elsewhere.length > 0
      ? `${elsewhere.length} failure(s) in that run name a file the overlay did not place, so they are not this change's — act on them separately:\n${listFailures(elsewhere)}`
      : undefined;
    return {
      outcome: 'pass',
      detail: `\`${testCommand}\` failed on the base with the ${testFiles.length} test file(s) from head overlaid (exit ${overlaid.status}), and a failure in that run names one of them: ${named}.`,
      warning: structural ? STRUCTURAL_WARNING : collateral,
    };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tmp], { cwd: root, encoding: 'utf8' });
    rmSync(tmp, { recursive: true, force: true });
  }
}

const result = runOnBase();
finish(result.outcome, result.detail, result.warning);
