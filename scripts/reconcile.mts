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
//                                                              // checks comes from one
//                                                              // `gh pr checks <pr>` call per
//                                                              // in-review PR, not from the
//                                                              // list-call's rollup
//     stale: [{ number, reason }],                            // in-progress, no PR, no remote branch
//     orphanWorktrees: [path],                                // linked worktree, branch gone from origin
//     deadWorktrees: [{ path, branch, pid, dirty, unpushed }], // locked by a pid that no
//                                                              // longer exists. dirty: true
//                                                              // when `git -C <path> status
//                                                              // --porcelain` prints
//                                                              // anything, else false, else
//                                                              // (a broken worktree) null.
//                                                              // unpushed: commits in the
//                                                              // worktree's HEAD not on
//                                                              // `origin/<branch>`, or null
//                                                              // when there is no such
//                                                              // remote branch (or no
//                                                              // `branch` at all, or the
//                                                              // worktree is broken). These
//                                                              // two `git` calls run only
//                                                              // for dead worktrees, never
//                                                              // for live ones.
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
// A dead worktree can still hold work the orchestrator would otherwise throw
// away by following its own advice (`git worktree remove --force`): an
// uncommitted change, or a local commit never pushed (#88, four implementers
// died mid-work in M4). Each `deadWorktrees[]` entry therefore also reports
// `dirty` (`git -C <path> status --porcelain` printed anything) and
// `unpushed` (commits on the worktree's `HEAD` not on `origin/<branch>`, via
// `git -C <path> rev-list --count refs/remotes/origin/<branch>..HEAD` — fully
// qualified, same #48 reason as `commitsAhead` below: a local branch literally
// named `origin/<branch>` would otherwise shadow the remote-tracking ref —
// gated by `git -C <path> rev-parse --verify --quiet
// refs/remotes/origin/<branch>` so a branch never pushed reads `unpushed:
// null` rather than a nonsensical count). Both `git` calls run only for
// entries already in `deadWorktrees` — never for a live worktree, whether or
// not it turns out to be dirty or ahead.
//
// GitHub data comes only from `gh` (issue list, pr list, api, pr checks);
// worktree and branch data from `git worktree list --porcelain` and (after
// `git fetch --prune origin`, unless --no-fetch) `git for-each-ref
// refs/remotes/origin`. Node built-ins only, no dependency.
//
// `inReview[].checks` comes from one `gh pr checks <pr> --json name,bucket`
// call per in-review PR (cached by PR number, so two issues closed by the
// same PR still cost one call) — `gh` already deduplicates superseded check
// runs and classifies each into `bucket` (pass, fail, pending, skipping,
// cancel) the way `gh pr list --json statusCheckRollup` does neither, so
// reconcile no longer re-implements either (the #21 and #24 bugs were bugs
// of that re-implementation). `gh pr checks` exits non-zero whenever a check
// is failing or still pending, but still prints the JSON on stdout in that
// case, so its exit code is ignored; if stdout does not parse as JSON,
// `checks` reads 'pending' rather than failing the whole pass over one PR.
//
// Crash policy: never a stack trace. A failing `gh` or `git` call (auth,
// rate limit, an unknown milestone, no remote) prints { "error": "..." } to
// stdout and exits 1 — except `gh pr checks`, whose failure degrades that
// one PR's `checks` to 'pending' instead (see above), and the `git status`
// call behind `deadWorktrees[].dirty`, whose failure (a broken or removed
// worktree) degrades that one entry's `dirty` (and `unpushed`, since a
// worktree whose status cannot be read cannot be trusted for a commit range
// either) to `null` instead of failing the whole pass.
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../ci/lib/args.mts';
import { parseBlockedBy } from './lib/issues.mts';

type Label = { name: string };
type Issue = { number: number; title: string; body: string; labels: Label[] };
type PR = { number: number; headRefName: string; labels: Label[]; reviewDecision: string | null };
type Milestone = { number: number; title: string; state: string };
type PrCheckEntry = { name?: string; bucket?: string };

