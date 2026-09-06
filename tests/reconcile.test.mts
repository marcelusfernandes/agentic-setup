#!/usr/bin/env node
// Cases for scripts/reconcile.mts: it prints the loop state (ready issues,
// in-progress, in-review, stale, orphan worktrees) as one JSON document.
// GitHub data comes from a fake `gh` put first on PATH (a bash script that
// dispatches on the subcommand and prints canned JSON); worktree data comes
// from a real temporary git repository with a real linked worktree and a
// real (bare, local) "origin" remote, so `git fetch --prune`, `git
// for-each-ref` and `git worktree list --porcelain` are exercised for real.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { check, cleanup, finish, git, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

// --- a fake `gh` on PATH ----------------------------------------------------
const FAKE_GH = `#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  "api repos/{owner}/{repo}/milestones")
    echo '[{"number":2,"title":"M2","state":"open"},{"number":1,"title":"M1","state":"open"}]'
    ;;
  "issue list")
    args="$*"
    case "$args" in
      *"--state closed"*)
        echo '[{"number":3}]'
        ;;
      *"--milestone M1"*)
        cat <<'JSON'
[
  {"number":10,"title":"Ready no blockers","body":"## Dependencies\\nBlocked by: none\\n","labels":[{"name":"state:ready"}]},
  {"number":11,"title":"Ready blocked open","body":"## Dependencies\\nBlocked by: #99\\n","labels":[{"name":"state:ready"}]},
  {"number":12,"title":"Ready blocked closed","body":"## Dependencies\\nBlocked by: #3\\n","labels":[{"name":"state:ready"}]},
  {"number":20,"title":"In progress with pr","body":"","labels":[{"name":"state:in-progress"}]},
  {"number":21,"title":"In progress stale","body":"","labels":[{"name":"state:in-progress"}]},
  {"number":30,"title":"In review green approved","body":"","labels":[{"name":"state:in-review"}]},
  {"number":31,"title":"In review red","body":"","labels":[{"name":"state:in-review"}]},
  {"number":40,"title":"In review pending checks","body":"","labels":[{"name":"state:in-review"}]},
  {"number":41,"title":"In review gh pr checks prints non-JSON","body":"","labels":[{"name":"state:in-review"}]},
  {"number":42,"title":"In review cancelled check reads red","body":"","labels":[{"name":"state:in-review"}]},
  {"number":50,"title":"In progress prune target","body":"","labels":[{"name":"state:in-progress"}]},
  {"number":60,"title":"In progress shadowed tracking ref","body":"","labels":[{"name":"state:in-progress"}]},
  {"number":70,"title":"In progress resumable ahead of main","body":"","labels":[{"name":"state:in-progress"}]},
  {"number":71,"title":"In progress resumable but checked out in a worktree","body":"","labels":[{"name":"state:in-progress"}]},
  {"number":72,"title":"In progress worktree locked by a dead pid","body":"","labels":[{"name":"state:in-progress"}]},
  {"number":73,"title":"In progress worktree locked by a live pid","body":"","labels":[{"name":"state:in-progress"}]},
  {"number":74,"title":"In progress worktree locked with pid 0 in the reason","body":"","labels":[{"name":"state:in-progress"}]}
]
JSON
        ;;
      *)
        echo "fake-gh: unknown milestone" >&2
        exit 1
        ;;
    esac
    ;;
  "pr list")
    cat <<'JSON'
[
  {"number":100,"headRefName":"feat/20-x","labels":[],"reviewDecision":null},
  {"number":130,"headRefName":"feat/30-y","labels":[{"name":"review:approved"}],"reviewDecision":null},
  {"number":131,"headRefName":"feat/31-z","labels":[],"reviewDecision":null},
  {"number":140,"headRefName":"feat/40-pending-checks","labels":[],"reviewDecision":null},
  {"number":141,"headRefName":"feat/41-nonjson-checks","labels":[],"reviewDecision":null},
  {"number":142,"headRefName":"feat/42-cancelled-check","labels":[],"reviewDecision":null},
  {"number":160,"headRefName":"feat/60-shadowed","labels":[],"reviewDecision":null}
]
JSON
    ;;
  "pr checks")
    case "\${3:-}" in
      130)
        echo '[{"name":"scope","bucket":"pass"},{"name":"test (node)","bucket":"pass"}]'
        ;;
      131)
        echo '[{"name":"scope","bucket":"pass"},{"name":"test (node)","bucket":"fail"}]'
        exit 1
        ;;
      140)
        echo '[{"name":"scope","bucket":"pass"},{"name":"test (node)","bucket":"pending"}]'
        exit 8
        ;;
      141)
        echo "gh: 1 of 2 checks still pending"
        exit 1
        ;;
      142)
        echo '[{"name":"scope","bucket":"pass"},{"name":"test (node)","bucket":"cancel"}]'
        exit 1
        ;;
      *)
        echo "fake-gh: unknown pr checks: $*" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "fake-gh: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- a real repo with branches, a remote, and an orphan worktree -----------
const repo = tempRepo();
git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);

const remoteDir = mkdtempSync(join(tmpdir(), 'agentic-remote-'));
cleanup(() => rmSync(remoteDir, { recursive: true, force: true }));
git(['init', '-q', '--bare', remoteDir], repo);
git(['remote', 'add', 'origin', remoteDir], repo);

for (const branch of [
  'feat/20-x',
  'feat/30-y',
  'feat/31-z',
  'feat/40-pending-checks',
  'feat/41-nonjson-checks',
  'feat/42-cancelled-check',
  'feat/50-prune-target',
  'feat/60-shadowed',
]) {
  git(['checkout', '-q', '-b', branch, 'main'], repo);
  git(['push', '-q', 'origin', branch], repo);
}
git(['checkout', '-q', 'main'], repo);

// A real clone sets refs/remotes/origin/HEAD; `git init` + `remote add`
// (used above) never does on its own, so recreate it explicitly.
git(['push', '-q', 'origin', 'main'], repo);
git(['fetch', '-q', 'origin'], repo);
git(['remote', 'set-head', 'origin', 'main'], repo);

// A plain local branch that shadows a remote-tracking ref one level down:
// `refs/heads/origin/feat/60-shadowed` next to `refs/remotes/origin/feat/
// 60-shadowed`. `%(refname:short)` picks the *shortest unambiguous* form —
// with this shadow present it renders the tracking ref as
// "remotes/origin/feat/60-shadowed" instead of "origin/feat/60-shadowed",
// so the code's `.replace(/^origin\//, '')` no longer strips the prefix.
// (A branch literally named "origin" cannot reproduce the closely related
// origin/HEAD finding this way: its mere existence makes git disambiguate
// origin/HEAD to "origin/HEAD" instead of the bogus "origin", which is
// exactly the scenario git's own disambiguation is designed to avoid.)
git(['branch', 'origin/feat/60-shadowed', 'main'], repo);

