#!/usr/bin/env node
// Smoke tests for the hooks and the CI scripts. No framework and node:
// built-ins only, so the same file runs under `node tests/smoke.mjs` and
// `bun tests/smoke.mjs`. Every case spawns the real script with a crafted
// payload against a throwaway git repository; nothing is mocked.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = process.argv[0];
const cleanups = [];
let passed = 0;
let failed = 0;

/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL  ${name}${detail ? `\n      ${detail.trim().split('\n').slice(-6).join('\n      ')}` : ''}`);
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-smoke-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'smoke@example.com'], dir);
  git(['config', 'user.name', 'smoke'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

/** @param {string} dir @param {Record<string, string>} files @param {string} message */
function commit(dir, files, message) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(['add', '-A'], dir);
  git(['commit', '-q', '--allow-empty', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

/** @param {string} script @param {object | string} payload @param {{ cwd?: string, env?: Record<string, string> }} [opts] */
function hook(script, payload, opts = {}) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'hooks', script)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** @param {string} script @param {string[]} args @param {{ cwd?: string, env?: Record<string, string> }} [opts] */
function ci(script, args, opts = {}) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'ci', script), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, GITHUB_EVENT_PATH: '', GITHUB_STEP_SUMMARY: '', ...opts.env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// ---------------------------------------------------------------- protect-main
{
  /** @param {string} command @param {string} cwd @param {Record<string, string>} [env] */
  const bash = (command, cwd, env) => hook('protect-main.mjs', { tool_name: 'Bash', tool_input: { command }, cwd }, { cwd, env });
  const repo = tempRepo();
  commit(repo, { 'a.txt': 'a' }, 'init');

  const denied = [
    'git push --force origin feat/1-x',
    'git push -f origin feat/1-x',
    'git push origin +feat/1-x',
    'git push origin HEAD:main',
    'git push origin main',
    'git push --delete origin main',
    'git branch -D main',
    'gh pr merge --admin 12',
    'cd sub && git push origin main',
    'git push', // bare push while on main
  ];
  for (const command of denied) {
    const r = bash(command, repo);
    check(`protect-main denies: ${command}`, r.status === 2 && /permissionDecision":"deny/.test(r.stdout), r.stderr);
  }
  const allowed = [
    'git push origin feat/1-x',
    'git push -u origin feat/1-x',
    'git status',
    'ls -la',
    'AGENTIC_ALLOW_PUSH_MAIN=1 git push origin main',
    'AGENTIC_ALLOW_MERGE=1 gh pr merge 1 --squash',
  ];
  for (const command of allowed) {
    const r = bash(command, repo);
    check(`protect-main allows: ${command}`, r.status === 0 && r.stdout === '', r.stderr);
  }
  git(['checkout', '-q', '-b', 'feat/1-x'], repo);
  check('protect-main allows bare push from a work branch', bash('git push', repo).status === 0);
  check('protect-main fails CLOSED on merge when gh cannot read the PR', bash('gh pr merge 1 --squash', repo).status === 2);
  check('protect-main ignores non-Bash tools', hook('protect-main.mjs', { tool_name: 'Edit', tool_input: { command: 'git push origin main' } }).status === 0);
  check('protect-main allows on unreadable payload', hook('protect-main.mjs', '{not json').status === 0);
}

// ------------------------------------------------------------ protect-worktree
{
  const repo = tempRepo();
  commit(repo, { 'a.txt': 'a' }, 'init');
  const wt = join(repo, '.worktrees', 'agent-1');
  git(['worktree', 'add', '-q', '-b', 'feat/1-x', wt], repo);
  /** @param {string} file_path @param {object} [extra] @param {string} [cwd] */
  const write = (file_path, extra = {}, cwd = wt) => hook('protect-worktree.mjs', { tool_name: 'Write', tool_input: { file_path }, cwd, agent_id: 'agent-1', ...extra }, { cwd });

  check('protect-worktree denies a subagent writing into the main checkout', write(join(repo, 'a.txt')).status === 2);
  check('protect-worktree denies a new file under the main checkout', write(join(repo, 'src', 'new.ts')).status === 2);
  check('protect-worktree allows a write inside the worktree', write(join(wt, 'a.txt')).status === 0);
  check('protect-worktree allows a relative path (resolved against cwd)', write('b.txt').status === 0);
  check('protect-worktree allows scratch files outside both', write(join(tmpdir(), 'scratch.txt')).status === 0);
  check('protect-worktree ignores the main session (no agent_id)', hook('protect-worktree.mjs', { tool_name: 'Write', tool_input: { file_path: join(repo, 'a.txt') }, cwd: wt }, { cwd: wt }).status === 0);
  check('protect-worktree ignores a subagent in the main checkout', write(join(repo, 'a.txt'), {}, repo).status === 0);
}

// -------------------------------------------------------------------- stop-gate
{
  const repo = tempRepo();
  commit(repo, { 'a.txt': 'a' }, 'init');
  const stop = (env = {}, payload = {}) => hook('stop-gate.mjs', { hook_event_name: 'Stop', cwd: repo, ...payload }, { cwd: repo, env: { AGENTIC_TEST_CMD: '', AGENTIC_CHECK_CMD: '', ...env } });

  check('stop-gate skips on main', stop({ AGENTIC_TEST_CMD: 'exit 1' }).status === 0);
  git(['checkout', '-q', '-b', 'feat/1-x'], repo);
  check('stop-gate blocks when the test command fails', stop({ AGENTIC_TEST_CMD: 'exit 1' }).status === 2);
  check('stop-gate passes when the test command passes', stop({ AGENTIC_TEST_CMD: 'exit 0' }).status === 0);
  check('stop-gate runs check before test', stop({ AGENTIC_CHECK_CMD: 'exit 1', AGENTIC_TEST_CMD: 'exit 0' }).status === 2);
  check('stop-gate skips when a stop hook is already active', stop({ AGENTIC_TEST_CMD: 'exit 1' }, { stop_hook_active: true }).status === 0);
  check('stop-gate does not recurse', stop({ AGENTIC_TEST_CMD: 'exit 1', AGENTIC_STOP_GATE_ACTIVE: '1' }).status === 0);
  check('stop-gate skips with nothing detectable', stop().status === 0);
  commit(repo, { 'b.txt': 'b' }, 'test(red): b must exist');
  check('stop-gate skips after a test(red) commit', stop({ AGENTIC_TEST_CMD: 'exit 1' }).status === 2 ? false : true);
  git(['checkout', '-q', '-b', 'feat/2-y'], repo);
  commit(repo, { 'package.json': JSON.stringify({ scripts: { test: 'exit 3' } }) }, 'feat: failing suite');
  check('stop-gate detects npm test from package.json', stop().status === 2);
  git(['checkout', '-q', '-b', 'wip'], repo);
  check('stop-gate skips a branch outside <type>/<n>-<slug>', stop({ AGENTIC_TEST_CMD: 'exit 1' }).status === 0);
}

// ------------------------------------------------------------------ scope-check
{
  const dir = mkdtempSync(join(tmpdir(), 'agentic-scope-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  /** @param {string} name @param {string} content */
  const file = (name, content) => {
    writeFileSync(join(dir, name), content);
    return join(dir, name);
  };
  const files = file('files.txt', 'src/a.ts\nsrc/lib/b.ts\n');
  const issueSrc = file('issue-src.md', '## Goal\nx\n\n## Files\nGlobs this issue may touch:\n- `src/**`\n\n## Dependencies\nnone\n');
  const issueLib = file('issue-lib.md', '## Files\n- `lib/**`, `docs/*.md`\n');
  const issueBare = file('issue-bare.md', '## Files\n- src/**\n');
  const prPlain = file('pr-plain.md', 'Closes #1\n\n## Files\nGlobs touched (must match the issue).\n');
  const prGrant = file('pr-grant.md', 'Closes #1\n\n## Files\n- authorised: `src/a.ts`\n  (orchestrator: needed for AC3)\n- authorised: `src/lib/b.ts` — see issue comment\n');
  const prNoClose = file('pr-noclose.md', '## What changed\nstuff\n');
  /** @param {string} f @param {string | null} i @param {string} p */
  const scope = (f, i, p) => ci('scope-check.mjs', ['--files-file', f, ...(i ? ['--issue-body-file', i] : []), '--pr-body-file', p]);

  check('scope passes inside the issue globs', scope(files, issueSrc, prPlain).status === 0);
  check('scope passes with bare (unquoted) globs', scope(files, issueBare, prPlain).status === 0);
  check('scope fails outside the issue globs', scope(files, issueLib, prPlain).status === 1);
  check('scope passes when the PR grants the files with authorised:', scope(files, issueLib, prGrant).status === 0);
  check('scope fails without Closes #N', scope(files, null, prNoClose).status === 1);
  const r = scope(files, issueLib, prPlain);
  check('scope names the violations', /src\/a\.ts/.test(r.out) && /src\/lib\/b\.ts/.test(r.out), r.out);
}

