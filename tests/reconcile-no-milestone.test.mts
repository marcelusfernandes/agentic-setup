#!/usr/bin/env node
// Cases for `scripts/reconcile.mts --no-milestone` (#259): the loop's state as
// the same JSON document, over the open issues that carry no milestone at all.
// Its own file rather than a section of `tests/reconcile.test.mts`, which is
// already near the repository's 800-line limit.
//
// Same method as that file: GitHub data comes from a fake `gh` put first on
// PATH (a bash script dispatching on the subcommand), worktree and branch data
// from a real temporary git repository with a real bare "origin", so `git
// fetch --prune`, `git for-each-ref` and `git worktree list --porcelain` are
// exercised for real. The fixture here is deliberately small: the mode is
// defined by the *absence* of a milestone, so what it needs to prove is which
// issues it selects, that it selects them without reading a milestone at all,
// and how it refuses.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, finish, git, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

// --- a fake `gh` on PATH ----------------------------------------------------
// `FAKE_GH_MILESTONES` picks what the milestones endpoint answers: `ok` (one
// open milestone), `noopen` (a closed one only — nothing for the default pick
// to reconcile against), `fail` (the call errors, which is how the cases below
// prove `--no-milestone` never makes it).
const FAKE_GH = `#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  "api repos/{owner}/{repo}/milestones"*)
    case "\${FAKE_GH_MILESTONES:-ok}" in
      fail)
        echo "fake-gh: milestones unavailable" >&2
        exit 1
        ;;
      noopen)
        echo '{"number":1,"title":"MClosed","state":"closed","description":"An objective.\\n\\nOut of this phase:\\n- none\\n\\nExit criteria:\\n- [ ] one\\n\\nDepends on: none\\n"}'
        ;;
      *)
        echo '{"number":1,"title":"M1","state":"open","description":"An objective.\\n\\nOut of this phase:\\n- none\\n\\nExit criteria:\\n- [ ] one\\n\\nDepends on: none\\n"}'
        ;;
    esac
    ;;
  "issue list")
    args="\$*"
    case "\$args" in
      *"--state closed"*)
        echo '[{"number":3}]'
        ;;
      *"--milestone "*)
        # Nothing here should ever list a milestone's issues: this fixture
        # answers the repository-wide list only, so a call naming a milestone
        # is a refusal that failed to refuse. The message deliberately does not
        # repeat the flag names the cases below assert on, so a run that gets
        # here cannot satisfy them by accident.
        echo "fake-gh: this fixture answers no such list: \$*" >&2
        exit 1
        ;;
      *)
        # The repository-wide open list, with the milestone field. Two
        # milestone-carrying issues are in it on purpose — the local filter is
        # what has to leave them out.
        cat <<'JSON'
[
  {"number":80,"title":"Small fix with no milestone","body":"## Dependencies\\nBlocked by: none\\n","labels":[{"name":"state:ready"}],"milestone":null},
  {"number":81,"title":"No milestone, blocked on an open issue","body":"## Dependencies\\nBlocked by: #99\\n","labels":[{"name":"state:ready"}],"milestone":null},
  {"number":82,"title":"No milestone, in progress with neither PR nor branch","body":"","labels":[{"name":"state:in-progress"}],"milestone":null},
  {"number":83,"title":"No milestone, awaiting a person","body":"## Dependencies\\nBlocked by: none\\n","labels":[{"name":"state:ready"},{"name":"human:pending"}],"milestone":null},
  {"number":10,"title":"Ready, in M1","body":"## Dependencies\\nBlocked by: none\\n","labels":[{"name":"state:ready"}],"milestone":{"number":1,"title":"M1"}},
  {"number":11,"title":"In progress, in M1","body":"","labels":[{"name":"state:in-progress"}],"milestone":{"number":1,"title":"M1"}}
]
JSON
        ;;
    esac
    ;;
  "pr list")
    echo '[]'
    ;;
  *)
    echo "fake-gh: unknown command: \$*" >&2
    exit 1
    ;;
esac
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-nomilestone-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- a real repo with a real bare "origin" ---------------------------------
// No branches beyond `main`: none of the milestone-less issues in the fixture
// carries a lock branch, which is what makes #82 `stale`. The remote still has
// to exist and to have a HEAD, because the script fetches with prune and
// resolves the default branch from `refs/remotes/origin/HEAD` before it
// classifies anything.
const repo = tempRepo();
git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);

const remoteDir = mkdtempSync(join(tmpdir(), 'agentic-remote-nomilestone-'));
cleanup(() => rmSync(remoteDir, { recursive: true, force: true }));
git(['init', '-q', '--bare', remoteDir], repo);
git(['remote', 'add', 'origin', remoteDir], repo);
git(['push', '-q', 'origin', 'main'], repo);
git(['fetch', '-q', 'origin'], repo);
git(['remote', 'set-head', 'origin', 'main'], repo);

function reconcileWithEnv(extraEnv: Record<string, string>, ...args: string[]) {
  return spawnSync(RUNTIME, [join(ROOT, 'scripts', 'reconcile.mts'), ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: PATH_WITH_FAKE_GH, ...extraEnv },
  });
}

function reconcile(...args: string[]) {
  return reconcileWithEnv({}, ...args);
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- AC1: the mode selects the milestone-less issues and classifies them the
// usual way. A small fix reasonably goes without a milestone, and until this
// mode existed step 0 could not see one at all: the default pick fails with
// `no open milestone` and `--milestone` can only name one. ------------------
const r = reconcile('--no-milestone');
check('reconcile --no-milestone exits 0', r.status === 0, `${r.stdout}\n${r.stderr}`);
check('reconcile --no-milestone prints nothing but JSON on stdout', parseJson(r.stdout) !== null, r.stdout);

const out = parseJson(r.stdout);
check(
  '--no-milestone reports milestone: null and milestoneLint: null (AC1)',
  out !== null && out.milestone === null && out.milestoneLint === null,
  r.stdout,
);

// The document's fields, in the order the script's header documents them. A
// pin, not a comparison between two runs: comparing this run's keys with a
// milestone run's cannot fail while both exit 0, so it would guard nothing.
// This fails when a field is dropped, renamed or emitted in another order.
const SHAPE = ['milestone', 'milestoneLint', 'ready', 'humanPending', 'inProgress', 'resumable', 'inReview', 'stale', 'orphanWorktrees', 'deadWorktrees'];
check(
  '--no-milestone prints the documented JSON shape, field for field and in order (AC1)',
  out !== null && JSON.stringify(Object.keys(out)) === JSON.stringify(SHAPE),
  JSON.stringify(Object.keys(out ?? {})),
);

check(
  '--no-milestone lists the milestone-less state:ready issue, and not the one blocked on an open issue (AC1)',
  JSON.stringify((out?.ready ?? []).map((i: any) => i.number)) === JSON.stringify([80]),
  JSON.stringify(out?.ready),
);
check(
  '--no-milestone classifies a milestone-less in-progress issue with no PR and no branch as stale (AC1)',
  (out?.stale ?? []).length === 1 && out.stale[0].number === 82,
  JSON.stringify(out?.stale),
);
check(
  '--no-milestone reports a milestone-less issue awaiting a person, and keeps it out of ready (AC1)',
  JSON.stringify((out?.humanPending ?? []).map((i: any) => i.number)) === JSON.stringify([83]),
  JSON.stringify(out?.humanPending),
);

const reported = [
  ...(out?.ready ?? []),
  ...(out?.humanPending ?? []),
  ...(out?.inProgress ?? []),
  ...(out?.resumable ?? []),
  ...(out?.inReview ?? []),
  ...(out?.stale ?? []),
].map((i: any) => i.number);
check(
  "--no-milestone never mixes in a milestone's issues, in any bucket (AC1)",
  !reported.includes(10) && !reported.includes(11),
  JSON.stringify(reported),
);

// The two sets are disjoint because the filter is local, so the mode reads no
// milestone at all: with the milestones call erroring, a pass that made it
// would fail (it is the hard read when it is what picks the milestone), and
// this one still exits 0 with the same issues.
const rNoMilestonesCall = reconcileWithEnv({ FAKE_GH_MILESTONES: 'fail' }, '--no-milestone');
const outNoMilestonesCall = parseJson(rNoMilestonesCall.stdout);
check(
  '--no-milestone never reads the milestones endpoint: an erroring one changes nothing (AC1)',
  rNoMilestonesCall.status === 0 &&
    outNoMilestonesCall?.milestone === null &&
    outNoMilestonesCall?.milestoneLint === null &&
    JSON.stringify((outNoMilestonesCall?.ready ?? []).map((i: any) => i.number)) === JSON.stringify([80]),
  `${rNoMilestonesCall.stdout}\n${rNoMilestonesCall.stderr}`,
);

// --- AC2: the two flags name two different sets of issues, so asking for both
// is a usage error naming both, not a silent precedence. -------------------
const rBothFlags = reconcile('--no-milestone', '--milestone', 'M1');
check('--no-milestone with --milestone exits 1 (AC2)', rBothFlags.status === 1, `${rBothFlags.stdout}\n${rBothFlags.stderr}`);
const outBothFlags = parseJson(rBothFlags.stdout);
check(
  '--no-milestone with --milestone is a usage error naming both flags (AC2)',
  typeof outBothFlags?.error === 'string' &&
    outBothFlags.error.includes('--no-milestone') &&
    outBothFlags.error.includes('--milestone'),
  rBothFlags.stdout,
);
check(
  'the two-flag usage error never reconciles one of them anyway (AC2)',
  outBothFlags?.milestone === undefined && outBothFlags?.ready === undefined,
  rBothFlags.stdout,
);
check('the two-flag usage error never prints a stack trace (AC2)', !/\n\s*at /.test(rBothFlags.stderr), rBothFlags.stderr);

// --- AC3: with neither flag and no open milestone, the refusal names the
// other way out as well, instead of leaving --milestone as the only exit. ---
const rNoOpenMilestone = reconcileWithEnv({ FAKE_GH_MILESTONES: 'noopen' });
check(
  'no open milestone and neither flag still exits 1 (AC3)',
  rNoOpenMilestone.status === 1,
  `${rNoOpenMilestone.stdout}\n${rNoOpenMilestone.stderr}`,
);
const outNoOpenMilestone = parseJson(rNoOpenMilestone.stdout);
check(
  'the no-open-milestone failure names --no-milestone as well as --milestone (AC3)',
  typeof outNoOpenMilestone?.error === 'string' &&
    outNoOpenMilestone.error.startsWith('no open milestone') &&
    outNoOpenMilestone.error.includes('--milestone') &&
    outNoOpenMilestone.error.includes('--no-milestone'),
  rNoOpenMilestone.stdout,
);

finish();
