#!/usr/bin/env node
// reconcile — prints the agent loop's current state as one JSON document, so
// step 0 of skills/orchestrate/SKILL.md reads it instead of running three
// gh/git commands and cross-referencing them by hand.
//
//   node scripts/reconcile.mts [--milestone "<title>"] [--no-fetch]
//
// Without --milestone, picks the open milestone with the lowest number.
//
// Without --no-fetch, runs `git fetch --prune origin` once before reading
// remote branches, so step 0 of skills/orchestrate/SKILL.md no longer runs
// its own fetch and a pass makes one network call for git, not two. Remote
// branches then come from the local refs (`git for-each-ref
// refs/remotes/origin`), not a second network round trip.
// --no-fetch skips the fetch and reads whatever those local refs already
// hold, so a pass can run offline against the state of the last fetch — at
// the cost of not seeing a branch deleted on the remote since then.
//
// Output shape:
//   {
//     milestone: string,
//     ready: [{ number, title, blockedBy: number[] }],       // Blocked-by all closed
//     inProgress: [{ number, branch, hasRemoteBranch, pr }],  // pr: number | null
//     resumable: [{ number, branch, commitsAheadOfMain }],    // in-progress, remote
//                                                              // branch, no open PR, not
//                                                              // checked out in any *live*
//                                                              // local worktree of this
//                                                              // checkout (dead-locked ones
//                                                              // don't count)
//     inReview: [{ number, pr, checks: 'green'|'red'|'pending', reviewApproved }],
//     stale: [{ number, reason }],                            // in-progress, no PR, no remote branch
//     orphanWorktrees: [path],                                // linked worktree, branch gone from origin
//     deadWorktrees: [{ path, branch, pid }],                  // locked by a pid that no longer exists
//   }
//
// A fresh orchestrator session has no live agents by definition, so an
// in-progress issue with a remote branch, no open PR, and no local worktree
// checked out on that branch is not "an implementer is working right now" —
// it is resumable: round N+1 from `origin/<branch>` (skills/safe-worktree
// §C). Classification order for an in-progress issue: open PR -> inProgress
// (with pr); else no remote branch -> stale; else branch checked out in a
// *live* local worktree of this checkout -> inProgress (pr: null); else ->
// resumable, and it is removed from inProgress.
//
// Claude Code locks an agent worktree only while that agent runs, with a
// reason of the form `claude agent agent-<id> (pid <N> start <date>)`; it
// removes the lock on a clean exit (the worktree stays, unlocked), but a
// killed session leaves the lock behind, still naming the now-dead pid. A
// worktree whose lock names a pid that `process.kill(N, 0)` reports gone
// (ESRCH) does not count as a live agent's checkout, so its branch does not
// block `resumable` — the worktree is instead listed in `deadWorktrees` for
// the orchestrator to remove (`git worktree unlock` then `remove --force`)
// before dispatching round N+1. A worktree with no lock, a lock with no pid
// in its reason (or `pid <= 0`, which signals nothing and proves nothing),
// or a lock whose pid is alive (or whose signal fails with EPERM — no
// permission to signal it is not evidence it is gone) is treated exactly as
// before: alive, still "checked out". This narrows, but does not close, the
// #46 restart gap: an agent that finished *without* opening a PR, in a
// session that has since died, leaves an unlocked worktree indistinguishable
// from a live session's paused agent — that residual still reads
// `inProgress` and needs a person, or a future liveness signal, to resolve.
//
// GitHub data comes only from `gh` (issue list, pr list, api); worktree and
// branch data from `git worktree list --porcelain` and (after `git fetch
// --prune origin`, unless --no-fetch) `git for-each-ref refs/remotes/origin`.
// Node built-ins only, no dependency.
//
// Crash policy: never a stack trace. A failing `gh` or `git` call (auth,
// rate limit, an unknown milestone, no remote) prints { "error": "..." } to
// stdout and exits 1.
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../ci/lib/args.mts';
import { parseBlockedBy } from './lib/issues.mts';

type Label = { name: string };
type Issue = { number: number; title: string; body: string; labels: Label[] };
type CheckEntry = {
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
};
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

/**
 * `gh pr list --json statusCheckRollup` returns every check run ever attached
 * to the head commit, including runs `concurrency.cancel-in-progress`
 * cancelled when the PR was pushed to again. Keep only the latest entry per
 * check name (check runs) / context (status contexts), the way `gh pr
 * checks` deduplicates, before classifying — latest by `startedAt`, since a
 * re-run always starts after the run it replaces, whatever that run's
 * `completedAt` (a cancelled predecessor can complete after the replacement
 * has already started).
 */
function latestChecksByName(entries: CheckEntry[]): CheckEntry[] {
  const latest = new Map<string, CheckEntry>();
  for (const entry of entries) {
    const key = entry.name ?? entry.context ?? '';
    const existing = latest.get(key);
    if (!existing) {
      latest.set(key, entry);
      continue;
    }
    const existingTime = existing.startedAt ?? existing.completedAt;
    const time = entry.startedAt ?? entry.completedAt;
    // Order by startedAt, not completedAt: a re-run starts after its
    // predecessor started, regardless of when that predecessor (possibly
    // cancelled well after the replacement began) completed. Comparing
    // completedAt would let a cancelled predecessor's late completion
    // outrank the replacement that is currently running. Both entries
    // carry a timestamp: the later one wins. Otherwise (either side
    // missing one) the later array position wins — this loop runs in
    // array order, so the incoming entry always wins that case.
    if (existingTime && time ? time >= existingTime : true) latest.set(key, entry);
  }
  return [...latest.values()];
}

