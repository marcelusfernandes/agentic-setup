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
  // #25: $( … ) is the $() twin of the backtick command substitution above —
  // the inner command must not truncate the outer one (denied on both main
  // and a work branch, since the refspec "main" is still directly seen; no
  // masking risk from the bare-push-from-main fallback here).
  'git push origin $(echo) main',
  'git push origin $(echo x) main',
  'git push origin $(echo $(true)) main', // nested $( … ): a depth counter must find the *outer* close
  'git push origin "+main"', // quoted force-refspec: isForcePush must read the unquoted token
  'git push origin "+"main', // quote boundary spliced inside a force-refspec
  'git push "-f" origin feat/1-x', // quoted -f: isForcePush must read the unquoted token
  'git push "--force" origin feat/1-x', // regression lock: quoted --force already matched isForcePush's old raw-string regex
  'git push origin $"main"', // $"..." locale quoting: unquote must strip it like "..."
  'git push origin main&> /dev/null', // &> glued directly to the refspec must not swallow it into one token
  'git push origin main >&2', // regression lock: already denied pre-#25 (a real space keeps "main" its own token)
  'git push origin main 2>&1 | cat', // regression lock: a pipe after the redirect must still split normally
  'echo \\>& git push origin main', // a backslash-escaped > is ordinary text; the & after it must still split
  'git push --delete origin "main"', // regression lock: quoted --delete target already worked pre-#25
  'git push "--delete" origin main', // quoted --delete flag itself: unquote-before-flag-check must catch it
  'git push origin 2>/dev/null', // the whole refspec position is a redirect: bare-push-from-main fallback must still fire
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
  // #25 negative controls: every denied-list device above, aimed at a
  // non-main push, must still be allowed.
  'echo ">&" && git push origin feat/1-x', // a quoted ">&" is literal text, not a redirection that could hide the &&
  'git push origin feat/1-x > log.txt', // redirection target must be dropped, but the real refspec kept
  'echo "$(date)" && git push origin feat/1-x', // $( … ) inside an unrelated echo must not corrupt the later push
  'git commit -m "see $(pwd)"', // $( … ) inside a non-push command is untouched (skipped by the fast path)
];
for (const command of allowed) {
  const r = bash(command, repo);
  check(`protect-main allows: ${command}`, r.status === 0 && r.stdout === '', r.stderr);
}
git(['checkout', '-q', '-b', 'feat/1-x'], repo);
check('protect-main allows bare push from a work branch', bash('git push', repo).status === 0);

// From a non-main branch, a bare "git push origin" with no refspec is allowed
// (the earlier "bare push" case above never proves this: on branch main a
// severed head segment is *also* denied by the bare-push-from-main fallback,
// masking a broken split). These prove a backtick pair inside the push does
// not sever the refspec from the command that carries it.
const deniedFromWorkBranch = [
  'git push origin `echo` main', // a backtick pair inside the command must not sever the outer push
  'git push origin `echo x` main', // same, with content in the backtick pair
  'git push origin ` ` main', // same, with only whitespace in the backtick pair
  'git push --delete origin `x` main', // same, on a --delete push
  'git push origin `# x` main', // a # comment inside backticks must end at the closing backtick, not swallow it
  'git push origin `# \\` x` main', // an escaped backtick inside the comment does not close it early
  'echo a `# x` && git push origin main', // the comment ends at the backtick; a real && still splits after
  'echo a `#` && git push origin main', // the comment can be empty and still end right at the backtick
  'echo a `# x`; git push origin main', // same, with a ; after the backtick pair instead of &&
  'git push --delete origin `# x` main', // same comment-in-backticks case, on a --delete push
];
for (const command of deniedFromWorkBranch) {
  const r = bash(command, repo);
  check(`protect-main denies from a work branch: ${command}`, r.status === 2 && /permissionDecision":"deny/.test(r.stdout), r.stderr);
}

check('protect-main fails CLOSED on merge when gh cannot read the PR', bash('gh pr merge 1 --squash', repo).status === 2);
check('protect-main ignores non-Bash tools', hook('protect-main.mts', { tool_name: 'Edit', tool_input: { command: 'git push origin main' } }).status === 0);
check('protect-main allows on unreadable payload', hook('protect-main.mts', '{not json').status === 0);

finish();