const worktreeDir = join(mkdtempSync(join(tmpdir(), 'agentic-worktree-')), 'wt');
cleanup(() => rmSync(worktreeDir, { recursive: true, force: true }));
git(['worktree', 'add', '-q', '-b', 'feat/99-orphan', worktreeDir, 'main'], repo);

// --- AC1/AC2/AC3 (#46): resumable — a remote branch, no open PR, no local
// worktree checked out on it. #70 has two commits pushed beyond `origin/main`
// and no worktree: resumable, with commitsAheadOfMain === 2. #71 has a
// worktree checked out on its branch (an agent of this checkout may be
// alive), so it must stay `inProgress` instead of moving to `resumable`.
git(['checkout', '-q', '-b', 'feat/70-resumable-ahead', 'main'], repo);
git(['commit', '-q', '--allow-empty', '-m', 'ahead 1'], repo);
git(['commit', '-q', '--allow-empty', '-m', 'ahead 2'], repo);
git(['push', '-q', 'origin', 'feat/70-resumable-ahead'], repo);

git(['checkout', '-q', '-b', 'feat/71-resumable-worktree', 'main'], repo);
git(['push', '-q', 'origin', 'feat/71-resumable-worktree'], repo);
git(['checkout', '-q', 'main'], repo);

const resumableWorktreeDir = join(mkdtempSync(join(tmpdir(), 'agentic-resumable-worktree-')), 'wt');
cleanup(() => rmSync(resumableWorktreeDir, { recursive: true, force: true }));
git(['worktree', 'add', '-q', resumableWorktreeDir, 'feat/71-resumable-worktree'], repo);

