#!/usr/bin/env node
// protect-main — PreToolUse (Bash).
//
// Layer three, for a session in a repo with no server-side ruleset yet.
// Denies, before the command runs, a segment (split on &&, ||, ;, |,
// newlines — no quote parsing) that:
//   1. starts with `git push` and force-pushes (--force, -f, +refspec)
//   2. starts with `git push` and targets main/master: a refspec whose
//      remote side is main/master (short or `refs/heads/` form), or no
//      refspec at all while the current branch is main/master — or deletes
//      them: a refspec starting with `:` whose remote side is main/master
//      (`:main`, `:refs/heads/main`), or a --delete/-d flag with
//      main/master among the refspecs
//   3. invokes `gh pr merge`, with or without `--admin`, and whether or not a
//      global flag is typed before the subcommand (`gh -R owner/repo pr merge`,
//      `--repo`, `--hostname`, in short, long, attached or `=` form)
// The ruleset and `hooks/git-pre-push` (every push from this machine, in or
// out of Claude Code) are the layers that count; this one saves a round
// trip. No quotes, backticks or `$()` are parsed, so a commit message that
// quotes one of the forms above may be denied too — write it differently.
//
// Known misses, by construction: a segment is only matched when the forbidden
// command is its head — `gh` at the head, with only its recognised global
// flags between `gh` and `pr merge` — so every indirect form gets through —
// `bash -c 'gh pr merge 1'`, `sh -lc …`, `xargs gh …`, `command gh pr merge 1`,
// `time gh pr merge 1`, a subshell `(gh pr merge 1)`, an alias, a wrapper
// script, `$(…)`/backtick substitution, or the command read from a file. Only
// leading env assignments, `sudo` and `env` are stripped (`commandSegments`).
// These are NOT oversights to be patched one by one: chasing them is an arms
// race a string check cannot win, and it is why this hook is the third layer
// and not the gate. The ruleset (and, for merges, `scripts/land.mts`'s own
// refusal path) is what actually holds.
//
// Item 3 does not touch `scripts/land.mts`: that script spawns `gh` from
// inside Node, so the session's Bash tool — the only thing this hook sees —
// reads `node scripts/land.mts <pr>`, which is allowed.
//
// Valve, for bootstrapping a repo with no ruleset yet:
//   AGENTIC_ALLOW_PUSH_MAIN=1   lifts item 2's push form only, never 1, 3,
//                               or item 2's deletion form
// **No environment variable lifts item 3, and none is going to be added.**
// An operator who genuinely has to merge a pull request by hand does it
// outside the agent session (a terminal of their own, or the GitHub UI);
// inside a session, `node scripts/land.mts <pr>` is the only way to merge.
//
// Crash policy: ALLOW. Node missing, an unreadable payload, or a throw here
// all let the call through — the ruleset and git-pre-push remain.
import { commandSegments, currentBranch, deny, note, parsePayload, readStdin, valve } from './lib/common.mts';

const HOOK = 'protect-main';
const PROTECTED = /^(?:refs\/heads\/)?(?:main|master)$/;
const MERGE_REMEDY =
  'Run `node scripts/land.mts <pr>` instead — it is the only way to merge from a session, ' +
  'and `--admin` is never a remedy. No environment variable lifts this; a genuine manual ' +
  'merge happens outside the agent session.';
const stripQuotes = (t: string) => t.replace(/^(['"])(.*)\1$/, '$2');

// The `gh` global flags that take a value, in the forms the tokeniser has to
// skip to reach the subcommand. `--flag=value` and the attached short form
// (`-Rowner/repo`) are one token; the separated forms take the next token too.
const GH_FLAG_WITH_SEPARATE_VALUE = new Set(['-R', '--repo', '--hostname']);
const GH_FLAG_WITH_ATTACHED_VALUE = /^(?:-R.+|--(?:repo|hostname)=.*)$/;

/**
 * Whether the segment invokes `gh pr merge`, at the head or behind the global
 * flags above (#204: `gh -R owner/repo pr merge --admin` is valid gh syntax
 * and used to reach the shell). Anything the tokeniser does not recognise ends
 * the skip, so an unknown flag reads as the subcommand and the segment is
 * allowed — the same trade as the rest of this hook: the ruleset is the gate.
 */
function isGhPrMerge(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean).map(stripQuotes);
  if (tokens[0] !== 'gh') return false;
  let i = 1;
  while (i < tokens.length) {
    if (GH_FLAG_WITH_SEPARATE_VALUE.has(tokens[i])) i += 2;
    else if (GH_FLAG_WITH_ATTACHED_VALUE.test(tokens[i])) i += 1;
    else break;
  }
  return tokens[i] === 'pr' && tokens[i + 1] === 'merge';
}

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
    refspecs.some((r) => PROTECTED.test(r.includes(':') ? r.slice(r.lastIndexOf(':') + 1) : r)) ||
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
    if (isGhPrMerge(segment)) {
      const lead = /--admin\b/.test(segment)
        ? '`gh pr merge --admin` bypasses the checks; forbidden.'
        : 'merging a pull request by hand is forbidden.';
      deny(HOOK, `${lead} ${MERGE_REMEDY}`);
    }
  }
}

main().catch((err) => {
  note(HOOK, `hook error, allowing the call: ${err?.message ?? err}`);
  process.exit(0);
});