// ------------------------------------------------------------- negative-control
{
  const repo = tempRepo();
  const pkg = JSON.stringify({ name: 'x', private: true, scripts: { test: 'node tests/check.mjs' } });
  const base = commit(repo, {
    'package.json': pkg,
    'lib.mjs': 'export const v = 1;\n',
    'tests/check.mjs': 'process.exit(0);\n',
  }, 'chore: base');

  git(['checkout', '-q', '-b', 'feat/1-x'], repo);
  const head = commit(repo, {
    'lib.mjs': 'export const v = 2;\n',
    'tests/check.mjs': "import { v } from '../lib.mjs';\nprocess.exit(v === 2 ? 0 : 1);\n",
  }, 'feat: v2');
  /** @param {string} h @param {string} [labels] */
  const nc = (h, labels = '') => ci('negative-control.mjs', ['--base', base, '--head', h, ...(labels ? ['--labels', labels] : [])], { cwd: repo });

  let r = nc(head);
  check('negative-control passes when the new test fails on the base', r.status === 0 && /\bpass\b/.test(r.out), r.out);
  check('negative-control skips docs PRs by label', nc(head, 'type:docs').status === 0 && /skipped/.test(nc(head, 'type:docs').out));

  git(['checkout', '-q', '-b', 'feat/2-vacuous', base], repo);
  const vacuous = commit(repo, { 'lib.mjs': 'export const v = 3;\n', 'tests/check.mjs': "console.log('looks tested');\nprocess.exit(0);\n" }, 'feat: vacuous');
  r = nc(vacuous);
  check('negative-control fails a vacuous test', r.status === 1 && /vacuous/.test(r.out), r.out);

  git(['checkout', '-q', '-b', 'feat/3-notests', base], repo);
  const noTests = commit(repo, { 'lib.mjs': 'export const v = 4;\n' }, 'feat: no tests');
  r = nc(noTests);
  check('negative-control fails when no test file changed', r.status === 1 && /no-tests/.test(r.out), r.out);
  check('negative-control leaves no worktree behind', !/negative-control-/.test(git(['worktree', 'list'], repo)));
}