// --- AC1/AC2/AC4 (#56): a worktree locked by a dead pid does not count as a
// live agent. #72's worktree is locked with a reason naming a pid that does
// not exist: the branch must not count as "checked out" for classification
// purposes, so the issue is resumable and the worktree is reported in
// deadWorktrees. #73's worktree is locked with this test process's own
// (live) pid: it must count exactly like an unlocked checkout (AC4, fail
// safe) — inProgress, not resumable, and absent from deadWorktrees.
function findDeadPid(): number {
  for (let pid = 99999; pid < 999999; pid++) {
    try {
      process.kill(pid, 0);
    } catch (err: any) {
      if (err && err.code === 'ESRCH') return pid;
    }
  }
  throw new Error('could not find a pid that does not exist on this machine');
}
const DEAD_PID = findDeadPid();

git(['checkout', '-q', '-b', 'feat/72-dead-locked-worktree', 'main'], repo);
git(['push', '-q', 'origin', 'feat/72-dead-locked-worktree'], repo);
git(['checkout', '-q', 'main'], repo);

const deadLockedWorktreeDir = join(mkdtempSync(join(tmpdir(), 'agentic-dead-locked-worktree-')), 'wt');
cleanup(() => rmSync(deadLockedWorktreeDir, { recursive: true, force: true }));
git(['worktree', 'add', '-q', deadLockedWorktreeDir, 'feat/72-dead-locked-worktree'], repo);
git(
  ['worktree', 'lock', deadLockedWorktreeDir, '--reason', `claude agent agent-dead (pid ${DEAD_PID} start Sat Sep  5 19:34:36 2026)`],
  repo,
);

git(['checkout', '-q', '-b', 'feat/73-live-locked-worktree', 'main'], repo);
git(['push', '-q', 'origin', 'feat/73-live-locked-worktree'], repo);
git(['checkout', '-q', 'main'], repo);

const liveLockedWorktreeDir = join(mkdtempSync(join(tmpdir(), 'agentic-live-locked-worktree-')), 'wt');
cleanup(() => rmSync(liveLockedWorktreeDir, { recursive: true, force: true }));
git(['worktree', 'add', '-q', liveLockedWorktreeDir, 'feat/73-live-locked-worktree'], repo);
git(
  ['worktree', 'lock', liveLockedWorktreeDir, '--reason', `claude agent agent-live (pid ${process.pid} start Sat Sep  5 19:34:36 2026)`],
  repo,
);

// Regression guard: `pid 0` in a lock reason is not evidence of death. Signal
// `0` is a pure existence check (`process.kill(0, 0)` delivers nothing to any
// process and does not throw), so this already passes on the current code —
// this case guards against a future change to `isPidAlive` treating `pid <=
// 0` as a real, signalable pid.
git(['checkout', '-q', '-b', 'feat/74-pid-zero-worktree', 'main'], repo);
git(['push', '-q', 'origin', 'feat/74-pid-zero-worktree'], repo);
git(['checkout', '-q', 'main'], repo);

const pidZeroWorktreeDir = join(mkdtempSync(join(tmpdir(), 'agentic-pid-zero-worktree-')), 'wt');
cleanup(() => rmSync(pidZeroWorktreeDir, { recursive: true, force: true }));
git(['worktree', 'add', '-q', pidZeroWorktreeDir, 'feat/74-pid-zero-worktree'], repo);
git(
  ['worktree', 'lock', pidZeroWorktreeDir, '--reason', 'claude agent agent-zero (pid 0 start Sat Sep  5 19:34:36 2026)'],
  repo,
);

// --- AC1 (#88): dead worktrees report whether they still hold work worth
// saving. #72 above (already dead-locked, no changes beyond the pushed
// branch) doubles as the clean case: dirty: false, unpushed: 0.

