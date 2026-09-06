#!/usr/bin/env node
// negative-control — the tests a PR adds must fail without the PR's change.
//
// Checks out the PR's base in a temporary worktree, first runs the project's
// test command there UNCHANGED (the baseline), then copies ONLY the test
// files from the PR's diff on top of it and runs the command again,
// requiring that second run to fail. Outcomes:
//   skipped      the PR carries a label in SKIP_LABELS (docs, deps, infra,
//                refactor, spec) — only feature and bug PRs owe a negative control
//   pass         the baseline was green and the overlaid run failed — the tests bite
//   vacuous      the baseline was green and the overlaid run also passed — the
//                tests prove nothing
//   no-tests     the diff adds or changes no test files
//   cannot-run   the test command could not be found or detected
//   inconclusive the baseline itself failed, before the overlay — a base that
//                cannot run its own tests makes the negative control unable
//                to discriminate anything
//
// A `pass` whose overlaid output carries a structural signature (a missing
// module, a missing export, a syntax error) still exits 0 — with an opaque
// test command one crashing test file cannot be told apart from several real
// failures — but prints and summarises a `warning:` line nudging toward a
// throwing stub instead.
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

const SKIP_LABELS = ['type:docs', 'type:deps', 'type:infra', 'type:refactor', 'type:spec'];
const TEST_FILE_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/*_test.go', '**/test_*.py', '**/*_test.py',
  '**/tests/**', '**/test/**', '**/__tests__/**', 'e2e/**', 'spec/**',
];
const TAIL = 40;

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();

type Outcome = 'skipped' | 'pass' | 'vacuous' | 'no-tests' | 'cannot-run' | 'inconclusive';

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
const skip = SKIP_LABELS.find((l) => labels.includes(l));
if (skip) finish('skipped', `PR is labelled \`${skip}\`; no negative control expected.`);

const extraGlobs = (process.env.AGENTIC_TEST_GLOBS ?? '').split(',').map((g) => g.trim()).filter(Boolean);
const changed = git(['diff', '--no-renames', '--name-only', `${base}...${head}`]).split('\n').map((l) => l.trim()).filter(Boolean);
const testFiles = changed.filter((f) => matchesAny(f, [...TEST_FILE_GLOBS, ...extraGlobs]));
if (testFiles.length === 0) finish('no-tests', 'the diff changes no test files; a feature or bug PR must add the test that fails first (`test(red):`).');

const commands = detectCommands(root);
if (!commands.test) finish('cannot-run', 'no test command detected; set AGENTIC_TEST_CMD in the workflow.');

type RunResult = { status: number | null; crashed: boolean; output: string };

/** Runs the detected test command in `cwd`; never throws. */
function runTests(cwd: string): RunResult {
  const r = spawnSync(String(commands.test), [], { cwd, shell: true, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  return { status: r.status, crashed: r.status === 127 || Boolean(r.error), output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const tail = (output: string): string => output.split('\n').slice(-TAIL).join('\n');

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
    return {
      outcome: 'pass',
      detail: `\`${commands.test}\` failed on the base (exit ${overlaid.status}) with ${testFiles.length} test file(s): ${testFiles.map((f) => `\`${f}\``).join(', ')}.`,
      warning: STRUCTURAL_SIGNATURE.test(overlaid.output) ? STRUCTURAL_WARNING : undefined,
    };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tmp], { cwd: root, encoding: 'utf8' });
    rmSync(tmp, { recursive: true, force: true });
  }
}

const result = runOnBase();
finish(result.outcome, result.detail, result.warning);
