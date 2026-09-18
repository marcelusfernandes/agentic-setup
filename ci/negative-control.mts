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
//   pass         the baseline was green and the overlaid run failed — the tests bite
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
//   no-tests     the diff adds or changes no test files
//   cannot-run   the test command could not be found or detected, or the
//                branch's `proof/<slug>.json` could not be read as written.
//                When nothing was detected, the detail names the escape a
//                repository has whatever its stack: a `Makefile` with a
//                `test:` target, which ci/lib/detect.mts reads first. The
//                declaration's causes, each naming the path it rejected:
//                it does not parse, it is not a JSON object, it has no
//                `"tests"` array, its `"command"` is not a non-empty string,
//                a declared path is absolute or escapes the repository root
//                once normalised, a declared path is absent from the head
//                commit, or the declaration exists at head and its blob
//                cannot be read
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
// checks the shape of.
//
// The declaration fails closed. Presence is decided from the head *tree*
// (`git ls-tree`), never from the exit status of `git show`: only "absent
// from the head commit" means "this branch declares nothing", and every
// other failure — a corrupt object, an unreadable head, a `git` that cannot
// run — is `cannot-run`. A declaration that does not parse, names no test,
// carries a `command` that is not a non-empty string, or names a path that
// is absolute, escapes the repository root once normalised, or is absent at
// head, is `cannot-run` too, named path and all, before any worktree is
// made. A broken declaration must not silently narrow the control: a fall
// back to the detected globs would report "we could not verify this" as
// "this passed", which is the one thing this check exists to prevent.
// Without a declaration nothing changes, including the path-class skip,
// which is decided before the declaration is read.
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
import { detectCommands } from './lib/detect.mts';
import { matchesAny } from './lib/globs.mts';
import { appendSummary } from './lib/summary.mts';

// Read for one release only, to print a `note:` and to name the label in a
// skip the path class already decided. They never skip on their own: the
// implementer applies its own PR's labels.
const LEGACY_SKIP_LABELS = ['type:docs', 'type:deps', 'type:infra', 'type:refactor', 'type:spec'];
// The primary skip. Markdown is a class wherever it lives: `*` never crosses
// a `/`, so `*.md` alone covered the root only and a pull request touching
// nothing but `skills/x/SKILL.md` or `agents/y.md` failed as `no-tests`
// although there was nothing to test. `.claude/**` is session configuration,
// which no test covers either. Both root forms are kept alongside `**/*.md`:
// the list is read by people as well as by `matchesAny`.
const SKIP_PATH_GLOBS = ['docs/**', '.github/**', 'templates/**', '.claude/**', '*.md', '**/*.md'];
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

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();

type Outcome = 'skipped' | 'pass' | 'structural' | 'vacuous' | 'no-tests' | 'cannot-run' | 'inconclusive';

/** A comma-separated env list, trimmed, empty entries dropped. */
const csv = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// A structural failure (missing module, missing export, syntax error) reads
// as red for the wrong reason: it says the file could not run at all, not
// that an assertion caught the PR's change. See safe-worktree §B7.
const STRUCTURAL_SIGNATURE = /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|does not provide an export named/;

const STRUCTURAL_WARNING =
  'the red on the base looks structural (missing module or export), not an assertion — prefer a throwing stub so the red is a runtime red (safe-worktree §B7)';

/**
 * Whether the overlaid run failed structurally *because of the overlay*.
 *
 * The output is split into diagnostic blocks — maximal runs of consecutive
 * non-blank lines, which is how a runtime prints one diagnostic: the error
 * header, the offending source line, then its stack frames. A block counts
 * only when it carries a structural signature **and** names one of `paths`,
 * the overlaid test files plus every file the diff touches. Node names the
 * file in the header of both shapes — `Cannot find module '…' imported from
 * <file>` on the signature line itself, and `file:///…/<file>:1` three lines
 * above a `SyntaxError`.
 *
 * Reading the whole output instead made any structural-looking line anywhere
 * decide the outcome: a dependency that logs `Cannot find module` and carries
 * on prints its line in a block of its own and says nothing about whether the
 * overlaid file could run, yet it flipped an honest assertion red to
 * `structural` (#214).
 */
function structuralInOverlay(output: string, paths: string[]): boolean {
  const named = paths.map((p) => p.trim()).filter(Boolean);
  if (named.length === 0) return false;
  return output
    .split(/\n[ \t]*\n/)
    .some((block) => {
      const lines = block.split('\n');
      return lines.some((line) => STRUCTURAL_SIGNATURE.test(line))
        && lines.some((line) => named.some((path) => line.includes(path)));
    });
}