// #75: an uncommitted file in a dead-locked worktree -> dirty: true.
git(['checkout', '-q', '-b', 'feat/75-dirty-worktree', 'main'], repo);
git(['push', '-q', 'origin', 'feat/75-dirty-worktree'], repo);
git(['checkout', '-q', 'main'], repo);
const dirtyWorktreeDir = join(mkdtempSync(join(tmpdir(), 'agentic-dirty-worktree-')), 'wt');
cleanup(() => rmSync(dirtyWorktreeDir, { recursive: true, force: true }));
git(['worktree', 'add', '-q', dirtyWorktreeDir, 'feat/75-dirty-worktree'], repo);
writeFileSync(join(dirtyWorktreeDir, 'untracked.txt'), 'uncommitted work\n');
git(
  ['worktree', 'lock', dirtyWorktreeDir, '--reason', `claude agent agent-dirty (pid ${DEAD_PID} start Sat Sep  5 19:34:36 2026)`],
  repo,
);

// #76: a local commit never pushed -> unpushed: 1.
git(['checkout', '-q', '-b', 'feat/76-unpushed-commit', 'main'], repo);
git(['push', '-q', 'origin', 'feat/76-unpushed-commit'], repo);
git(['checkout', '-q', 'main'], repo);
const unpushedCommitWorktreeDir = join(mkdtempSync(join(tmpdir(), 'agentic-unpushed-commit-worktree-')), 'wt');
cleanup(() => rmSync(unpushedCommitWorktreeDir, { recursive: true, force: true }));
git(['worktree', 'add', '-q', unpushedCommitWorktreeDir, 'feat/76-unpushed-commit'], repo);
git(['commit', '-q', '--allow-empty', '-m', 'local only'], unpushedCommitWorktreeDir);
git(
  [
    'worktree',
    'lock',
    unpushedCommitWorktreeDir,
    '--reason',
    `claude agent agent-unpushed (pid ${DEAD_PID} start Sat Sep  5 19:34:36 2026)`,
  ],
  repo,
);

// #77: a branch never pushed to origin at all -> unpushed: null.
const noRemoteWorktreeDir = join(mkdtempSync(join(tmpdir(), 'agentic-no-remote-worktree-')), 'wt');
cleanup(() => rmSync(noRemoteWorktreeDir, { recursive: true, force: true }));
git(['worktree', 'add', '-q', '-b', 'feat/77-no-remote-branch', noRemoteWorktreeDir, 'main'], repo);
git(
  [
    'worktree',
    'lock',
    noRemoteWorktreeDir,
    '--reason',
    `claude agent agent-noremote (pid ${DEAD_PID} start Sat Sep  5 19:34:36 2026)`,
  ],
  repo,
);

// A local branch literally named "origin/main" shadows the remote-tracking
// ref "origin/main" one level down, the same way "origin/feat/60-shadowed"
// does above (#48) — except here it targets `commitsAheadOfMain`'s own
// `origin/<default>..origin/<branch>` computation. Point it at #70's tip
// (not main's), so a resolution that picks this local branch instead of the
// real `refs/remotes/origin/main` shows up as a wrong count (0, since the
// range would run from #70's tip to itself), not a coincidentally right one.
git(['branch', 'origin/main', 'feat/70-resumable-ahead'], repo);

function reconcile(...args: string[]) {
  return spawnSync(RUNTIME, [join(ROOT, 'scripts', 'reconcile.mts'), ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: PATH_WITH_FAKE_GH },
  });
}

// --- happy path: --milestone M1 ---------------------------------------------
const r = reconcile('--milestone', 'M1');
check('reconcile exits 0', r.status === 0, `${r.stdout}\n${r.stderr}`);
check('reconcile prints nothing but JSON on stdout', (() => {
  try {
    JSON.parse(r.stdout);
    return true;
  } catch {
    return false;
  }
})(), r.stdout);

let out: any = null;
try {
  out = JSON.parse(r.stdout);
} catch {
  out = null;
}

check('milestone is the title', out?.milestone === 'M1');

const readyNumbers = (out?.ready ?? []).map((i: any) => i.number).sort();
check('ready excludes the issue blocked on an open issue', JSON.stringify(readyNumbers) === JSON.stringify([10, 12]), JSON.stringify(out?.ready));
const ready10 = (out?.ready ?? []).find((i: any) => i.number === 10);
const ready12 = (out?.ready ?? []).find((i: any) => i.number === 12);
check('ready reports no blockers as an empty array', Array.isArray(ready10?.blockedBy) && ready10.blockedBy.length === 0);
check('ready reports a closed blocker', Array.isArray(ready12?.blockedBy) && ready12.blockedBy.includes(3));
check('ready carries the title', ready10?.title === 'Ready no blockers');

