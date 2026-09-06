#!/usr/bin/env node
// Cases for hooks/protect-main.mts: the plain third-layer check — no push to
// main, no force-push, no `gh pr merge --admin`. Spawns the real hook
// against a throwaway git repo.
import { check, commit, finish, git, hook, tempRepo } from './lib/harness.mts';

const bash = (command: string, cwd: string, env?: Record<string, string>) =>
  hook('protect-main.mts', { tool_name: 'Bash', tool_input: { command }, cwd }, { cwd, env });

const repo = tempRepo();
commit(repo, { 'a.txt': 'a' }, 'init');

// AC1(a): force-push, in any form the hook is asked to catch.
// AC1(b): a push that targets main/master, or a bare push while on it.
// AC1 merge: `gh pr merge --admin`.
const denied = [
  'git push --force origin feat/1-x',
  'git push -f origin feat/1-x',
  'git push origin +feat/1-x',
  'git push origin main',
  'git push origin master',
  'git push origin HEAD:main',
  'git push origin "main"', // the token test strips one layer of surrounding quotes
  'git push', // bare push while on main
  'cd sub && git push origin main', // a segment after && is still checked
  'gh pr merge --admin 12',
  'git push origin main:refs/heads/main', // AC1/AC3: long-form refspec, remote side is protected
  'git push origin HEAD:refs/heads/master',
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
  'AGENTIC_ALLOW_PUSH_MAIN=1 git push origin main', // inline valve
  'gh pr merge 1', // fail-closed is gone: no --admin, the server decides
  'gh pr merge 1 --squash',
  'git push origin main:refs/heads/feat/x', // AC2/AC3: local side matches, remote side does not
];
for (const command of allowed) {
  const r = bash(command, repo);
  check(`protect-main allows: ${command}`, r.status === 0 && r.stdout === '', r.stderr);
}
check(
  'protect-main allows a push to main with the env valve set',
  bash('git push origin main', repo, { AGENTIC_ALLOW_PUSH_MAIN: '1' }).status === 0,
);
check(
  'protect-main allows the long-form refspec to main with the env valve set',
  bash('git push origin main:refs/heads/main', repo, { AGENTIC_ALLOW_PUSH_MAIN: '1' }).status === 0,
);

// AC1/AC3: the valve lifts pushing to main, never deleting it.
const deniedWithValve = [
  'git push origin :main',
  'git push origin :refs/heads/main',
  'git push origin --delete main',
  'git push -d origin main',
];
for (const command of deniedWithValve) {
  const r = bash(command, repo, { AGENTIC_ALLOW_PUSH_MAIN: '1' });
  check(`protect-main denies deleting main even with the valve set: ${command}`, r.status === 2 && /permissionDecision":"deny/.test(r.stdout), r.stderr);
}
check('protect-main allows deleting a work branch', bash('git push origin :feat/x', repo).status === 0);

git(['checkout', '-q', '-b', 'feat/1-x'], repo);
check('protect-main allows bare push from a work branch', bash('git push', repo).status === 0);

check('protect-main ignores non-Bash tools', hook('protect-main.mts', { tool_name: 'Edit', tool_input: { command: 'git push origin main' } }).status === 0);
check('protect-main allows on unreadable payload', hook('protect-main.mts', '{not json').status === 0);

finish();
