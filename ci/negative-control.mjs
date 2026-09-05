#!/usr/bin/env node
// negative-control — the tests a PR adds must fail without the PR's change.
//
// Checks out the PR's base in a temporary worktree, copies ONLY the test
// files from the PR's diff on top of it, runs the project's test command
// there, and requires it to fail. Outcomes:
//   skipped     the PR carries a label in SKIP_LABELS (docs, deps, infra,
//               refactor, spec) — only feature and bug PRs owe a negative control
//   pass        the test command failed on the base — the tests bite
//   vacuous     the test command passed on the base — the tests prove nothing
//   no-tests    the diff adds or changes no test files
//   cannot-run  the test command could not be found or detected
//
// Inputs: --base <sha> --head <sha> (or the pull_request event), labels from
// the event or --labels a,b. Test files: TEST_FILE_GLOBS below, extended
// with AGENTIC_TEST_GLOBS (comma-separated). Test command: ci/lib/detect.mjs
// or AGENTIC_TEST_CMD. For Node projects the head checkout's node_modules is
// linked into the base worktree so nothing is reinstalled.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { detectCommands } from './lib/detect.mjs';
import { matchesAny } from './lib/globs.mjs';
import { appendSummary } from './lib/summary.mjs';

const SKIP_LABELS = ['type:docs', 'type:deps', 'type:infra', 'type:refactor', 'type:spec'];
const TEST_FILE_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/*_test.go', '**/test_*.py', '**/*_test.py',
  '**/tests/**', '**/test/**', '**/__tests__/**', 'e2e/**', 'spec/**',
];
const TAIL = 40;

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();

/** @param {'skipped'|'pass'|'vacuous'|'no-tests'|'cannot-run'} outcome @param {string} detail */
function finish(outcome, detail) {
  const ok = outcome === 'skipped' || outcome === 'pass';
  appendSummary(`## negative-control\n\n${ok ? '' : '**FAILED** — '}\`${outcome}\` — ${detail}`);
  console.log(`negative-control: ${outcome} — ${detail}`);
  process.exit(ok ? 0 : 1);
}

function readEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** @param {string[]} gitArgs @param {string} [cwd] */
function git(gitArgs, cwd = root) {
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
  : (event?.pull_request?.labels ?? []).map((/** @type {{ name: string }} */ l) => l.name);
const skip = SKIP_LABELS.find((l) => labels.includes(l));
if (skip) finish('skipped', `PR is labelled \`${skip}\`; no negative control expected.`);

const extraGlobs = (process.env.AGENTIC_TEST_GLOBS ?? '').split(',').map((g) => g.trim()).filter(Boolean);
const changed = git(['diff', '--no-renames', '--name-only', `${base}...${head}`]).split('\n').map((l) => l.trim()).filter(Boolean);
const testFiles = changed.filter((f) => matchesAny(f, [...TEST_FILE_GLOBS, ...extraGlobs]));
if (testFiles.length === 0) finish('no-tests', 'the diff changes no test files; a feature or bug PR must add the test that fails first (`test(red):`).');

const commands = detectCommands(root);
if (!commands.test) finish('cannot-run', 'no test command detected; set AGENTIC_TEST_CMD in the workflow.');

/**
 * Runs the test command on a base worktree with the head's test files on top.
 * Returns the outcome instead of exiting, so the worktree is always removed
 * (`process.exit` inside a `try` skips `finally`).
 * @returns {{ outcome: 'pass'|'vacuous'|'cannot-run', detail: string }}
 */
function runOnBase() {
  const tmp = mkdtempSync(join(tmpdir(), 'negative-control-'));
  try {
    git(['worktree', 'add', '--detach', tmp, base]);
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
    if (commands.stack === 'node' && existsSync(join(root, 'node_modules')) && !existsSync(join(tmp, 'node_modules'))) {
      symlinkSync(join(root, 'node_modules'), join(tmp, 'node_modules'), 'dir');
    }

    const r = spawnSync(String(commands.test), [], { cwd: tmp, shell: true, encoding: 'utf8', env: { ...process.env, CI: '1' } });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-TAIL).join('\n');
    console.log(`--- \`${commands.test}\` on base ${base.slice(0, 7)} with ${testFiles.length} test file(s) from head ---\n${output}\n---`);

    if (r.status === 127 || r.error) {
      return { outcome: 'cannot-run', detail: `\`${commands.test}\` could not be executed on the base checkout.` };
    }
    if (r.status === 0) {
      return { outcome: 'vacuous', detail: `\`${commands.test}\` passed on the base with the PR's test files applied — the tests do not depend on the change.` };
    }
    return { outcome: 'pass', detail: `\`${commands.test}\` failed on the base (exit ${r.status}) with ${testFiles.length} test file(s): ${testFiles.map((f) => `\`${f}\``).join(', ')}.` };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tmp], { cwd: root, encoding: 'utf8' });
    rmSync(tmp, { recursive: true, force: true });
  }
}

const result = runOnBase();
finish(result.outcome, result.detail);