const inProgress20 = (out?.inProgress ?? []).find((i: any) => i.number === 20);
const inProgress21 = (out?.inProgress ?? []).find((i: any) => i.number === 21);
check('in-progress with a remote branch and a PR', inProgress20?.branch === 'feat/20-x' && inProgress20?.hasRemoteBranch === true && inProgress20?.pr === 100, JSON.stringify(inProgress20));
check('in-progress with neither PR nor remote branch', inProgress21?.branch === null && inProgress21?.hasRemoteBranch === false && inProgress21?.pr === null, JSON.stringify(inProgress21));

check('stale lists only the issue with no PR and no remote branch', (out?.stale ?? []).length === 1 && out.stale[0].number === 21, JSON.stringify(out?.stale));

// --- AC3: a remote-tracking ref shadowed by a same-named local branch one
// level down must still resolve to its real (slash-bearing) branch name, not
// leak `remotes/origin/...` (or worse, drop out entirely) because
// `%(refname:short)` shortened it to a longer, ambiguity-avoiding form -----
const inProgress60 = (out?.inProgress ?? []).find((i: any) => i.number === 60);
check(
  'in-progress resolves a remote branch whose tracking ref is shadowed by a same-named local branch one level down',
  inProgress60?.branch === 'feat/60-shadowed' && inProgress60?.hasRemoteBranch === true && inProgress60?.pr === 160,
  JSON.stringify(inProgress60),
);

// --- AC1/AC2/AC3 (#46): resumable vs. still-inProgress ----------------------
const resumable70 = (out?.resumable ?? []).find((i: any) => i.number === 70);
check(
  'resumable: remote branch, no PR, no worktree checkout, reports commits ahead of main',
  resumable70?.branch === 'feat/70-resumable-ahead' && resumable70?.commitsAheadOfMain === 2,
  JSON.stringify(resumable70),
);
check(
  'a resumable issue is removed from inProgress (AC1)',
  (out?.inProgress ?? []).every((i: any) => i.number !== 70),
  JSON.stringify(out?.inProgress),
);

const inProgress71 = (out?.inProgress ?? []).find((i: any) => i.number === 71);
check(
  'in-progress: remote branch, no PR, but checked out in a local worktree stays inProgress (AC2)',
  inProgress71?.branch === 'feat/71-resumable-worktree' && inProgress71?.hasRemoteBranch === true && inProgress71?.pr === null,
  JSON.stringify(inProgress71),
);
check(
  'a worktree-checked-out issue is never reported as resumable',
  (out?.resumable ?? []).every((i: any) => i.number !== 71),
  JSON.stringify(out?.resumable),
);

// --- AC1/AC2/AC4 (#56): a dead-pid lock does not count as a live agent -----
const resumable72 = (out?.resumable ?? []).find((i: any) => i.number === 72);
check(
  'a worktree locked by a dead pid does not count as checked out: its issue is resumable, with commitsAheadOfMain (AC1/AC2)',
  resumable72?.branch === 'feat/72-dead-locked-worktree' && resumable72?.commitsAheadOfMain === 0,
  JSON.stringify(resumable72),
);
check(
  'a dead-pid-locked issue is removed from inProgress',
  (out?.inProgress ?? []).every((i: any) => i.number !== 72),
  JSON.stringify(out?.inProgress),
);

const deadWorktrees: any[] = out?.deadWorktrees ?? [];
const deadWorktree72 = deadWorktrees.find((w) => w.branch === 'feat/72-dead-locked-worktree');
const deadLockedRealpath = realpathSync(deadLockedWorktreeDir);
check(
  'deadWorktrees lists the dead-pid-locked worktree with its path, branch and pid (AC2)',
  deadWorktree72 !== undefined && deadWorktree72.pid === DEAD_PID && realpathSync(deadWorktree72.path) === deadLockedRealpath,
  JSON.stringify(deadWorktree72),
);
check(
  'a clean dead worktree (no uncommitted changes, nothing unpushed) reports dirty: false, unpushed: 0 (#88 AC1)',
  deadWorktree72?.dirty === false && deadWorktree72?.unpushed === 0,
  JSON.stringify(deadWorktree72),
);