// `gh pr checks --json name,bucket` categorizes each check's raw CI state
// into exactly one of these five buckets (see `gh pr checks --help`) — this
// mirrors that five-way split, not GitHub's raw CheckConclusionState names.
const CHECK_GREEN = new Set(['pass', 'skipping']);
const CHECK_RED = new Set(['fail', 'cancel']);

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
 * `gh pr checks <pr>` already deduplicates superseded check runs (a re-run
 * `concurrency.cancel-in-progress` cancelled when the PR was pushed to
 * again) the way `gh pr list --json statusCheckRollup` does not, and its
 * `bucket` field already classifies each surviving check into pass, fail,
 * pending, skipping or cancel — so this reads that instead of re-deriving
 * green/red/pending from raw CheckConclusionState strings the old rollup
 * code did. `gh pr checks` exits non-zero whenever a check is failing or
 * still pending, but still prints the JSON on stdout in that case — so the
 * exit code is ignored and only stdout is read. A non-JSON stdout (an actual
 * `gh` failure: no such PR, no auth, `gh` not on PATH) degrades to 'pending'
 * rather than failing the whole pass over one PR's checks. Cached by PR
 * number so a PR closing more than one in-review issue costs one call.
 */
const checksCache = new Map<number, 'green' | 'red' | 'pending'>();
function checksForPr(prNumber: number): 'green' | 'red' | 'pending' {
  const cached = checksCache.get(prNumber);
  if (cached) return cached;
  const r = spawnSync('gh', ['pr', 'checks', String(prNumber), '--json', 'name,bucket'], { encoding: 'utf8' });
  const out = (r.stdout ?? '').trim();
  let result: 'green' | 'red' | 'pending' = 'pending';
  if (out) {
    try {
      const entries: PrCheckEntry[] = JSON.parse(out);
      const bucket = (c: PrCheckEntry) => String(c.bucket ?? '').toLowerCase();
      if (Array.isArray(entries) && entries.length > 0) {
        if (entries.some((c) => CHECK_RED.has(bucket(c)))) result = 'red';
        else if (entries.every((c) => CHECK_GREEN.has(bucket(c)))) result = 'green';
      }
    } catch {
      // Non-JSON stdout: leave result at 'pending' rather than failing the
      // whole pass over one PR's checks.
    }
  }
  checksCache.set(prNumber, result);
  return result;
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
  ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,labels,reviewDecision', '--limit', '200'],
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

/**
 * Whether a dead worktree still holds work worth saving (#88): `dirty` when
 * `git -C <path> status --porcelain` prints anything, `unpushed` the count of
 * commits on its `HEAD` not on `origin/<branch>` (`null` when `branch` is
 * absent, or names no remote-tracking ref — a branch never pushed at all). A
 * `git status` failure (a broken or removed worktree) reports `dirty: null`
 * rather than throwing; `unpushed` degrades to `null` alongside it, since a
 * worktree whose status cannot be trusted cannot be trusted for a commit
 * range either. Called only for entries already known to be dead.
 */
function deadWorktreeWork(path: string, branch: string | null): { dirty: boolean | null; unpushed: number | null } {
  const status = spawnSync('git', ['-C', path, 'status', '--porcelain'], { encoding: 'utf8' });
  if (status.status !== 0) return { dirty: null, unpushed: null };
  const dirty = status.stdout.trim().length > 0;

  if (!branch) return { dirty, unpushed: null };
  const verify = spawnSync('git', ['-C', path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { encoding: 'utf8' });
  if (verify.status !== 0) return { dirty, unpushed: null };

  const count = spawnSync('git', ['-C', path, 'rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`], { encoding: 'utf8' });
  const unpushed = count.status === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : null;
  return { dirty, unpushed };
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
  .map((w) => ({ path: w.path, branch: w.branch, pid: w.pid as number, ...deadWorktreeWork(w.path, w.branch) }));

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
      checks: pr ? checksForPr(pr.number) : 'pending' as const,
      reviewApproved: pr ? hasLabel(pr.labels, 'review:approved') || pr.reviewDecision === 'APPROVED' : false,
    };
  });

const stale = inProgress
  .filter((i) => i.pr === null && !i.hasRemoteBranch)
  .map((i) => ({ number: i.number, reason: 'no open PR and no remote branch' }));

const orphanWorktrees = linkedWorktrees.filter((w) => w.branch && !remoteHeads.has(w.branch)).map((w) => w.path);

console.log(JSON.stringify({ milestone, ready, inProgress, resumable, inReview, stale, orphanWorktrees, deadWorktrees }, null, 2));
