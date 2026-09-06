#!/usr/bin/env node
// protect-main — PreToolUse (Bash).
//
// Layer three, for a session in a repo with no server-side ruleset yet.
// Denies, before the command runs, a segment (split on &&, ||, ;, |,
// newlines — no quote parsing) that:
//   1. starts with `git push` and force-pushes (--force, -f, +refspec)
//   2. starts with `git push` and targets main/master: a token equal to
//      main/master, one ending in :main/:master, or no refspec at all while
//      the current branch is main/master
//   3. starts with `git push` and deletes main/master: a refspec starting
//      with `:` whose remote side is main/master (`:main`, `:refs/heads/main`),
//      or a --delete/-d flag with main/master among the refspecs — denied
//      regardless of the valve
//   4. starts with `gh pr merge` and passes `--admin`
// The ruleset and `hooks/git-pre-push` (every push from this machine, in or
// out of Claude Code) are the layers that count; this one saves a round
// trip. No quotes, backticks or `$()` are parsed, so a commit message that
// quotes one of the forms above may be denied too — write it differently.
//
// Valve, for bootstrapping a repo with no ruleset yet:
//   AGENTIC_ALLOW_PUSH_MAIN=1   lifts item 2 (never 1, 3 or 4 — it never
//                               covers deleting main/master)
//
// Crash policy: ALLOW. Node missing, an unreadable payload, or a throw here
// all let the call through — the ruleset and git-pre-push remain.
import { commandSegments, currentBranch, deny, note, parsePayload, readStdin, valve } from './lib/common.mts';

const HOOK = 'protect-main';
const PROTECTED = /^(?:refs\/heads\/)?(?:main|master)$/;
const stripQuotes = (t: string) => t.replace(/^(['"])(.*)\1$/, '$2');

function checkPush(segment: string, cwd: string, command: string): void {
  const tokens = segment.replace(/^git\s+push\b/, '').trim().split(/\s+/).filter(Boolean).map(stripQuotes);
  if (tokens.some((t) => t.startsWith('--force') || /^-[A-Za-z]*f[A-Za-z]*$/.test(t) || (t.startsWith('+') && t.length > 1))) {
    deny(HOOK, 'force-push is forbidden on every branch.');
  }
  const hasDeleteFlag = tokens.some((t) => t === '--delete' || /^-[A-Za-z]*d[A-Za-z]*$/.test(t));
  const refspecs = tokens.filter((t) => !t.startsWith('-')).slice(1); // [0] is the remote
  const deletesMain = refspecs.some((r) => (r.startsWith(':') ? PROTECTED.test(r.slice(1)) : hasDeleteFlag && PROTECTED.test(r)));
  if (deletesMain) {
    deny(HOOK, 'deleting main/master is forbidden. (AGENTIC_ALLOW_PUSH_MAIN=1 lifts pushing to main for bootstrap only; it never covers deletion.)');
  }
  const targetsMain =
    refspecs.some((r) => PROTECTED.test(r) || /:(?:main|master)$/.test(r)) ||
    (refspecs.length === 0 && PROTECTED.test(currentBranch(cwd)));
  if (targetsMain && !valve('AGENTIC_ALLOW_PUSH_MAIN', command)) {
    deny(HOOK, 'direct push to main/master is forbidden; open a PR. (AGENTIC_ALLOW_PUSH_MAIN=1 is for bootstrap only.)');
  }
}

async function main() {
  const payload = parsePayload(await readStdin());
  if (!payload || payload.tool_name !== 'Bash') return;
  const command = String(payload.tool_input?.command ?? '');
  if (!/push|merge/.test(command)) return; // fast path: nothing to look at
  const cwd = payload.cwd || process.cwd();

  for (const segment of commandSegments(command)) {
    if (/^git\s+push\b/.test(segment)) checkPush(segment, cwd, command);
    if (/^gh\s+pr\s+merge\b/.test(segment) && /--admin\b/.test(segment)) {
      deny(HOOK, '`gh pr merge --admin` bypasses the checks; forbidden.');
    }
  }
}

main().catch((err) => {
  note(HOOK, `hook error, allowing the call: ${err?.message ?? err}`);
  process.exit(0);
});
