#!/usr/bin/env node
// Cases for scripts/reconcile.mts: it prints the loop state (ready issues,
// in-progress, in-review, stale, orphan worktrees) as one JSON document.
// GitHub data comes from a fake `gh` put first on PATH (a bash script that
// dispatches on the subcommand and prints canned JSON); worktree data comes
// from a real temporary git repository with a real linked worktree and a
// real (bare, local) "origin" remote, so `git ls-remote` and
// `git worktree list --porcelain` are exercised for real.
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
  {"number":40,"title":"In review dedupe green","body":"","labels":[{"name":"state:in-review"}]},
  {"number":41,"title":"In review dedupe red latest failure","body":"","labels":[{"name":"state:in-review"}]},
  {"number":42,"title":"In review dedupe pending latest in-progress","body":"","labels":[{"name":"state:in-review"}]}
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
  {"number":100,"headRefName":"feat/20-x","labels":[],"statusCheckRollup":[{"state":"SUCCESS"}],"reviewDecision":null},
  {"number":130,"headRefName":"feat/30-y","labels":[{"name":"review:approved"}],"statusCheckRollup":[{"state":"SUCCESS"}],"reviewDecision":null},
  {"number":131,"headRefName":"feat/31-z","labels":[],"statusCheckRollup":[{"state":"FAILURE"}],"reviewDecision":null},
  {"number":140,"headRefName":"feat/40-dedupe-green","labels":[],"statusCheckRollup":[
    {"name":"scope","status":"COMPLETED","conclusion":"CANCELLED"},
    {"name":"scope","status":"COMPLETED","conclusion":"SUCCESS"},
    {"name":"test (node)","status":"COMPLETED","conclusion":"SUCCESS"},
    {"name":"test (bun)","status":"COMPLETED","conclusion":"SUCCESS"},
    {"name":"negative-control","status":"COMPLETED","conclusion":"CANCELLED"},
    {"name":"negative-control","status":"COMPLETED","conclusion":"SUCCESS"}
  ],"reviewDecision":null},
  {"number":141,"headRefName":"feat/41-dedupe-red","labels":[],"statusCheckRollup":[
    {"name":"scope","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-01-01T00:05:00Z","completedAt":"2026-01-01T00:06:00Z"},
    {"name":"scope","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:01:00Z"}
  ],"reviewDecision":null},
  {"number":142,"headRefName":"feat/42-dedupe-pending","labels":[],"statusCheckRollup":[
    {"name":"test (node)","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:01:00Z"},
    {"name":"test (node)","status":"IN_PROGRESS","conclusion":null,"startedAt":"2026-01-01T00:02:00Z","completedAt":null}
  ],"reviewDecision":null}
]
JSON
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

for (const branch of ['feat/20-x', 'feat/30-y', 'feat/31-z', 'feat/40-dedupe-green', 'feat/41-dedupe-red', 'feat/42-dedupe-pending']) {
  git(['checkout', '-q', '-b', branch, 'main'], repo);
  git(['push', '-q', 'origin', branch], repo);
}
git(['checkout', '-q', 'main'], repo);

const worktreeDir = join(mkdtempSync(join(tmpdir(), 'agentic-worktree-')), 'wt');
cleanup(() => rmSync(worktreeDir, { recursive: true, force: true }));
git(['worktree', 'add', '-q', '-b', 'feat/99-orphan', worktreeDir, 'main'], repo);

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

const inReview30 = (out?.inReview ?? []).find((i: any) => i.number === 30);
const inReview31 = (out?.inReview ?? []).find((i: any) => i.number === 31);
check('in-review green + approved', inReview30?.pr === 130 && inReview30?.checks === 'green' && inReview30?.reviewApproved === true, JSON.stringify(inReview30));
check('in-review red, not approved', inReview31?.pr === 131 && inReview31?.checks === 'red' && inReview31?.reviewApproved === false, JSON.stringify(inReview31));

// --- AC1/AC2: dedupe superseded check runs before classifying --------------
const inReview40 = (out?.inReview ?? []).find((i: any) => i.number === 40);
const inReview41 = (out?.inReview ?? []).find((i: any) => i.number === 41);
const inReview42 = (out?.inReview ?? []).find((i: any) => i.number === 42);
check(
  'in-review dedupes superseded CANCELLED runs to green (the raw #20 rollup)',
  inReview40?.pr === 140 && inReview40?.checks === 'green',
  JSON.stringify(inReview40),
);
check(
  'in-review reads red when the latest run of a check is FAILURE, even though an older run of the same check succeeded',
  inReview41?.pr === 141 && inReview41?.checks === 'red',
  JSON.stringify(inReview41),
);
check(
  'in-review reads pending when the latest run of a check is still IN_PROGRESS',
  inReview42?.pr === 142 && inReview42?.checks === 'pending',
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