function finish(outcome: Outcome, detail: string, warning?: string): never {
  const ok = outcome === 'skipped' || outcome === 'pass';
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

type Declaration = { path: string; tests: string[]; command?: string };

/** The `<slug>` of a `<type>/<n>-<slug>` ref, or `null` for any other shape. */
function branchSlug(ref: string): string | null {
  const m = ref.replace(/^refs\/heads\//, '').trim().match(/^[^/]+\/\d+-([a-z0-9-]+)$/);
  return m ? m[1] : null;
}

type Presence = 'present' | 'absent' | 'unresolvable';

/**
 * Whether `path` is in the head *commit*, answered from the tree rather than
 * from the exit status of `git show`.
 *
 * `git show <head>:<path>` fails identically for a path the commit does not
 * have, for a blob whose object is missing or corrupt, and for a `git` that
 * cannot run at all, so its status alone cannot tell "this branch declares
 * nothing" from "we could not read what it declares" — and reading the
 * second as the first is the silent fallback this check exists to prevent.
 * `git ls-tree` answers from the tree: exit 0 with the path on stdout when
 * the commit has it, exit 0 and empty stdout when it does not, and non-zero
 * only when the question itself could not be asked — a path outside the
 * repository, or a head that will not resolve.
 */
function pathAtHead(path: string): { presence: Presence; error: string } {
  const r = spawnSync('git', ['ls-tree', '--name-only', head, '--', path], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    return { presence: 'unresolvable', error: (r.stderr ?? '').trim() || r.error?.message || `git ls-tree exited ${r.status}` };
  }
  return { presence: (r.stdout ?? '').trim() === '' ? 'absent' : 'present', error: '' };
}

/** The sentence every rejected declaration ends with. */
const brokenDeclaration = (path: string, why: string): never =>
  finish('cannot-run', `\`${path}\` ${why}. A proof declaration decides what is overlaid; a broken one must not narrow the control silently.`);

/**
 * `proof/<slug>.json` as it stands at head, or `null` when the branch
 * declares nothing. Never reads the working tree: the file is taken from the
 * head commit, so the check does not depend on what is checked out. Only
 * "absent from the head tree" is "declares nothing"; a declaration that is
 * present and unusable — unreadable, unparsable, or not the shape — exits
 * `cannot-run` rather than falling back to the globs, because a declaration
 * that is present is the contract.
 */
function readDeclaration(slug: string): Declaration | null {
  const path = `proof/${slug}.json`;
  const bad = (why: string): never => brokenDeclaration(path, why);

  const at = pathAtHead(path);
  if (at.presence === 'absent') return null; // this branch declares nothing
  if (at.presence === 'unresolvable') bad(`could not be looked up in the head commit (${at.error})`);

  const show = spawnSync('git', ['show', `${head}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (show.status !== 0) {
    bad(`is in the head commit and could not be read (${(show.stderr ?? '').trim() || show.error?.message || `git show exited ${show.status}`})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(show.stdout);
  } catch (error) {
    bad(`does not parse as JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) bad('is not a JSON object');
  const decl = parsed as Record<string, unknown>;

  const tests = decl.tests;
  if (!Array.isArray(tests) || tests.length === 0 || !tests.every((t) => typeof t === 'string' && t.trim() !== '')) {
    bad('has no `"tests"` array of file paths');
  }
  const command = decl.command;
  if (command !== undefined && (typeof command !== 'string' || command.trim() === '')) {
    bad('has a `"command"` that is not a non-empty string');
  }
  return {
    path,
    tests: (tests as string[]).map((t) => t.trim()),
    command: typeof command === 'string' ? command.trim() : undefined,
  };
}

/**
 * A copy of `decl` whose `tests` are normalised POSIX paths, or `cannot-run`
 * naming the first path that is not one.
 *
 * The declaration is written by the implementer and the overlay follows it
 * literally: `join(tmp, file)` with an absolute or `..` path reads and
 * removes outside the temporary worktree, and a path the head does not have
 * used to be replayed as "deleted in the PR — delete it on the base too",
 * which turns a typo into an unrelated base file removed and a control run on
 * a tree nobody described. Both are refused here, before the worktree exists
 * and therefore before anything can be written or removed.
 */
function validateDeclaredPaths(decl: Declaration): Declaration {
  const bad = (why: string): never => brokenDeclaration(decl.path, why);
  const tests = decl.tests.map((file) => {
    const slashed = file.replace(/\\/g, '/');
    if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
      bad(`names the absolute path \`${file}\`; a declared test path is relative to the repository root`);
    }
    const normalised = posix.normalize(slashed);
    if (normalised === '..' || normalised.startsWith('../')) {
      bad(`names \`${file}\`, which escapes the repository root once normalised (\`${normalised}\`)`);
    }
    const at = pathAtHead(normalised);
    if (at.presence === 'unresolvable') {
      bad(`names \`${file}\`, which could not be looked up in the head commit (${at.error})`);
    }
    if (at.presence === 'absent') {
      bad(`names \`${file}\`, which the head commit does not have; a declared path that is missing at head is a typo, not a file the pull request deletes`);
    }
    return normalised;
  });
  return { ...decl, tests };
}

const branchRef = typeof args.branch === 'string' ? args.branch.trim() : String(event?.pull_request?.head?.ref ?? '').trim();
const slug = branchRef ? branchSlug(branchRef) : null;
if (branchRef && !slug) {
  console.log(`note: \`${branchRef}\` is not a \`<type>/<n>-<slug>\` branch, so no proof declaration is looked up for it.`);
}
const declared = slug ? readDeclaration(slug) : null;
const declaration = declared ? validateDeclaredPaths(declared) : null;
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
if (testFiles.length === 0) finish('no-tests', 'the diff changes no test files, and it is not confined to a skipped path class; add the test that fails first (`test(red):`), declare the proof in `proof/<slug>.json`, or add the path class to AGENTIC_SKIP_GLOBS.');

const commands = detectCommands(root);
const testCommand = declaration?.command ?? commands.test;
if (!testCommand) finish('cannot-run', 'no test command detected; set AGENTIC_TEST_CMD in the workflow, name the command in `proof/<slug>.json`, or give the repository a `Makefile` with a `test:` target — `ci/lib/detect.mts` reads a Makefile before every other stack marker, so that target is the written escape for a stack it cannot detect.');

type RunResult = { status: number | null; crashed: boolean; output: string };

/**
 * Runs the detected test command in `cwd`; never throws. The two streams are
 * joined by a blank line, not concatenated: `structuralInOverlay` reads
 * diagnostic blocks, and without the separation the last line a test logs on
 * stdout shares a block with the first line a runtime writes on stderr — a
 * `Cannot find module` the test merely printed would then borrow the file
 * name out of the stack header that follows it.
 */
function runTests(cwd: string): RunResult {
  const r = spawnSync(String(testCommand), [], { cwd, shell: true, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  return { status: r.status, crashed: r.status === 127 || Boolean(r.error), output: `${r.stdout ?? ''}\n\n${r.stderr ?? ''}`.trim() };
}

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
    if (baseline.crashed) {
      return { outcome: 'cannot-run', detail: `\`${testCommand}\` could not be executed on the base checkout.` };
    }
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

    if (overlaid.crashed) {
      return { outcome: 'cannot-run', detail: `\`${testCommand}\` could not be executed on the base checkout.` };
    }
    if (overlaid.status === 0) {
      return {
        outcome: 'vacuous',
        detail: `\`${testCommand}\` passed on the base with the PR's test files applied — the tests do not depend on the change. When the PR adds a whole new test tree, suspect the entry point instead of the tests: a command that enumerates its test directories cannot see a tree the base does not have, so the base keeps running its own list and stays green. The entry point is overlaid only when it is one of the overlaid files — a path a test glob matches (TEST_FILE_GLOBS, extended by AGENTIC_TEST_GLOBS) or a path \`proof/<slug>.json\` names in its \`tests\`. So make the entry point discover its tests rather than list them, and either keep it in the overlay by one of those two routes, which proves the fix in this same PR, or name the discovering command as the \`command\` of \`proof/<slug>.json\`, which replaces the detected command for both runs.`,
      };
    }
    const named = testFiles.map((f) => `\`${f}\``).join(', ');
    const structural = structuralInOverlay(overlaid.output, [...testFiles, ...changed]);
    if (structural && !redCommitTouchesTests()) {
      return {
        outcome: 'structural',
        detail: `\`${testCommand}\` failed on the base only structurally (missing module or export, or a syntax error) with ${testFiles.length} test file(s): ${named} — the file could not run there at all, which is not an assertion catching the change. Either write a throwing stub so the red is a runtime red (safe-worktree §B7), or commit the failing test first with a subject starting \`test(red):\` that touches one of those files.\n${tail(overlaid.output)}`,
      };
    }
    return {
      outcome: 'pass',
      detail: `\`${testCommand}\` failed on the base (exit ${overlaid.status}) with ${testFiles.length} test file(s): ${named}.`,
      warning: structural ? STRUCTURAL_WARNING : undefined,
    };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tmp], { cwd: root, encoding: 'utf8' });
    rmSync(tmp, { recursive: true, force: true });
  }
}

const result = runOnBase();
finish(result.outcome, result.detail, result.warning);
