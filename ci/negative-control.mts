#!/usr/bin/env node
// negative-control — the tests a PR adds must fail without the PR's change.
//
// Checks out the PR's base in a temporary worktree, first runs the project's
// test command there UNCHANGED (the baseline), then copies ONLY the test
// files from the PR's diff on top of it and runs the command again,
// requiring that second run to fail. Outcomes:
//   skipped      every file the PR changes sits in a skipped path class
//                (SKIP_PATH_GLOBS below, extended by AGENTIC_SKIP_GLOBS) —
//                docs, workflows, templates and root Markdown owe no
//                negative control
//   pass         the baseline was green and the overlaid run failed — the tests bite
//   structural   the overlaid run failed only structurally (a missing module,
//                a missing export, a syntax error) and no `test(red):` commit
//                in base..head touches any of the overlaid test files
//   vacuous      the baseline was green and the overlaid run also passed — the
//                tests prove nothing
//   no-tests     the diff adds or changes no test files
//   cannot-run   the test command could not be found or detected
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
// The skip is by path class, not by the PR's own labels: the implementer
// applies its own PR's labels, so a `type:` label could buy its own
// exemption. `type:docs`/`deps`/`infra`/`refactor`/`spec` are still read —
// for one release — but only to print a `note:` line saying they no longer
// skip on their own, and to name the label in a skip the path class already
// decided. AGENTIC_SKIP_GLOBS (comma-separated, env only, no config file)
// adds path classes; `*.md` matches root-level Markdown only, as `*` never
// crosses a `/` (ci/lib/globs.mts).
//
// Inputs: --base <sha> --head <sha> (or the pull_request event), labels from
// the event or --labels a,b. Test files: TEST_FILE_GLOBS below, extended
// with AGENTIC_TEST_GLOBS (comma-separated). Test command: ci/lib/detect.mts
// or AGENTIC_TEST_CMD. For Node projects the head checkout's node_modules is
// linked into the base worktree so nothing is reinstalled.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from './lib/args.mts';
import { detectCommands } from './lib/detect.mts';
import { matchesAny } from './lib/globs.mts';
import { appendSummary } from './lib/summary.mts';

// Read for one release only, to print a `note:` and to name the label in a
// skip the path class already decided. They never skip on their own: the
// implementer applies its own PR's labels.
const LEGACY_SKIP_LABELS = ['type:docs', 'type:deps', 'type:infra', 'type:refactor', 'type:spec'];
// The primary skip. `*.md` is root-level Markdown only (`*` never crosses a
// `/`); a nested Markdown file is skipped through `docs/**` or by adding the
// class to AGENTIC_SKIP_GLOBS.
const SKIP_PATH_GLOBS = ['docs/**', '.github/**', 'templates/**', '*.md'];
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
if (changed.length > 0 && changed.every((f) => matchesAny(f, skipGlobs))) {
  const alsoLabelled = legacyLabel ? ` The PR also carries \`${legacyLabel}\`, which no longer skips on its own.` : '';
  finish(
    'skipped',
    `every changed file sits in a skipped path class (${skipGlobs.map((g) => `\`${g}\``).join(', ')}); no negative control expected.${alsoLabelled}`,
  );
}
if (legacyLabel) {
  console.log(`note: \`${legacyLabel}\` no longer skips the negative control by itself — the skip is by path class (set AGENTIC_SKIP_GLOBS to add one). The label is read for backward compatibility for one release.`);
}

const extraGlobs = csv(process.env.AGENTIC_TEST_GLOBS);
const testFiles = changed.filter((f) => matchesAny(f, [...TEST_FILE_GLOBS, ...extraGlobs]));
if (testFiles.length === 0) finish('no-tests', 'the diff changes no test files, and it is not confined to a skipped path class; add the test that fails first (`test(red):`), or add the path class to AGENTIC_SKIP_GLOBS.');

const commands = detectCommands(root);
if (!commands.test) finish('cannot-run', 'no test command detected; set AGENTIC_TEST_CMD in the workflow.');

type RunResult = { status: number | null; crashed: boolean; output: string };

/** Runs the detected test command in `cwd`; never throws. */
function runTests(cwd: string): RunResult {
  const r = spawnSync(String(commands.test), [], { cwd, shell: true, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  return { status: r.status, crashed: r.status === 127 || Boolean(r.error), output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
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

function overlayTestFiles(tmp: string): void {
  for (const file of testFiles) {
    const show = spawnSync('git', ['show', `${head}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const target = join(tmp, file);
    if (show.status !== 0) {
      rmSync(target, { force: true }); // deleted in the PR: delete on the base too
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, show.stdout);
  }
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
    console.log(`--- \`${commands.test}\` on pristine base ${base.slice(0, 7)} ---\n${tail(baseline.output)}\n---`);
    if (baseline.crashed) {
      return { outcome: 'cannot-run', detail: `\`${commands.test}\` could not be executed on the base checkout.` };
    }
    if (baseline.status !== 0) {
      return {
        outcome: 'inconclusive',
        detail: `\`${commands.test}\` already fails on the pristine base (exit ${baseline.status}); the base does not pass its own tests; the negative control cannot discriminate.\n${tail(baseline.output)}`,
      };
    }

    overlayTestFiles(tmp);
    const overlaid = runTests(tmp);
    console.log(`--- \`${commands.test}\` on base ${base.slice(0, 7)} with ${testFiles.length} test file(s) from head ---\n${tail(overlaid.output)}\n---`);

    if (overlaid.crashed) {
      return { outcome: 'cannot-run', detail: `\`${commands.test}\` could not be executed on the base checkout.` };
    }
    if (overlaid.status === 0) {
      return { outcome: 'vacuous', detail: `\`${commands.test}\` passed on the base with the PR's test files applied — the tests do not depend on the change.` };
    }
    const named = testFiles.map((f) => `\`${f}\``).join(', ');
    const structural = STRUCTURAL_SIGNATURE.test(overlaid.output);
    if (structural && !redCommitTouchesTests()) {
      return {
        outcome: 'structural',
        detail: `\`${commands.test}\` failed on the base only structurally (missing module or export, or a syntax error) with ${testFiles.length} test file(s): ${named} — the file could not run there at all, which is not an assertion catching the change. Either write a throwing stub so the red is a runtime red (safe-worktree §B7), or commit the failing test first with a subject starting \`test(red):\` that touches one of those files.\n${tail(overlaid.output)}`,
      };
    }
    return {
      outcome: 'pass',
      detail: `\`${commands.test}\` failed on the base (exit ${overlaid.status}) with ${testFiles.length} test file(s): ${named}.`,
      warning: structural ? STRUCTURAL_WARNING : undefined,
    };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tmp], { cwd: root, encoding: 'utf8' });
    rmSync(tmp, { recursive: true, force: true });
  }
}

const result = runOnBase();
finish(result.outcome, result.detail, result.warning);
