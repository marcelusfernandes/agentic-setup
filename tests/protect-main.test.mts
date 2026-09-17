#!/usr/bin/env node
// Cases for hooks/protect-main.mts: the plain third-layer check — no push to
// main, no force-push, no `gh pr merge` by hand (with or without `--admin`).
// Spawns the real hook against a throwaway git repo. Also asserts the
// declarative deny list that ships next to the hook, since the two state the
// same rule and drift silently otherwise.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, check, commit, finish, git, hook, tempRepo } from './lib/harness.mts';

const bash = (command: string, cwd: string, env?: Record<string, string>) =>
  hook('protect-main.mts', { tool_name: 'Bash', tool_input: { command }, cwd }, { cwd, env });

const repo = tempRepo();
commit(repo, { 'a.txt': 'a' }, 'init');

// AC1(a): force-push, in any form the hook is asked to catch.
// AC1(b): a push that targets main/master, or a bare push while on it.
// AC1 merge: any `gh pr merge` segment, `--admin` or not, and with a global
// flag (`-R`/`--repo`, `--hostname`) typed before the `pr merge` subcommand.
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
  'gh pr merge 1 --admin',
  'gh pr merge 1 --squash',
  'gh pr merge 1',
  'gh pr merge 42 --squash --delete-branch',
  'cd sub && gh pr merge 7 --merge', // a merge after && is still a command segment
  'echo "x; gh pr merge 1"', // no quote parsing: the `;` splits inside the string too (see the hook header)
  'gh -R owner/repo pr merge 1', // #204: a global flag before the subcommand is still a merge
  'gh -Rowner/repo pr merge 1', // the short flag with its value attached
  'gh --repo owner/repo pr merge 1 --squash',
  'gh --repo=owner/repo pr merge 1 --squash',
  'gh --hostname github.example.com pr merge 1',
  'gh -R owner/repo --hostname github.example.com pr merge 1', // two global flags
  'git status && gh -R owner/repo pr merge --admin', // #204: after another segment, no PR number
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
  'node scripts/land.mts 1', // the only way to merge: gh is spawned from Node, not from this Bash
  'node scripts/land.mts 1 --allow-label',
  'git commit -m "docs: never gh pr merge by hand"', // quoted, not a command segment
  'gh pr view 1 --json mergeStateStatus', // a neighbouring gh pr subcommand stays allowed
  'gh -R owner/repo pr view 1 --json mergeStateStatus', // #204: skipping a global flag never widens past `pr merge`
  'gh -R owner/repo pr list --search merge', // the skipped flag's value is not read as a subcommand
  'git push origin main:refs/heads/feat/x', // AC2/AC3: local side matches, remote side does not
  'git push origin refs/heads/main:feat/x', // AC2: local side is refs/heads/main, remote side does not match
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

// AC1: the refusal names the one way to merge, and says `--admin` is no remedy.
const plain = bash('gh pr merge 1 --squash', repo);
check('protect-main names `node scripts/land.mts <pr>` when it refuses a hand-typed merge', /node scripts\/land\.mts <pr>/.test(plain.stderr), plain.stderr);
check('protect-main says `--admin` is never a remedy', /--admin/.test(plain.stderr) && /never a remedy/.test(plain.stderr), plain.stderr);

const admin = bash('gh pr merge 1 --admin', repo);
check('protect-main keeps the existing --admin wording', /bypasses the checks/.test(admin.stderr), admin.stderr);
check('protect-main also names land.mts on the --admin form', /node scripts\/land\.mts <pr>/.test(admin.stderr), admin.stderr);

// #204: the wording does not depend on where the subcommand starts.
const globalAdmin = bash('gh -R owner/repo pr merge 1 --admin', repo);
check('protect-main keeps the --admin wording behind a global flag', /bypasses the checks/.test(globalAdmin.stderr), globalAdmin.stderr);
const globalPlain = bash('gh -R owner/repo pr merge 1', repo);
check('protect-main uses the plain wording behind a global flag', /merging a pull request by hand is forbidden/.test(globalPlain.stderr), globalPlain.stderr);

// AC3: no valve lifts the merge rule — a genuine manual merge leaves the session.
check(
  'protect-main denies a hand-typed merge even with the push valve set inline',
  bash('AGENTIC_ALLOW_PUSH_MAIN=1 gh pr merge 1 --squash', repo).status === 2,
);
check(
  'protect-main denies a hand-typed merge even with the push valve in the environment',
  bash('gh pr merge 1 --squash', repo, { AGENTIC_ALLOW_PUSH_MAIN: '1' }).status === 2,
);

// AC2: the declarative deny list states the same rule, in both copies.
const settingsRaw = readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8');
const templateRaw = readFileSync(join(ROOT, 'templates', 'claude-settings.json'), 'utf8');
const denyList: string[] = JSON.parse(settingsRaw).permissions.deny;
check('the deny list refuses every `gh pr merge`', denyList.includes('Bash(gh pr merge *)'), settingsRaw);
check('the deny list no longer refuses only the --admin form', !denyList.some((rule) => rule.includes('gh pr merge') && rule.includes('--admin')), settingsRaw);
check('.claude/settings.json and templates/claude-settings.json are byte-identical', settingsRaw === templateRaw);

check('protect-main ignores non-Bash tools', hook('protect-main.mts', { tool_name: 'Edit', tool_input: { command: 'git push origin main' } }).status === 0);
check('protect-main allows on unreadable payload', hook('protect-main.mts', '{not json').status === 0);

finish();