const deadWorktree75 = deadWorktrees.find((w) => w.branch === 'feat/75-dirty-worktree');
check(
  'a dead worktree with an uncommitted file reports dirty: true, unpushed: 0 (#88 AC1)',
  deadWorktree75?.dirty === true && deadWorktree75?.unpushed === 0,
  JSON.stringify(deadWorktree75),
);

const deadWorktree76 = deadWorktrees.find((w) => w.branch === 'feat/76-unpushed-commit');
check(
  'a dead worktree with one local commit never pushed reports dirty: false, unpushed: 1 (#88 AC1)',
  deadWorktree76?.dirty === false && deadWorktree76?.unpushed === 1,
  JSON.stringify(deadWorktree76),
);

const deadWorktree77 = deadWorktrees.find((w) => w.branch === 'feat/77-no-remote-branch');
check(
  'a dead worktree on a branch never pushed to origin reports unpushed: null (#88 AC1)',
  deadWorktree77?.dirty === false && deadWorktree77?.unpushed === null,
  JSON.stringify(deadWorktree77),
);

const inProgress73 = (out?.inProgress ?? []).find((i: any) => i.number === 73);
check(
  'a worktree locked by a live pid still counts as checked out: its issue stays inProgress (AC4, fail safe)',
  inProgress73?.branch === 'feat/73-live-locked-worktree' && inProgress73?.pr === null,
  JSON.stringify(inProgress73),
);
check(
  'a live-pid-locked issue is never reported as resumable',
  (out?.resumable ?? []).every((i: any) => i.number !== 73),
  JSON.stringify(out?.resumable),
);
check(
  'deadWorktrees does not list a worktree locked by a live pid',
  !deadWorktrees.some((w) => w.branch === 'feat/73-live-locked-worktree'),
  JSON.stringify(deadWorktrees),
);

// --- regression guard (#56 round 2): pid 0 in a lock reason is not evidence
// of death — treated as alive, same as no pid at all -----------------------
const inProgress74 = (out?.inProgress ?? []).find((i: any) => i.number === 74);
check(
  'a worktree locked with pid 0 in the reason is not dead: its issue stays inProgress',
  inProgress74?.branch === 'feat/74-pid-zero-worktree' && inProgress74?.pr === null,
  JSON.stringify(inProgress74),
);
check(
  'a pid-0-locked issue is never reported as resumable',
  (out?.resumable ?? []).every((i: any) => i.number !== 74),
  JSON.stringify(out?.resumable),
);
check(
  'deadWorktrees does not list a worktree locked with pid 0 in the reason',
  !deadWorktrees.some((w) => w.branch === 'feat/74-pid-zero-worktree'),
  JSON.stringify(deadWorktrees),
);

const inReview30 = (out?.inReview ?? []).find((i: any) => i.number === 30);
const inReview31 = (out?.inReview ?? []).find((i: any) => i.number === 31);
check('in-review green + approved', inReview30?.pr === 130 && inReview30?.checks === 'green' && inReview30?.reviewApproved === true, JSON.stringify(inReview30));
check('in-review red, not approved', inReview31?.pr === 131 && inReview31?.checks === 'red' && inReview31?.reviewApproved === false, JSON.stringify(inReview31));

// --- AC1: checks comes from `gh pr checks <pr> --json name,bucket`, not the
// `gh pr list` rollup. `bucket` is the five-way classification (pass, fail,
// pending, skipping, cancel) `gh` itself computes from the raw per-check
// state — reconcile reads that instead of re-deriving green/red/pending from
// raw CheckConclusionState strings (SUCCESS, FAILURE, ...) the way the old
// rollup code did. -----------------------------------------------------------
const inReview40 = (out?.inReview ?? []).find((i: any) => i.number === 40);
const inReview41 = (out?.inReview ?? []).find((i: any) => i.number === 41);
const inReview42 = (out?.inReview ?? []).find((i: any) => i.number === 42);
check(
  'in-review reads pending when gh pr checks reports a check still pending',
  inReview40?.pr === 140 && inReview40?.checks === 'pending',
  JSON.stringify(inReview40),
);
check(
  'in-review reads pending when gh pr checks exits non-zero with non-JSON stdout, instead of erroring the whole pass',
  inReview41?.pr === 141 && inReview41?.checks === 'pending',
  JSON.stringify(inReview41),
);
check(
  'in-review reads red when gh pr checks reports a cancelled check (bucket "cancel")',
  inReview42?.pr === 142 && inReview42?.checks === 'red',
  JSON.stringify(inReview42),
);

