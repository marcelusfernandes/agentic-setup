#!/usr/bin/env node
// reconcile — prints the agent loop's current state as one JSON document, so
// step 0 of skills/orchestrate/SKILL.md reads it instead of running three
// gh/git commands and cross-referencing them by hand.
//
//   node scripts/reconcile.mts [--milestone "<title>"]
//
// Without --milestone, picks the open milestone with the lowest number.
//
// Output shape:
//   {
//     milestone: string,
//     ready: [{ number, title, blockedBy: number[] }],       // Blocked-by all closed
//     inProgress: [{ number, branch, hasRemoteBranch, pr }],  // pr: number | null
//     inReview: [{ number, pr, checks: 'green'|'red'|'pending', reviewApproved }],
//     stale: [{ number, reason }],                            // in-progress, no PR, no remote branch
//     orphanWorktrees: [path],                                // linked worktree, branch gone from origin
//   }
//
// GitHub data comes only from `gh` (issue list, pr list, api); worktree and
// branch data from `git worktree list --porcelain` and `git ls-remote
// --heads origin`. Node built-ins only, no dependency.
//
// Crash policy: never a stack trace. A failing `gh` or `git` call (auth,
// rate limit, an unknown milestone, no remote) prints { "error": "..." } to
// stdout and exits 1.
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../ci/lib/args.mts';
import { extractSection } from '../ci/lib/scope.mts';

type Label = { name: string };
type Issue = { number: number; title: string; body: string; labels: Label[] };
type CheckEntry = { state?: string; conclusion?: string };
type PR = { number: number; headRefName: string; labels: Label[]; statusCheckRollup: CheckEntry[] | null; reviewDecision: string | null };
type Milestone = { number: number; title: string; state: string };

const GREEN = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const RED = new Set(['FAILURE', 'ERROR', 'CANCELLED']);

function fail(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

function gh(args: string[]): string {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) fail(`gh ${args.join(' ')}: ${(r.stderr || r.stdout || 'failed').trim().split('\n')[0]}`);
  return r.stdout;
}

function ghJson<T>(args: string[], fallback: T): T {
  const out = gh(args).trim();
  if (!out) return fallback;
  try {
    return JSON.parse(out) as T;
  } catch {
    fail(`gh ${args.join(' ')}: could not parse JSON output`);
  }
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) fail(`git ${args.join(' ')}: ${(r.stderr || 'failed').trim().split('\n')[0]}`);
  return r.stdout;
}

function hasLabel(labels: Label[] | undefined, name: string): boolean {
  return (labels ?? []).some((l) => l.name === name);
}

/** "Blocked by: #3, #4" (or "none") from the issue body's Dependencies section. */
function parseBlockedBy(body: string): number[] {
  const section = extractSection(body, 'Dependencies') ?? body;
  const line = section.split(/\r?\n/).map((l) => l.trim()).find((l) => /^blocked by:/i.test(l));
  if (!line) return [];
  const rest = line.replace(/^blocked by:/i, '').trim();
  if (/^none\b/i.test(rest)) return [];
  return [...rest.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

function checksState(rollup: CheckEntry[] | null): 'green' | 'red' | 'pending' {
  const entries = rollup ?? [];
  if (entries.length === 0) return 'pending';
  const status = (c: CheckEntry) => String(c.conclusion ?? c.state ?? '').toUpperCase();
  if (entries.some((c) => RED.has(status(c)))) return 'red';
  if (entries.every((c) => GREEN.has(status(c)))) return 'green';
  return 'pending';
}

const args = parseArgs(process.argv.slice(2));

// 1. milestone: --milestone as given, else the open milestone with the lowest number.
let milestone: string;
if (typeof args.milestone === 'string') {
  milestone = args.milestone;
} else {
  const milestones = ghJson<Milestone[]>(['api', 'repos/{owner}/{repo}/milestones'], []);
  const open = milestones.filter((m) => m.state === 'open').sort((a, b) => a.number - b.number);
  if (open.length === 0) fail('no open milestone (pass --milestone).');
  milestone = open[0].title;
}

// 2. open issues in the milestone.
const issues = ghJson<Issue[]>(
  ['issue', 'list', '--milestone', milestone, '--state', 'open', '--json', 'number,title,body,labels', '--limit', '200'],
  [],
);

// 3. closed issues, repo-wide (a blocker can sit in another milestone).
const closedNumbers = new Set(
  ghJson<{ number: number }[]>(['issue', 'list', '--state', 'closed', '--json', 'number', '--limit', '1000'], []).map((i) => i.number),
);

// 4. open PRs.
const prs = ghJson<PR[]>(
  ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,labels,statusCheckRollup,reviewDecision', '--limit', '200'],
  [],
);

// 5. remote branches (one call).
const remoteHeads = new Set(
  git(['ls-remote', '--heads', 'origin'])
    .split('\n')
    .map((l) => l.trim().split('\t')[1])
    .filter((ref): ref is string => Boolean(ref))
    .map((ref) => ref.replace(/^refs\/heads\//, '')),
);

// 6. worktrees; the first block from `git worktree list` is always the main one.
const worktrees = git(['worktree', 'list', '--porcelain'])
  .split(/\n{2,}/)
  .map((b) => b.trim())
  .filter(Boolean)
  .map((block) => ({
    path: block.match(/^worktree\s+(.*)$/m)?.[1] ?? '',
    branch: block.match(/^branch\s+refs\/heads\/(.*)$/m)?.[1] ?? null,
  }));
const linkedWorktrees = worktrees.slice(1);

function branchFor(number: number): string | null {
  const re = new RegExp(`^[a-z]+/${number}-`);
  return [...remoteHeads].find((b) => re.test(b)) ?? null;
}
function prFor(branch: string | null): PR | null {
  if (!branch) return null;
  return prs.find((p) => p.headRefName === branch) ?? null;
}

const ready = issues
  .filter((i) => hasLabel(i.labels, 'state:ready'))
  .map((i) => ({ number: i.number, title: i.title, blockedBy: parseBlockedBy(i.body ?? '') }))
  .filter((i) => i.blockedBy.every((n) => closedNumbers.has(n)));

const inProgress = issues
  .filter((i) => hasLabel(i.labels, 'state:in-progress'))
  .map((i) => {
    const branch = branchFor(i.number);
    const pr = prFor(branch);
    return { number: i.number, branch, hasRemoteBranch: branch !== null, pr: pr ? pr.number : null };
  });

const inReview = issues
  .filter((i) => hasLabel(i.labels, 'state:in-review'))
  .map((i) => {
    const branch = branchFor(i.number);
    const pr = prFor(branch);
    return {
      number: i.number,
      pr: pr ? pr.number : null,
      checks: pr ? checksState(pr.statusCheckRollup) : 'pending' as const,
      reviewApproved: pr ? hasLabel(pr.labels, 'review:approved') || pr.reviewDecision === 'APPROVED' : false,
    };
  });

const stale = inProgress
  .filter((i) => i.pr === null && !i.hasRemoteBranch)
  .map((i) => ({ number: i.number, reason: 'no open PR and no remote branch' }));

const orphanWorktrees = linkedWorktrees.filter((w) => w.branch && !remoteHeads.has(w.branch)).map((w) => w.path);

console.log(JSON.stringify({ milestone, ready, inProgress, inReview, stale, orphanWorktrees }, null, 2));