function checksState(rollup: CheckEntry[] | null): 'green' | 'red' | 'pending' {
  const entries = latestChecksByName(rollup ?? []);
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

// 5. remote branches: one fetch (unless --no-fetch), then local refs — no
// `git ls-remote` network round trip.
if (!args['no-fetch']) {
  git(['fetch', '--prune', 'origin']);
}
// `%(refname:short)` picks the shortest name that stays unambiguous among
// *all* local refs, not a fixed "strip refs/remotes/origin/" prefix: a local
// branch can force it to render a tracking ref differently (down to the
// literal "origin" for refs/remotes/origin/HEAD itself, which the old
// `.replace(/^origin\//, '')` + `!== 'HEAD'` filter never caught). `lstrip=3`
// always drops exactly the leading `refs/remotes/origin/` components,
// leaving `HEAD` (then filtered) or the real branch name, slashes included.
const remoteHeads = new Set(
  git(['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((ref) => ref !== 'HEAD'),
);

// `origin/<default>` for the resumable count below. `refs/remotes/origin/HEAD`
// is set by a real clone, and the test fixture sets it explicitly (`git
// remote set-head origin <default>`) after its first fetch, so this resolves
// offline from local refs — no extra `gh` call. Only if that symbolic ref is
// missing (an `origin` added by hand, never fetched with a HEAD) does this
// fall back to `gh repo view`, the same source `claim.mts`/`land.mts` use.
function defaultBranchName(): string {
  const symref = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
  if (symref.status === 0) {
    return symref.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  }
  const repoInfo = ghJson<{ defaultBranchRef?: { name?: string } }>(['repo', 'view', '--json', 'defaultBranchRef'], {});
  return repoInfo.defaultBranchRef?.name ?? 'main';
}
const defaultBranch = defaultBranchName();

// A `pid <N>` a Claude Code lock reason names, tested against the live
// process table: no throw -> alive; ESRCH -> gone; anything else (EPERM: no
// permission to signal it, or an unexpected errno) -> alive, fail safe —
// never remove a worktree that might still be in use (AC4).
function isPidAlive(pid: number): boolean {
  // A `\d+` capture cannot itself produce a negative or non-numeric pid, but
  // guard anyway: `pid <= 0` (a bare "pid 0", or a NaN from an unparsable
  // capture) is not a real, signalable process — signal 0 to pid 0 hits the
  // caller's own process group and proves nothing, so treat it as no
  // evidence rather than asking `process.kill` to answer a question it was
  // never asked. No evidence -> alive, same as a lock with no pid at all.
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// 6. worktrees; the first block from `git worktree list` is always the main
// one. A `locked` line with no reason on it, or a reason with no `pid <N>` in
// it, is treated as alive: no evidence the process is gone.
const worktrees = git(['worktree', 'list', '--porcelain'])
  .split(/\n{2,}/)
  .map((b) => b.trim())
  .filter(Boolean)
  .map((block) => {
    const lockedLine = block.match(/^locked(?:[ \t]+(.*))?$/m);
    const pidMatch = lockedLine?.[1]?.match(/pid\s+(\d+)/);
    const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;
    return {
      path: block.match(/^worktree\s+(.*)$/m)?.[1] ?? '',
      branch: block.match(/^branch\s+refs\/heads\/(.*)$/m)?.[1] ?? null,
      dead: lockedLine !== null && pid !== null && !isPidAlive(pid),
      pid,
    };
  });
const linkedWorktrees = worktrees.slice(1);
const deadWorktrees = linkedWorktrees
  .filter((w) => w.dead)
  .map((w) => ({ path: w.path, branch: w.branch, pid: w.pid as number }));

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

// Branches checked out in any *live* local worktree of this checkout (the
// main worktree included) — an issue whose lock branch is checked out here
// may have a live agent, even before it has opened a PR. A worktree whose
// lock names a dead pid does not count: no evidence an agent is alive there.
const checkedOutBranches = new Set(
  worktrees
    .filter((w) => !w.dead)
    .map((w) => w.branch)
    .filter((b): b is string => b !== null),
);

// Fully-qualified `refs/remotes/origin/...` on both sides, not the short
// `origin/<x>` form: git's revision resolution for a short name prefers a
// local branch (`refs/heads/origin/<x>`) over the remote-tracking ref
// (`refs/remotes/origin/<x>`) of the same name — the exact shadow #48 fixed
// for `for-each-ref`. A local branch literally named `origin/main` or
// `origin/<lock-branch>` would otherwise make this resolve to the wrong
// commit and silently misreport the count instead of failing loudly.
function commitsAhead(branch: string): number {
  const out = git(['rev-list', `refs/remotes/origin/${defaultBranch}..refs/remotes/origin/${branch}`, '--count']).trim();
  return Number.parseInt(out, 10) || 0;
}

const inProgressAll = issues
  .filter((i) => hasLabel(i.labels, 'state:in-progress'))
  .map((i) => {
    const branch = branchFor(i.number);
    const pr = prFor(branch);
    return { number: i.number, branch, hasRemoteBranch: branch !== null, pr: pr ? pr.number : null };
  });

// Resumable: a remote branch, no open PR, not checked out in any *live*
// local worktree of this checkout (checkedOutBranches already excludes
// dead-locked worktrees) — see the header comment for the classification
// order and rationale.
const resumable = inProgressAll
  .filter((i) => i.pr === null && i.branch !== null && !checkedOutBranches.has(i.branch))
  .map((i) => ({ number: i.number, branch: i.branch as string, commitsAheadOfMain: commitsAhead(i.branch as string) }));
const resumableNumbers = new Set(resumable.map((i) => i.number));

const inProgress = inProgressAll.filter((i) => !resumableNumbers.has(i.number));

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

console.log(JSON.stringify({ milestone, ready, inProgress, resumable, inReview, stale, orphanWorktrees, deadWorktrees }, null, 2));