const orphanRealpath = realpathSync(worktreeDir);
const orphans: string[] = out?.orphanWorktrees ?? [];
check(
  'orphanWorktrees lists the linked worktree whose branch is not on the remote',
  orphans.some((p) => realpathSync(p) === orphanRealpath || basename(p) === basename(worktreeDir)),
  JSON.stringify(orphans),
);
check('orphanWorktrees does not list the main worktree', !orphans.some((p) => realpathSync(p) === realpathSync(repo)));

// #50 has a remote branch, no PR and no worktree checkout, so it now starts
// out `resumable` (AC1), not `inProgress` — see the negative control below.
const resumable50 = (out?.resumable ?? []).find((i: any) => i.number === 50);
check(
  'resumable prune target starts with a remote branch (no PR, no worktree checkout), no commits pushed beyond main',
  resumable50?.branch === 'feat/50-prune-target' && resumable50?.commitsAheadOfMain === 0,
  JSON.stringify(resumable50),
);

// --- AC1/AC2/AC3: default fetch (--prune) sees a branch deleted on the real
// remote since the last fetch; --no-fetch does not, reading the stale local
// ref instead. The deletion happens directly on the bare "origin" (not via a
// push from `repo`), so `repo`'s own refs/remotes/origin/* stay stale until
// something actually fetches. On the base (ls-remote queries the remote live,
// every time) both calls would already report the branch gone, so this pair
// only distinguishes the fixed behaviour from the base's. --------------------
git(['branch', '-D', 'feat/50-prune-target'], remoteDir);

const outNoFetch: any = JSON.parse(reconcile('--milestone', 'M1', '--no-fetch').stdout);
const noFetchResumable50 = (outNoFetch?.resumable ?? []).find((i: any) => i.number === 50);
check(
  '--no-fetch still reports the stale local ref as a resumable remote branch (AC2)',
  noFetchResumable50 !== undefined,
  JSON.stringify(noFetchResumable50),
);

const outFetched: any = JSON.parse(reconcile('--milestone', 'M1').stdout);
const fetchedResumable50 = (outFetched?.resumable ?? []).find((i: any) => i.number === 50);
const fetchedStale50 = (outFetched?.stale ?? []).find((i: any) => i.number === 50);
check(
  'the default run fetches with --prune first and no longer sees the deleted branch, so it is stale instead of resumable (AC1/AC3)',
  fetchedResumable50 === undefined && fetchedStale50 !== undefined,
  JSON.stringify({ fetchedResumable50, fetchedStale50 }),
);

// --- default milestone: lowest-numbered open milestone, no --milestone -----
const r2 = reconcile();
check('reconcile exits 0 with no --milestone', r2.status === 0, `${r2.stdout}\n${r2.stderr}`);
let out2: any = null;
try {
  out2 = JSON.parse(r2.stdout);
} catch {
  out2 = null;
}
check('reconcile picks the lowest-numbered open milestone by default', out2?.milestone === 'M1', r2.stdout);

// --- AC3: a failing gh yields { error } and exit 1, never a stack trace ----
const r3 = reconcile('--milestone', 'DoesNotExist');
check('reconcile exits 1 when gh fails', r3.status === 1, `${r3.stdout}\n${r3.stderr}`);
let out3: any = null;
try {
  out3 = JSON.parse(r3.stdout);
} catch {
  out3 = null;
}
check('reconcile reports { error } on stdout', typeof out3?.error === 'string' && out3.error.length > 0, r3.stdout);
check('reconcile never prints a stack trace', !/\n\s*at /.test(r3.stdout) && !/\n\s*at /.test(r3.stderr), `${r3.stdout}\n${r3.stderr}`);

finish();
