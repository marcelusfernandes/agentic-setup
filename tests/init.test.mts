#!/usr/bin/env node
// Cases for scripts/init.mts: the installer copies templates into a target
// repository, merges settings, and installs an executable pre-push hook.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, commit, finish, git, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

const repo = tempRepo();
commit(repo, { 'README.md': '# x\n' }, 'init');
mkdirSync(join(repo, '.claude'), { recursive: true });
writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm -rf / *)', 'WebFetch'] }, other: true }));
const init = (...extra: string[]) => spawnSync(RUNTIME, [join(ROOT, 'scripts', 'init.mts'), '--no-gh', ...extra], { cwd: repo, encoding: 'utf8' });

let r = init();
check('init exits 0', r.status === 0, `${r.stdout}${r.stderr}`);
for (const f of [
  '.github/ISSUE_TEMPLATE/task.md', '.github/ISSUE_TEMPLATE/config.yml', '.github/pull_request_template.md',
  '.github/workflows/guard-main.yml', '.github/workflows/agentic-checks.yml',
  '.github/scripts/agentic/scope-check.mts', '.github/scripts/agentic/negative-control.mts', '.github/scripts/agentic/lib/detect.mts',
  '.worktreeinclude',
]) check(`init copies ${f}`, existsSync(join(repo, f)));
check('init leaves nothing stray at the root', !existsSync(join(repo, 'claude-settings.json')) && !existsSync(join(repo, 'ci')));

const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
check('init keeps existing settings', settings.other === true && settings.permissions.deny.includes('WebFetch'));
check('init merges the deny list without duplicates', settings.permissions.deny.includes('Bash(git push --force *)') && settings.permissions.deny.filter((d: string) => d === 'Bash(rm -rf / *)').length === 1);

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
const pre = (line: string, env: Record<string, string> = {}) => spawnSync('bash', [prePush, 'origin', 'https://example.invalid/x.git'], { cwd: repo, input: line, encoding: 'utf8', env: { ...process.env, ...env } });
const sha = git(['rev-parse', 'HEAD'], repo);
const zero = '0'.repeat(40);
check('pre-push refuses a push to main', pre(`refs/heads/main ${sha} refs/heads/main ${zero}\n`).status === 1);
check('pre-push allows a new work branch', pre(`refs/heads/feat/1-x ${sha} refs/heads/feat/1-x ${zero}\n`).status === 0);
check('pre-push honours the bootstrap valve', pre(`refs/heads/main ${sha} refs/heads/main ${zero}\n`, { AGENTIC_ALLOW_PUSH_MAIN: '1' }).status === 0);

finish();
