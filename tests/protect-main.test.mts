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
  'echo $(git push origin main)', // subshell content must still be seen
  'echo \\"a && git push origin main', // backslash outside quotes escapes the quote, doesn't open one; && still splits
  'git commit -m "x" && git push origin main', // a cleanly closed string still lets a real operator split after it
  "git status  # let's see\ngit push origin main", // a # comment must not let its apostrophe swallow the newline
  "echo $'it\\'s' && git push origin main", // $'...' ANSI-C quoting: backslash escapes even in single quotes
  'git push origin "main"', // double-quoted refspec token
  "git push origin 'main'", // single-quoted refspec token
  "git push origin $'main'", // $'...' ANSI-C quoted refspec token
  "git push origin mai'n'", // single quotes spliced inside a bare word
  'git push origin ma"in"', // double quotes spliced inside a bare word
  'git branch -D "main"', // quoted branch name in a delete
  'git branch -D feat/1-x main', // main is not the first name after -D, but is still deleted
  'echo `git push origin main`', // backtick command substitution, outside quotes
  'echo "`git push origin main`"', // backtick command substitution, inside double quotes
  'echo x & git push origin main', // a lone & backgrounds the first command; the second still runs
  'git push origin main & echo done', // a lone & backgrounds the first command but still runs it
  'git push origin main 2>&1', // a redirect after the refspec must not hide the push
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
  'echo "a && git push origin main"', // one segment, starting with echo
  "git commit -m 'x; git push --force'", // one segment, starting with git commit
  'echo "a \\" && git push origin main && b"', // escaped quote doesn't end the string; still one segment
  "echo '`git push origin main`'", // backtick inside single quotes is literal text
  'echo x >&2 && git push origin feat/1-x', // >& is a redirection, not a lone &, and doesn't hide the real &&
  'git commit -m "a & b"', // & inside a double-quoted string is not the background operator
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
