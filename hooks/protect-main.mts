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
//   4. invokes `gh issue edit` while the payload carries an `agent_id` AND the
//      session's cwd resolves to a linked worktree — the same discriminator
//      `hooks/protect-worktree.mts` uses. An `authorised:` line in an issue's
//      `## Files` widens what the pull request closing it may touch, and
//      `ci/scope-check.mts` reads that body at check time; only the
//      orchestrator, which runs in the main checkout, writes one. An agent is
//      born in a worktree and never leaves it, so "in a linked worktree" is
//      how this hook tells the session a grant would exempt from the session
//      allowed to write it. Global flags are skipped the same way as item 3.
// The ruleset and `hooks/git-pre-push` (every push from this machine, in or
// out of Claude Code) are the layers that count; this one saves a round
// trip. No quotes, backticks or `$()` are parsed, so a commit message that
// quotes one of the forms above may be denied too — write it differently.
//
// Known misses, by construction: a segment is only matched when the forbidden
// command is its head — `gh` at the head, with only its recognised global
// flags between `gh` and `pr merge` / `issue edit` — so every indirect form
// gets through — `bash -c 'gh pr merge 1'`, `sh -lc …`, `xargs gh …`,
// `command gh pr merge 1`, `time gh pr merge 1`, a subshell `(gh pr merge 1)`,
// an alias, a wrapper script, `$(…)`/backtick substitution, or the command
// read from a file. Only leading env assignments, `sudo` and `env` are
// stripped (`commandSegments`). Item 4 misses the same forms and one more of
// its own: `gh api -X PATCH repos/{owner}/{repo}/issues/<n>` edits a body
// without the words `issue edit` anywhere in it, and a `git` push of a commit
// that edits nothing on GitHub is not an issue edit at all.
// These are NOT oversights to be patched one by one: chasing them is an arms
// race a string check cannot win, and it is why this hook is the third layer
// and not the gate. The ruleset (and, for merges, `scripts/land.mts`'s own
// refusal path) is what actually holds; for item 4 the durable layer is the
// CI side — `ci/scope-check.mts` holding a grant to its provenance — which
// waits on this repository having an orchestrator identity to compare against
// (see `docs/decisions/0024-a-grant-is-never-written-from-a-worktree.md`).
//
// Item 3 does not touch `scripts/land.mts`: that script spawns `gh` from
// inside Node, so the session's Bash tool — the only thing this hook sees —
// reads `node scripts/land.mts <pr>`, which is allowed.
//
// Valve, for bootstrapping a repo with no ruleset yet:
//   AGENTIC_ALLOW_PUSH_MAIN=1   lifts item 2's push form only, never 1, 3, 4,
//                               or item 2's deletion form
// **No environment variable lifts item 3 or item 4, and none is going to be
// added.** An operator who genuinely has to merge a pull request by hand does
// it outside the agent session (a terminal of their own, or the GitHub UI);
// inside a session, `node scripts/land.mts <pr>` is the only way to merge. An
// agent that needs a wider scope asks the orchestrator for the grant and
// stops; a valve here would be the self-grant the rule exists to refuse.
//
// Crash policy: ALLOW. Node missing, an unreadable payload, a `git` that
// cannot answer where the session is standing, or a throw here all let the
// call through — the ruleset and git-pre-push remain. Item 4 in particular
// allows whenever the worktree test cannot be made: an unreadable repository
// is not evidence of a grant.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { commandSegments, currentBranch, deny, git, note, parsePayload, readStdin, valve } from './lib/common.mts';

const HOOK = 'protect-main';
const PROTECTED = /^(?:refs\/heads\/)?(?:main|master)$/;
const MERGE_REMEDY =
  'Run `node scripts/land.mts <pr>` instead — it is the only way to merge from a session, ' +
  'and `--admin` is never a remedy. No environment variable lifts this; a genuine manual ' +
  'merge happens outside the agent session.';
