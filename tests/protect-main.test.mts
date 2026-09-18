#!/usr/bin/env node
// Cases for hooks/protect-main.mts: the plain third-layer check — no push to
// main, no force-push, no `gh pr merge` by hand (with or without `--admin`),
// and no `gh issue edit` from inside an agent's worktree (#237: the session an
// `authorised:` grant would exempt is never the session that writes it).
// Spawns the real hook against a throwaway git repo — and, for #237, against a
// real linked worktree of it, since the worktree is the discriminator. Also
// asserts the declarative deny list that ships next to the hook, since the two
// state the same rule and drift silently otherwise.
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

// #237 AC1/AC3: an `authorised:` grant is never written by the session it would
// exempt. The discriminator is the one protect-worktree.mts already uses — an
// agent_id in the payload plus a cwd that resolves to a LINKED worktree — so the
// cases below run against a real `git worktree add`, not a second clone.
const grantWt = join(repo, '.worktrees', 'agent-237');
git(['worktree', 'add', '-q', '-b', 'fix/237-grant', grantWt], repo);
const agentBash = (command: string, cwd: string, env?: Record<string, string>) =>
  hook('protect-main.mts', { tool_name: 'Bash', tool_input: { command }, cwd, agent_id: 'agent-237' }, { cwd, env });

const deniedInWorktree = [
  'gh issue edit 42 --body-file x',
  'gh issue edit 42 --body-file /tmp/issue.md --add-label state:ready',
  'gh -R owner/repo issue edit 42 --body-file x', // #204: a global flag before the subcommand is still an edit
  'gh -Rowner/repo issue edit 42 --body-file x',
  'gh --repo=owner/repo issue edit 42 --body-file x',
  'git status && gh issue edit 42 --body-file x', // a segment after && is still checked
];
for (const command of deniedInWorktree) {
  const r = agentBash(command, grantWt);
  check(`protect-main denies from an agent's worktree: ${command}`, r.status === 2 && /permissionDecision":"deny/.test(r.stdout), r.stderr);
}

// #237 AC3: the main checkout is untouched, and so is every neighbouring
// `gh issue` subcommand from anywhere.
check(
  'protect-main allows `gh issue edit` from the main checkout (the orchestrator writes the grant)',
  agentBash('gh issue edit 42 --body-file x', repo).status === 0,
);
check(
  'protect-main allows `gh issue edit` from a worktree with no agent_id',
  bash('gh issue edit 42 --body-file x', grantWt).status === 0,
);
const allowedInWorktree = [
  'gh issue view 42',
  'gh issue view 42 --json body -q .body',
  'gh issue comment 42 --body "blocked on a grant"',
  'gh issue list --label state:ready',
  'gh pr edit 42 --body-file x', // a grant in a PR body never counted anyway (#155)
];
for (const command of allowedInWorktree) {
  const r = agentBash(command, grantWt);
  check(`protect-main allows from an agent's worktree: ${command}`, r.status === 0 && r.stdout === '', r.stderr);
}

// #237 AC4: no environment variable lifts it — the push valve covers item 2 only.
check(
  'protect-main denies the issue edit even with the push valve set inline',
  agentBash('AGENTIC_ALLOW_PUSH_MAIN=1 gh issue edit 42 --body-file x', grantWt).status === 2,
);
check(
  'protect-main denies the issue edit even with the push valve in the environment',
  agentBash('gh issue edit 42 --body-file x', grantWt, { AGENTIC_ALLOW_PUSH_MAIN: '1' }).status === 2,
);

// #237 AC1: the refusal names the remedy the contract already has.
const grantRefusal = agentBash('gh issue edit 42 --body-file x', grantWt);
check('protect-main names the orchestrator as the one who writes a grant', /orchestrator/i.test(grantRefusal.stderr) && /grant/i.test(grantRefusal.stderr), grantRefusal.stderr);
check('protect-main tells the session to stop rather than work around it', /and stop\b/i.test(grantRefusal.stderr), grantRefusal.stderr);
check('protect-main says no environment variable lifts the issue-edit rule', /no environment variable lifts this/i.test(grantRefusal.stderr), grantRefusal.stderr);

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
