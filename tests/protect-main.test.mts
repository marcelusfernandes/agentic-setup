#!/usr/bin/env node
// Cases for hooks/protect-main.mts: no push to main, no force-push, no merge
// without gh answering. Spawns the real hook against a throwaway git repo.
import { check, commit, finish, git, hook, tempRepo } from './lib/harness.mts';

const bash = (command: string, cwd: string, env?: Record<string, string>) =>
  hook('protect-main.mts', { tool_name: 'Bash', tool_input: { command }, cwd }, { cwd, env });

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
check('protect-main ignores non-Bash tools', hook('protect-main.mts', { tool_name: 'Edit', tool_input: { command: 'git push origin main' } }).status === 0);
check('protect-main allows on unreadable payload', hook('protect-main.mts', '{not json').status === 0);

finish();