// ------------------------------------------------------------------------- init
{
  const repo = tempRepo();
  commit(repo, { 'README.md': '# x\n' }, 'init');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm -rf / *)', 'WebFetch'] }, other: true }));
  /** @param {...string} extra */
  const init = (...extra) => spawnSync(RUNTIME, [join(ROOT, 'scripts', 'init.mjs'), '--no-gh', ...extra], { cwd: repo, encoding: 'utf8' });

  let r = init();
  check('init exits 0', r.status === 0, `${r.stdout}${r.stderr}`);
  for (const f of [
    '.github/ISSUE_TEMPLATE/task.md', '.github/ISSUE_TEMPLATE/config.yml', '.github/pull_request_template.md',
    '.github/workflows/guard-main.yml', '.github/workflows/agentic-checks.yml',
    '.github/scripts/agentic/scope-check.mjs', '.github/scripts/agentic/negative-control.mjs', '.github/scripts/agentic/lib/detect.mjs',
    '.worktreeinclude',
  ]) check(`init copies ${f}`, existsSync(join(repo, f)));
  check('init leaves nothing stray at the root', !existsSync(join(repo, 'claude-settings.json')) && !existsSync(join(repo, 'ci')));

  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  check('init keeps existing settings', settings.other === true && settings.permissions.deny.includes('WebFetch'));
  check('init merges the deny list without duplicates', settings.permissions.deny.includes('Bash(git push --force *)') && settings.permissions.deny.filter((/** @type {string} */ d) => d === 'Bash(rm -rf / *)').length === 1);

  const prePush = join(repo, '.git', 'hooks', 'pre-push');
  check('init installs an executable pre-push', existsSync(prePush) && (statSync(prePush).mode & 0o111) !== 0);

  writeFileSync(join(repo, '.github', 'pull_request_template.md'), 'mine\n');
  r = init();
  check('init rerun respects an edited file', r.status === 0 && /pull_request_template\.md exists and differs/.test(r.stdout) && readFileSync(join(repo, '.github', 'pull_request_template.md'), 'utf8') === 'mine\n', r.stdout);
  const settings2 = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  check('init rerun does not duplicate deny rules', new Set(settings2.permissions.deny).size === settings2.permissions.deny.length);
  init('--force');
  check('init --force overwrites an edited file', readFileSync(join(repo, '.github', 'pull_request_template.md'), 'utf8') !== 'mine\n');

  // the installed git pre-push, fed the way git feeds it
  /** @param {string} line @param {Record<string, string>} [env] */
  const pre = (line, env = {}) => spawnSync('bash', [prePush, 'origin', 'https://example.invalid/x.git'], { cwd: repo, input: line, encoding: 'utf8', env: { ...process.env, ...env } });
  const sha = git(['rev-parse', 'HEAD'], repo);
  const zero = '0'.repeat(40);
  check('pre-push refuses a push to main', pre(`refs/heads/main ${sha} refs/heads/main ${zero}\n`).status === 1);
  check('pre-push allows a new work branch', pre(`refs/heads/feat/1-x ${sha} refs/heads/feat/1-x ${zero}\n`).status === 0);
  check('pre-push honours the bootstrap valve', pre(`refs/heads/main ${sha} refs/heads/main ${zero}\n`, { AGENTIC_ALLOW_PUSH_MAIN: '1' }).status === 0);
}

for (const fn of cleanups) fn();
console.log(`${passed} passed, ${failed} failed (${RUNTIME.split('/').pop()})`);
process.exit(failed ? 1 : 0);