const GRANT_REMEDY =
  'The issue body carries the `## Files` globs and any `authorised:` grant that widens them, ' +
  'so a session editing the issue it is implementing can grant itself scope. Ask the orchestrator ' +
  'for the grant on the issue, and stop — do not work around this. No environment variable lifts this.';
const stripQuotes =(t: string) => t.replace(/^(['"])(.*)\1$/, '$2');

// The `gh` global flags that take a value, in the forms the tokeniser has to
// skip to reach the subcommand. `--flag=value` and the attached short form
// (`-Rowner/repo`) are one token; the separated forms take the next token too.
const GH_FLAG_WITH_SEPARATE_VALUE = new Set(['-R', '--repo', '--hostname']);
const GH_FLAG_WITH_ATTACHED_VALUE = /^(?:-R.+|--(?:repo|hostname)=.*)$/;

/**
 * Whether the segment invokes `gh <group> <verb>`, at the head or behind the
 * global flags above (#204: `gh -R owner/repo pr merge --admin` is valid gh
 * syntax and used to reach the shell; `gh -R owner/repo issue edit` is the
 * same shape for item 4). Anything the tokeniser does not recognise ends the
 * skip, so an unknown flag reads as the subcommand and the segment is allowed
 * — the same trade as the rest of this hook: the ruleset is the gate.
 */
function isGhCommand(segment: string, group: string, verb: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean).map(stripQuotes);
  if (tokens[0] !== 'gh') return false;
  let i = 1;
  while (i < tokens.length) {
    if (GH_FLAG_WITH_SEPARATE_VALUE.has(tokens[i])) i += 2;
    else if (GH_FLAG_WITH_ATTACHED_VALUE.test(tokens[i])) i += 1;
    else break;
  }
  return tokens[i] === group && tokens[i + 1] === verb;
}

/** Real path of an existing directory; the path itself when it cannot be read. */
function realish(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * Whether `cwd` sits in a **linked** worktree — the test
 * `hooks/protect-worktree.mts:46-51` makes, and for the same reason: the
 * orchestrator runs in the main checkout and every agent is born in a
 * worktree of it. Both sides are resolved through `realpathSync`, because
 * `--show-toplevel` already answers in real paths while `--git-common-dir`
 * answers relative to `cwd`, and `/var/…` and `/private/var/…` must compare
 * equal on macOS or the main checkout reads as a worktree. A `git` that
 * cannot answer returns `false`: the crash policy is ALLOW.
 */
function inLinkedWorktree(cwd: string): boolean {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  const common = git(['rev-parse', '--git-common-dir'], cwd);
  if (!top.ok || !common.ok) return false;
  return realish(top.stdout.trim()) !== realish(resolve(cwd, common.stdout.trim(), '..'));
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
  // Fast path: the three words that can start a rule. `issue` joins them for
  // item 4 rather than the hook parsing every command it has no rule for.
  if (!/push|merge|issue/.test(command)) return;
  const cwd = payload.cwd || process.cwd();
  // Computed at most once per call, and only when a segment is already an
  // `gh issue edit`: the worktree test costs two `git` spawns.
  let linkedWorktree: boolean | null = null;

  for (const segment of commandSegments(command)) {
    if (/^git\s+push\b/.test(segment)) checkPush(segment, cwd, command);
    if (isGhCommand(segment, 'pr', 'merge')) {
      const lead = /--admin\b/.test(segment)
        ? '`gh pr merge --admin` bypasses the checks; forbidden.'
        : 'merging a pull request by hand is forbidden.';
      deny(HOOK, `${lead} ${MERGE_REMEDY}`);
    }
    if (payload.agent_id && isGhCommand(segment, 'issue', 'edit')) {
      linkedWorktree ??= inLinkedWorktree(cwd);
      if (linkedWorktree) deny(HOOK, `editing an issue from inside a worktree is forbidden. ${GRANT_REMEDY}`);
    }
  }
}

main().catch((err) => {
  note(HOOK, `hook error, allowing the call: ${err?.message ?? err}`);
  process.exit(0);
});
