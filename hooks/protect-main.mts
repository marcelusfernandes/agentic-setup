#!/usr/bin/env node
// protect-main — PreToolUse (Bash).
//
// The agent-side layer of main protection. Denies, before the command runs:
//   1. force-push in any form (--force, --force-with-lease, -f, +refspec)
//   2. push to main/master (explicit ref, HEAD:main, or a bare push from main)
//   3. deleting main/master, locally or on the remote
//   4. `gh pr merge --admin`
//   5. `gh pr merge` without every check green, or without the review label
//      (AGENTIC_REVIEW_LABEL, default "review:approved") or an APPROVED review
//
// Items 1 and 4 are also covered by the permission deny list that
// `/agentic-setup:init` writes; keeping them here costs three lines and
// catches the forms a prefix pattern cannot (`-fu`, `+main`).
//
// Valves, for bootstrapping a repository and for a person acting on purpose:
//   AGENTIC_ALLOW_PUSH_MAIN=1   lifts item 2 (never 1)
//   AGENTIC_ALLOW_MERGE=1       lifts item 5 (never 4)
//
// Crash policy: ALLOW. If Node is missing, the payload is unreadable, or this
// file throws, the call goes through — the git pre-push hook and the
// guard-main action are the other layers. The one place this fails CLOSED is
// item 5: if `gh` cannot report the checks or the PR, the merge is denied,
// because "could not verify" is not "verified".
import { commandSegments, currentBranch, deny, note, parsePayload, readStdin, run, valve } from './lib/common.mts';

const HOOK = 'protect-main';
const PROTECTED = /^(?:refs\/heads\/)?(?:main|master)$/;
const GREEN = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

function isForcePush(args: string): boolean {
  return /--force\b/.test(args) || /(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?=\s|$)/.test(args) || /\s\+\S/.test(args);
}

function checkPush(args: string, cwd: string, command: string): void {
  if (isForcePush(args)) deny(HOOK, 'force-push is forbidden on every branch.');
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const deleting = tokens.includes('--delete') || tokens.includes('-d');
  const refspecs = tokens.filter((t) => !t.startsWith('-')).slice(1); // [0] is the remote
  const targetsMain =
    refspecs.some((r) => PROTECTED.test(r.includes(':') ? r.split(':').pop() ?? '' : r)) ||
    ((refspecs.length === 0 || refspecs.every((r) => r === 'HEAD')) && PROTECTED.test(currentBranch(cwd)));
  if (deleting && refspecs.some((r) => PROTECTED.test(r))) deny(HOOK, 'deleting main/master on the remote is forbidden.');
  if (targetsMain && !valve('AGENTIC_ALLOW_PUSH_MAIN', command)) {
    deny(HOOK, 'direct push to main/master is forbidden; open a PR. (AGENTIC_ALLOW_PUSH_MAIN=1 is for bootstrap only.)');
  }
}

function checkMerge(args: string, cwd: string, command: string): void {
  if (/--admin\b/.test(args)) deny(HOOK, '`gh pr merge --admin` bypasses the checks; forbidden.');
  if (valve('AGENTIC_ALLOW_MERGE', command)) return;
  const target = args.trim().split(/\s+/).find((t) => t && !t.startsWith('-'));
  const ref = target ? [target] : [];

  const checks = run('gh', ['pr', 'checks', ...ref, '--json', 'name,state'], { cwd });
  let list: { name: string; state: string }[] | null = null;
  try {
    list = JSON.parse(checks.stdout || '[]');
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) deny(HOOK, `could not read the PR checks (${(checks.stderr || 'no output').trim().slice(0, 160)}).`);
  if (list.length === 0) deny(HOOK, 'the PR has no checks registered; without CI there is no autonomous merge. (AGENTIC_ALLOW_MERGE=1 is for bootstrap only.)');
  const red = list.filter((c) => !GREEN.has(String(c.state).toUpperCase()));
  if (red.length) deny(HOOK, `checks not green: ${red.map((c) => `${c.name}=${c.state}`).join(', ')}.`);

  const view = run('gh', ['pr', 'view', ...ref, '--json', 'labels,reviewDecision'], { cwd });
  let pr: { labels?: { name: string }[]; reviewDecision?: string } | null = null;
  try {
    pr = JSON.parse(view.stdout || 'null');
  } catch {
    pr = null;
  }
  if (!pr) deny(HOOK, `could not read the PR (${(view.stderr || 'no output').trim().slice(0, 160)}).`);
  const label = process.env.AGENTIC_REVIEW_LABEL || 'review:approved';
  const hasLabel = (pr.labels ?? []).some((l) => l.name === label);
  if (!hasLabel && pr.reviewDecision !== 'APPROVED') {
    deny(HOOK, `the PR has neither the "${label}" label nor an APPROVED review; the reviewer goes first.`);
  }
}

async function main() {
  const payload = parsePayload(await readStdin());
  if (!payload || payload.tool_name !== 'Bash') return;
  const command = String(payload.tool_input?.command ?? '');
  if (!/push|merge|branch/.test(command)) return; // fast path: nothing to look at
  const cwd = payload.cwd || process.cwd();

  for (const segment of commandSegments(command)) {
    const push = segment.match(/^git\s+(?:-C\s+\S+\s+|--\S+\s+)*push\b(.*)$/);
    if (push) {
      checkPush(push[1], cwd, command);
      continue;
    }
    if (/^git\s+branch\s+.*(?:-D|--delete\s+--force|-d)\s+(?:main|master)\b/.test(segment)) {
      deny(HOOK, 'deleting main/master locally is forbidden.');
    }
    const merge = segment.match(/^gh\s+pr\s+merge\b(.*)$/);
    if (merge) checkMerge(merge[1], cwd, command);
  }
}

main().catch((err) => {
  note(HOOK, `hook error, allowing the call: ${err?.message ?? err}`);
  process.exit(0);
});
